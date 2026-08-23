// The worker's job protocol. The pure part model it runs over — viewSubParts /
// exportSubParts / resolveParams / buildPosed — lives in part-model.js, a leaf, so
// the oracle and the collision check can share it without importing this async,
// kernel-bound module back.
import { meshTo3MF } from "./geometry/threemf.js";
import { exportablePartNames } from "./export-select.js";
import { fontControlAllows, fontSourceAllowed, isNoFontSource } from "./font-source.js";
import { fontsFor, resolveFonts } from "./fonts.js";
import { normalizeOpentype, parseFont } from "./geometry/opentype-interop.js";
import { ensureImports, resolveImports } from "./imports.js";
import { safeName } from "./safe-name.js";
import { exportSubParts, resolveParams, buildPosed } from "./part-model.js";

// The oracle loads LAZILY, per job family, never at worker boot. It is the largest
// JS payload in the worker's graph (measure/verify/build and silhouette/match), and
// only the `inspect` job runs any of it — the generate/export hot path touches none.
// Each family below is a literal dynamic import(), which Vite splits into its own
// chunk under `worker.format: "es"` (this repo's config and partforge-cloud's both),
// so a user who never runs an oracle job never downloads or parses one. The module
// loader caches the namespace after the first await, so repeat jobs pay a
// resolved-promise tick, not a re-fetch.
// test/worker-layering.test.js's eager-closure guard holds this in place.
const loadInspect = () => Promise.all([
  import("./oracle/build.js"),
  import("./oracle/measure.js"),
  import("./oracle/verify.js"),
]);

// The DESCRIBE stack is not part of this package at all: the semantic mesh oracle
// lives in a separate, closed package, and this open framework never names it. A
// host that has it INJECTS a loader — `runWorker(part, { loadOracle })`, threaded
// here as `opts.loadOracle`, resolving to the oracle package's barrel (describe,
// describeMemo, compactDescribe). Injection rather than a bare import specifier is
// deliberate: a literal `import("@scope/pkg")` in open source would fail every
// downstream Vite build where the package isn't installed, while an injected thunk
// is simply absent — and an absent oracle answers the job with the structured
// `oracle-unavailable` report below instead of stalling or throwing.

// One describe memo for the life of this worker, created alongside the stack's first
// load. Deliberately NOT swept on setPart the way solid-cache is: describe is pure in
// the mesh bytes (spec §4.1), so an edit can never invalidate it, and dropping it on
// rebind would throw away the single most expensive thing this worker computes for no
// reason at all. Keyed by content digest, so a genuinely changed file misses correctly.
let DESCRIBE_MEMO = null;

// Handle one geometry job, posting results/progress via `post(msg, transfer?)`.
// Backend-agnostic and part-agnostic: every part specific comes through `part`.
//   { type:"generate", subparts, view, params } → { type:"meshes", meshes, ms }
//   { type:"export-stl", view, params }         → { type:"download-parts", ext, mime, parts }
//   { type:"export-step", view, params }        → { type:"download", data, filename, mime }
// A generate also accepts `opts.isStale` — a caller-supplied predicate checked at each
// sub-part boundary — and answers { type:"superseded" } instead of `meshes` when it
// stops early (a build that ended without meshes, not an error; see KERNEL-CONTRACT.md).
// Each result branch declares its own transferables (the big binary buffers,
// zero-copy across the worker boundary) right where the buffers are created —
// so a new job type can't silently regress to structured-cloning its payload.
// Progress is posted as { type:"progress", phase }. Export builds thread the
// progress callback into build() so a part's own per-feature progress surfaces;
// preview generates stay quiet (no callback) to avoid flicker during slider drags.
const bufferOf = (data) => (ArrayBuffer.isView(data) ? data.buffer : data);

// One caller-supplied match target as a reference mask, or null when it is not one we
// can score. Every field here is untrusted wire data, so shape is checked rather than
// assumed — a target the caller got wrong is skipped, never thrown, so one bad entry
// cannot cost the others their scores (or the caller their geometry report).
//   {kind: "profile", rings: [[[x,y], ...], ...]}  — millimetres, so it carries scale
//   {kind: "image",   mask: {data, width, height}} — a photo, so it carries none
function referenceMask(target, rasterizeRingsMask) {
  if (target?.kind === "profile") return Array.isArray(target.rings) ? rasterizeRingsMask(target.rings) : null;
  if (target?.kind === "image") {
    const m = target.mask;
    if (!m?.data || !(m.width > 0) || !(m.height > 0)) return null;
    // mmPerPx is deliberately absent: a photograph has no millimetres, which is what
    // keeps the scale-aware comparison off for an image target no matter what is asked.
    return { data: m.data, width: m.width, height: m.height };
  }
  return null;
}

