# Measurement mode — in-scene presentation (v2)

Revision of [2026-08-12-measure-mode-design.md](2026-08-12-measure-mode-design.md).
Live review of the shipped v1 found the screen-space SVG overlay flashing
during interaction and — the structural problem — perceptually disconnected
from the model: 2D dims laid out per frame cannot rotate or foreshorten with
the geometry, so during orbit the drawing "swims" and it stops being obvious
what a measurement measures. A spike (`?dim3spike`) validated the fix:
dimension objects that live IN the three.js scene, riding the parts group.
This spec keeps v1's goals, engines, identity model, chrome, and lifecycle,
and replaces the presentation layer.

**Binding style reference:** the spike as reviewed and approved on
2026-08-13. Its constants are normative and restated in §Visual language.

## What stays (normative sections of v1 carry over unchanged)

- Goals, out-of-scope list, units/precision.
- `feature-dims.js` — untouched. Its 3D anchors in the delivered-geometry
  frame are exactly what the in-scene renderer consumes.
- `pins.js`, `param-link.js` — untouched.
- `selection/feature-highlight.js`, hover suppression, drag-vs-click
  discipline, `raycastViewer` hover pipeline.
- `measure-controls.js` chrome, Escape ordering (escapeScope/escapeGuard),
  `panel/render.js`'s `revealParam` + `.pf-param-flash`.
- Pin semantics: per-view, keyed identity, dormancy, re-anchor on regen.
- Mount wiring shape and the `<button id="measure">` host contract.

## What is replaced

| v1 module | v2 disposition |
|---|---|
| `dim-layout.js` (2D screen layout) | **deleted** → `dim3-place.js` (3D placement, pure) |
| `dim-overlay.js` (SVG renderer) | **deleted** → `dim3-scene.js` (three.js renderer) |
| `capture-overlay.js` + composite API | **deleted** — in-scene dims render into captures natively |
| `measure-mode.js` projection/frameSig/render path | rewritten to drive place → scene; hover/pin/raycast logic kept |
| `.pf-dim-*` SVG CSS | trimmed to what chrome still uses |

The v1 SVG overlay never shipped (PR #120 held), so the public API changes
freely: `runtime.measure` drops `getOverlaySvg`; `inlineOverlayStyles` /
`overlaySvgString` / `compositeOverlay` exports are removed from `src/index.js`
and `types/index.d.ts`.

## Architecture

```
measure-mode.js   Orchestrator (three+DOM). Hover/pin/click/suppression as in
                  v1. On any rebuild trigger: specs → dim3-place → dim3-scene.
dim3-place.js     PURE (three math classes allowed; no DOM/GL/rendering
                  objects). Specs + posed vertex data + camera direction +
                  previous choices → placement: a list of dimension "drawings"
                  (segments, triangles, label quads) in the delivered-geometry
                  frame, plus the per-dim side choice for hysteresis.
dim3-scene.js     three.js renderer. Builds LineSegments2 / triangle meshes /
                  canvas-texture label quads from a placement, parents them in
                  a group under partsGroup, applies theme colors, runs the
                  per-frame label readability flips, raycasts label quads for
                  chip clicks. Text painting isolated behind an injectable
                  painter so tests run without a real 2d canvas.
```

Dims parent into `partsGroup`, so the pivot rotation, per-view recentring,
and pose fast-path all apply for free; all placement math is in the
delivered-geometry frame (mm). Dim materials are **not** registered with the
cutaway (dimensions state facts about the part, not the view — never
sectioned), draw with `depthTest: false`, `transparent: true`, renderOrder
998 (labels 999) so they read over the model, under nothing.

### Rebuild triggers (no per-frame layout — this kills the v1 flashing)

Dimension objects are static scene children. They rebuild only on: mode
entry, geometry regen, view switch, hover change, pin change, theme change,
and a side-selection flip. Per-frame work is limited to: `LineMaterial`
resolution update, label flip corrections (§Text), and the side-selection
dirty check (cheap dot products; flips are rare by hysteresis).

## Placement — `dim3-place.js`

### Coplanarity (the spike's core finding)

Every dimension is a flat drawing in a single plane. A linear dim is defined
by: measurement direction `dir`, in-plane outward direction `ext` (part → dim
line), and plane normal `n = dir × ext`. Extension lines, dim line, arrows,
and text all lie in that plane. Nothing ever leaves the plane; the text angle
never changes relative to the drawing.

### Plane snapping to real geometry

- **Anchor vertices**: for overall extent dims, scan the posed vertex data of
  visible meshes for the vertices realizing the min/max along the measured
  axis (ties within 1e-3 mm break toward the dim line, so a flat base anchors
  on the drawn side).
- **Plane position**: the plane slides along its normal to pass through
  whichever of the two anchor vertices is nearer the reference side of the
  model the dim is drawn toward; the other anchor projects into the plane.
- **Extension-line surface contact**: each extension line starts on the model
  surface, found by an in-plane raycast from the dim-line endpoint toward the
  part, nudged 0.05 mm inside the extreme plane so a grazing ray on the
  extreme face registers; fall back to the projected anchor when the plane
  misses the model. The raycast is injected as `surfaceHit(origin, dir) →
  point|null` (orchestrator builds it on `THREE.Raycaster` over visible
  meshes) so placement stays pure and testable.

### Side selection with hysteresis (new in v2 — the spike's known gap)

Fixed placement puts dims behind/through the model from far azimuths. Each
linear dim generates candidate placements — the four in-plane/outward
combinations around the measured axis (e.g. the width dim can lie in the
floor plane extended toward ±Y, or in a vertical plane extended toward ±Z).
Score candidates by camera facing (plane normal alignment with the view
direction, and outward side toward the camera); the previous choice is kept
unless a challenger beats it by ≥15% (the v1 hysteresis constant). Flips
trigger a rebuild of that dim only.

### Dim kinds

- **Overall W×D×H** (always on): three linear dims on the visible assembly,
  anchored at true extreme vertices as above.
- **Sub-part bbox** (hover, no feature): same anatomy on the sub-part's posed
  bounds.
- **Plane feature** (hover): linear extent dims in the face's own plane,
  using `feature-dims` anchors.
- **Cylinder** (hover): full circle → a diameter dim lying in the fitted
  circle's plane (line through the center, arrows at both rim points, `⌀`
  text outside); partial arc → `R` with a short in-plane leader from the arc
  midpoint. Depth → a linear dim along the fitted axis.

