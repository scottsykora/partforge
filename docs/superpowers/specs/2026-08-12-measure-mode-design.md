# Measurement mode — design

A ruler toggle in the viewbar (next to cutaway) that turns the viewer into a
live engineering drawing: always-on overall dimensions, hover a feature to read
its own dimensions, click to pin a dimension that survives regenerates and
updates as parameters change. Pinned dimensions that correspond to a rail
control link back to it — click the dimension, the slider lights up and takes
keyboard focus.

## Goals

Three jobs, in priority order:

1. **Live parametric readout** — pins persist across slider drags and
   regenerates, re-anchored by stable identity, so you can watch "does raising
   wall thickness actually give me 3 mm here?" while dragging.
2. **Static verification** — overall bounds always on in the mode; hover any
   feature or sub-part for its dimensions. Zero-click at its core.
3. **Communication** — an in-browser capture can composite the overlay into a
   dimensioned image. The headless CLI render path is untouched.

Out of scope for v1 (explicitly deferred):

- **Agent-facing measurement** (pick-serve-style flows).
- **Two-pick point-to-point caliper** and **wall-thickness probe**.
- **True edge measurement** (hover near a feature edge → its length /
  circumference). v1.1; structured so it slots in without touching the rest.
- **Touch feature-hover** — on touch-only devices v1 shows always-on dims only
  (consistent with hover.js's existing skip). Tap-to-measure is a v1.1
  question.
- **Narrow-layout param reveal** — below `RAIL_NARROW_BREAKPOINT` the rail is a
  separate pane; dimension→control reveal is a no-op there in v1.
- **CLI `render --measurements`** — would make the layout engine a second,
  Node-side consumer; not now.

Units are millimetres, displayed at 0.01 precision (the `q2` quantum from
`selection/resolve.js`).

## Architecture

Screen-space SVG overlay + pure dimension engine (chosen over in-scene three.js
dimension objects: crisp text at any DPR, CSS theming for free, DOM
hit-testing for pins, and the hard logic lands in pure Node-testable modules.
Engineering drawings are a 2D screen-space idiom; capture pays one compositing
step, and dims drawing over the model is drafting convention anyway).

### Modules — `src/framework/measure/`

```
measure-controls.js   DOM chrome: ruler button + contextual actions ("Clear",
                      "mm" unit tag), aria/tooltip/Escape/detach — a direct
                      sibling of cutaway-controls.js, same restore discipline.
measure-mode.js       Orchestrator. Mode on/off; drives raycast hit → spec →
                      layout → overlay. Subscribes to camera/frame changes and
                      geometry swaps. The only module here touching both
                      three.js and DOM.
feature-dims.js       PURE. Feature triangle subset → MeasureSpec (cylinder /
                      plane / bbox). Also sub-part → W×D×H and visible
                      assembly → overall spec. Typed arrays in, data out; no
                      three.js (oracle/mesh.js discipline).
dim-layout.js         PURE. Specs + project(point3)→{x,y,behind} + viewport +
                      previous layout → 2D drawing primitives with collision
                      avoidance and hysteresis.
pins.js               PURE. Pin store keyed (view, subPart, featureLabel|null,
                      occurrenceIndex); re-anchor against fresh geometry;
                      dormancy for vanished labels.
param-link.js         PURE. (part, view, params, subPart, spec) → the param
                      key driving a measured value, or null.
capture-overlay.js    compositeOverlay(frameDataUrl, svgString, viewport) →
                      Promise<dataUrl>.
dim-overlay.js        Thin SVG renderer: primitives → a full-viewport <svg>;
                      all styling via CSS classes; owns chip hit-testing.
```

Plus one targeted refactor outside the directory:
`selection/feature-highlight.js` — the overlay-mesh + subset-cache piece
extracted from `selection/hover.js`, consumed by both hover.js and
measure-mode, so there is one highlight implementation and one subset cache.
`attachHoverLabels` also gains `setSuppressed(bool)` (same idea as its
existing cutaway-handle suppression) so measure mode can take over the
pointer.

### Wiring

- Hosts add `<button id="measure">` to the viewbar (all example pages get it);
  optional-per-host exactly like cutaway — absent button, no-op chrome.
- `mount.js` resolves `els.chrome.measure` like the others and mounts
  `attachMeasureControls(viewer, { measure }, { tooltip, part, hover,
  revealParam })` after the cutaway chrome.
- `panel/render.js`'s `buildControls` grows `revealParam(key)`: expand the
  containing collapsed section/fold, `scrollIntoView`, focus the widget's
  primary input, apply a transient `.pf-param-flash` class.

### Data flow

- **Mode on** → overlay mounts; overall + per-sub-part specs computed from
  current meshes; always-on dims fade in.
- **Pointer move** → existing `raycastViewer` → `feature-dims` → hover spec →
  layout → overlay.
- **Click on hit** → `pins.toggle()`; if the spec has a `paramLink`, also
  `revealParam`.
- **Geometry swap** (regen) → pins re-resolve by label; specs recompute;
  re-layout.
- **Pose change** (fast path, animation) → nothing recomputes but projection:
  anchors are stored in the delivered geometry's frame and projected through
  `mesh.matrixWorld` each layout pass, so dims ride poses for free. The
  overall-bbox spec recomputes from posed bounds the way `frameTo` does.
- **Camera move** → re-project + re-layout only, via `viewer.onFrame` with a
  dirty check.

## The dimension engine — `feature-dims.js`

Input: the delivered mesh payload the viewer already holds — `positions`,
optional `indices` (OCCT is indexed, Manifold isn't; the subset walk handles
both, unlike hover.js's non-indexed-only subset), per-triangle `featureIds`,
and the `features` label table.

Classification, in order, for a hovered feature's triangle set:

1. **Planar face** — all face normals agree within ~1e-3 rad. Values: in-plane
   extents. Basis: if the normal snaps to a global axis (the `COS_3DEG` idiom
   from `selection/resolve.js`), extents run along the other two global axes —
   a box face reads W×H, not a PCA-tilted pair; otherwise principal directions
   from the 2D vertex covariance.
2. **Cylinder** — side-wall normals of a cylinder lie in the plane ⊥ axis, so
   the axis is the smallest-eigenvalue eigenvector of the normal covariance.
   Radius = mean vertex distance from the axis; accept on tight residuals.
   Values: ⌀ + depth (extent along axis). Angular coverage ≥ ~300° → `⌀8.00`;
   partial arc (a fillet) → `R2.00`, matching drafting convention.
3. **Fallback bbox** — anything else (lofts, hulls, text): the feature's own
   W×D×H. Every hover produces some honest measurement.

Sub-part hover (no feature under cursor) and the always-on overall dims are
the degenerate case: bbox specs from cached bounding boxes.

Spec shape (the contract layout, pins, and overlay consume):

```js
{ kind: "cylinder" | "plane" | "bbox",
  subPart, featureLabel,            // anchor identity (null label = sub-part bbox)
  values: { diameter, depth, partial } /* or extents */,
  paramLink,                        // param key or null
  anchors: { /* 3D points in the mesh's geometry frame, per dimension line */ } }
```

Specs cache per `(geometry instance, featureId)` — invalidated naturally by
regeneration, same pattern as hover.js's subset cache.

## Dimension → control linking — `param-link.js`

Heuristic, not author-declared (escape hatch later: an explicit annotation on
`Solid.label()` — no authoring API on day one):

- Candidates = `subPartReadKeys(part, view, params)` for the hit sub-part
  (`param-deps.js` — the same scoping `resolveSelection` uses).
- A candidate links if its current value matches a measured value within the
  0.01 quantum; also matched at `value/2` for radius-style params against
  measured diameters.
- Return the key on a **unique** match; zero or multiple candidates → null.
  Never guess between two.

The link is visible before you click: a linked hover readout carries the param
name (`⌀ 8.00 · bore_d`). Clicking a linked dimension pins it **and** reveals
the control in one gesture; clicking an already-pinned one unpins (no focus
steal). Unlinked dimensions just pin.

## The layout engine — `dim-layout.js`

Pure per frame: `layout(specs, project, viewport, prev)` → flat 2D
primitives. `project` is the only camera knowledge (a closure the orchestrator
builds from `mesh.matrixWorld` + camera); tests drive it with a fake
orthographic projector.

Three primitive kinds out:

- **Linear dimension** (bbox extents, cylinder depth): extension lines with
  the standard visual gap near geometry and overshoot past the dimension
  line; dimension line with arrowheads; text centered on (or beside, when
  cramped) the line.
- **Leader callout** (⌀ / R): bent leader from the text chip to the feature's
  projected center — cleaner at glancing angles than drawing across a
  projected ellipse.
- **Label chip** — the text box; carries the param-link marker; the click/pin
  hit target.

Placement:

- **Overall W×D×H** use the silhouette trick: per axis, pick the bbox edge
  parallel to that axis whose screen-space position is most outboard — dims
  hug the silhouette, never cross the model. Offset outward by a fixed
  screen-space margin (constant px; zoom doesn't change overlay density).
- **Feature dims** flare outward, away from the model's screen-bbox center.
- **Collision pass**: deterministic greedy sweep — labels sorted by anchor,
  each nudged along its dimension line, then stacked outward, until clear of
  prior label rects. No solver; must fit the frame budget.
- **Hysteresis**: layout receives its previous output; a side/offset choice
  flips only when the new score beats the old by a margin. Dims stay planted
  during orbit.
- **Degrade rule**: anchors behind the camera or off-viewport drop their
  primitive cleanly (extension lines clip to the viewport). A pin fully
  off-screen collapses to a small edge-of-screen chip pointing at it — one
  primitive, not a special mode.

## Visual language — `dim-overlay.js` + CSS

Thesis: **a drawing, not a HUD.** Real drafting anatomy — hairline dimension
lines with true extension-line gap (4 px) and overshoot (3 px), small filled
triangular arrowheads (~7 px), bent leaders, correct notation (`⌀8.00`,
`R2.00`, `24.00 × 12.50`). All values in Geist Mono (`--pf-mono`).

Hierarchy (new component tokens `--pf-dim-*` in app.css, derived from existing
tokens):

- **Static dims** (always-on bbox): bare mono text with a theme-background
  halo (SVG `paint-order: stroke`), lines in muted ink (`--pf-muted-2`).
- **Hover / pinned dims**: same anatomy at full strength (`--pf-text-2`).
  Pinned dims gain an `×` affordance on chip hover; otherwise pinning changes
  persistence, not costume.
- **Param-linked dims — the one deliberate visual risk**: the label renders as
  a genuine mini control pill (accent border, param name beside the value,
  hover state, pointer cursor, focus ring) — a piece of the rail living inside
  the drawing. Everything else stays quiet so this reads.

Mechanics: one full-viewport `<svg>` (`pointer-events: none`; only label chips
re-enable), z-index between canvas and the chrome's 15. Hovered feature keeps
the existing `#4da3ff` surface highlight (via the extracted
`feature-highlight.js`) for continuity.

Chrome: the ruler button is an inline 16 px SVG glyph (diagonal rule with
ticks) matching the rail-toggle's stroke style; `.on` + `aria-pressed` exactly
like cutaway. Its action row shows `Clear` (only when pins exist) and a static
`mm` unit tag.

Motion: mode entry fades always-on dims in with a single 140 ms ease-out
(`prefers-reduced-motion` honored); hover dims appear with zero transition.
`.pf-param-flash` is a ~900 ms accent outline pulse decaying to the normal
focus ring.

## Interaction & lifecycle

- **Entry/exit**: ruler toggles. Exit hides the overlay but keeps pins in
  memory — re-entering restores them; `Clear` is the explicit destroyer.
- **Escape closes measure first**: its keydown handler registers in capture
  phase and stops propagation so cutaway's handler doesn't also fire; a second
  Escape closes cutaway.
- **Click discipline**: orbit-drag vs pin-click via a ~5 px pointer-travel
  threshold (the click-picker idiom). Clicking geometry pins the hovered dim;
  clicking a chip pins/unpins directly. Chips are `role="button"`,
  `tabindex="0"`, Enter/Space activate.
- **Hover handoff**: measure active → `attachHoverLabels.setSuppressed(true)`;
  measure-mode runs its own move→raycast loop with the shared highlighter.
  Cutaway gizmo drags suppress measure hover via `onCutawayHandleHover`.
- **Cutaway coexistence**: `raycastViewer` already filters through
  `isPointVisible`, so hovering a cross-section measures what you see. Pinned
  dims keep drawing when their anchors are clipped away — a dimension states a
  fact about the part, not the view.
- **Views**: pins are per-view; the mode itself stays on across view switches
  (a lens — unlike cutaway, which mount resets per view).
- **Regen**: pins re-resolve by label; a pin whose label vanished goes
  dormant (hidden, kept, revives if the label returns). Duplicate labels
  disambiguate by occurrence index. Mid-regen, previous dims persist until
  delivery.

## Capture

`capture-overlay.js`: `compositeOverlay(frameDataUrl, svgString, viewport) →
Promise<dataUrl>` (async because SVG must decode as an image), plus
`getOverlaySvg()` on the measure API. Existing capture paths stay
byte-identical — canonical-view thumbnails and capture-build never include
dims. Caveat, accepted for v1: fonts don't travel into rasterized SVG unless
embedded, so composited captures fall back through the `--pf-mono` stack;
embedding a WOFF subset is the upgrade if it grates.

## Testing

- `feature-dims`: synthetic tessellations — box face → plane extents, cylinder
  soup → ⌀/depth, partial arc → R, plus an **indexed** variant for the OCCT
  path.
- `dim-layout`: fake ortho projector; silhouette-edge selection, collision
  nudging, hysteresis (same input + prev layout → no flip), off-screen chip.
- `pins`: re-anchor by label, dormancy/revival, occurrence indexing, per-view
  keying.
- `param-link`: unique vs ambiguous matches, radius-vs-diameter halving,
  read-keys scoping.
- `measure-controls`: jsdom tests mirroring the cutaway-controls suite —
  aria-pressed, the Escape capture-ordering contract against cutaway, full
  detach/restore.
- Worker layering untouched: `measure/` is main-thread chrome; `feature-dims`
  is pure and importable anywhere.

## Rollout order

Each step lands green:

1. Pure leaves: `feature-dims`, `dim-layout`, `pins`, `param-link`.
2. `selection/feature-highlight.js` extraction refactor (+ hover.js
   `setSuppressed`).
3. `dim-overlay.js` renderer + tokens/CSS.
4. `measure-mode.js` orchestrator.
5. `measure-controls.js` chrome + mount wiring + example-page buttons.
6. Panel `revealParam` + `.pf-param-flash`.
7. `capture-overlay.js`.
8. Docs: `AUTHORING-PARTS.md` note that `Solid.label()` names also power
   measurement hover and pins.

Version bump rides the PR per the release rules.
