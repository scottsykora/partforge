# Sketch tools: shapes, colors, eraser, and a semantic element model

**Date:** 2026-08-27
**Status:** Approved (prototyped interactively; gestures and chrome validated
in a throwaway browser prototype before this spec was written)

## Summary

Annotation ("Sketch") mode grows from a single freehand pen into a small
drawing toolset — pen, line, rectangle, ellipse, a grab-hand edit tool, and an
eraser — with three ink colors. The stroke model becomes a typed **element**
model in which every element keeps its constructive parameters (a circle knows
its center and radius) for its whole life: the eraser subtracts *parameter
intervals* rather than destroying geometry, and moves / resizes / rotations
edit the parameters. The send payload bumps to **v3**: a semantic `elements`
array (typed params, erased intervals, a human-readable description, and
raycast anchors) replaces the v2 `strokes` array, so an LLM consumer gets a
faithful structured description of the sketch alongside the PNGs.

## Goals

- Rectangle / ellipse / line tools, each drawn with a single corner-to-corner
  drag; rect and ellipse snap magnetically to square / circle near 1:1 aspect
  (Shift forces the constraint; Shift on the line tool snaps to 45°).
- Three ink colors (red, blue, green), all with the existing white-halo
  treatment.
- An eraser that removes swept spans from any element while the element's
  constructive parameters survive — a 40%-erased circle is still "a circle,
  center c, radius r, with these arcs missing".
- A grab-hand tool: drag an element's outline to move it, drag its handles to
  edit it (line endpoints, rect corners, ellipse radii), and drag just outside
  it to rotate it.
- A top-centre sketch toolbar that replaces the viewbar while the mode is on.
- A v3 `onAnnotationSend` payload carrying the semantic element list.

## Non-goals

- Arc / polygon / text tools (dropped during design; the element model is
  open to adding types later).
- Persistent selection state; the hand tool is hover-engaged only.
- The prototype's "what the model sees" side panel (prototype-only chrome;
  the payload `description` strings carry the same content).
- Payload back-compat with v2 consumers: this is a clean break, the same dance
  as v2 (partforge-cloud updates when it bumps the dep).

## Element model (pure, `src/framework/annotate/`)

The freehand-only ink store generalizes to an **element store**. Every element
is:

```js
{ type, color, width, params, gaps }
```

- `type`: `"freehand" | "line" | "rect" | "ellipse"`.
- `color`: `"red" | "blue" | "green"` (hexes: `#d92d20`, `#1570ef`,
  `#079455`; halo unchanged).
- `width`: fraction of the viewport short edge (the existing
  `DEFAULT_STROKE_WIDTH` convention).
- `params` (constructive, see coordinate frame below):
  - freehand: `{ points: [[x,y], …] }`
  - line: `{ x1, y1, x2, y2 }`
  - rect: `{ cx, cy, w, h, rot }` (center-based so rotation and
    opposite-corner resize are sane)
  - ellipse: `{ cx, cy, rx, ry, rot }`; a circle is an ellipse with
    `rx === ry` and is described/exported as a circle
- `gaps`: merged, sorted list of erased `[t0, t1]` spans in the element's 1-D
  parameter domain `t ∈ [0, 1]`:
  - freehand: normalized arc length
  - line: normalized length
  - rect: normalized perimeter (top-left corner, clockwise)
  - ellipse: normalized parametric angle

Pure functions per type (one geometry module, unit-testable with no DOM):
`sample(el)` → dense `[{x, y, t}]` outline samples; `visibleRuns(el)` →
polyline runs between gaps; `describe(el)` → the semantic string;
`handlesOf(el)` → edit handles; `centerOf(el)`; interval utilities
(`mergeGaps`, `visibleFraction`). Params are treated as immutable per edit
step so samples can be cached per element and invalidated on edit.

### Coordinate frame

Elements are stored in **stage space**: `y ∈ [0, 1]`, `x ∈ [0, aspect]`
(aspect = viewport width / height). This is the existing `diagDistance` idiom
taken as the storage frame, and it is what keeps a circle circular: geometry,
rotation, snapping, and distance thresholds all work in a uniform space, and
rendering maps to pixels by scaling by the canvas height. The v2 store's
per-axis-normalized points convert at the boundary (pointer events in,
payload/render out).

## Tools and gestures

- **Pen** — unchanged freehand: begin/extend/end with the existing
  min-distance thinning; a click leaves a dot.
- **Line** — drag endpoint to endpoint. Shift snaps the angle to 45°
  increments.
