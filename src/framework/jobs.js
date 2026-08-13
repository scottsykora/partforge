// The worker's job protocol. The pure part model it runs over — viewSubParts /
// exportSubParts / resolveParams / buildPosed — lives in part-model.js, a leaf, so
// the oracle and the collision check can share it without importing this async,
// kernel-bound module back.
import { meshTo3MF } from "./geometry/threemf.js";
import { exportablePartNames } from "./export-select.js";
import { resolveFonts } from "./fonts.js";
import { safeName } from "./safe-name.js";
import { exportSubParts, resolveParams, buildPosed } from "./part-model.js";
import { measure } from "./oracle/measure.js";
import { verify } from "./oracle/verify.js";
import { buildView } from "./oracle/build.js";
import { MATCH_VIEWS, rasterizeMeshMask, rasterizeRingsMask } from "./oracle/silhouette.js";
import { matchViews } from "./oracle/match.js";

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
function referenceMask(target) {
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
function scoreMatchTargets(built, targets, onProgress) {
  if (!targets?.length) return null;
  try {
    const meshes = built.map((b) => b.mesh);
    const viewMasks = {};
    for (const view of MATCH_VIEWS) viewMasks[view] = rasterizeMeshMask(meshes, view);

    const out = [];
    for (const target of targets) {
      try {
        const reference = referenceMask(target);
        if (!reference) continue;
        // scaleAware is the CALLER's promise that both sides are in millimetres, and
        // this is the caller: rings are mm and the mesh masks carry mmPerPx, so a
        // profile target gets the absolute-size score (`iouScale`, contourDist in mm)
        // while an image target gets the pose-normalized one.
        const scoreOpts = { scaleAware: target.kind === "profile" };
        const { best, views } = matchViews(viewMasks, reference, scoreOpts) ?? {};
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

  try {
    // Preload any part-declared fonts into the kernel before building — once per
    // font name; a lazy dynamic import because this is async context (unlike the
    // synchronous kernel-front), so it doesn't cost sync callers anything.
    if (part.fonts && kernel._fonts) {
      const opentype = (await import("opentype.js")).default;
      const bufs = await resolveFonts(part.fonts);
      for (const [name, buf] of bufs) if (!kernel._fonts.has(name)) kernel._fonts.set(name, opentype.parse(buf));
    }
    // Inside the try so a throwing derive posts an error the UI can show,
    // instead of killing the worker turn silently (an endless spinner).
    const { p, d } = resolveParams(part, msg.params);
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
      kernel.resetCacheStats?.(); // count hits/misses for just this job
      for (const [i, name] of msg.subparts.entries()) {
        if (useCache) kernel.beginSubPart?.(name); // open the per-sub-part cache round
        try {
          const m = posed(name, "display").toMesh({ quality: "preview" });
          meshes.push({ name, positions: m.positions, normals: m.normals, indices: m.indices, triangles: m.triangles, edges: m.edges, featureIds: m.featureIds, features: m.features });
        } finally {
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
      post({ type: "meshes", meshes, ms: Date.now() - t0, cache: kernel.cacheStats?.() }, transfer);
    } else if (msg.type === "capture-generate") {
      // A private, job-correlated one-shot channel for captureView — builds a
      // (possibly non-active) view's meshes off the regen loop, so it can never
      // race or clobber live state. Same per-sub-part build+cache-round as
      // `generate` above (cache:true reuses the worker's geometry memo), but no
      // isStale/superseded polling — there's nothing to supersede a one-shot.
      const useCache = msg.cache !== false;
      const meshes = [];
      for (const name of msg.subparts) {
        if (useCache) kernel.beginSubPart?.(name);
        try {
          const m = posed(name, "display").toMesh({ quality: "preview" });
          meshes.push({ name, positions: m.positions, normals: m.normals, indices: m.indices, triangles: m.triangles, edges: m.edges, featureIds: m.featureIds, features: m.features });
        } finally {
          if (useCache) kernel.endSubPart?.();
          kernel.cleanup?.();
        }
      }
      const captureTransfer = meshes.flatMap((m) =>
        [m.positions.buffer, m.normals?.buffer, m.indices?.buffer, m.edges?.buffer, m.featureIds?.buffer].filter(Boolean));
      post({ type: "capture-meshes", jobId: msg.jobId, meshes }, captureTransfer);
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
      // re-casting the same min-wall rays a second time. Measuring `{ minWall:
      // true }` here is what makes the seed usable by any verify run, min-wall
      // gated or not — the result says so itself (`measuredMinWall`), so this
      // call and the seed cannot drift apart.
      //
      // The view is built HERE rather than inside measure, and handed down through
      // `opts.built`, because optional match scoring needs the same meshes: one build
      // feeds the measurement and the six silhouette rasterizations both.
      const built = buildView(kernel, part, msg.view, msg.params ?? {});
      const measured = measure(kernel, part, msg.view, msg.params ?? {}, { minWall: true, built });
      const report = {
        measure: measured,
        verify: verify(kernel, part, {
          view: msg.view,
          seed: { params: msg.params ?? {}, result: measured },
        }),
      };
      // `match` is present only when the caller asked for it AND something scored, so
      // an inspect with no `matchTargets` answers on exactly the shape it always has.
      const match = scoreMatchTargets(built, msg.matchTargets, onProgress);
      if (match) report.match = match;
      post({ type: "report", ...report }, match?.map((m) => m.delta.data.buffer) ?? []);
    }
  } catch (err) {
    if (err?.code === "NEEDS_OCCT") post({ type: "needs-occt", jobId: msg.jobId });
    else post({ type: "error", message: String(err?.message || err), jobId: msg.jobId });
  } finally {
    kernel.cleanup?.();
  }
}