## Visual language (locked by the spike — constants normative)

- **Lines**: `LineSegments2`/`LineMaterial`, linewidth 1.5 px, one shared
  material per theme.
- **Standoff**: dim line offset from the part `max(6, 0.10 × modelSize)` mm.
- **Extension lines**: 1.0 mm gap from the surface-contact point, 1.5 mm
  overshoot past the dim line.
- **Arrowheads**: flat triangles lying in the dim plane, filled (solid),
  narrow: length `0.7 × clamp(0.04 × span, 1.2 mm, 3 mm)`, half-width
  `0.25 × length`. Dim line insets by the arrow length so it never pokes
  through. (Per ISO 129 terminator style is free; consistency is the rule —
  ours is small solid narrow triangles everywhere.)
- **Text**: in-plane quads, canvas-painted mono type with a dark halo
  stroke; quad height `max(3.2, 0.05 × modelSize)` mm; placed **outside**
  the dim line, centered at `0.85 × textHeight` along `ext`, oriented with
  local up pointing back at the line. Vertical dims read bottom-to-top
  (drafting convention).
- **Readability flips**: labels correct among four in-plane states —
  `Ry(π)` when viewed from behind (mirror fix), `Rz(π)` when reading
  right-to-left — chosen per frame with a 0.08 dot-product deadband so
  edge-on angles never flicker.
- **Param-linked labels**: the pill from v1 survives, painted into the
  texture — rounded accent-bordered background with the param name beside
  the value. Linked dims remain the one loud element.
- **Theme**: dim ink and label palette derive from the viewer theme (one
  entry per THEME mode, both verified in light and dark). The viewer exposes
  a theme-change notification (`onThemeChange` or an equivalent hook wired
  through mount) — dims re-color materials and repaint textures on switch.
  Exact hexes are an implementation choice reviewed against both themes.

## Interaction deltas from v1

- **Chips are label quads**: clicking a hovered dim's label (or its
  geometry) pins; clicking a pinned label unpins; a linked dim also fires
  `revealParam`. Hit-testing via the existing raycast (label quads are
  meshes) with the same drag-vs-click threshold.
