# Error patterns — symptom-indexed lookup

When a build, test, `measure`, or `verify` run fails confusingly: **grep this file
for the symptom first** — the literal error text, or a phrase describing the
misbehavior — before debugging from scratch.

**How to add a pattern** (`##` headings are reserved for pattern entries — the lint
test parses every one; keep prose like this as plain paragraphs):

- One pattern per `## <id>` heading. The heading is a **stable kebab-case ID**:
  permanent once committed — never renamed, never reused. External consumers
  (issue #27 diagnostics, HARDWARE.md, skills) cite `ERROR-PATTERNS.md#<id>`.
- **Namespaces:** core framework patterns are bare slugs. Subsystem patterns take
  a reserved prefix — `hardware-*` is reserved for the parts library (issue #30).
  One `#`-level section per namespace.
- Entry shape — exactly these three list lines, then optional note paragraphs:
  - **Symptom:** the literal string an agent would see, verbatim in backticks,
    when one exists; otherwise the observable misbehavior. This is the grep target.
  - **Cause:** one sentence.
  - **Fix:** the concrete change, linking the governing rule
    ([AUTHORING-PARTS.md](AUTHORING-PARTS.md) section) rather than restating it.
- No tables inside entries.
- Code that throws should throw greppable strings: an error message thrown by
  partforge should match its pattern's Symptom line verbatim.
- `test/error-patterns.test.js` lints this file's structure.

# Core framework

## worker-imports-main-entry

- **Symptom:** `ReferenceError: document is not defined` thrown from a worker build.
- **Cause:** The part (or a helper it imports) imports `partforge` instead of `partforge/geometry`, and the main entry pulls in the DOM viewer/controls.
- **Fix:** Import geometry helpers only from `partforge/geometry` in anything a worker loads. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Geometry: the kernel / `Solid` API".

## impure-build-stale-preview

- **Symptom:** Preview geometry doesn't change after editing the part's `build` (or changes once, then sticks), with no error anywhere.
- **Cause:** The preview kernel memoizes geometry by content hash, and an impure `build` (`Math.random`, clock, module-level mutable state) silently defeats it.
- **Fix:** Make `build` a pure function of `(k, p, d)`; move randomness/state into `derive` inputs or delete it. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Caching & determinism".

## replicad-consumed-operand

- **Symptom:** On the OCCT backend a solid is unexpectedly empty, or the build crashes, right after the same solid was transformed or used in a boolean — often only in STEP export, with the Manifold preview fine.
- **Cause:** replicad transforms and booleans (`translate`/`rotate`/`mirror`/`cut`/…) consume their operand — the input solid is deleted and a new one returned.
- **Fix:** Never reuse a solid after transforming it; take a `.clone()` first when you need the original again. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Conventions & gotchas".

## probe-routed-to-occt

- **Symptom:** A part builds far slower than expected (preview takes seconds instead of milliseconds), and the worker logs show it running on the `occt` worker.
- **Cause:** The geometry-free probe found a CAD-only op (`fillet`/`chamfer`/`shell`) referenced in `build` — even in a dead or conditional branch — and routed the whole part to OCCT.
- **Fix:** Remove the unused CAD-only call, or force the backend with `meta.backend: "manifold"` (or `"occt"`). See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Fillet & chamfer (automatic OCCT backend)".

## boolean-not-watertight

- **Symptom:** `NOT watertight ✗` from `partforge measure` (non-zero exit) after adding a boolean cut or union.
- **Cause:** A coplanar-face or grazing-cut degeneracy — the tool surface exactly touches the body surface, leaving zero-thickness geometry.
- **Fix:** Overcut: extend the tool past the faces it pierces (e.g. the demo's cut tool is `h + 4` starting at `z = -2`) and avoid exactly-flush faces in unions. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Verifying a part headlessly (render + measure)".

## dual-kernel-same-process

- **Symptom:** A test file crashes or hangs (WASM abort) when it boots both geometry kernels.
- **Cause:** OCCT and Manifold WASM must not boot in the same process.
- **Fix:** Keep OCCT-booting tests in their own files (vitest isolates per file) and boot via `bootOcctKernel()` in a `beforeAll`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Testing a part".

## view-dependent-display-place

- **Symptom:** A sub-part renders correctly in one view but appears misplaced (usually in its other-view pose) after switching views.
- **Cause:** A `place` that depends on `ctx.view` for `purpose: "display"` — display meshes are built once per sub-part and cached across views.
- **Fix:** Make display placement view-independent; only `place(..., { purpose: "export" })` may branch on `view`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "The `PartDefinition` contract".

## wrong-node-version

- **Symptom:** Confusing failures during `npm install`, tests, or CLI runs — WASM load errors, syntax errors in dependencies, or kernels that never boot — on a machine that built fine before.
- **Cause:** The shell's default Node is older than the required Node 24 (`.nvmrc` pins it).
- **Fix:** Run `nvm use` before `npm install`, tests, or any `npx partforge` command. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Quickstart".

## worker-url-not-inline

- **Symptom:** The app loads but geometry never builds — the worker 404s or is missing from the production bundle (works in `npm run dev`, breaks in `npm run build`).
- **Cause:** The `new Worker(new URL(...))` call was moved out of the app entry file (into a helper or variable), so Vite's static analysis can't see and bundle the worker.
- **Fix:** Keep `new Worker(new URL("./<part>-worker.js", import.meta.url), ...)` inline in `src/app-<part>.js`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Wiring a part into a runnable app".

## minwall-sliver-triangles

- **Symptom:** `⚠` minWall warnings from `verify` on a faceted part whose walls are clearly thicker than the profile minimum.
- **Cause:** The ray-shot wall-thickness measurement can catch sliver triangles at facet seams, reading a near-zero "wall" that isn't a designed wall.
- **Fix:** Check where the reported thin spot is: at a facet seam or chamfer transition it's a sliver artifact (minWall is a warning, never a gate — safe to note and move on); along a real wall, thicken the wall. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Self-verification (the `verify` block)".

# Hardware library

Reserved for `hardware-*` patterns (issue #30). No entries yet.
