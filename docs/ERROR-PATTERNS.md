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
  partforge should appear verbatim, in a backtick literal **at the start** of its
  pattern's Symptom line. Only that leading literal is what the crash matcher
  matches on — backticks used for prose later in the line never participate, so a
  reworded Symptom must lead with the thrown string, not bury it mid-sentence.
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
- **Fix:** Never reuse a solid after transforming it; take a `.clone()` first when you need the original again. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Geometry: the kernel / `Solid` API" (the `s.clone()` row).

The framework itself rebuilds each sub-part fresh per job and applies `place` once, which avoids the problem — follow the same pattern in your own code.

## probe-routed-to-occt

- **Symptom:** A part builds far slower than expected (preview takes seconds instead of milliseconds), and the worker logs show it running on the `occt` worker.
- **Cause:** The geometry-free probe runs `build` against a recording proxy (dummy query values), and a `fillet`/`chamfer`/`shell` call it reaches — including a branch the real build wouldn't take, since queries return dummies — routes the whole part to OCCT.
- **Fix:** Remove the CAD-only call the probe reaches unnecessarily, or force the backend with `meta.backend: "manifold"` (or `"occt"`). See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Fillet & chamfer (automatic OCCT backend)".

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

## expect-static-across-presets

- **Symptom:** A `verify` exact gate (`holes`, `volume`, …) fails on SOME presets only — e.g. `✗ planter holes 1  (0 != 1)` on two cases while defaults pass — and the preview looks right for every preset.
- **Cause:** `verify` runs `expect` across defaults + every preset, and a preset legitimately changes the asserted fact (an optional feature like a drain/bore toggles the genus), while the expectation is one static value.
- **Fix:** Declare `expect` as a pure function of the case's resolved params — `expect: (p, d) => ({ body: { holes: p.drain > 0 ? 1 : 0 } })` — or restrict `verify.cases`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Self-verification (the `verify` block)".

## param-key-missing-from-defaults

- **Symptom:** The affected control's number box renders empty/blank (internally `numStr(undefined)` produces the string `NaN`, which a number input sanitizes to empty), or its range slider sits at a browser-default position and edits don't drive the geometry — no error is thrown — and if the key is `hidden`, no control is rendered for it at all.
- **Cause:** A `key` used in the `parameters` schema (slider, feature, or preset override) doesn't exist in `defaults` — every key must, including `hidden` ones.
- **Fix:** Add the key to `defaults` with a sensible starting value. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Parameters: the control-panel schema".

## dimmed-control-vestigial-param

- **Symptom:** A control renders dimmed (but still editable) and changing it does nothing on screen.
- **Cause:** No sub-part visible in the active view reads that parameter — the relevance-aware panel dims controls with no on-screen effect.
- **Fix:** This is a signal, not a bug: either the parameter is vestigial (delete it), the control is in the wrong section/view scope, or you're in a view that legitimately doesn't use it. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "The relevance-aware panel".

## linked-checkout-wasm-403

- **Symptom:** In a consuming app using an `npm link`ed partforge checkout, the kernel never boots and the dev-server network tab shows `403` on the Manifold/OCCT `.wasm` files.
- **Cause:** The linked checkout lives outside the app's project root, so Vite's dev server refuses to serve its files.
- **Fix:** Allow-list it: `server: { fs: { allow: ["./", "../partforge"] } }` in the app's `vite.config.js`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Developing against a local (linked) partforge".

## ring-sector-full-circle

- **Symptom:** `ringSectorPolygon: arcDeg must be < 360 (use a cut for a full ring)`
- **Cause:** A full annulus can't be a single simple polygon — it's a contour-with-hole.
- **Fix:** Cut an inner cylinder from an outer one (or `k.extrude({ outer, holes })`); use `ringSectorPolygon` only for partial arcs. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Profiles & patterns".

## occt-closed-loop-unsupported

- **Symptom:** `loft: closed:true loops are only supported on the Manifold backend` (or the same message from `sweep:`) — typically during STEP export of a part that previews fine.
- **Cause:** Capless closed loops are a Manifold-only capability; the OCCT backend rejects them, and STEP export always runs on OCCT.
- **Fix:** Keep the part on Manifold (no STEP) or model the loop as a capped solid both backends support. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Geometry: the kernel / `Solid` API".

## smooth-geometry-faceted-preview

- **Symptom:** A `ruled:false` loft or `smooth:true` sweep looks faceted/straight-walled in the viewer even though the options are set.
- **Cause:** Smooth blending is OCCT-native; the Manifold preview always tessellates ruled straight walls — only STEP export carries the smooth surface.
- **Fix:** Nothing is wrong — verify smoothness in the exported STEP, not the preview. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Geometry: the kernel / `Solid` API".

## scale-moved-the-part

- **Symptom:** After `s.scale(f)` a part is resized but also relocated — features drift away from where they were built.
- **Cause:** `scale(factor, center?)` defaults its center to the origin, so scaling an off-origin solid about the origin also translates it.
- **Fix:** Pass the center you mean, e.g. `s.scale(f, s.boundingBox().center)` to resize in place. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Geometry: the kernel / `Solid` API".

## occt-holes-watertight-na

- **Symptom:** `watertight n/a` in `partforge measure` output, and `holes`/`watertight` assertions in a `verify` block don't run, on a part with fillets/chamfers.
- **Cause:** `holes` and `watertight` are Manifold-only topology facts, and this part auto-routed to OCCT — the assertions skip rather than fail.
- **Fix:** Expected behavior: assert on backend-independent facts (`bbox`, `volume`, `overlaps`) for OCCT parts, or split topology assertions into a Manifold-buildable configuration. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Self-verification (the `verify` block)".

## html-page-missing-in-prod

- **Symptom:** A part's page 404s in the production deploy while working fine under `npm run dev`.
- **Cause:** Only pages listed in `build.rollupOptions.input` are compiled by the production build; other root `*.html` pages are dev-only conveniences Vite serves without building.
- **Fix:** Add the page to `build.rollupOptions.input` in `vite.config.js` if it should ship. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Wiring a part into a runnable app".

# Hardware library

Reserved for `hardware-*` patterns (issue #30). No entries yet.