- **Rect / Ellipse** — one corner-to-corner drag (ellipse fills the dragged
  bounding box). While dragging, if the aspect is within 12% of 1:1 the shape
  snaps to a square / circle (magnetic); Shift forces it. Dashed accent
  construction guides with a live mono label (`w × h`, `r …`, length·angle)
  render during the drag.
- **Hand** — a probe decides what the pointer would act on, with this
  priority:
  1. **Handle** (pick radius ~8 px): line endpoints move that endpoint; rect
     corners resize against the *fixed opposite corner* (anchor captured in
     world space at gesture start, so crossing the anchor is well-behaved),
     with the same 1:1 magnetic snap; ellipse has rx / ry handles (near-1:1
     snaps back to a circle), and a true circle has a *single* radius handle
     so it never accidentally becomes an ellipse.
  2. **Outline** (within reach ≈ max(10 px, 1.5 × stroke width)): drag moves
     the element (translate params; gaps ride along).
  3. **Rotate band** (outline reach + ~22 px): drag rotates about
     `centerOf(el)`; Shift snaps to 15°. The band engages **only when exactly
     one element is that close** — two candidates make "just outside" mean
     nothing, so neither rotates. Rect/ellipse rotation writes the `rot`
     param; line/freehand rotation transforms the stored points (total-angle
     applied to params captured at gesture start, so snapping never
     accumulates drift).
  Hover feedback: accent glow on the engaged element, handles drawn as small
  squares, grab/crosshair cursors, and a circular-arrow rotate glyph in the
  band. Live labels during edits (dims / radius / signed degrees).
- **Eraser** — a brush (~16 px radius) swept over the canvas. Each stroke
  segment marks the covered `t`-spans of every element it touches
  (sample-distance test against brush radius + half stroke width) and merges
  them into `gaps`. An element whose visible fraction drops below 2% is
  dropped. One undo step per eraser drag.

Undo is snapshot-based and uniform: one snapshot per committed action (draw,
move, resize, rotate, erase drag, clear). Escape cancels an in-flight gesture;
the existing Escape-exits-mode behavior is preserved (gesture cancel wins
first).

## Chrome

While Sketch mode is ON, the **viewbar hides** and a **top-centre pill
toolbar** (same `#viewbar` pill idiom: surface / border / `--pf-radius-pill` /
float shadow, 34 px icon buttons) owns the mode:

```
[pen] [line] [rect] [ellipse] [hand] [eraser] | (red)(blue)(green) | [undo] [clear] ([Send])
```

- Undo / Clear are icon buttons (disabled states as today: undo when the
  stack is empty, clear when there are no elements).
- Every button binds to the framework's existing tooltip system
  (`attachButtonTooltips`) — hover and keyboard-focus tooltips.
- **Send** appears at the right end only when the host has not claimed
  sending (`annotateSend: "viewbar"`, the mount default). With
  `annotateSend: "host"` (partforge-cloud) there is no Send in the toolbar —
  the host composer at bottom-centre owns it, exactly today's contract.
