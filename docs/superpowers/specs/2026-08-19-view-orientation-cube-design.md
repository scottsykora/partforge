# View-orientation cube + projection toggle — design

**Date:** 2026-08-19
**Status:** Approved design, pre-implementation

## Purpose

Give the viewer a persistent orientation widget: a small ghost cube with the
part's X/Y/Z axes drawn in front of it, sitting above the viewbar. It shows
which way the part is facing at a glance, and its 26 regions — 6 faces, 12
edges, 8 corners — are click targets that tween the camera to that canonical
angle. Directly beneath it, a one-button toggle switches the viewer between
perspective and orthographic projection.

Today the only way to reach a canonical angle in the UI is to orbit there by
hand; `view-angles.js` already knows the seven canonical poses, but nothing on
screen exposes them. Orthographic projection is not available at all.

## Decisions (settled during brainstorming)

1. **Form: hybrid.** A translucent ghost cube supplies all 26 click regions,
   with the three axis arrows drawn on top of it so the *directions* stay
   legible. Not a bare axis triad, and not a solid labelled cube.
2. **Axis frame: the model / CAD frame, Z up.** The frame parts are authored
   in and that every parameter, measurement, and exported STL/STEP/3MF uses —
   not the viewer's three.js world frame. The widget applies the same pivot
   rotation the part does, so it always agrees with the geometry on screen.
3. **Rendering: pure geometry + 2D canvas.** A DOM-free, three-free geometry
   leaf projects and hit-tests; a thin renderer paints a small 2D canvas. Not
   a scissored WebGL viewport, and not SVG — see *Rendering approach* below
   for why.
4. **Projection toggle scope: live view + `captureCurrent`.** The on-screen
   camera and the user's "capture what I framed" shot follow the toggle. The
   agent-facing canonical renders (`captureCanonicalViews`,
   `renderMeshPayloads`, CLI `partforge render`) stay perspective
   unconditionally, keeping that output stable for partforge-cloud's
   regenerated prompt corpus.
5. **Placement: bottom-right, stacked above the viewbar.** All camera controls
   in one cluster. Costs a vertical stacking contract, handled below.
6. **Toggle form: a single icon button** with the existing `#viewbar button`
   chrome and its `.on` state, showing a perspective-frustum glyph that swaps
   to a parallel-box glyph. Its own one-button pill directly under the cube.
7. **Interaction: click to snap, drag to orbit, hover to highlight.** The full
   CAD ViewCube behaviour. A drag past threshold cancels the click.
8. **Hide rule: during Sketch (annotate) mode only.** Sketch freezes the view
   deliberately — ink is stored in screen space and is meaningful only against
   the pose it was drawn over — so a live camera control on top of it invites
   the one gesture that invalidates the drawing. The **whole stack** hides,
   projection button included: switching projection re-frames the frozen view
   and invalidates the ink just as an orbit would. The widget stays visible
   during Measure (which does not freeze the camera), during animation
   playback, and below the narrow breakpoint on phones.

## Rendering approach

Three options were weighed. The cost that decides between them is **main-thread
work inside the rAF callback**, not GPU work: the widget is ~90×90 CSS px, so
its raster and its composite over the WebGL canvas are noise anywhere. The loop
it joins is already busy — `controls.update()` → `camTween.update()` → frame
listeners → `cutaway.updateForCamera()` (which re-slices cut-face outlines) →
`renderer.render()` → `cutaway.renderOverlay()`.