- **Accepted tradeoff**: label quads are not DOM, so per-chip keyboard
  focus/Enter activation from v1 is dropped in v2. Chrome-level keyboard
  access stays (toggle button, Clear, Escape). Revisit if a11y demand
  materializes — the identity model supports a DOM mirror later.
- **Offscreen pinned edge-chips**: dropped (YAGNI). An offscreen dim is
  simply offscreen; pins persist and return with the camera.
- Everything else (Escape ordering, hover suppression, cutaway coexistence,
  per-view pins, regen dormancy) is v1 verbatim.

## Capture

In-scene dims render wherever the live scene renders — this is Goal 3 with
no compositing step:

- `captureCurrent` (showcase capture): includes dims whenever the mode is on.
  This becomes the documented way to get a dimensioned image.
- `captureCanonicalViews` and `renderMeshPayloads` (thumbnails, agent
  renders): **never** include dims — the dim group is hidden for the
  synchronous capture the same way the grid already is (thumbnails use a
  throwaway scene and are immune by construction).
- `runtime.measure` API: `{ isEnabled, setEnabled, clearPins, pinCount }`.

## Testing

- `dim3-place`: pure tests — plane snap picks the near-side anchor; extreme
  vertex scan with tie-break; surface contact uses the injected `surfaceHit`
  and falls back cleanly; side selection scores + 15% hysteresis (same
  camera → no flip); arrow/text geometry constants; cylinder ⌀ vs R.
- `dim3-scene`: happy-dom tests with an injected fake painter — object
  counts/parenting under partsGroup, renderOrder/depthTest flags, theme
  re-color + repaint, label flip-state transitions fed synthetic camera
  quaternions, dispose releases geometries/materials/textures.
- `measure-mode`: existing suite updated — hover/pin flows now assert against
  the scene group instead of SVG.
- Deleted with their modules: `dim-layout` and `capture-overlay` tests, SVG
  assertions in `dim-overlay` tests.
- Worker layering untouched: `dim3-*` are DOM-side framework modules;
  `feature-dims` remains pure and worker-safe.

## Rollout order

1. `dim3-place.js` pure engine + tests.
2. `dim3-scene.js` renderer + tests (injectable painter).
3. `measure-mode.js` rewrite onto place/scene; delete `dim-layout.js`,
   `dim-overlay.js`, `capture-overlay.js`, their tests, and the main-entry /
   types exports; trim CSS.
4. Viewer theme-change hook + theme palettes; capture exclusion for
   canonical views.
5. Spike removal (`dim3-spike.js`, the `?dim3spike` hook in mount.js).
6. Docs: AUTHORING-PARTS host-wiring notes updated (capture story, API);
   AGENTS.md architecture line updated.

Version stays 0.54.0 — nothing of v1's overlay was ever published.

## Amendments

**2026-08-13 — screen-constant label sizing.** Review on very small parts (the
8 mm demo spacer) showed the mm-based text floor dominating the model when
zoomed in. Labels now DISPLAY at a screen-constant height: one world height
per view, derived from the camera's distance to the model centre so text
renders ≈18 px (`LABEL_SCREEN_PX` in dim3-scene) at any zoom. Uniform per view
by construction — a single reference distance sizes every label, so nearer
labels are not individually normalized; they read slightly larger under
perspective like the rest of the scene. Applied per frame in `dim3-scene`'s
tick as a scale + reposition (the label stays `0.85 × displayHeight` outside
its dim line); placement's `textHeight` constant remains the nominal for
leader lengths and initial quad geometry, and the rebuild-not-per-frame
invariant is untouched.

**2026-08-13 — screen-constant arrowheads and overshoot.** Arrowheads
(`ARROW_SCREEN_PX` = 10, half-width still 0.25 × length) and the
extension-line overshoot past the dim line (`OVERSHOOT_SCREEN_PX` = 7) follow
the same rule, sized off the same per-view reference distance. Placement no
longer carries arrow or overshoot lengths: it emits them as unit decorations
(an arrow is a tip + in-plane basis, a tail an origin + direction) that
`dim3-scene` instances from shared unit geometries and scales each frame. The
dimension line now runs tip to tip — the solid arrowheads draw over it, so no
inset needs recomputing when arrows resize. This supersedes the locked
`arrowLen`/`ARROW_HALF_W`/`OVERSHOOT` mm constants in §Visual language
(`GAP` stays mm-based: it relates to the model surface, not the screen).