- A one-line mono gesture hint renders under the toolbar (e.g. "drag corner
  to corner · snaps to square near 1:1 · shift forces").
- The viewbar hide follows the established pattern for mode-driven chrome
  visibility in mount (the viewcube-hide idiom): mount owns the OR of reasons,
  restores on exit, and the attribute-restore discipline of
  `annotate-controls.js` is preserved for anything it touches.
- The narrow-pane layout keeps working: the toolbar is stage-anchored
  (`max-width: calc(100% - 16px)`, wrapping), so it behaves under
  `RAIL_NARROW_BREAKPOINT` and host pane takeover.

The `runtime.annotate` host surface is unchanged (`setEnabled`, `undo`,
`clear`, `strokeCount` — now element count — `send`, `onInkChange`,
`onModeChange`); tool and color selection are internal to the mode's chrome.

## Payload v3

`ANNOTATION_VERSION = 3`. The `strokes` field is **replaced** by `elements`;
`images`, `camera` (world + parts frames), `viewport`, and `context` are
unchanged in shape. Per element:

```js
{
  type, color: { name, hex },
  width,                      // short-edge fraction, as v2
  params,                     // constructive, stage-space (y 0..1, x 0..aspect)
  erased: [[t0, t1], …],      // merged spans, [] when untouched
  visibleFraction,            // 0..1
  description,                // "red rect · c (34%, 79%) · 20% × 25% · rot 62°"
  anchors: [ … ],
}
```

- `params` include `rot` (radians) for rect/ellipse; an `rx === ry` ellipse
  exports as `{ …, r, circle: true }` and a `w === h` rect carries
  `square: true` — drawn intent (the snap) survives into the data.
- `description` is generated by `describe(el)`: type (square/circle when
  snapped), center/extents as viewport percentages, rotation in degrees,
  plus erased-state ("63% visible · 2 gaps") when gaps exist.
- `anchors` generalize v2: for each **visible run**, start / arc-length-mid /
  end, each raycast exactly as today (`{ subPart, pointLocal }` or null);
  rect and ellipse additionally anchor their **center** (the "what did they
  circle" signal, now exact instead of centroid-inferred). Anchor `screen`
  coords stay per-axis-normalized 0..1 as in v2, since consumers use them
  against the images.
- The drawing PNG renders exactly what the user sees (visible runs only, per
  color, halo under core across all elements).

## Architecture / file plan

All in `src/framework/annotate/` unless noted; the module stays DOM-split the
way measure/ is (pure leaves, one canvas renderer, one orchestrator, one
chrome file):

- `elements.js` (new, pure) — element store (replaces `createInkStore`),
  per-type geometry (sample/runs/describe/handles/center), interval math,
  erase application, edit appliers (translate/resize/rotate), snap logic.
  No DOM, no three.
- `ink.js` — retired: its store, point-thinning, `pointAt`, and
  `anchorSpecs`/centroid logic migrate into `elements.js` (freehand is just
  one element type; closed-stroke centroid inference is superseded by exact
  shape centers). `DEFAULT_STROKE_WIDTH` moves with the store.
- `ink-canvas.js` — renders typed elements (visible runs, per-element color,
  two-pass halo/core), plus overlay adornments fed by the mode: construction
  guides, handles, glow, rotate glyph, eraser ring, labels. Still owns
  resize/DPR/export (`toDataUrl` unchanged).
- `annotate-mode.js` — tool state machine (current tool, color, gesture,
  hover probe), pointer routing, payload v3 assembly, `ANNOTATION_VERSION = 3`.
- `sketch-toolbar.js` (new) — the top-centre toolbar chrome: builds the
  buttons, binds tooltips, syncs enabled/pressed state, hosts Send when the
  viewbar owns sending. `annotate-controls.js` keeps the viewbar pencil
  toggle and its attribute-restore contract, but its Undo/Clear/Send action
  row moves into the toolbar.
- `mount.js` — wires toolbar creation into the annotate lifecycle and hides /
  restores the viewbar on mode change (viewcube-hide idiom).
- `app.css` / `chrome.css` — toolbar, swatches, hint, cursors, tooltip reuse.

## Error handling

- Degenerate drags (sub-6 px) commit nothing; a pen click still leaves a dot.
- Erase-to-nothing drops the element (threshold 2% visible).
- `send()` keeps the v2 ordering guarantees: model capture first, abort with
  ink intact on a lost WebGL context; empty-store send is a no-op.
- Zero-size viewport rects abort pointer handling as today.

## Testing

Extends `test/framework/annotate/` (vitest, no browser):

- **Interval math**: merge/overlap/edge-touching gaps, visible fraction,
  visible-run extraction across gap boundaries, drop threshold.
- **Geometry**: per-type sampling (rect perimeter walk incl. rotation,
  ellipse/circle, line), snap thresholds (11% snaps, 13% doesn't; Shift
  forces), 45° line snap, handle positions under rotation, opposite-corner
  resize incl. crossing the anchor, rotation appliers (param vs point-based)
  and 15° snapping without drift.
- **Eraser**: brush sweep → expected spans per type; gaps survive
  move/resize/rotate unchanged in t-space.
- **Store**: undo snapshots per action; clear; element ordering.
- **Describe/payload**: description strings (square/circle naming, rot notes,
  gap notes), v3 shape, anchors per visible run + centers, raycast wiring
  (mocked viewer, the existing `annotate-mode.test.js` idiom).
- **Chrome**: toolbar build/teardown attribute restore, tooltip binding,
  Send presence by `annotateSend`, viewbar hide/restore on mode toggle
  (extends `mount-wiring.test.js`).

## Release

`package.json` minor bump on this branch as part of the PR (the publish
workflow ships it on merge). partforge-cloud follows up separately: consume
v3 (`elements`) when it bumps the dep, and its prompt corpus regenerates
against the installed package.
