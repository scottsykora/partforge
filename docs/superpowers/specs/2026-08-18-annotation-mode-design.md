# Annotation mode — design

**Date:** 2026-08-18
**Status:** Approved design, pre-implementation

## Purpose

Let a user mark up the 3D view and send the markup to the AI agent hosted by
partforge-cloud. The user clicks an **Annotate** button in the viewbar, draws
freehand strokes over the frozen 3D view, and hits **Send**. The drawing and
the 3D render travel **separately** in one payload, so the host can composite
them into a single image now *and* re-reference the drawing against later
model updates (the payload carries the camera pose and grounded 3D anchors,
not just pixels).

## Decisions (settled during brainstorming)

1. **Anchoring: 2D ink + camera pose.** Strokes live in screen space; the
   payload carries the exact camera so the host can re-render the updated
   model from the same pose and overlay the same ink. Additionally, a few
   points per stroke are raycast into the model at send time ("anchors") so
   the agent knows what geometry the ink refers to.
2. **Delivery: host callback.** `mount()` gains an `onAnnotationSend(payload)`
   option. partforge-cloud forwards it to its agent; partforge owns no
   transport. If the host does not pass the callback, the annotate button is
   hidden entirely.
3. **Tools: freehand only.** One pen, one color, undo, clear. No shapes, no
   text.
4. **Send is drawing-only.** No note field; partforge-cloud's chat composer
   carries any words.
5. **Camera freezes while the mode is active.** The user frames the view
   first, then annotates. The overlay canvas owns the pointer, so orbit
   controls never see the drag — the freeze needs no viewer changes.
6. **Ink layer: transparent 2D `<canvas>` overlay** stacked over
   `viewer.domElement` inside the stage. First screen-space overlay canvas in
   the framework; appended to the stage container (the `animation-controls.js`
   precedent), never `document.body`.

## Architecture

`src/framework/annotate/`, mirroring the measure-mode four-layer split:

| File | Layer | Responsibility |
|---|---|---|
| `ink.js` | Pure leaf (no DOM, no three) | Stroke model: normalized-coordinate polylines, point thinning while drawing, undo/clear, closed-stroke detection, centroid computation, anchor t-selection, serialization. |
| `ink-canvas.js` | Renderer | Owns the transparent overlay `<canvas>`; its own `ResizeObserver`; redraws strokes (dark core + light halo); exports the transparent PNG. 2D context acquisition is injectable (happy-dom has no canvas 2D — the `dim3-scene` `paintLabel` pattern). |
| `annotate-mode.js` | Orchestrator | The only annotate file touching both DOM and viewer: pointer handling with pointer capture, enter/exit, anchor raycasts, camera snapshot, payload assembly, calls the host callback. |
| `annotate-controls.js` | Viewbar chrome | The pencil button + a contextual `.pf-annotate-actions` group (Undo, Clear, Send) shown while the mode is on — the `pf-measure-actions` pattern. No behavior beyond sync. |

### Interaction flow

1. User frames the model, clicks **Annotate** (`#annotate` in the viewbar,
   resolved as `elements.chrome.annotate ?? byId("annotate")` in `mount.js`'s
   single element-resolution block).
2. Overlay canvas covers the viewer: crosshair cursor, `touch-action: none`.
   Camera input is frozen because the overlay owns all pointer events.
3. Click-drag draws a stroke; pointer capture keeps strokes alive across the
   canvas edge. A second simultaneous touch is ignored. Undo removes the last
   stroke. Send is disabled while the canvas is empty.
4. **Send**: assemble the payload (below), call `onAnnotationSend(payload)`,
   exit the mode, clear the ink.
5. **Escape** or re-clicking the button exits and **discards** the ink — ink
   is tied to the frozen camera and does not persist across mode exits
   (deliberately unlike measure pins). Escape uses the established
   stage-scoped listener + `stopImmediatePropagation` ordering so it
   interoperates with measure and cutaway.
6. Entering annotate mode calls `measureMode.setEnabled(false)` and
   suppresses hover tooltips and the picker via the pull-based
   `suppressed: () => annotateMode.isEnabled()` idiom.

### Anchors

At send time, a few points per stroke are raycast into the scene
(`raycastViewer` + `worldToSubPartLocal`, the existing pick vocabulary):

- start, midpoint, and end of every stroke (t = 0, 0.5, 1);
- for strokes that close on themselves (endpoints within 5% of the viewport
  diagonal, in normalized space), one additional raycast at the **centroid**
  of the enclosed region — the "what did they circle" answer.

Each anchor records its normalized screen point and either the hit
(`{ subPart, pointLocal }`, CAD-frame coordinates) or `null`. Misses are kept:
"circled empty space beside the part" is signal. Anchor point selection
(t-values, closed detection, centroid) is pure logic in `ink.js`; only the
raycasts themselves happen in `annotate-mode.js`.