// Score the part's six canonical silhouettes against each match target.
// `built` is the view's already-built sub-parts — the meshes are JS-owned, so this
// reads correctly after the kernel has been cleaned up.
//
// Total by construction: match scoring is an EXTRA on top of the geometric report, so
// any failure here omits `match` and leaves the report itself intact. A caller who
// asked for a score and got none can ask again; a caller who lost their measurement
// because a mask blew up has lost the thing they actually came for.
//
// The six mesh masks are rasterized ONCE and shared across every target — the targets
// are the cheap side of this (a couple of reference masks), the part is not.
async function scoreMatchTargets(built, targets, onProgress) {
  if (!targets?.length) return null;
  try {
    // Loaded here, past the early return: an inspect with no matchTargets — the
    // common case — never pays for the rasterizer.
    const [{ MATCH_VIEWS, rasterizeMeshMask, rasterizeRingsMask }, { matchViews }] = await Promise.all([
      import("./oracle/silhouette.js"),
      import("./oracle/match.js"),
    ]);
    const meshes = built.map((b) => b.mesh);
    const viewMasks = {};
    for (const view of MATCH_VIEWS) viewMasks[view] = rasterizeMeshMask(meshes, view);

    const out = [];
    for (const target of targets) {
      try {
        const reference = referenceMask(target, rasterizeRingsMask);
        if (!reference) continue;
        // scaleAware is the CALLER's promise that both sides are in millimetres, and
        // this is the caller: rings are mm and the mesh masks carry mmPerPx, so a
        // profile target gets the absolute-size score (`iouScale`, contourDist in mm)
        // while an image target gets the pose-normalized one.
        const scoreOpts = { scaleAware: target.kind === "profile" };
        const { best, views } = matchViews(viewMasks, reference, scoreOpts);
        if (!best) continue; // nothing scoreable — a dropped target, never a zero score
        const { delta, ...scores } = best;
        out.push({ kind: target.kind, best: scores, views, delta: { view: best.view, ...delta } });
      } catch (err) {
        onProgress(`match target skipped: ${String(err?.message || err)}`);
      }
    }
    return out.length ? out : null;
  } catch (err) {
    onProgress(`match scoring skipped: ${String(err?.message || err)}`);
    return null;
  }
}

