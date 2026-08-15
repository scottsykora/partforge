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

The framework itself rebuilds each sub-part fresh per job and applies `place` once, which avoids the problem — follow the same pattern in your own code. (Since the OCCT solid cache landed, the in-repo backend clones internally before every consuming replicad call, so wrapped `Solid`s effectively have value semantics and this crash should no longer reproduce through the kernel API — but the portable rule stands: per KERNEL-CONTRACT.md a backend MAY consume, so a part must still not rely on reuse.)

## probe-routed-to-occt

- **Symptom:** A part builds far slower than expected (preview takes seconds instead of milliseconds), and the worker logs show it running on the `occt` worker.
- **Cause:** The geometry-free probe runs `build` against a recording proxy (dummy query values), and a **Solid** `fillet`/`chamfer`/`shell` call it reaches — including a branch the real build wouldn't take, since queries return dummies — routes the whole part to OCCT. (`Shape2D.fillet`/`.chamfer` are the shared pure-JS implementation and do **not** route; the probe tracks which handle kind an op ran on.)
- **Fix:** Remove the CAD-only call the probe reaches unnecessarily, or force the backend with `meta.backend: "manifold"` (or `"occt"`). If the rounding is on a 2-D profile, `Shape2D.fillet` before extruding keeps the part on Manifold. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Fillet & chamfer (automatic OCCT backend)".

## fillet-chamfer-many-edges-slow

- **Symptom:** A part that fillets or chamfers the rim of an extruded profile (a gear, a star, any many-point polygon) takes many seconds — even tens of seconds — per build, with no error anywhere.
- **Cause:** OCCT fillet/chamfer cost scales with the number of selected edges, and an `inPlane` rim selector on a many-point extruded profile selects every polygon edge (hundreds for a gear), so one op call costs seconds — and re-runs on every parameter change.
- **Fix:** Use `extrude`'s `bevel` option instead of `chamfer` — same geometry, stays on the fast Manifold backend. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Beveling profile rims: extrude's bevel option".

## chamfer-rescue-bisection

- **Symptom:** `partforge: chamfer` warning saying the distance `over-ran the geometry — reduced to` a smaller one (or `has no valid distance`), with an attempt count and elapsed seconds, alongside slow builds.
- **Cause:** The requested chamfer distance doesn't fit the geometry (it over-runs an adjacent face or a short edge), so the failure-rescue bisection in `occt-repair.js` re-runs the full chamfer up to 7 more times to find the largest valid distance — multiplying an already-expensive op by ~8× on every build, since the result is only cached per exact input hash.
- **Fix:** Lower the chamfer parameter to at most the printed valid distance (the rescue then never fires), clamp it in `build` from the geometry that limits it, or — for extruded profile rims — switch to `extrude`'s `bevel` option, which finds its own limit in pure JS. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Beveling profile rims: extrude's bevel option".

Variant literals under this entry: `partforge: chamfer <d> over-ran the geometry — reduced to <d'> (largest valid; <n> attempts, <t>s — see ERROR-PATTERNS.md#chamfer-rescue-bisection)`, `partforge: chamfer <d> has no valid distance for this geometry — feature skipped (<n> attempts, <t>s — see ERROR-PATTERNS.md#chamfer-rescue-bisection)`.

## extrude-bevel-invalid

- **Symptom:** `extrude: bevel must fit the height (bottom + top < h)` or `extrude: bevel cannot combine with twist or scaleTop` thrown from a build.
- **Cause:** `extrude`'s `bevel` option desugars into offset-loft envelopes, which need an untwisted straight extrusion and room for both bevels inside the height.
- **Fix:** Clamp the bevel from the height parameter (e.g. `Math.min(c, h / 2 - 0.2)`) and drop `twist`/`scaleTop`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Beveling profile rims: extrude's bevel option".

Variant literals under this entry: `extrude: unknown bevel option`, `extrude: bevel must be a number or { bottom?, top? }`, `extrude: bevel distances must be finite numbers >= 0`.

## extrude-bevel-reduced