An **on-demand raycast tool** for the agent (post-hoc "raycast this
annotation at (x, y)") is explicitly deferred: the payload already carries
camera intrinsics, viewport, view, and the params snapshot — everything a
host-side v2 tool needs — so it requires no payload change later.

## Payload

One JSON-serializable, versioned object:

```js
{
  version: 1,
  strokes: [{ points: [[nx, ny], ...], width }],   // points normalized 0..1 in viewport
                                                   // space; width as a fraction of the
                                                   // viewport's short edge
  anchors: [
    { stroke: 0, t: 0,   screen: [nx, ny], hit: { subPart, pointLocal: [x, y, z] } },
    { stroke: 0, t: 0.5, screen: [nx, ny], hit: null },
    { stroke: 0, t: 1,   screen: [nx, ny], hit: { ... } },
    { stroke: 0, kind: "centroid", screen: [nx, ny], hit: { ... } },  // closed strokes only
  ],
  images: {
    drawing: "data:image/png;base64,...",   // transparent ink layer
    model:   "data:image/jpeg;base64,...",  // 3D render without ink — captureCurrent()
  },
  camera: {
    world: { pos, target, up, fov },   // exact replay against this build
    parts: { pos, target, up, fov },   // camera in the CAD frame — survives recentring
  },
  viewport: { width, height, dpr },
  context: { view, params },           // active view name + params snapshot at send
}
```

Rationale for the non-obvious parts:

- **Vectors and PNG both.** The PNG composites immediately over any
  same-aspect render; the normalized polylines re-draw the ink at any
  resolution or re-project it later. Both come from the same stroke model.
- **Camera in two frames.** The viewer recenters the assembly on its
  bounding-box center per view (`partsGroup.position = -center`), so after a
  model update changes the bbox, the same *world* camera frames the part
  differently. The `parts` pose — transformed through the inverse of
  `partsGroup.matrixWorld`, the same mapping measure mode uses — keeps the
  camera fixed relative to the CAD geometry, which is what re-referencing
  against updates needs. Anchor `pointLocal` values are in the same CAD
  frame, so all grounded data lines up.
- **`context.params` makes the payload self-describing**: the host can
  rebuild the exact annotated model state without correlating timestamps.

**Everything is captured at send time** — model image, anchors, camera,
viewport — against the live projection. This is the consistency rule that
handles both resize and mid-annotation param rebuilds (see Edge cases).

## Host API

Follows the existing conventions exactly (callbacks in via `onX` options,
mode controls out via a namespaced runtime sub-object):

- `mount(part, { onAnnotationSend })` — optional; absence hides the button.
- `runtime.annotate = { isEnabled(), setEnabled(on), clear(), strokeCount(),
  send(), onModeChange(cb) → off }` — declared in `makeHandle` with a
  `NOOP_ANNOTATE` default so the handle shape never varies; mirrored in
  `types/index.d.ts` and the `mount.js` doc-comment contract.
- Hosts add `<button id="annotate">` to their viewbar markup (demo app
  included); `elements.chrome.annotate` overrides the id lookup.
- `mount.js` wiring order matches measure: create mode after params exist,
  `cleanup.defer(() => annotateMode.detach())` immediately, attach chrome
  with `{ tooltip, escapeScope: els.viewer }`.

## Error handling

- `captureCurrent()` returns `null` on a lost WebGL context → `send()`
  aborts, ink stays intact, nothing is silently dropped; recovery rides the
  existing `onContextLost` path.
- `send()` with zero strokes is a no-op (and the button is disabled).
- Raycast misses are recorded as `hit: null`, never dropped or errored.
- Every attach returns `{ detach }`; every subscribe returns an unsubscribe;
  detach/dispose are idempotent; chrome no-ops without its button and
  restores captured host attributes via `teardown.js` helpers.

## Edge cases

- **Resize / rail collapse while annotating**: ink is normalized, so it
  redraws scaled; a large aspect change can drift ink slightly off the
  geometry it was drawn over. Accepted — send-time capture keeps the payload
  internally consistent, and the user sees the drift before sending.
- **Params change mid-annotation**: allowed; send-time capture means the
  payload describes what is on screen.
- **Narrow layout (<720px)**: works in the stage pane; the actions group
  follows the measure-actions responsive rules, including the explicit
  `#viewbar X[hidden] { display: none }` guard (author-origin `display: flex`
  beats the UA `[hidden]` rule).
- **Ink visibility**: dark stroke core with a thin light halo, readable on
  both themes and any model color.

## Testing

- `ink.js`: dense pure unit tests — thinning, normalization, undo/clear,
  closed-stroke detection, centroid, anchor t-selection, serialization.
- `annotate-mode.js`: stub viewer + injected 2D-context factory — payload
  assembly, send-abort on null capture, discard-on-exit, suppression
  interplay with measure/hover.
- `annotate-controls.js`: mirrors measure-controls tests — attach/detach
  idempotence, attribute restore, `aria-pressed`, Escape ordering.
- Demo app gains the button; existing `check-app` smoke covers boot. No new
  Playwright scenarios in v1.
- Annotate code is main-thread only and never enters the worker graph
  (`test/worker-layering.test.js` is unaffected).

## Out of scope (v1)

Shape/text tools; the on-demand agent raycast tool; in-viewer replay of
received annotations; pick-serve/CLI integration; ink persistence across mode
exits; color options.