export async function handle(kernel, part, msg, post, opts = {}) {
  const isStale = opts.isStale ?? (() => false);
  const onProgress = (phase) => post({ type: "progress", phase, jobId: msg.jobId });
  const label = (name) => part.parts[name].label ?? name;
  const exportName = (name) => part.parts[name].export?.name ?? name;

  // Warnings this job raised before any sub-part was built — a refused font
  // source, today. They ride the result's `warnings` (below) rather than only a
  // progress phase, which the next busy chip overwrites milliseconds later: a
  // tampered share link must leave a notice that is still readable once the
  // build has landed. `part: null` because these belong to the job, not to any
  // one sub-part.
  const jobWarnings = [];
  try {
    // Params first: the fonts declaration may be a function of them, and a
    // throwing derive() should surface before a font download rather than
    // after one. Still inside the try, so that throw posts an error the UI can
    // show instead of killing the worker turn silently (an endless spinner).
    //
    // The font-source check runs as resolveParams' sanitize hook, not after it:
    // rewriting p[key] afterwards would leave derive() — and therefore `d`, and
    // therefore the geometry — holding the refused value while build() saw the
    // default.
    const { p, d } = resolveParams(part, msg.params, (params) => {
      // A param bound to a `type: "font"` control is user input — on a shared
      // link it is arbitrary attacker-supplied text that `fonts: (p) => …` would
      // turn into a fetch URL. Refuse out-of-`allow` values back to the part's
      // own default rather than failing the build: a bad link should show the
      // part, not an error page.
      for (const [key, allow] of fontControlAllows(part)) {
        const v = params[key];
        if (isNoFontSource(v) || fontSourceAllowed(v, allow)) continue;
        const message = `font source for "${key}" is not allowed — using the default`;
        onProgress(message);          // the live chip…
        jobWarnings.push({ part: null, message });   // …and the durable record
        params[key] = part.defaults?.[key];
      }
    });
    // Preload any part-declared fonts into the kernel before building. A lazy
    // dynamic import because this is async context (unlike the synchronous
    // kernel-front), so it doesn't cost sync callers anything. The namespace
    // shape differs between bundler and Node resolution (a bare `.default`
    // here is undefined in every browser bundle) — normalize it.
    const fontsDecl = fontsFor(part, p);
    // A nullish/empty source means "no font declared" for that name, not an
    // error — e.g. `fonts: (p) => ({ face: p.face })` when p.face ended up
    // undefined because the refusal above had no default to fall back to, or
    // because the author simply left it unset. text2d falls back to the
    // bundled Roboto for a name with no declared source. Passing it through
    // to resolveFonts would throw ("must be bytes, a URL, or a thunk…"),
    // producing exactly the error-page outcome the refusal above exists to
    // avoid. Drop it here, centrally, rather than teaching resolveFonts about
    // "empty is fine" (it still must error on a *present* source of the wrong
    // shape — that's a real authoring bug). The progress note is what keeps a
    // genuine typo (a name that never resolves) visible instead of silently
    // swallowed.
    const fontsToResolve = fontsDecl && Object.fromEntries(
      Object.entries(fontsDecl).filter(([name, src]) => {
        if (!isNoFontSource(src)) return true;
        onProgress(`no font source declared for "${name}" — skipping`);
        return false;
      }),
    );
    // Gated on the part DECLARING `fonts` at all, not on this job having one to
    // resolve — the prune below has to run on the empty declaration too, and a
    // part with no `fonts` field must not touch the map (a host or test harness
    // may have seeded kernel._fonts directly, e.g. bootManifoldKernel({ fonts })).
    if (part.fonts && kernel._fonts) {
      const declared = fontsToResolve ?? {};
      if (Object.keys(declared).length) {
        onProgress("resolving fonts");
        const opentype = normalizeOpentype(await import("opentype.js"));
        const bufs = await resolveFonts(declared);
        // Keyed on the SOURCE, not the name. A name is not a font identity: one
        // worker outlives many parts (worker-rebind) and, once a font can come
        // from a param, many picks — all of which reuse the same declared name.
        // The old `if (!_fonts.has(name))` made the first bytes ever seen under a
        // name permanent for the life of the worker.
        //
        // The source, not the resolved buffer: the two agree only because the
        // resolver's own memo is unbounded and hands back the identical object
        // every time. Key on that and this memo silently degrades to per-fetch
        // identity — a re-parse per build — the day eviction is added there.
        kernel._fontsBySource ??= new Map();
        for (const [name, buf] of bufs) {
          const source = declared[name];
          let font = kernel._fontsBySource.get(source);
          if (!font) { font = parseFont(opentype, buf, name); kernel._fontsBySource.set(source, font); }
          kernel._fonts.set(name, font);
        }
      }
      // Drop every name this build's declaration does not supply. `_fonts` is
      // the kernel's, and the kernel outlives the job: without this, a face the
      // user picked and then CLEARED stays registered under its old name, and an
      // unconditional `k.text2d(s, { font: "face" })` goes on rendering it
      // instead of falling back — the stale-registration bug of spec §5, one
      // step narrower and just as silent.
      for (const name of [...kernel._fonts.keys()]) {
        if (!Object.hasOwn(declared, name)) kernel._fonts.delete(name);
      }
    }
    // Register this part's declared imports on the kernel running this job — the
    // import-asset sibling of the fonts preload above. See ensureImports for the
    // lazy-error policy that keeps a STEP import inert until a build actually
    // calls k.import on it.
    if (part.imports) await ensureImports(kernel, part.imports, opts.importMeshes ?? null);
    // Local shorthand over the shared helper: kernel/part/view/p/d are fixed per job.
    const posed = (name, purpose, prog) => buildPosed(kernel, part, name, { purpose, view: msg.view, p, d, onProgress: prog });
    // Explicit selection (headless exportParts) overrides view-derived selection.
    const selected = () =>
      msg.parts
        ? exportablePartNames(part, p).filter((name) => msg.parts.includes(name))
        : exportSubParts(part, msg.view, p);
    const fileBase = safeName(msg.name ?? msg.view); // STEP/3MF single-file name base (part-derived → untrusted)

    if (msg.type === "generate") {
      const t0 = Date.now();
      const useCache = msg.cache !== false; // ?debug toggle can disable caching (cache:false)
      const meshes = [];
      // Feature-skip warnings (a fillet/chamfer the geometry defeated — see the
      // backends' takeBuildWarnings): drained per sub-part below so each message
      // names the sub-part whose build recorded it, and drained-and-discarded here
      // first so a previous job's stragglers (an oracle build, an export) cannot be
      // misattributed to this build's first sub-part.
      kernel.takeBuildWarnings?.();
      const warnings = [...jobWarnings];   // job-level notices ride along with the per-sub-part ones
      kernel.resetCacheStats?.(); // count hits/misses for just this job
      for (const [i, name] of msg.subparts.entries()) {
        if (useCache) kernel.beginSubPart?.(name); // open the per-sub-part cache round
        try {
          const m = posed(name, "display").toMesh({ quality: "preview" });
          meshes.push({ name, positions: m.positions, normals: m.normals, indices: m.indices, triangles: m.triangles, edges: m.edges, featureIds: m.featureIds, features: m.features });
        } finally {
          for (const message of kernel.takeBuildWarnings?.() ?? []) warnings.push({ part: name, message });
          if (useCache) kernel.endSubPart?.(); // always close the bracket — a throw mid-build must not strand pinned solids
          kernel.cleanup?.();                  // free this round's transients (cached/pinned solids survive)
        }
        // Cooperative cancel: yield one macrotask so queued messages (a newer
        // generate, a part rebind) can be seen, then stop at this boundary if
        // this build is stale. The last sub-part skips the yield — nothing
        // follows it. Completed sub-parts have already committed their cache
        // brackets, so an abort here strands nothing.
        if (i < msg.subparts.length - 1) {
          await new Promise((r) => setTimeout(r, 0));
          if (isStale()) return void post({ type: "superseded" });
        }
      }
      const transfer = meshes.flatMap((m) =>
        [m.positions.buffer, m.normals?.buffer, m.indices?.buffer, m.edges?.buffer, m.featureIds?.buffer].filter(Boolean));
      post({ type: "meshes", meshes, ms: Date.now() - t0, cache: kernel.cacheStats?.(),
             ...(warnings.length ? { warnings } : {}) }, transfer);
    } else if (msg.type === "capture-generate") {
      // A private, job-correlated one-shot channel for captureView — builds a
      // (possibly non-active) view's meshes off the regen loop, so it can never
      // race or clobber live state. Same per-sub-part build+cache-round as
      // `generate` above (cache:true reuses the worker's geometry memo), but no
      // isStale/superseded polling — there's nothing to supersede a one-shot.
      const useCache = msg.cache !== false;
      const meshes = [];
      kernel.takeBuildWarnings?.(); // discard a previous job's stragglers (same as generate)
      const warnings = [...jobWarnings];
      for (const name of msg.subparts) {
        if (useCache) kernel.beginSubPart?.(name);
        try {
          const m = posed(name, "display").toMesh({ quality: "preview" });
          meshes.push({ name, positions: m.positions, normals: m.normals, indices: m.indices, triangles: m.triangles, edges: m.edges, featureIds: m.featureIds, features: m.features });
        } finally {
          for (const message of kernel.takeBuildWarnings?.() ?? []) warnings.push({ part: name, message });
          if (useCache) kernel.endSubPart?.();
          kernel.cleanup?.();
        }
      }
      const captureTransfer = meshes.flatMap((m) =>
        [m.positions.buffer, m.normals?.buffer, m.indices?.buffer, m.edges?.buffer, m.featureIds?.buffer].filter(Boolean));
      post({ type: "capture-meshes", jobId: msg.jobId, meshes,
             ...(warnings.length ? { warnings } : {}) }, captureTransfer);
    } else if (msg.type === "export-stl") {
      const names = selected();
      if (names.length === 0) throw new Error("no exportable parts selected");
      const out = [];
      for (const name of names) {
        onProgress(`building ${label(name)}`);
        out.push({ name: exportName(name), data: await posed(name, "export", onProgress).toSTL({ quality: msg.quality ?? "print" }) });
      }
      post({ type: "download-parts", ext: "stl", mime: "model/stl", parts: out, jobId: msg.jobId },
           out.map((pp) => bufferOf(pp.data)));
    } else if (msg.type === "export-step") {
      const names = selected();
      if (names.length === 0) throw new Error("no exportable parts selected");
      const solids = names.map((name) => {
        onProgress(`building ${label(name)}`);
        return { name: exportName(name), solid: posed(name, "export", onProgress) };
      });
      onProgress("writing STEP file");
      const data = await kernel.toSTEP(solids);
      post({ type: "download", data, filename: `${fileBase}.step`, mime: "application/step", jobId: msg.jobId }, [bufferOf(data)]);
    } else if (msg.type === "export-3mf") {
      const names = selected();
      if (names.length === 0) throw new Error("no exportable parts selected");
      const meshes = names.map((name) => {
        onProgress(`building ${label(name)}`);
        const { positions, indices } = posed(name, "export", onProgress).toIndexedMesh({ quality: msg.quality ?? "print" });
        return { name: exportName(name), positions, indices };
      });
      onProgress("writing 3MF file");
      const data = meshTo3MF(meshes);
      post({ type: "download", data, filename: `${fileBase}.3mf`, mime: "model/3mf", jobId: msg.jobId }, [bufferOf(data)]);
    } else if (msg.type === "tessellate-imports") {
      // OCCT-worker service job for the STEP-on-Manifold crossover: answer with
      // print-quality triangle meshes for every STEP import, transferable.
      const resolved = await resolveImports(part.imports ?? {});
      const meshes = {};
      for (const [name, a] of resolved) {
        if (a.format !== "step") continue;
        const { positions, indices } = kernel.import(name).toIndexedMesh({ quality: "print" });
        meshes[name] = { digest: a.digest, positions, indices };
      }
      post({ type: "import-meshes", jobId: msg.jobId, meshes },
           Object.values(meshes).flatMap((m) => [m.positions.buffer, m.indices.buffer]));
    } else if (msg.type === "inspect") {
      // Full geometric oracle for the current view: solid facts (volume/genus/
      // watertight), mesh facts, overlaps, and gap distances, plus the part's
      // structural + declared verify gates. Runs against the worker's live kernel
      // — the main thread only has mesh arrays, so this can only happen here.
      // measure/verify build their own solids via buildView and are cleaned up by
      // the `finally` below.
      // The two halves overlap: verify always expands a "defaults" case, and for
      // an unparameterized inspect that case IS this measurement. Seeding it in
      // (see verify.js's seeding block for the min-wall superset rule that makes
      // the reuse sound) stops the oracle from rebuilding the same geometry and
      // re-casting the same min-wall rays a second time. On a full lap the seed is
      // usable by any verify run, min-wall gated or not, because the pass ran — and
      // the result says so ITSELF (`measuredMinWall`/`measuredGaps`), never a claim
      // by this caller, so the two cannot drift apart. On a quick lap the passes did
      // not run, the stamps say false, and verify reports what it could not check.
      //
      // The view is built HERE rather than inside measure, and handed down through
      // `opts.built`, because optional match scoring needs the same meshes: one build
      // feeds the measurement and the six silhouette rasterizations both.
      //
      // The default matters and must match measure()'s own: buildView has NO view
      // default — viewSubParts(part, undefined) returns [] without erroring — so an
      // inspect with no `view` (partforge-cloud's requestReport has always sent
      // undefined, meaning "the current view") built an EMPTY view here, and every
      // downstream consumer degraded silently: measure reported zero subparts and a
      // [0,0,0] bbox, match scored nothing, and verify still passed. Pre-0.55,
      // measure built internally and its own signature default hid this. Found by a
      // live browser check, not by tests: this suite passes explicit views, and the
      // cloud's unit tests fake the worker.
      //
      // `checks: "quick"` is the agent's fast lap. Min wall and pair distances are
      // the oracle's two ray-casting passes and, profiled on a 460k-triangle
      // assembly, 79% of its cost — and they SHARE the BVH those rays need, so
      // skipping one leaves the index build standing and saves about half of what
      // skipping both does. Everything else is derived from the build this job
      // already paid for and stays: triangles, bbox, volume, genus, watertight,
      // and the assembly overlap check. verify still runs — the gates that read
      // those facts are free — and reports what it could not evaluate rather than
      // passing it, which is why `quick` can be honoured on a gated part instead
      // of refused. Anything other than the literal "quick" is the full lap: an
      // unrecognized value must never quietly buy less checking than the caller
      // asked for.
      const quick = msg.checks === "quick";
      const [{ buildView }, { measure }, { verify }] = await loadInspect();
      const view = msg.view ?? Object.keys(part.views)[0];
      const built = buildView(kernel, part, view, msg.params ?? {});
      const measured = measure(kernel, part, view, msg.params ?? {},
        { minWall: !quick, gaps: !quick, built });
      const report = {
        measure: measured,
        verify: verify(kernel, part, {
          // The defaulted view, not msg.view: the seed below was measured on it, and
          // verify's seed reuse is only sound when both name the same view.
          view,
          // This job's own (lazily-imported) measure, not verify's static fallback:
          // the two are different module instances once measure.js loads through a
          // dynamic import, and the seeding test's call-count mock only sees this
          // one. One binding for the whole inspect keeps that countable — and true.
          measureFn: measure,
          quick,
          seed: { params: msg.params ?? {}, result: measured },
        }),
      };
      // `match` is present only when the caller asked for it AND something scored, so
      // an inspect with no `matchTargets` answers on exactly the shape it always has.
      const match = await scoreMatchTargets(built, msg.matchTargets, onProgress);
      if (match) report.match = match;
      post({ type: "report", ...report }, match?.map((m) => m.delta.data.buffer) ?? []);
    } else if (msg.type === "describe") {
      // Semantic description of an IMPORTED mesh — not of the built part. The two are
      // different questions: `inspect` asks "what did this source build?", `describe`
      // asks "what is this file?". describe never touches the part's own geometry, which
      // is why it takes an import name rather than a view.
      //
      // Manifold only, and not by choice on this path: mesh imports on OCCT are never
      // attempted, so a describe job posted to an OCCT worker is a routing bug, not a
      // fallback opportunity. It surfaces as an ordinary error rather than a reroute.
      if (!opts.loadOracle) {
        // Same closed-set, returned-not-thrown error contract describe itself keeps
        // (its errors are findings, not crashes) — shaped as the structured triple the
        // whole repo emits, so a caller can act on the code. ERROR-PATTERNS.md#describe-
        // oracle-unavailable carries the fix.
        post({ type: "describe-report", report: {
          error: "oracle-unavailable",
          detail: "this app was built without the mesh oracle package",
          diagnostic: {
            cause: "the describe job needs the closed oracle package, and no loadOracle loader was injected into runWorker",
            location: `describe "${msg.importName}"`,
            correctiveAction: "install the oracle package and pass runWorker(part, { loadOracle: () => import(...) }); see ERROR-PATTERNS.md#describe-oracle-unavailable",
          },
          source: { name: msg.importName, digest: null },
        } });
        return;
      }
      const { describe: describeMesh, describeMemo, compactDescribe } = await opts.loadOracle();
      const solid = kernel.import(msg.importName);      // throws on an unknown name
      // `_importDigest` is the backend's existing underscore side-channel (KERNEL-CONTRACT
      // "Conformance classes") — the same digest already folded into every import cache key.
      const digest = kernel._importDigest?.(msg.importName) ?? null;
      DESCRIBE_MEMO ??= describeMemo();
      const full = describeMesh(kernel, solid, {
        name: msg.importName,
        digest,
        budget: msg.budget,
        memo: DESCRIBE_MEMO,
      });
      // The compact shape is derived, never memoised separately: one memo entry per
      // mesh, two views of it, no way for the two to drift.
      post({ type: "describe-report", report: msg.compact ? compactDescribe(full) : full });
    }
  } catch (err) {
    // `subparts` (generate jobs only) tells the reroute policy which sub-parts the
    // failed job covered, so only those latch to OCCT — not the whole part.
    if (err?.code === "NEEDS_IMPORT_MESH") post({ type: "needs-import-mesh", jobId: msg.jobId, subparts: msg.subparts });
    else if (err?.code === "NEEDS_OCCT") post({ type: "needs-occt", jobId: msg.jobId, subparts: msg.subparts });
    else post({ type: "error", message: String(err?.message || err), jobId: msg.jobId });
  } finally {
    kernel.cleanup?.();
  }
}