- **Scissored WebGL viewport** (three's own `ViewHelper` pattern) is the
  cheapest per frame — a scissor, a clear, a few dozen triangles, zero DOM —
  but face labels become canvas textures rebuilt on every theme swap, hover and
  click need raycast plumbing, and none of it runs without a live GL context,
  so none of it is testable in this suite.
- **SVG** would rewrite `points` on ~26 polygons per frame; each write
  re-parses a string into an `SVGPointList` and invalidates style and paint for
  the subtree, processed in the same frame's rendering steps. Estimated at a
  few tenths of a millisecond on desktop and low single-digit milliseconds on a
  weak phone — bounded, but spent during orbit, which is the worst time to
  spend it. Its apparent advantage, free DOM hit-testing, is illusory here:
  happy-dom/jsdom have essentially no SVG geometry or `pointer-events` support,
  so those hit regions would not have been covered by tests anyway.
- **2D canvas (chosen).** One `clearRect` plus ~30 fills and strokes into a
  90×90 (×DPR) backing store, and only when the camera actually moved. No DOM
  mutation, no style invalidation, no layout. Idle frames cost literally
  nothing. Hit-testing becomes a pure point-in-polygon function against the
  same projected quads — *more* testable than the SVG version, not less. The
  renderer follows the `createInkCanvas` injection seam so tests hand it a
  fake.

What the canvas gives up versus SVG is crisp CSS-var-themed text (canvas text
is fine; a theme change simply repaints) and free DOM focus and keyboard, which
is replaced deliberately by visually-hidden buttons (below).

## Architecture

`src/framework/viewcube/`, mirroring the `measure/` and `annotate/` four-layer
split:

| File | Layer | Responsibility |
|---|---|---|
| `cube-geom.js` | Pure leaf (no DOM, no three, no `node:`) | The unit cube's 26 regions in the model frame as vertex lists; rotation by a camera quaternion passed as four plain numbers; orthographic projection to 2D; painter sort by region-centre depth; `hitRegion(px, py, projected)` by point-in-polygon; the three axis arrows and their label positions. |
| `cube-canvas.js` | Renderer | Owns the `<canvas>`, its DPR backing store and its `ResizeObserver`; paints back faces → arrow tails → translucent front faces → arrowheads → labels, plus the hover highlight. 2D context acquisition is injectable (the `ink-canvas.js` / `dim3-scene` `paintLabel` precedent). |
| `viewcube-mode.js` | Orchestrator | The only viewcube file touching both DOM and viewer: frame subscription, camera dirty-check, pointer handling with capture, the drag/click threshold, the Sketch hide rule, theme redraws. |
| `viewcube-controls.js` | Chrome | Builds `.pf-viewcube-stack`, the projection button and its tooltip, and the visually-hidden per-view buttons. Sync only, no behaviour. |

Two new pure leaves at the framework root, both imported by `viewer.js` so the
widget itself never touches three:

| File | Responsibility |
|---|---|
| `camera-orbit.js` | Spherical math for "drag by (dx, dy) → orbit": position-minus-target to spherical, apply Δθ/Δφ, clamp polar, back to Cartesian. |
| `projection.js` | The invertible perspective⇄orthographic framing pair (below). |

### The orientation contract

The cube needs 26 orientations; `view-angles.js` defines 7, and that list is
load-bearing elsewhere — `captureViewsFromScene` slices against
`CANONICAL_VIEWS.length`, the CLI takes a view name, and partforge-cloud's
render tool names them.

**`CANONICAL_VIEWS` does not grow.** `view-angles.js` gains a separate
`ORIENTATIONS` map of all 26, keyed by id (`top`, `front-right`,
`top-front-right`, …), with the existing seven as a subset resolving to
byte-identical poses. `cameraPoseForView` accepts any id. Capture callers keep
the seven-name list they already have; only the cube reads the 26.
`tweenCameraTo` then works on all 26 for free.

Up-vector rule: world +Y for every orientation except pure `top` and pure
`bottom`, which keep the special-cased ups already in `DIRS`.

### Model-frame mapping

The pivot's `rotation.x = -π/2` maps model (x, y, z) → world (x, z, −y).
Therefore, with model-frame labels:

| Widget region | Model axis | World direction |
|---|---|---|
| `front` | −Y | +Z |
| `back` | +Y | −Z |
| `top` | +Z | +Y |
| `bottom` | −Z | −Y |
| `right` | +X | +X |
| `left` | −X | −X |
| `iso` corner | (+X, −Y, +Z) | (1, 1, 1) |

This is the standard CAD convention (front view looks down +Y at the XZ face)
and it falls out of the existing pivot without a second rotation anywhere.

## Projection swap

Two camera objects, one active. `viewer.js` keeps its existing
`PerspectiveCamera` and gains an `OrthographicCamera`; an `activeCamera`
binding decides which one `OrbitControls`, the render loop, and everything
downstream see.

### Framing continuity

The two projections must frame identically at the instant of the toggle or the
part jumps. Perspective framing is a distance; ortho framing is a frustum
height plus a zoom. `projection.js` owns both directions:

- to ortho: `halfH = dist · tan(fov / 2)`, `halfW = halfH · aspect`, `zoom = 1`
- to perspective: `dist = halfH / (zoom · tan(fov / 2))`

The second recovers whatever dolly the user did while in ortho (where
`OrbitControls` changes `camera.zoom` rather than the position). Round-tripping
the pair is a unit test.

### Viewer changes

- **`viewer.camera` becomes a getter** for the active camera. Every consumer —
  `measure/dim3-scene.js`, `selection/raycast.js`, `annotate/annotate-mode.js`,
  `measure/measure-mode.js` — already reads it fresh at call time rather than
  destructuring it, so this is transparent to all of them.
- **`resize()`** updates `aspect` on the perspective camera and
  `left/right/top/bottom` on the ortho one, holding the vertical world extent
  so a window resize does not rescale the part.
- **`frameTo()`** becomes projection-aware: same direction and `r · 2.6 + 6`
  distance as today, plus a frustum recompute and `zoom = 1` when ortho is
  active.
- **New handle surface:** `setProjection(mode)`, `getProjection()`,
  `onProjectionChange(cb)`. Surfaced on the runtime as
  `runtime.projection = { get, set, onChange }`, matching how `measure` and
  `annotate` are surfaced. Persisted in `view-state.js` beside the camera and
  theme, and restored during mount **before** the first `frameTo()`, so a
  reload into ortho frames once rather than framing in perspective and then
  visibly re-framing.
- **`orbitBy({ dx, dy })`** on the handle, for the cube's drag. Internally it
  cancels any in-flight cue tween and notifies the camera-start listeners, so
  grabbing the cube disarms remaining animation cues exactly as grabbing the
  canvas does. The math comes from `camera-orbit.js`.

### Three call sites that would otherwise be silently wrong

1. **`measure/dim3-scene.js:323`** computes
   `worldPerPx(dist, viewer.camera.fov ?? 45, h)`. Under an ortho camera `fov`
   is `undefined`, so that `?? 45` produces a plausible-but-wrong scale and
   every dimension label, arrow, standoff and stagger drifts as the user
   dollies. It needs the ortho branch `|top − bottom| / zoom / h` — which
   `cutaway-gizmo.js:485` already implements, so this mirrors existing code
   rather than inventing it.
2. **`cutaway`** captures `camera` once at construction and hands it to its
   gizmo. Rather than thread a getter through the gizmo's fifteen references,
   `createCutaway` gains `setCamera(cam)`, which reassigns the binding and
   forwards to the gizmo (its `camera` becomes `let`). The gizmo's ortho paths
   already exist: `isPerspectiveCamera` at `:203`, the `zoom`-aware scale at
   `:485`.
3. **`renderOffscreen`** builds a temp `PerspectiveCamera`. Per decision 4,
   `captureCurrent` must build a matching ortho temp camera when ortho is
   active; `captureCanonicalViews`, `renderMeshPayloads` and the CLI stay
   perspective unconditionally.

### Annotation payload — versioned change

`annotate/annotate-mode.js:88` writes `fov` into the payload's camera block,
and `ANNOTATION_VERSION` is `1`. A user can switch to ortho and *then* open
Sketch, so that payload can be captured under a projection that has no `fov`.

The camera block gains `projection: "perspective" | "orthographic"` and
`orthoHeight`, and **`ANNOTATION_VERSION` bumps to `2`**. An additive optional
field alone would leave any consumer that reconstructs the camera from `fov`
silently wrong rather than loudly broken. This is a contract partforge-cloud
reads; it is documented where the payload is specified.

## Chrome, placement, and stacking

The widget builds its own DOM, following `mobile-tabs.js` and
`animation-controls.js`. No part's `.html` changes, and partforge-cloud's
scaffold does not either — which also keeps its `sandbox-scaffold.test.js`
green, since that test enumerates `#viewbar button` and the projection button
lives outside the viewbar.

Structure, a right-aligned column `.pf-viewcube-stack`:

```
┌─────────┐
│ canvas  │   the cube, ~90×90 CSS px (×DPR backing store)
└─────────┘
    ┌───┐     one-button pill, #viewbar chrome inherited
    │ ◱ │     perspective ⇄ orthographic, .on when ortho
    └───┘
  [ viewbar ]  existing, unchanged
```

Placement obeys the split the codebase already enforces: `chrome.css` positions
it (PLACEMENT ONLY), `app.css` styles it, so a host re-anchoring the stack
still inherits the pill chrome. The viewbar occupies 12px–56px from the stage
bottom, so the stack anchors at 64px — but **read, not hardcoded**: a
`ResizeObserver` on `#viewbar` publishes `--pf-viewbar-clear` on the stage,
mirroring how `animation-controls.js` publishes `--pf-anim-clear`.

### The stacking bug this would otherwise introduce

`animation-controls.js` keeps the transport bar clear of the viewbar by
measuring `#viewbar`'s rect and clamping the bar's left when the two vertical
bands intersect. The bottom-right cluster is now taller than `#viewbar`, so on
a narrow stage the transport bar would slide underneath the cube.

The fix is at the **call site**, not in the math: pass the union of the
`#viewbar` and `.pf-viewcube-stack` rects. `planAnimBarPlacement` is already a
pure function taking `viewbarLeft` and is untouched — only what is measured
changes. This is also what makes the widget safe on a phone, where it stays
visible per decision 8.

## Interaction

- **Hover** — `pointermove` on the canvas → `hitRegion()` → redraw with that
  region highlighted; `pointerleave` clears it.
- **Click** — `pointerdown` arms; `pointerup` within a 4px threshold fires
  `viewer.tweenCameraTo(id, { duration: 0.6 })`, the same tween and damping the
  animation cues use.
- **Drag** — past 4px it becomes an orbit and the click is cancelled. Pointer
  is captured; deltas go through `viewer.orbitBy()`.
- **Keyboard** — six visually-hidden buttons behind the canvas, one per
  canonical view, each labelled and each firing the same tween. Canvas
  rendering costs free DOM focus, so this is the deliberate replacement.

## Lifecycle and cost control

Redraw on `viewer.onThemeChange`. Hidden via the `hidden` property while Sketch
is on, subscribed through `annotateMode.onModeChange`. Every listener is
registered through `cleanup.defer`, like its siblings in `mount.js`.

The frame subscription compares the camera quaternion — and, in ortho, `zoom` —
against the last drawn values and returns immediately when unchanged. **Idle
frames do zero work**: no clear, no fills. Redraws happen only while the camera
is moving, plus once on theme or projection change. This is asserted by a test,
not assumed.

## Testing

`test/framework/viewcube/`, matching how `annotate/` and `measure/` are
covered:

- **`cube-geom.test.js`** — the bulk of the value, all plain functions over
  plain arrays: all 26 regions present and non-degenerate; rotation by a known
  quaternion projects the expected face forward; painter sort puts the
  camera-facing face last; `hitRegion` returns the face at a face centre, the
  edge at an edge midpoint, the corner at a corner, `null` outside the
  silhouette; the model-frame axis mapping table above.
- **`camera-orbit.test.js`** — spherical round-trip, polar clamping at both
  poles, zero delta is exactly a no-op.
- **`projection.test.js`** — the conversion pair round-trips, including after a
  simulated dolly (`zoom ≠ 1`); aspect changes hold the vertical extent.
- **`cube-canvas.test.js`** — against an injected fake context: draw order is
  back faces → arrow tails → front faces → arrowheads → labels; the hover
  region draws in the highlight fill; a theme change repaints.
- **`viewcube-mode.test.js`** — with a stub viewer: an unchanged quaternion
  draws nothing; a 3px release tweens and a 5px release orbits; Sketch on hides
  and off restores; detach removes every listener.
- **`viewer-projection.test.js`** — `viewer.camera` returns the active camera
  after a swap; `setProjection` round-trips framing; `captureCurrent` builds an
  ortho temp camera in ortho while `captureCanonicalViews` stays perspective.
- **Extensions to existing files**, not new ones: `animation-controls.test.js`
  gains the union-rect case (transport bar clears the taller cluster, not just
  `#viewbar`); `dim3-scene.test.js` gains the ortho `worldPerPx` branch.
- `npm run check` smoke-boots the widget in real Chromium alongside the
  existing four apps.

## Documentation and release

- `AGENTS.md`'s architecture map gains `viewcube/` beside `measure/` and
  `annotate/`, one line per module.
- `docs/AUTHORING-PARTS.md` documents the new runtime surface
  (`runtime.projection`) and the annotation payload's new camera fields.
  `docs-coherence.test.js` exists precisely because undocumented surface is
  what rots partforge-cloud's regenerated prompt corpus.
- **`package.json` goes `0.68.0` → `0.69.0` on the feature branch, in the
  PR.** Per `AGENTS.md` this is the quiet failure mode: forget it and the merge
  lands, the version already exists on npm, the publish workflow correctly
  no-ops, and the work never ships.

## Sequencing

Before implementation locks any visual constant, build a **throwaway
look-and-feel spike** with live A/B toggles: cube size, ghost-face opacity,
label style, arrow weight, highlight colour, drag sensitivity. The constants
this spec would otherwise guess at get chosen by eye in the real app and then
recorded here; the spike itself is discarded.

Two measurements ride along in that same pass, both of which this design
currently asserts rather than knows:

1. The redraw cost on a real phone profile.
2. Whether the camera dirty-check genuinely holds idle frames at zero under
   `OrbitControls` damping, which settles asymptotically rather than exactly.

## Out of scope

- Orthographic output from `captureCanonicalViews`, `renderMeshPayloads`, or
  the CLI (decision 4).
- A `meta.projection` per-part default. Nothing asks for it yet.
- Animating the cube independently of the camera, snap-to-nearest-orientation,
  or a "home" button — the existing reframe button already covers the last.