- **Symptom:** `partforge: extrude bevel` warning saying the requested distance `exceeds what the profile can take — reduced to` a smaller one (or `has no valid offset for this profile — rim left square`; `hole` in place of `profile` when a hole's flare is the limit).
- **Cause:** Offsetting the rim by the bevel distance would pinch a narrow feature (a tooth land, a thin bar, a thin web beside a hole) shut, so the bevel deterministically backs off to the largest offset the outline can take — the same geometric limit OCCT's chamfer hits, resolved in pure JS instead of kernel re-runs.
- **Fix:** Usually nothing — the reduced bevel is the correct maximum for the geometry. To silence it, clamp the bevel parameter below the printed value or widen the narrow feature.

## roundedbox-rim-clamped

- **Symptom:** `roundedBox: round.top <n> clamped to round.side <m> (side must be 0 or ≥ rim radii; use side: 0 for a rim-only round-over)` in the console, and the built rim round-over is smaller than the `round.top`/`round.bottom` you passed.
- **Cause:** the middle regime `0 < side < rim` has no closed-form corner shared by both backends, so the rim radii clamp down to `side` (the footprint-defining radius never grows silently).
- **Fix:** either raise `round.side` to ≥ the rim radii (torus/sphere corners), or set `side: 0` exactly for a full-size rim-only round-over on sharp vertical edges.

## roundedbox-strict-h

- **Symptom:** `roundedBox: with round.side > 0, round.top + round.bottom must be < h (the rim fillets would meet tangentially; reduce the rim radii slightly, or use side: 0 for a sharp-sided full-height round-over)` thrown from a build.
- **Cause:** with `round.side > 0`, the top and bottom rim fillets are separate features that need a straight wall band between them; `top + bottom == h` (or greater) leaves no band, so the fillets would meet tangentially — which the B-rep backend cannot build.
- **Fix:** reduce `round.top`/`round.bottom` slightly so their sum is strictly less than `h`, or set `round.side: 0` for a sharp-sided full-height round-over. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § roundedBox row.

## roundedbox-fillet-skipped

- **Symptom:** `partforge: fillet(<r>) produced invalid geometry — feature skipped` (or `… produced an empty solid — feature skipped`) in the console during a `roundedBox` build, and the OCCT-exported rim is sharp where a round-over was requested.
- **Cause:** OCCT's native fillet cannot build the rim round-over at a degenerate boundary (e.g. a rim radius exactly equal to `round.side` on a stadium profile, `2·side == min(w, d)`) and would otherwise return invalid-but-nonempty geometry; the monotonicity/validity gate in `occt-repair.js`'s `safeOp` catches it and skips the feature rather than exporting invalid STEP.
- **Fix:** shrink the affected rim radius slightly below `round.side` (or below the degenerate boundary), or accept the sharp rim at that exact radius.

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

## place-not-rigid

- **Symptom:** The exported/printed part is a mirror image of — or a different size than — the same part shown in the assembly/display view. Nothing throws: the preview looks right and only the STL/STEP is wrong, or vice-versa.
- **Cause:** A `place` whose `purpose: "display"` and `"export"` branches differ by a non-rigid transform — `mirror` (flips handedness) or a non-identity `scale` (changes size) — so display and export are no longer the same solid, only its reflection/resize.
- **Fix:** Keep the display-vs-export `place` difference a rigid motion (`translate`/`rotate`/`rotateAbout`/`along`/`at`) only. If the part genuinely needs a reflected or resized form, bake that into `build` so both purposes share one canonical solid and pose it rigidly. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "The `PartDefinition` contract".

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

## near-miss-gap

- **Symptom:** A `⚠ … nearMiss` warning or `✗ … contact` failure from `verify` reporting sub-parts `N mm apart, expected touching`, or a `near-misses:` line in `measure` output for parts that look joined in the preview.
- **Cause:** Two sub-parts that should meet don't quite — a boss shorter than the gap it must bridge, a mis-placed mating datum in `derive()`, or a union that silently missed. Renders and volume/bbox checks cannot see sub-mm joint gaps; this check exists precisely for them.
- **Fix:** If the pair should touch, grow the joining feature or fix the datum math so the faces meet, then declare the pair in `verify.expect._view.contacts`; if a free fit is intended, declare it under `clearance`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Self-verification (the `verify` block)".

## expect-static-across-presets

- **Symptom:** A `verify` exact gate (`holes`, `volume`, …) fails on SOME presets only — e.g. `✗ planter holes 1  (0 != 1)` on two cases while defaults pass — and the preview looks right for every preset.
- **Cause:** `verify` runs `expect` across defaults + every preset, and a preset legitimately changes the asserted fact (an optional feature like a drain/bore toggles the genus), while the expectation is one static value.
- **Fix:** Declare `expect` as a pure function of the case's resolved params — `expect: (p, d) => ({ body: { holes: p.drain > 0 ? 1 : 0 } })` — or restrict `verify.cases`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Self-verification (the `verify` block)".

## param-key-missing-from-defaults

- **Symptom:** The affected control's number box renders empty/blank (internally `numStr(undefined)` produces the string `NaN`, which a number input sanitizes to empty), or its range slider sits at a browser-default position and edits don't drive the geometry — no error is thrown — and if the key is `hidden`, no control is rendered for it at all.
- **Cause:** A `key` used in the `parameters` schema (slider, feature, or preset override) doesn't exist in `defaults` — every key must, including `hidden` ones.
- **Fix:** Add the key to `defaults` with a sensible starting value. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Parameters: the control-panel schema".

## features-missing-sliders

- **Symptom:** `Cannot read properties of undefined (reading 'filter')` thrown from the control panel while the app boots, with no geometry ever rendering.
- **Cause:** A `features` entry in the parameter schema has no `sliders` array — `controls.js` reads `feat.sliders.filter(...)` unguarded. A bare on/off control was put in `features` instead of `toggles`.
- **Fix:** Move a bare boolean to the section's `toggles` array (`{ key, label, on }`), or give the `features` entry the `sliders` array it requires. `npx partforge lint <part>` catches this statically as `features-requires-sliders`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Parameters: the control-panel schema".

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
- **Fix:** Cut an inner cylinder from an outer one (or `k.extrude({ profile: { outer, holes }, h })`); use `ringSectorPolygon` only for partial arcs. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Profiles & patterns".

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

## cutaway-capture-hatch-flood

- **Symptom:** With cutaway enabled, a `captureCurrent`/`captureViews` image comes back with section hatch flooding a whole quad and burying the part, while the live viewer looks correct; a consumer may instead report the capture being rejected as too large, because full-frame hatch is worst-case JPEG content.
- **Cause:** Cutaway masks its section caps with the stencil buffer, and a `THREE.WebGLRenderTarget` has none unless it asks for one — so the mask no-ops in offscreen renders even though the visible canvas (created with `stencil: true`) is fine.
- **Fix:** Allocate offscreen render targets with `stencilBuffer: true` (`renderOffscreen` in `src/framework/viewer.js`); `scripts/check-app.mjs` measures hatch coverage in a real-GL capture to keep it that way.

## options-unknown-key

- **Symptom:** `unknown option` — e.g. `cylinder: unknown option "radius" — did you mean r?`
- **Cause:** an options-form kernel call passed a key the op does not accept (typo, or long-form vocabulary like `radius`/`height`).
- **Fix:** use the canonical keys from the op table in [AUTHORING-PARTS.md](AUTHORING-PARTS.md); the error's did-you-mean / valid-keys hint names them.

## options-missing-key

- **Symptom:** `is required` — e.g. `cylinder: h is required`, `sweep: path is required`.
- **Cause:** an options-form kernel call omitted a required key.
- **Fix:** supply the key; canonical forms are in the [AUTHORING-PARTS.md](AUTHORING-PARTS.md) op table and KERNEL-CONTRACT.md "Calling convention".

## cylinder-radius-keys

- **Symptom:** `cylinder: pass exactly one of r/d, or r1+r2 / d1+d2`
- **Cause:** mixed or missing radius vocabulary — both `r` and `d`, straight + cone keys together, only one cone end, or `r1`+`d2`.
- **Fix:** straight cylinders take one of `r`|`d` plus `h`; cones take `r1`+`r2` or `d1`+`d2` plus `h`.

The sphere variant is `sphere: pass exactly one of r/d` (same cause and fix).

## box-size-vs-corners

- **Symptom:** `box: pass size or min+max, not both`
- **Cause:** the two `box` forms were mixed in one call.
- **Fix:** either `{size, center?}` (centered in X/Y, base at z=0; `center:true` centers Z too) or `{min, max}` — see [AUTHORING-PARTS.md](AUTHORING-PARTS.md).

## box-center-with-corners

- **Symptom:** `box: center only applies to the size form`
- **Cause:** `center` was passed alongside `min`/`max`, but explicit corners already fix the placement.
- **Fix:** drop `center`, or switch to `{size, center?}` — see [AUTHORING-PARTS.md](AUTHORING-PARTS.md).

## offset-polygon-bad-input

- **Symptom:** `offsetPolygon: need at least 3 points`
- **Cause:** malformed input to `offsetPolygon` — too few points after dedup, or (variant messages) a non-finite `delta`, non-finite coordinates, an unknown `corners` style, or a profile that is neither a point list nor `{outer, holes}`.
- **Fix:** pass a CCW `[[x,y],…]` list (≥ 3 distinct points) or `{outer, holes}`, a finite `delta` in mm, and `corners: "round" | "chamfer" | "sharp"` — see [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Profiles & patterns".

Variant literals under this entry: `offsetPolygon: delta must be a finite number`, `offsetPolygon: coordinates must be finite numbers`, `offsetPolygon: corners must be "round" | "chamfer" | "sharp"`, `offsetPolygon: profile must be a point list or {outer, holes}`.

## offset-polygon-input-self-intersects

- **Symptom:** `offsetPolygon: input polygon self-intersects`
- **Cause:** the input contour crosses itself — the profile is broken before any offsetting happens (checked up front so bad input is not blamed on the offset).
- **Fix:** repair the generating math for the contour; the offset envelope requires simple polygons in and out.

## offset-polygon-collapse

- **Symptom:** `offsetPolygon: offset collapses the polygon`
- **Cause:** the offset consumed the shape — either an inset ate the whole polygon (result area ≤ 0 or fewer than 3 points, `|delta|` past the narrowest half-width; also thrown for a region hole that would vanish), or an offset displaced an edge past its own length so the edge inverts (a large inset, or a large *outset* of a concave profile where `|delta|` exceeds a reflex-adjacent edge — this last case can also depend on `corners`, since `"sharp"` extends edges further than `"round"`/`"chamfer"`).
- **Fix:** reduce `|delta|`, or clamp it from the shape's dimensions before offsetting (see planter.js's wall cap). If a vanishing hole is intended, remove the hole from the region explicitly. Realistic clearances (fractions of a mm) on any profile, and wall insets up to the narrowest feature, never trip this.

## offset-polygon-result-self-intersects

- **Symptom:** `offsetPolygon: offset result self-intersects (reduce |delta| or simplify the profile)`
- **Cause:** the true offset of this shape at this `|delta|` is not a single simple polygon (e.g. insetting a dumbbell past its waist would split it in two) — out of `offsetPolygon`'s envelope.
- **Fix:** reduce `|delta|`, or decompose the profile into separately-offset simple contours.

## cubic-segment-mixes-arc-and-cubic

- **Symptom:** `extrude: <role> segment cannot mix arc (via) and cubic (c1/c2)`
- **Cause:** A path-contour segment carries both `via` (three-point arc) and `c1`/`c2` (cubic Bézier). A segment is exactly one kind.
- **Fix:** Drop `via` for a cubic, or drop `c1`/`c2` for an arc. Use `pathProfile().arcTo(to, via)` or `.cubicTo(to, c1, c2)` to build segments.

## cubic-segment-missing-controls

- **Symptom:** `extrude: <role> cubic segment needs c1 and c2 as finite [x,y]`
- **Cause:** A cubic segment is missing `c1` or `c2`, or a control point is not a finite `[x,y]` (e.g. `NaN`, wrong length).
- **Fix:** Provide both control points as finite `[x,y]`. A cubic Bézier needs two controls between the previous point and `to`.

## shape2d-simple-not-single-region

- **Symptom:** `Shape2D.simple: result has N regions, not 1 (use toRegions())`
- **Cause:** `.simple()` was called on a boolean result that is empty or split into multiple disjoint regions (e.g. `intersect` of disjoint shapes, or a `cut` that severs a shape in two).
- **Fix:** Use `.toRegions()` to get the array, or adjust the operands so the result is a single connected region. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "2-D booleans".

## shape2d-offset-collapses

- **Symptom:** `Shape2D.offset: offset collapses the shape (reduce |delta|)`
- **Cause:** A negative (inset) `offset` removed more than the shape's half-width,
  leaving no geometry — or the delta is larger than the feature it offsets.
- **Fix:** Reduce `|delta|`, or check the source profile is large enough for the
  inset. Realistic clearances (fractions of a mm) and wall insets up to the
  narrowest feature never trip this.

## shape2d-offset-partial-reflection-residual

- **Symptom:** An outward `Shape2D.offset` on a region with a hole leaves a leftover
  hole ring behind (`.holes.length` stays > 0, `.area()` under-reports) even though
  the hole's narrowest span is smaller than `delta` and the pocket should have
  closed completely.
- **Cause:** A raw offset ring can be locally valid — correctly wound (CW for a
  hole), no self-intersections — while still lying inside the region it should have
  been swept away by. That's a *global* defect only a whole-shape containment check
  can see, and `offset`'s validator (`contour-offset.js`'s `validateRawOffset`)
  only checks local validity. Known limitation — see
  [KERNEL-CONTRACT.md "Offset: known limitations"](KERNEL-CONTRACT.md#offset-known-limitations).
- **Fix:** No general fix yet. Verify `.holes.length` after an offset meant to
  close a pocket rather than assuming it did; work around by offsetting in stages
  or padding the pocket before offsetting.

## shape2d-offset-kissing-ring-passes-validation

- **Symptom:** Two rings produced by the same `Shape2D.offset` call (two eroding
  holes, or a hole and the outer) end up exactly touching or collinearly
  overlapping along an edge, but the offset does not throw and does not merge
  them — the result comes back with the rings still separate and overlapping.
- **Cause:** The offset validator's strict-crossing test (`segsCross` in
  `contour-offset.js`) is deliberately transversal-only — it ignores collinear
  touches (a duplicate/overlapping edge, no true crossing point) — because that
  shape also occurs legitimately, as the zero-width slit left by a neck pinched
  shut by the offset. The validator can't tell "duplicate edge that's actually
  fine" from "duplicate edge that means two rings should have merged"; only the
  specific pinched-neck case is recovered (`splitAtDuplicateEdges`), not the
  general kissing-ring case between two different rings. Known limitation — see
  [KERNEL-CONTRACT.md "Offset: known limitations"](KERNEL-CONTRACT.md#offset-known-limitations).
- **Fix:** No general fix yet. After an inward offset expected to merge nearby
  features, check the result's ring count and containment explicitly rather than
  trusting `offset` merged them; work around by unioning the source features (or
  their pre-offset pockets) before offsetting.

## fillet-chamfer-radius-does-not-fit

- **Symptom:** `filletProfile: corner <i> at (<x>, <y>): r=<r> does not fit; max ≈ <m>` (or `chamferProfile: … dist=<d> does not fit; max ≈ <m>`) thrown from `Shape2D.fillet`/`.chamfer` or the free `filletProfile`/`chamferProfile` functions.
- **Cause:** The requested radius/distance exceeds what the corner's adjacent edges (or curved neighbor) can hold before the tangent point runs past the segment's own end.
- **Fix:** Use the reported `max ≈` value, or narrow `opts.corners` to skip that corner. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Editing profiles".

Variant literal for a curve-adjacent corner (note the semicolon form, not parenthesized): `filletProfile: corner <i> at (<x>, <y>): could not fit r=<r> against the curved segment; max ≈ <m>` (`chamferProfile: … could not fit dist=<d> against the curved segment; max ≈ <m>` for chamfer).

## fillet-chamfer-corners-overlap

- **Symptom:** `filletProfile: corners <i> and <j> overlap on segment <k> (reduce r)` (or the same from `chamferProfile`).
- **Cause:** Two adjacent selected corners each claim more of the edge between them than it has — their combined setbacks exceed the segment's length (or curved arc-length span).
- **Fix:** Reduce `r`/`dist`, or fillet/chamfer only one of the two corners (drop the other from `opts.corners`). See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Editing profiles".

## profile-query-needs-single-contour

- **Symptom:** `profilePointAt: pass a single contour (use region.outer / region.holes[i])` (same shape from `profileLength`/`profileTangentAt`, with their own name in place of `profilePointAt`).
- **Cause:** The arc-length queries (`profileLength`, `profilePointAt`, `profileTangentAt`) are single-contour by nature, and a `{outer, holes}` region or region array was passed instead of a specific contour.
- **Fix:** Pass `region.outer` or `region.holes[i]`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Editing profiles" polymorphic input contract.

## validate-profile-regions-overlap-or-nest

- **Symptom:** `regions overlap or nest — merge with union() or make it a hole` in a `validateProfile(...).issues` entry (`type: "nesting"`) — reported, never thrown.
- **Cause:** Two regions in the profile occupy overlapping area without one being declared a hole of the other.
- **Fix:** Union the two regions into one shape, or restructure the overlapping region as a `holes` entry of its container. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Editing profiles" — run `validateProfile` after mutations.

## curve-fill-resolved-hole-uncontained

- **Symptom:** `curve-fill: resolved hole has no containing outer`
- **Cause:** paper.js returned an unexpected or numerically degenerate path topology for the supplied font outline; the resolver refuses to attach the hole to an arbitrary outer.
- **Fix:** reduce or normalize degenerate font contours, confirm the correct CFF/TrueType fill rule was selected, and add the glyph as a focused `curve-fill.test.js` regression before changing resolver tolerances.

## animation-plays-choppy

- **Symptom:** An animation stutters or updates a few times a second instead of smoothly; `?debug` shows `rebuilt` counts climbing during playback.
- **Cause:** A track drives a param that feeds real geometry (or a build the pose probe can't trust — a query op or function selector), so every frame is a worker rebuild instead of a pose repair.
- **Fix:** Run `npx partforge lint <part>` — the `animation-track-rebuilds` note names the track. Restructure so the param only feeds rigid placement (`place()` or a trailing translate/rotate in `build`), or accept best-effort playback if geometry morphing is the intent. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Animations".

## phantom-edges-on-curved-surface

- **Symptom:** edge lines or hard-shaded patches appear scattered on a smooth
  curved surface (a sphere, fillet, or blend) in the viewer or in `render` PNGs.
- **Cause:** the mesh reached the viewer without kernel `normals`/`edges`, so a
  consumer fell back to dihedral-angle guessing on coarse preview tessellation.
- **Fix:** the backend's `toMesh` must return analytic normals and filtered
  feature edges ([KERNEL-CONTRACT.md](KERNEL-CONTRACT.md) "Shading intent") —
  fix the backend or payload plumbing; do not tune viewer angle thresholds.

## faceted-loft-previews-smooth

- **Symptom:** an intentionally faceted loft (low-side-count rings) previews
  smooth-shaded, but exports/prints show flat facets.
- **Cause:** the loft's shading policy resolved to smooth — a `shading:
  "smooth"` hint, `ruled: false`, or rings with 32+ sides.
- **Fix:** pass `shading: "faceted"` to `k.loft` (or drop the smooth-implying
  option) per [AUTHORING-PARTS.md](AUTHORING-PARTS.md) shading-intent note.

## duplicate-preset-name-throws

- **Symptom:** `duplicate preset name across sections:` thrown from verify/measure, naming the repeated preset (e.g. `duplicate preset name across sections: "Compact"`).
- **Cause:** The same preset name is declared twice — once via the legacy `presets` field, once as a `{ type: "preset" }` node, or twice within either.
- **Fix:** Rename one of them; `npx partforge lint` reports it statically as `duplicate-preset-name` before verify ever runs. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Rule catalog".

## when-condition-never-true

- **Symptom:** A control, group, preset, readout, or section with a `when` condition never appears, with no error anywhere.
- **Cause:** The condition references a key `defaults` doesn't declare (reads `undefined`, which every comparison treats as false) or a typo'd operator (`evalWhen` treats an unrecognized operator as false too).
- **Fix:** Run `npx partforge lint` — `when-key-not-in-defaults` or `when-unknown-operator` names the offending key or operator. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Rule catalog".

## readout-shows-em-dash

- **Symptom:** A `{ type: "readout" }` control renders "—" forever, no matter what the other controls are set to.
- **Cause:** The readout's `derivedKey` names a key that no `derive()` group actually produces.
- **Fix:** Name a key a `derive` group returns, or add that key to `derive`; `npx partforge lint` warns via `readout-unknown-derived-key`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Rule catalog".

## select-default-unreachable

- **Symptom:** The panel opens showing a `select`/`radio` value the control can never be set back to by interacting with it.
- **Cause:** `defaults[key]` is not among the control's `options` values — often a value-type mismatch (`12` is not `"12"`).
- **Fix:** Add the default to `options`, or change the default to one of the existing options; `npx partforge lint` errors via `select-default-not-in-options`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Rule catalog".

## screw-thread-vanishes-on-occt

- **Symptom:** a threaded part previews correctly but its STEP export is a plain
  cylinder, or a valid-looking but implausibly small STEP file (~2 KB, a few
  dozen entities, where a real thread is megabytes) that opens with no solid
  geometry; on the OCCT backend the union of a thread with a core returns
  exactly the core's volume, or `0`, with no error thrown.
- **Cause:** the thread was built as a thin sub-pitch helical sliver and unioned
  onto a core. OCCT's boolean fails on a near-self-touching swept operand and
  silently returns the other operand — or nothing — rather than throwing.
- **Fix:** build the thread in the **periodic** form instead — a profile spanning
  exactly one `pitch` with equal first and last radius encloses the axis, so
  `k.screwSweep` yields the whole threaded body with no boolean at all. See
  [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Helical & threaded features".

The hazard is specific to that sliver-riding-a-core shape, not to unions
involving screw geometry in general: a filled periodic `screwSweep` rod
unioned with an unrelated solid — a bolt head, say — booleans correctly. A
measured rod (585.545) unioned with a head (804.248) returned 1324.732 —
inside the geometrically expected range, not the bare-rod or empty-solid
signature above. It's the thin near-self-touching sliver that OCCT's boolean
mishandles, not screw geometry as such.

## occt-bbox-too-large-on-twist

- **Symptom:** `solid.boundingBox()` inside a `build()` reports a solid far larger
  than it is — on a twisted solid (`extrude`/`prism` with `twist`, or
  `k.screwSweep`) whose true max radius is 5, OCCT reports **7.209** where
  Manifold reports **5.000** — so anything placed off that query lands ~44% too
  far out in the STEP export while the preview looks right. The axial extent is
  exact; it is the twisted directions that inflate.
- **Cause:** OCCT derives the bounding box of a twisted B-spline surface from its
  **control hull**, not from the surface. The control points of a twisted section
  bow outward, so the box is a valid outer bound but a loose one. Volume and the
  meshed surface are exact; only the bbox query is loose.
- **Fix:** don't place geometry off `solid.boundingBox()` on a twisted solid —
  compute the extent from the parameters that built it (they are right there in
  `p`/`d`), or bound the twisted part with an untwisted proxy solid.

**The `measure` / `verify` gate is not affected**: `src/framework/oracle/measure.js`
takes its bbox from `bounds(mesh.positions)` — the meshed surface — never from
`solid.boundingBox()`, so `bbox` assertions read 5.000 on both backends. The
exposure is a `build()` that queries a twisted solid's box itself, which is the
normal idiom for placing something relative to a solid and now silently disagrees
between the Manifold preview and the OCCT STEP export.

# Hardware library

Reserved for `hardware-*` patterns (issue #30). No entries yet.
