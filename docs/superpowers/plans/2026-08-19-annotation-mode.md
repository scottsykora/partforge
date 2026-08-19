# Annotation Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A viewbar-launched annotation mode: freehand ink over the frozen 3D view, sent to the host via `onAnnotationSend` as a versioned payload (vector strokes + transparent PNG + model JPEG + camera in two frames + raycast anchors).

**Architecture:** Four-layer split mirroring measure mode — pure stroke model (`ink.js`), canvas renderer (`ink-canvas.js`), orchestrator (`annotate-mode.js`), viewbar chrome (`annotate-controls.js`) — wired into `mount.js` with a `NOOP_ANNOTATE`-defaulted `runtime.annotate` sub-object. The ink layer is a transparent 2D `<canvas>` overlay appended to the stage; because it owns the pointer while the mode is on, orbit controls freeze with zero viewer changes.

**Tech Stack:** Plain ESM, three.js (existing), vitest + happy-dom for tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-18-annotation-mode-design.md` — read it first; every decision below traces to it.

## Global Constraints

- **Node 24 required** (`.nvmrc`). If `node --version` isn't v24, prefix the pinned Node: `export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | grep v24 | tail -1)/bin:$PATH"` (sourcing nvm.sh is blocked in the sandbox).
- All framework code is DOM-tolerant plain ESM; `src/framework/annotate/` is main-thread-only and must never be imported from the worker graph.
- Every attach function returns `{ detach }`; every subscribe returns an unsubscribe; detach/dispose are idempotent (`let detached = false` guard).
- Framework-created classes/ids use the `pf-` prefix.
- Chrome no-ops without its button and restores captured host attributes via `src/framework/teardown.js` helpers.
- Tests: `// @vitest-environment happy-dom` header for DOM tests; happy-dom has **no canvas 2D context** — 2D-context acquisition must be injectable.
- Commit after every green test cycle. Do not run `npm publish` or tag; the version bump in Task 6 is the release mechanism.

---

### Task 1: `ink.js` — pure stroke model

**Files:**
- Create: `src/framework/annotate/ink.js`
- Test: `test/framework/annotate/ink.test.js`

**Interfaces:**
- Consumes: nothing (pure leaf, no imports).
- Produces (used by Tasks 2–3):
  - `DEFAULT_STROKE_WIDTH` (number, fraction of viewport short edge, `0.004`)
  - `diagDistance(a, b, aspect)` → distance between normalized points in viewport-diagonal units
  - `createInkStore({ minDistance? })` → `{ begin(nx, ny, { width, aspect }), extend(nx, ny), end(), strokes(), isEmpty(), strokeCount(), undo(), clear(), onChange(cb) → off }`
  - `pointAt(points, t, aspect)` → `[nx, ny]` by arc length
  - `isClosedStroke(points, aspect)` → boolean (endpoints within 5% of viewport diagonal)
  - `strokeCentroid(points)` → `[nx, ny]` (area-weighted, point-average fallback)
  - `anchorSpecs(points, aspect)` → `[{ t, screen } | { kind: "centroid", screen }]`

- [ ] **Step 1: Write the failing tests**

```js
// test/framework/annotate/ink.test.js
// Pure stroke model: thinning, undo/clear, closed-stroke detection, anchors.
import { expect, test } from "vitest";
import {
  createInkStore, diagDistance, pointAt, isClosedStroke, strokeCentroid,
  anchorSpecs, DEFAULT_STROKE_WIDTH,
} from "../../../src/framework/annotate/ink.js";

test("diagDistance measures in viewport-diagonal units", () => {
  // square viewport: corner to corner is exactly 1 diagonal
  expect(diagDistance([0, 0], [1, 1], 1)).toBeCloseTo(1);
  // wide viewport (aspect 2): a full horizontal run is 2/sqrt(5) of the diagonal
  expect(diagDistance([0, 0], [1, 0], 2)).toBeCloseTo(2 / Math.hypot(2, 1));
});

test("extend thins points closer than minDistance", () => {
  const ink = createInkStore({ minDistance: 0.01 });
  ink.begin(0.5, 0.5, { aspect: 1 });
  ink.extend(0.5005, 0.5);   // sub-threshold: dropped
  ink.extend(0.52, 0.5);     // kept
  ink.end();
  expect(ink.strokes()[0].points).toEqual([[0.5, 0.5], [0.52, 0.5]]);
});

test("a click without movement keeps a one-point stroke (a dot)", () => {
  const ink = createInkStore();
  ink.begin(0.3, 0.3, {});
  ink.end();
  expect(ink.strokeCount()).toBe(1);
  expect(ink.strokes()[0].points).toEqual([[0.3, 0.3]]);
  expect(ink.strokes()[0].width).toBe(DEFAULT_STROKE_WIDTH);
});

test("undo removes the last stroke; clear removes all; both notify", () => {
  const ink = createInkStore();
  let calls = 0;
  const off = ink.onChange(() => { calls += 1; });
  ink.begin(0.1, 0.1, {}); ink.end();
  ink.begin(0.2, 0.2, {}); ink.end();
  expect(ink.strokeCount()).toBe(2);
  ink.undo();
  expect(ink.strokeCount()).toBe(1);
  ink.clear();
  expect(ink.isEmpty()).toBe(true);
  expect(calls).toBe(6); // begin, end, begin, end, undo, clear
  off();
  ink.begin(0.5, 0.5, {});
  expect(calls).toBe(6); // unsubscribed: no further notifications
});

test("strokes() returns copies — mutating them cannot corrupt the store", () => {
  const ink = createInkStore();
  ink.begin(0.1, 0.1, {}); ink.end();
  const out = ink.strokes();
  out[0].points[0][0] = 99;
  expect(ink.strokes()[0].points[0][0]).toBe(0.1);
});

test("pointAt walks arc length, not index", () => {
  // Three points, but the first segment is 9× longer than the second:
  // the halfway point by arc length sits inside the first segment.
  const points = [[0, 0], [0.9, 0], [1.0, 0]];
  expect(pointAt(points, 0.5, 1)[0]).toBeCloseTo(0.5);
  expect(pointAt(points, 0, 1)).toEqual([0, 0]);
  expect(pointAt(points, 1, 1)).toEqual([1.0, 0]);
});

test("isClosedStroke: endpoints within 5% of the diagonal close the stroke", () => {
  const closed = [[0.5, 0.3], [0.7, 0.5], [0.5, 0.7], [0.3, 0.5], [0.51, 0.31]];
  const open = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9]];
  expect(isClosedStroke(closed, 1)).toBe(true);
  expect(isClosedStroke(open, 1)).toBe(false);
  expect(isClosedStroke([[0.1, 0.1], [0.1, 0.1]], 1)).toBe(false); // <3 points never closes
});

test("strokeCentroid: area-weighted for loops, point-average for degenerate", () => {
  const square = [[0, 0], [1, 0], [1, 1], [0, 1]];
  expect(strokeCentroid(square)[0]).toBeCloseTo(0.5);
  expect(strokeCentroid(square)[1]).toBeCloseTo(0.5);
  const line = [[0, 0], [1, 0]]; // zero area
  expect(strokeCentroid(line)).toEqual([0.5, 0]);
});

test("anchorSpecs: start/mid/end for open strokes, + centroid for closed", () => {
  const open = [[0.1, 0.1], [0.5, 0.1], [0.9, 0.1]];
  const specs = anchorSpecs(open, 1);
  expect(specs.map((s) => s.t)).toEqual([0, 0.5, 1]);
  const closed = [[0.5, 0.3], [0.7, 0.5], [0.5, 0.7], [0.3, 0.5], [0.5, 0.3]];
  const closedSpecs = anchorSpecs(closed, 1);
  expect(closedSpecs).toHaveLength(4);
  expect(closedSpecs[3].kind).toBe("centroid");
  expect(closedSpecs[3].screen[0]).toBeCloseTo(0.5);
  // a dot gets exactly one anchor
  expect(anchorSpecs([[0.2, 0.2]], 1)).toEqual([{ t: 0, screen: [0.2, 0.2] }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/framework/annotate/ink.test.js`
Expected: FAIL — cannot resolve `../../../src/framework/annotate/ink.js`.

- [ ] **Step 3: Implement `ink.js`**

```js
// Pure stroke model for annotation mode: normalized-coordinate polylines with
// point thinning while drawing, undo/clear, closed-stroke detection and anchor
// selection. No DOM, no three — unit-testable directly (the feature-dims.js
// stance). Points are [nx, ny] normalized 0..1 per viewport axis; distances
// are measured in viewport-DIAGONAL units so thresholds mean the same thing
// horizontally and vertically regardless of aspect.

// Stroke width as a fraction of the viewport's short edge (spec: payload
// carries this unit so any re-render can reproduce line weight).
export const DEFAULT_STROKE_WIDTH = 0.004;
// Spec: endpoints within 5% of the viewport diagonal = closed stroke.
const CLOSED_THRESHOLD = 0.05;
// pointermove fires per-pixel; keep only points this far (in diagonal units)
// from the previous kept point. ~2px at 1080p.
const MIN_POINT_DISTANCE = 0.0015;

export function diagDistance(a, b, aspect = 1) {
  const dx = (a[0] - b[0]) * aspect;
  const dy = a[1] - b[1];
  return Math.hypot(dx, dy) / Math.hypot(aspect, 1);
}

export function createInkStore({ minDistance = MIN_POINT_DISTANCE } = {}) {
  const strokes = [];
  let active = null;
  const listeners = new Set();
  const notify = () => { for (const cb of [...listeners]) cb(); };
  return {
    begin(nx, ny, { width = DEFAULT_STROKE_WIDTH, aspect = 1 } = {}) {
      active = { points: [[nx, ny]], width, aspect };
      strokes.push(active);
      notify();
    },
    extend(nx, ny) {
      if (!active) return;
      const last = active.points[active.points.length - 1];
      if (diagDistance([nx, ny], last, active.aspect) < minDistance) return;
      active.points.push([nx, ny]);
      notify();
    },
    end() {
      if (!active) return;
      active = null; // one-point strokes stay: a click leaves a visible dot
      notify();
    },
    strokes: () => strokes.map((s) => ({ points: s.points.map((p) => [...p]), width: s.width })),
    isEmpty: () => strokes.length === 0,
    strokeCount: () => strokes.length,
    undo() {
      if (!strokes.length) return;
      strokes.pop();
      active = null;
      notify();
    },
    clear() {
      if (!strokes.length && !active) return;
      strokes.length = 0;
      active = null;
      notify();
    },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  };
}

export function pointAt(points, t, aspect = 1) {
  if (points.length === 1) return [...points[0]];
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    lengths.push(lengths[i - 1] + diagDistance(points[i], points[i - 1], aspect));
  }
  const total = lengths[lengths.length - 1];
  if (total === 0) return [...points[0]];
  const target = t * total;
  let i = 1;
  while (i < lengths.length - 1 && lengths[i] < target) i++;
  const span = lengths[i] - lengths[i - 1];
  const f = span === 0 ? 0 : (target - lengths[i - 1]) / span;
  const [ax, ay] = points[i - 1];
  const [bx, by] = points[i];
  return [ax + (bx - ax) * f, ay + (by - ay) * f];
}

export function isClosedStroke(points, aspect = 1) {
  if (points.length < 3) return false;
  return diagDistance(points[0], points[points.length - 1], aspect) <= CLOSED_THRESHOLD;
}

// Area-weighted polygon centroid (shoelace); for a degenerate (near-zero-area)
// point set, fall back to the plain point average.
export function strokeCentroid(points) {
  let area2 = 0, cx = 0, cy = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    const cross = x0 * y1 - x1 * y0;
    area2 += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(area2) < 1e-9) {
    let sx = 0, sy = 0;
    for (const [x, y] of points) { sx += x; sy += y; }
    return [sx / points.length, sy / points.length];
  }
  return [cx / (3 * area2), cy / (3 * area2)];
}

// Anchor sample points for one stroke: start / arc-length-midpoint / end, plus
// the enclosed-region centroid when the stroke closes on itself ("what did
// they circle"). A one-point dot gets a single anchor. The orchestrator turns
// each spec's normalized `screen` point into a raycast.
export function anchorSpecs(points, aspect = 1) {
  if (points.length === 0) return [];
  if (points.length === 1) return [{ t: 0, screen: [...points[0]] }];
  const specs = [
    { t: 0, screen: [...points[0]] },
    { t: 0.5, screen: pointAt(points, 0.5, aspect) },
    { t: 1, screen: [...points[points.length - 1]] },
  ];
  if (isClosedStroke(points, aspect)) {
    specs.push({ kind: "centroid", screen: strokeCentroid(points) });
  }
  return specs;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/framework/annotate/ink.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/annotate/ink.js test/framework/annotate/ink.test.js
git commit -m "feat(annotate): pure stroke model — thinning, undo, closed detection, anchors"
```

---

### Task 2: `ink-canvas.js` — overlay canvas renderer

**Files:**
- Create: `src/framework/annotate/ink-canvas.js`
- Modify: `src/framework/chrome.css` (append `.pf-ink-canvas` layout rules)
- Test: `test/framework/annotate/ink-canvas.test.js`

**Interfaces:**
- Consumes: `runCleanupSteps` from `src/framework/teardown.js`.
- Produces (used by Task 3): `createInkCanvas(stage, { getContext2d? })` → `{ element, show(), hide(), setStrokes(strokes), toDataUrl(), size() → { width, height, dpr }, dispose() }`. `getContext2d` defaults to `(canvas) => canvas.getContext("2d")` and is injectable because happy-dom has no 2D context (the `dim3-scene.js` `paintLabel` pattern).

- [ ] **Step 1: Write the failing tests**

```js
// @vitest-environment happy-dom
// Overlay canvas renderer: DOM lifecycle, halo+core draw passes, PNG export.
import { afterEach, expect, test, vi } from "vitest";
import { createInkCanvas } from "../../../src/framework/annotate/ink-canvas.js";

afterEach(() => { document.body.innerHTML = ""; });

function fakeCtx() {
  return {
    calls: [],
    clearRect(...a) { this.calls.push(["clearRect", ...a]); },
    beginPath() { this.calls.push(["beginPath"]); },
    moveTo(...a) { this.calls.push(["moveTo", ...a]); },
    lineTo(...a) { this.calls.push(["lineTo", ...a]); },
    arc(...a) { this.calls.push(["arc", ...a]); },
    fill() { this.calls.push(["fill"]); },
    stroke() { this.calls.push(["stroke", this.strokeStyle, this.lineWidth]); },
  };
}

function fixture() {
  const stage = document.createElement("div");
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100 });
  document.body.appendChild(stage);
  const ctx = fakeCtx();
  const canvas = createInkCanvas(stage, { getContext2d: () => ctx });
  return { stage, ctx, canvas };
}

test("mounts hidden inside the stage with the pf- class", () => {
  const { stage, canvas } = fixture();
  expect(canvas.element.parentElement).toBe(stage);
  expect(canvas.element.className).toBe("pf-ink-canvas");
  expect(canvas.element.hidden).toBe(true);
});

test("show() sizes the bitmap to the stage rect × dpr and unhides", () => {
  const { canvas } = fixture();
  canvas.show();
  expect(canvas.element.hidden).toBe(false);
  const { width, height, dpr } = canvas.size();
  expect(width).toBe(Math.round(200 * dpr));
  expect(height).toBe(Math.round(100 * dpr));
});

test("setStrokes draws two passes per stroke: halo then core", () => {
  const { ctx, canvas } = fixture();
  canvas.show();
  ctx.calls.length = 0;
  canvas.setStrokes([{ points: [[0, 0], [1, 1]], width: 0.01 }]);
  const strokeCalls = ctx.calls.filter(([op]) => op === "stroke");
  expect(strokeCalls).toHaveLength(2);
  // halo pass is wider than the core pass
  expect(strokeCalls[0][2]).toBeGreaterThan(strokeCalls[1][2]);
  // and a different color
  expect(strokeCalls[0][1]).not.toBe(strokeCalls[1][1]);
});

test("a one-point stroke draws as a filled dot, twice (halo + core)", () => {
  const { ctx, canvas } = fixture();
  canvas.show();
  ctx.calls.length = 0;
  canvas.setStrokes([{ points: [[0.5, 0.5]], width: 0.01 }]);
  expect(ctx.calls.filter(([op]) => op === "arc")).toHaveLength(2);
  expect(ctx.calls.filter(([op]) => op === "fill")).toHaveLength(2);
});

test("dispose removes the element and is idempotent", () => {
  const { stage, canvas } = fixture();
  canvas.dispose();
  canvas.dispose();
  expect(stage.querySelector(".pf-ink-canvas")).toBe(null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/framework/annotate/ink-canvas.test.js`
Expected: FAIL — cannot resolve `ink-canvas.js`.

- [ ] **Step 3: Implement `ink-canvas.js`**

```js
// The annotation ink layer: a transparent 2D canvas stacked over the viewer
// canvas (the first screen-space overlay canvas in the framework — everything
// else that follows the model is in-scene, see dim3-scene.js). Appended to the
// STAGE, not document.body, so it lives in .pf-stage's positioning context and
// behaves under the narrow-pane layout. While visible it owns all pointer
// events, which is what freezes orbit controls during annotation — no viewer
// changes needed. Strokes render dark-core-over-light-halo so ink reads on
// both themes and any model color.
import { runCleanupSteps } from "../teardown.js";

const CORE_COLOR = "#d92d20";
const HALO_COLOR = "rgba(255, 255, 255, 0.85)";
const HALO_RATIO = 2.2; // halo pass width relative to the core width

export function createInkCanvas(stage, { getContext2d = (canvas) => canvas.getContext("2d") } = {}) {
  const canvas = document.createElement("canvas");
  canvas.className = "pf-ink-canvas";
  canvas.hidden = true;
  stage.appendChild(canvas);
  const ctx = getContext2d(canvas);
  let strokes = [];

  function drawPass(color, widthScale) {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const short = Math.min(canvas.width, canvas.height);
    for (const stroke of strokes) {
      const w = stroke.width * short * widthScale;
      if (stroke.points.length === 1) {
        const [nx, ny] = stroke.points[0];
        ctx.beginPath();
        ctx.arc(nx * canvas.width, ny * canvas.height, w / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.lineWidth = w;
      ctx.beginPath();
      stroke.points.forEach(([nx, ny], i) => {
        const x = nx * canvas.width;
        const y = ny * canvas.height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }

  function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawPass(HALO_COLOR, HALO_RATIO);
    drawPass(CORE_COLOR, 1);
  }

  function resize() {
    const rect = stage.getBoundingClientRect();
    const dpr = globalThis.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    draw();
  }

  // The viewer's own ResizeObserver is internal (viewer.js exposes no resize
  // hook), so the overlay runs its own — ink is normalized, so a resize is
  // just a re-rasterize at the new bitmap size.
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
  observer?.observe(stage);

  let disposed = false;
  return {
    element: canvas,
    show() { canvas.hidden = false; resize(); },
    hide() { canvas.hidden = true; },
    setStrokes(next) { strokes = next; draw(); },
    toDataUrl: () => canvas.toDataURL("image/png"),
    size: () => ({ width: canvas.width, height: canvas.height, dpr: globalThis.devicePixelRatio || 1 }),
    dispose() {
      if (disposed) return;
      disposed = true;
      runCleanupSteps([
        () => observer?.disconnect(),
        () => canvas.remove(),
      ], "ink canvas cleanup failed");
    },
  };
}
```

- [ ] **Step 4: Append the layout rules to `src/framework/chrome.css`**

At the end of the file (`.pf-stage` is `position: relative`, so `inset: 0` fills the stage; z-index 10 sits above the viewer canvas but below `#viewbar`'s 15 and `#busy`'s 20):

```css
/* ---- annotation ink layer: a transparent 2D canvas over the viewer --------
   Shown only while annotation mode is on. It deliberately owns pointer events
   while visible — that is what freezes orbit/pan/zoom during drawing. Below
   the viewbar (z 15) so Undo/Clear/Send stay clickable. */
.pf-ink-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 10;
  cursor: crosshair;
  touch-action: none;
}
.pf-ink-canvas[hidden] { display: none; }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/framework/annotate/ink-canvas.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/framework/annotate/ink-canvas.js src/framework/chrome.css test/framework/annotate/ink-canvas.test.js
git commit -m "feat(annotate): overlay ink canvas — halo/core rendering, resize, PNG export"
```

---

### Task 3: `annotate-mode.js` — orchestrator

**Files:**
- Create: `src/framework/annotate/annotate-mode.js`
- Test: `test/framework/annotate/annotate-mode.test.js`

**Interfaces:**
- Consumes: `createInkStore`, `anchorSpecs`, `DEFAULT_STROKE_WIDTH` (Task 1); `createInkCanvas` (Task 2, injectable as `createCanvas` for tests); `raycastViewer(viewer, clientX, clientY)` from `src/framework/selection/raycast.js` (returns `{ subPart, pointLocal, ... }` or `null`); viewer surface: `getCameraState()`, `camera` (raw THREE camera: `.up`, `.fov`), `_subMeshes`, `captureCurrent(opts)`.
- Produces (used by Tasks 4–5):
  - `ANNOTATION_VERSION` = `1`
  - `createAnnotateMode(viewer, { stage, getContext, onSend, createCanvas? })` → `{ setEnabled(on), isEnabled(), undo(), clear(), strokeCount(), send() → boolean, onInkChange(cb) → off, onModeChange(cb) → off, detach() }`
  - `getContext` is the late-bound `() => ({ view, params })` thunk (mount.js idiom).

- [ ] **Step 1: Write the failing tests**

```js
// @vitest-environment happy-dom
// Orchestrator: pointer → ink, enter/exit lifecycle, payload assembly, and the
// send-abort-on-null-capture contract.
import { afterEach, expect, test, vi } from "vitest";
import * as THREE from "three";
import { createAnnotateMode, ANNOTATION_VERSION } from "../../../src/framework/annotate/annotate-mode.js";

afterEach(() => { document.body.innerHTML = ""; });

const RECT = { left: 10, top: 20, width: 200, height: 100 };

function fakeCanvas() {
  const element = document.createElement("canvas");
  element.getBoundingClientRect = () => RECT;
  document.body.appendChild(element);
  return {
    element,
    show: vi.fn(),
    hide: vi.fn(),
    setStrokes: vi.fn(),
    toDataUrl: () => "data:image/png;base64,INK",
    size: () => ({ width: 400, height: 200, dpr: 2 }),
    dispose: vi.fn(),
  };
}

function fakeViewer(over = {}) {
  const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 1000);
  camera.position.set(0, 0, 10);
  return {
    camera,
    domElement: document.createElement("canvas"),
    _subMeshes: {},
    getCameraState: () => ({ pos: [0, 0, 10], target: [0, 0, 0] }),
    captureCurrent: vi.fn(() => "data:image/jpeg;base64,MODEL"),
    ...over,
  };
}

function fixture(over = {}) {
  const stage = document.createElement("div");
  document.body.appendChild(stage);
  const canvas = fakeCanvas();
  const viewer = fakeViewer(over.viewer);
  const onSend = vi.fn();
  const mode = createAnnotateMode(viewer, {
    stage,
    getContext: () => ({ view: "main", params: { size: 42 } }),
    onSend,
    createCanvas: () => canvas,
    ...over.opts,
  });
  return { stage, canvas, viewer, onSend, mode };
}

function pointer(type, clientX, clientY) {
  const e = new MouseEvent(type, { clientX, clientY, bubbles: true });
  return e;
}

function drawStroke(canvas, from = [60, 45], to = [110, 70]) {
  canvas.element.dispatchEvent(pointer("pointerdown", from[0], from[1]));
  canvas.element.dispatchEvent(pointer("pointermove", to[0], to[1]));
  canvas.element.dispatchEvent(pointer("pointerup", to[0], to[1]));
}

test("enable shows the canvas; drawing normalizes against the canvas rect", () => {
  const { canvas, mode } = fixture();
  mode.setEnabled(true);
  expect(canvas.show).toHaveBeenCalled();
  drawStroke(canvas, [60, 45], [110, 70]); // rect left=10 top=20 w=200 h=100
  expect(mode.strokeCount()).toBe(1);
  const strokes = canvas.setStrokes.mock.calls.at(-1)[0];
  expect(strokes[0].points[0]).toEqual([0.25, 0.25]);
  expect(strokes[0].points.at(-1)).toEqual([0.5, 0.5]);
});

test("exit discards ink and hides the canvas", () => {
  const { canvas, mode } = fixture();
  mode.setEnabled(true);
  drawStroke(canvas);
  mode.setEnabled(false);
  expect(mode.strokeCount()).toBe(0);
  expect(canvas.hide).toHaveBeenCalled();
});

test("send assembles the payload, calls onSend, exits, and clears", () => {
  const { canvas, viewer, onSend, mode } = fixture();
  mode.setEnabled(true);
  drawStroke(canvas);
  expect(mode.send()).toBe(true);
  expect(onSend).toHaveBeenCalledTimes(1);
  const payload = onSend.mock.calls[0][0];
  expect(payload.version).toBe(ANNOTATION_VERSION);
  expect(payload.strokes).toHaveLength(1);
  expect(payload.images).toEqual({ drawing: "data:image/png;base64,INK", model: "data:image/jpeg;base64,MODEL" });
  expect(payload.camera.world).toEqual({ pos: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov: 45 });
  expect(payload.camera.parts).toBe(null); // no meshes in the stub viewer
  expect(payload.viewport).toEqual({ width: 200, height: 100, dpr: 2 });
  expect(payload.context).toEqual({ view: "main", params: { size: 42 } });
  // anchors: one open stroke → t = 0 / 0.5 / 1, all misses (empty scene)
  expect(payload.anchors.map((a) => a.t)).toEqual([0, 0.5, 1]);
  expect(payload.anchors.every((a) => a.hit === null)).toBe(true);
  expect(payload.anchors[0].stroke).toBe(0);
  // capture size follows the ink bitmap's long edge
  expect(viewer.captureCurrent).toHaveBeenCalledWith({ size: 400 });
  // sent → mode exits and ink clears
  expect(mode.isEnabled()).toBe(false);
  expect(mode.strokeCount()).toBe(0);
});

test("send aborts (ink intact, still enabled) when captureCurrent returns null", () => {
  const { canvas, onSend, mode } = fixture({
    viewer: { captureCurrent: vi.fn(() => null) },
  });
  mode.setEnabled(true);
  drawStroke(canvas);
  expect(mode.send()).toBe(false);
  expect(onSend).not.toHaveBeenCalled();
  expect(mode.isEnabled()).toBe(true);
  expect(mode.strokeCount()).toBe(1);
});

test("send with no ink is a no-op", () => {
  const { onSend, mode } = fixture();
  mode.setEnabled(true);
  expect(mode.send()).toBe(false);
  expect(onSend).not.toHaveBeenCalled();
});

test("payload params are a snapshot, not the live object", () => {
  const params = { size: 1 };
  const { canvas, onSend, mode } = fixture({
    opts: { getContext: () => ({ view: "main", params }) },
  });
  mode.setEnabled(true);
  drawStroke(canvas);
  mode.send();
  params.size = 2;
  expect(onSend.mock.calls[0][0].context.params.size).toBe(1);
});

test("detach disposes the canvas and is idempotent", () => {
  const { canvas, mode } = fixture();
  mode.setEnabled(true);
  mode.detach();
  mode.detach();
  expect(canvas.dispose).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/framework/annotate/annotate-mode.test.js`
Expected: FAIL — cannot resolve `annotate-mode.js`.

- [ ] **Step 3: Implement `annotate-mode.js`**

```js
// Annotation-mode orchestrator — the one annotate module touching both the DOM
// and the viewer (the measure-mode.js stance). Owns pointer→ink, the mode
// lifecycle, and payload assembly. The overlay canvas is lazy-created on first
// enable and kept across toggles; INK is not — exiting the mode discards it,
// because screen-space ink is only meaningful against the camera pose it was
// drawn over (deliberately unlike measure pins).
import * as THREE from "three";
import { createInkStore, anchorSpecs, DEFAULT_STROKE_WIDTH } from "./ink.js";
import { createInkCanvas } from "./ink-canvas.js";
import { raycastViewer } from "../selection/raycast.js";

export const ANNOTATION_VERSION = 1;

export function createAnnotateMode(viewer, { stage, getContext, onSend, createCanvas = createInkCanvas } = {}) {
  const ink = createInkStore();
  let canvas = null; // lazy; created on first enable
  let enabled = false;
  let drawing = false;
  const modeListeners = new Set();
  const notifyMode = () => { for (const cb of [...modeListeners]) cb(); };
  const offInk = ink.onChange(() => canvas?.setStrokes(ink.strokes()));

  const rectOf = () => canvas.element.getBoundingClientRect();
  const normalized = (event, rect) => [
    Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  ];

  // isPrimary === false (a second simultaneous touch) is ignored; undefined
  // (plain MouseEvent, some test environments) draws normally.
  const onPointerDown = (event) => {
    if (event.isPrimary === false || drawing) return;
    const rect = rectOf();
    if (!rect.width || !rect.height) return;
    drawing = true;
    canvas.element.setPointerCapture?.(event.pointerId);
    const [nx, ny] = normalized(event, rect);
    ink.begin(nx, ny, { width: DEFAULT_STROKE_WIDTH, aspect: rect.width / rect.height });
  };
  const onPointerMove = (event) => {
    if (!drawing || event.isPrimary === false) return;
    const [nx, ny] = normalized(event, rectOf());
    ink.extend(nx, ny);
  };
  const onPointerEnd = (event) => {
    if (!drawing || event.isPrimary === false) return;
    drawing = false;
    ink.end();
  };

  function ensureCanvas() {
    if (canvas) return;
    canvas = createCanvas(stage);
    canvas.element.addEventListener("pointerdown", onPointerDown);
    canvas.element.addEventListener("pointermove", onPointerMove);
    canvas.element.addEventListener("pointerup", onPointerEnd);
    canvas.element.addEventListener("pointercancel", onPointerEnd);
  }

  function setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    if (on) {
      ensureCanvas();
      canvas.show();
    } else {
      drawing = false;
      ink.clear(); // spec: ink never survives an exit
      canvas?.hide();
    }
    notifyMode();
  }

  // The camera pose in two frames. World replays exactly against THIS build;
  // the parts frame (through the inverse of the shared parts parent's
  // matrixWorld — the measure-mode idiom) stays pinned to the CAD geometry, so
  // it survives the per-view bbox recentring when the model is rebuilt later.
  function cameraBlock() {
    const { pos, target } = viewer.getCameraState();
    const world = { pos, target, up: viewer.camera.up.toArray(), fov: viewer.camera.fov };
    const parent = Object.values(viewer._subMeshes ?? {})[0]?.parent ?? null;
    if (!parent) return { world, parts: null };
    parent.updateWorldMatrix(true, false);
    const inv = parent.matrixWorld.clone().invert();
    const map = (v) => new THREE.Vector3(v[0], v[1], v[2]).applyMatrix4(inv).toArray();
    const up = new THREE.Vector3(world.up[0], world.up[1], world.up[2]).transformDirection(inv).toArray();
    return { world, parts: { pos: map(world.pos), target: map(world.target), up, fov: world.fov } };
  }

  function send() {
    if (!enabled || ink.isEmpty()) return false;
    const rect = rectOf();
    if (!rect.width || !rect.height) return false;
    const { width, height, dpr } = canvas.size();
    // Model render FIRST: on a lost WebGL context captureCurrent returns null
    // and we abort with the ink intact — nothing is silently dropped.
    const model = viewer.captureCurrent({ size: Math.max(width, height) });
    if (!model) return false;
    const strokes = ink.strokes();
    const aspect = rect.width / rect.height;
    const anchors = strokes.flatMap((stroke, index) =>
      anchorSpecs(stroke.points, aspect).map((spec) => {
        const hit = raycastViewer(
          viewer,
          rect.left + spec.screen[0] * rect.width,
          rect.top + spec.screen[1] * rect.height,
        );
        return {
          stroke: index,
          ...(spec.kind ? { kind: spec.kind } : { t: spec.t }),
          screen: spec.screen,
          // a miss is kept as null — "circled empty space" is signal
          hit: hit ? { subPart: hit.subPart, pointLocal: hit.pointLocal } : null,
        };
      }));
    const { view, params } = getContext();
    onSend?.({
      version: ANNOTATION_VERSION,
      strokes,
      anchors,
      images: { drawing: canvas.toDataUrl(), model },
      camera: cameraBlock(),
      viewport: { width: rect.width, height: rect.height, dpr },
      context: { view, params: { ...params } },
    });
    setEnabled(false); // sent: exit and discard
    return true;
  }

  let detached = false;
  return {
    setEnabled,
    isEnabled: () => enabled,
    undo: () => ink.undo(),
    clear: () => ink.clear(),
    strokeCount: () => ink.strokeCount(),
    send,
    onInkChange: (cb) => ink.onChange(cb),
    onModeChange: (cb) => { modeListeners.add(cb); return () => modeListeners.delete(cb); },
    detach() {
      if (detached) return;
      detached = true;
      offInk();
      if (!canvas) return;
      canvas.element.removeEventListener("pointerdown", onPointerDown);
      canvas.element.removeEventListener("pointermove", onPointerMove);
      canvas.element.removeEventListener("pointerup", onPointerEnd);
      canvas.element.removeEventListener("pointercancel", onPointerEnd);
      canvas.dispose();
    },
  };
}
```

Note: `raycastViewer` reads `viewer.domElement.getBoundingClientRect()` and `viewer.camera` internally and filters `viewer._subMeshes` to visible meshes — with the stub viewer's empty `_subMeshes` it returns `null`, which is exactly what the tests assert.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/framework/annotate/annotate-mode.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/annotate/annotate-mode.js test/framework/annotate/annotate-mode.test.js
git commit -m "feat(annotate): orchestrator — pointer→ink, send-time payload with two-frame camera and anchors"
```

---

### Task 4: `annotate-controls.js` — viewbar chrome

**Files:**
- Create: `src/framework/annotate/annotate-controls.js`
- Modify: `src/framework/app.css` (`.pf-annotate-actions` appearance rules)
- Test: `test/framework/annotate/annotate-controls.test.js`

**Interfaces:**
- Consumes: the Task 3 mode surface (`isEnabled/setEnabled/undo/clear/strokeCount/send/onInkChange/onModeChange`); `attachButtonTooltips` from `src/framework/tooltip.js`; teardown helpers.
- Produces (used by Task 5): `attachAnnotateControls(viewer, mode, { annotate: button } = {}, { tooltip, escapeScope } = {}) → { detach }`. Contract: no button → inert no-op; button but `mode === null` (host passed no `onAnnotationSend`) → the button is hidden and restored on detach.

- [ ] **Step 1: Write the failing tests**

```js
// @vitest-environment happy-dom
// Viewbar chrome for annotation mode. Mirrors measure-controls.test.js:
// attach/detach round-trip, aria-pressed, action gating, Escape consumption.
import { afterEach, expect, test, vi } from "vitest";
import { attachAnnotateControls } from "../../../src/framework/annotate/annotate-controls.js";

afterEach(() => { document.body.innerHTML = ""; });

function fakeMode(over = {}) {
  const inkCbs = new Set();
  const modeCbs = new Set();
  let enabled = false;
  let strokes = 0;
  return {
    setEnabled: vi.fn((on) => { enabled = on; for (const cb of modeCbs) cb(); }),
    isEnabled: () => enabled,
    undo: vi.fn(() => { if (strokes) strokes -= 1; for (const cb of inkCbs) cb(); }),
    clear: vi.fn(() => { strokes = 0; for (const cb of inkCbs) cb(); }),
    strokeCount: () => strokes,
    send: vi.fn(() => strokes > 0),
    onInkChange: (cb) => { inkCbs.add(cb); return () => inkCbs.delete(cb); },
    onModeChange: (cb) => { modeCbs.add(cb); return () => modeCbs.delete(cb); },
    __setStrokes: (n) => { strokes = n; for (const cb of inkCbs) cb(); },
    ...over,
  };
}

function fixture() {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const button = document.createElement("button");
  document.body.appendChild(button);
  return { canvas, button, viewer: { domElement: canvas } };
}

test("no button -> inert no-op", () => {
  const { viewer } = fixture();
  const chrome = attachAnnotateControls(viewer, fakeMode(), {});
  expect(() => chrome.detach()).not.toThrow();
});

test("button without a mode (no onAnnotationSend) is hidden, restored on detach", () => {
  const { viewer, button } = fixture();
  const chrome = attachAnnotateControls(viewer, null, { annotate: button });
  expect(button.hidden).toBe(true);
  chrome.detach();
  expect(button.hidden).toBe(false);
});

test("toggle drives aria-pressed and reveals the actions row", () => {
  const { viewer, button } = fixture();
  const mode = fakeMode();
  attachAnnotateControls(viewer, mode, { annotate: button });
  expect(button.getAttribute("aria-pressed")).toBe("false");
  button.click();
  expect(mode.setEnabled).toHaveBeenCalledWith(true);
  expect(button.getAttribute("aria-pressed")).toBe("true");
  const actions = document.querySelector(".pf-annotate-actions");
  expect(actions.hidden).toBe(false);
  button.click();
  expect(actions.hidden).toBe(true);
});

test("Undo/Clear/Send disable while the canvas is empty, enable with ink", () => {
  const { viewer, button } = fixture();
  const mode = fakeMode();
  attachAnnotateControls(viewer, mode, { annotate: button });
  button.click(); // enable
  const [undoBtn, clearBtn, sendBtn] = document.querySelectorAll(".pf-annotate-actions button");
  expect(sendBtn.textContent).toBe("Send");
  expect(undoBtn.disabled && clearBtn.disabled && sendBtn.disabled).toBe(true);
  mode.__setStrokes(2);
  expect(undoBtn.disabled || clearBtn.disabled || sendBtn.disabled).toBe(false);
  sendBtn.click();
  expect(mode.send).toHaveBeenCalledTimes(1);
  undoBtn.click();
  expect(mode.undo).toHaveBeenCalledTimes(1);
  clearBtn.click();
  expect(mode.clear).toHaveBeenCalledTimes(1);
});

test("Escape exits the mode and consumes the keystroke", () => {
  const { viewer, button, canvas } = fixture();
  const mode = fakeMode();
  attachAnnotateControls(viewer, mode, { annotate: button });
  button.click(); // enable
  const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
  const stopSpy = vi.spyOn(event, "stopImmediatePropagation");
  canvas.dispatchEvent(event);
  expect(mode.setEnabled).toHaveBeenLastCalledWith(false);
  expect(event.defaultPrevented).toBe(true);
  expect(stopSpy).toHaveBeenCalled();
});

test("detach restores host attributes, content and removes the actions row", () => {
  const { viewer, button } = fixture();
  button.setAttribute("title", "host title");
  button.textContent = "host";
  const chrome = attachAnnotateControls(viewer, fakeMode(), { annotate: button });
  expect(button.innerHTML).toContain("svg");
  chrome.detach();
  chrome.detach(); // idempotent
  expect(button.getAttribute("title")).toBe("host title");
  expect(button.textContent).toBe("host");
  expect(button.hasAttribute("aria-pressed")).toBe(false);
  expect(document.querySelector(".pf-annotate-actions")).toBe(null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/framework/annotate/annotate-controls.test.js`
Expected: FAIL — cannot resolve `annotate-controls.js`.

- [ ] **Step 3: Implement `annotate-controls.js`**

```js
// Viewbar chrome for annotation mode: the pencil toggle + contextual actions
// (Undo / Clear / Send) shown while the mode is on. A direct sibling of
// measure-controls.js — same no-op-without-button contract, same attribute
// restore discipline on detach. The mode object (annotate-mode.js) owns all
// behavior; this file only puts it on screen. One extra contract: a host whose
// markup HAS the button but whose mount passed no onAnnotationSend gets the
// button hidden entirely (spec: no dead Send) — mount passes mode = null.
import { attachButtonTooltips } from "../tooltip.js";
import { runCleanupSteps, captureAttributes, restoreAttributes } from "../teardown.js";

const BUTTON_ATTRIBUTES = ["type", "aria-pressed", "aria-label", "title", "disabled", "hidden"];
const PENCIL_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>`;

const noop = () => {};

export function attachAnnotateControls(viewer, mode, { annotate: button } = {}, { tooltip, escapeScope } = {}) {
  if (!button) return { detach: noop };

  const hostAttributes = captureAttributes(button, BUTTON_ATTRIBUTES);
  if (!mode) {
    button.hidden = true;
    let restored = false;
    return {
      detach() {
        if (restored) return;
        restored = true;
        restoreAttributes(button, hostAttributes);
      },
    };
  }
  const hostHtml = button.innerHTML;
  const hostOn = button.classList.contains("on");

  button.type = "button";
  button.innerHTML = PENCIL_ICON;
  button.setAttribute("aria-pressed", "false");
  if (!tooltip && !button.hasAttribute("title")) button.title = "Annotate the view";

  const actions = document.createElement("span");
  actions.className = "pf-annotate-actions";
  const undoButton = document.createElement("button");
  undoButton.type = "button";
  undoButton.textContent = "Undo";
  undoButton.title = "Remove the last stroke";
  undoButton.setAttribute("aria-label", "Remove the last stroke");
  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.textContent = "Clear";
  clearButton.title = "Remove all strokes";
  clearButton.setAttribute("aria-label", "Remove all strokes");
  const sendButton = document.createElement("button");
  sendButton.type = "button";
  sendButton.className = "pf-annotate-send";
  sendButton.textContent = "Send";
  sendButton.title = "Send the annotation";
  sendButton.setAttribute("aria-label", "Send the annotation");
  actions.append(undoButton, clearButton, sendButton);
  button.after(actions);

  const tooltipBinding = tooltip
    ? attachButtonTooltips(tooltip, [button, undoButton, clearButton, sendButton].map((element) => ({ element })))
    : null;

  function sync() {
    const on = mode.isEnabled();
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("aria-label", on ? "Stop annotating" : "Annotate the view");
    button.classList.toggle("on", on);
    actions.hidden = !on;
    const empty = mode.strokeCount() === 0;
    undoButton.disabled = empty;
    clearButton.disabled = empty;
    sendButton.disabled = empty;
    tooltipBinding?.sync();
  }

  const onToggle = () => { mode.setEnabled(!mode.isEnabled()); sync(); };
  const onUndo = () => { mode.undo(); sync(); };
  const onClear = () => { mode.clear(); sync(); };
  const onSendClick = () => { mode.send(); sync(); };
  const onEscape = (event) => {
    if (event.key !== "Escape" || !mode.isEnabled()) return;
    event.preventDefault();
    // Consume the keystroke — same order-independence contract as
    // measure-controls.js vs cutaway (which covers itself with escapeGuard;
    // mount extends that guard to include annotate).
    event.stopImmediatePropagation();
    mode.setEnabled(false);
    sync();
    tooltipBinding?.hide();
  };
  const offInk = mode.onInkChange(sync);
  const offMode = mode.onModeChange(sync);

  button.addEventListener("click", onToggle);
  undoButton.addEventListener("click", onUndo);
  clearButton.addEventListener("click", onClear);
  sendButton.addEventListener("click", onSendClick);
  const escapeTargets = [escapeScope ?? viewer.domElement, button, undoButton, clearButton, sendButton];
  for (const element of escapeTargets) element.addEventListener("keydown", onEscape);
  sync();

  let detached = false;
  return {
    detach() {
      if (detached) return;
      detached = true;
      runCleanupSteps([
        offInk,
        offMode,
        () => button.removeEventListener("click", onToggle),
        () => undoButton.removeEventListener("click", onUndo),
        () => clearButton.removeEventListener("click", onClear),
        () => sendButton.removeEventListener("click", onSendClick),
        ...escapeTargets.map((element) => () => element.removeEventListener("keydown", onEscape)),
        () => tooltipBinding?.detach(),
        () => actions.remove(),
        () => restoreAttributes(button, hostAttributes),
        () => { button.innerHTML = hostHtml; },
        () => button.classList.toggle("on", hostOn),
      ], "annotate control cleanup failed");
    },
  };
}
```

- [ ] **Step 4: Add appearance rules to `src/framework/app.css`**

Next to the `.pf-measure-actions` block (around line 323), add the same shape for annotate — the `[hidden]` guard is required because `#viewbar button { display: flex }` is author-origin and beats the UA `[hidden]` rule:

```css
#viewbar .pf-annotate-actions { display: flex; gap: 4px; }
#viewbar .pf-annotate-actions[hidden] { display: none; }
#viewbar .pf-annotate-actions button { width: auto; min-width: 56px; padding: 0 8px; }
```

And extend the existing `@media (max-width: 360px)` block (around lines 340–341) so the annotate actions shrink with the others — add `.pf-annotate-actions` to both selectors:

```css
#viewbar .pf-cutaway-actions, #viewbar .pf-measure-actions, #viewbar .pf-annotate-actions { gap: 3px; }
#viewbar .pf-cutaway-actions button, #viewbar .pf-measure-actions button, #viewbar .pf-annotate-actions button { min-width: 44px; padding: 0 6px; }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/framework/annotate/annotate-controls.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/framework/annotate/annotate-controls.js src/framework/app.css test/framework/annotate/annotate-controls.test.js
git commit -m "feat(annotate): viewbar chrome — pencil toggle, Undo/Clear/Send, Escape contract"
```

---

### Task 5: mount wiring, runtime handle, types, demo app

**Files:**
- Modify: `src/framework/mount.js` (options at `:200`, element block at `:226-233`, `NOOP_MEASURE` area at `:39`, `makeHandle` at `:52`, mode wiring after `:345`, cutaway `escapeGuard` at `:363`, hover suppression at `:367-369`, picker `suppressed` at `:395`, handle return at `:855-872`, and the embedding-contract doc comment at `:129-199`)
- Modify: `types/index.d.ts` (`MountElements.chrome`, `MountOptions`, `PartRuntime`, new interfaces)
- Modify: `demo.html` (viewbar button), `src/app-demo.js` (`onAnnotationSend`)
- Test: `test/framework/annotate/mount-wiring.test.js`

**Interfaces:**
- Consumes: `createAnnotateMode` (Task 3), `attachAnnotateControls` (Task 4).
- Produces: `mount(part, { onAnnotationSend })`; `runtime.annotate` (the Task 3 surface minus `detach`, or `NOOP_ANNOTATE` when unwired); `elements.chrome.annotate`.

- [ ] **Step 1: Write the failing wiring test**

```js
// test/framework/annotate/mount-wiring.test.js
// The handle's annotate surface: constant shape, NOOP default (the
// NOOP_MEASURE contract, extended). makeHandle is the unit seam — no WASM,
// no DOM (mount.test.js stance).
import { expect, test } from "vitest";
import { makeHandle } from "../../../src/framework/mount.js";

const stubViewer = {
  captureCanonicalViews: () => [],
  captureCurrent: () => null,
  setActive: () => {},
  onContextLost: () => () => {},
};

function handle(over = {}) {
  return makeHandle({
    ready: Promise.resolve(),
    dispose: () => {},
    viewer: stubViewer,
    setParams: () => {},
    listExportableParts: () => [],
    exportParts: () => {},
    getView: () => "main",
    setView: () => false,
    captureView: () => null,
    ...over,
  });
}

test("annotate defaults to an inert no-op with the full surface", () => {
  const rt = handle();
  expect(rt.annotate.isEnabled()).toBe(false);
  expect(rt.annotate.strokeCount()).toBe(0);
  expect(rt.annotate.send()).toBe(false);
  expect(() => rt.annotate.setEnabled(true)).not.toThrow();
  expect(() => rt.annotate.clear()).not.toThrow();
  expect(typeof rt.annotate.onModeChange(() => {})).toBe("function");
});

test("a wired annotate mode is passed through as-is", () => {
  const mode = { isEnabled: () => true };
  expect(handle({ annotate: mode }).annotate).toBe(mode);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/framework/annotate/mount-wiring.test.js`
Expected: FAIL — `rt.annotate` is undefined.

- [ ] **Step 3: Wire mount.js**

Apply each edit; every location is given against current line numbers (they shift as you edit — match on the quoted code, not the number):

1. **Imports** (top of file, next to the measure imports):
```js
import { createAnnotateMode } from "./annotate/annotate-mode.js";
import { attachAnnotateControls } from "./annotate/annotate-controls.js";
```

2. **NOOP default** (below `NOOP_MEASURE`, line 39):
```js
// Same stance as NOOP_MEASURE: the handle's annotate surface exists whether or
// not this mount wired the mode (it wires only when the host passes
// onAnnotationSend — without a sink, Send would have nowhere to go).
const NOOP_ANNOTATE = {
  isEnabled: () => false, setEnabled: () => {}, clear: () => {},
  strokeCount: () => 0, send: () => false, onModeChange: () => () => {},
};
```

3. **makeHandle** — add `annotate` to the parameter list (line 52) and, next to `measure: measure ?? NOOP_MEASURE,` in the returned object:
```js
    // Annotation-mode API (spec 2026-08-18): { isEnabled, setEnabled, clear,
    // strokeCount, send, onModeChange } — an embedder drives the mode without
    // the built-in pencil button. send() delivers to onAnnotationSend and
    // returns false when there is no ink or the capture failed.
    annotate: annotate ?? NOOP_ANNOTATE,
```

4. **mount options** (line 200): add `onAnnotationSend` after `onParamsCommit`:
```js
export function mount(part, { createWorker, elements = {}, onBuild, onPick, onDownload, onViewChange, onParamsCommit, onAnnotationSend,
                              container: legacyContainer, controls: legacyControls } = {}) {
```

5. **Element block** (chrome object, line 226-232): add
```js
      annotate: elements.chrome?.annotate ?? byId("annotate"),
```

6. **Mode creation** — immediately after `cleanup.defer(() => measureMode.detach());` (line 351), before `measureChrome`:
```js
    // Annotation mode (spec 2026-08-18): freehand ink over the frozen view,
    // delivered to the host via onAnnotationSend. Wired only when the host
    // passes the sink; the chrome hides the button otherwise (mode = null).
    let annotateMode = null;
    if (onAnnotationSend) {
      annotateMode = createAnnotateMode(viewer, {
        stage: els.viewer,
        getContext: () => ({ view: view(), params }),
        onSend: onAnnotationSend,
      });
      cleanup.defer(() => annotateMode.detach());
      // Annotate and measure both claim canvas pointer input — mutually
      // exclusive, whichever turns on turns the other off.
      cleanup.defer(annotateMode.onModeChange(() => {
        if (annotateMode.isEnabled()) measureMode.setEnabled(false);
      }));
      cleanup.defer(measureMode.onModeChange(() => {
        if (measureMode.isEnabled()) annotateMode.setEnabled(false);
      }));
    }
    const annotateChrome = attachAnnotateControls(viewer, annotateMode, {
      annotate: els.chrome.annotate,
    }, { tooltip, escapeScope: els.viewer });
    cleanup.defer(() => annotateChrome.detach());
```

7. **Cutaway escapeGuard** (line 363): extend so an Escape meant for annotate can't also close the cutaway:
```js
    }, { tooltip, escapeGuard: () => measureMode.isEnabled() || (annotateMode?.isEnabled() ?? false) });
```

8. **Hover suppression** (lines 365-369): replace the measure-only subscription with a shared sync:
```js
    // Suppress the always-on hover tooltip while measure OR annotate mode is
    // active — measure's highlight + dims take the pointer; annotate's overlay
    // canvas takes it entirely.
    const syncHoverSuppression = () =>
      hover.setSuppressed(measureMode.isEnabled() || (annotateMode?.isEnabled() ?? false));
    cleanup.defer(measureMode.onModeChange(syncHoverSuppression));
    if (annotateMode) cleanup.defer(annotateMode.onModeChange(syncHoverSuppression));
```

9. **Picker suppression** (line 395):
```js
        suppressed: () => measureMode.isEnabled() || (annotateMode?.isEnabled() ?? false),
```

10. **Handle return** (line 855-872): add to the `makeHandle({ ... })` call, after `measure: { ... }`:
```js
      annotate: annotateMode ? {
        isEnabled: annotateMode.isEnabled,
        setEnabled: annotateMode.setEnabled,
        clear: annotateMode.clear,
        strokeCount: annotateMode.strokeCount,
        send: annotateMode.send,
        onModeChange: annotateMode.onModeChange,
      } : null,
```

11. **Embedding-contract doc comment** (the block at lines 129-199): add two entries in the style of the neighboring ones —
under the options: `* - onAnnotationSend(payload): receive user annotations (freehand ink over the frozen view). Supplying this reveals the #annotate viewbar button; omitting it hides the button entirely.`
under the runtime: `* - annotate: { isEnabled, setEnabled, clear, strokeCount, send, onModeChange } — drive annotation mode without the built-in button; no-op when onAnnotationSend was not supplied.`

- [ ] **Step 4: Update `types/index.d.ts`**

Add to `MountElements.chrome` (line ~86): `annotate?: HTMLElement | null;`

Add interfaces next to `MeasureRuntime` (line ~152):

```ts
/** One freehand stroke: points normalized 0..1 in viewport space; width as a
 *  fraction of the viewport's short edge. */
export interface AnnotationStroke {
  points: [number, number][];
  width: number;
}

/** A raycast sample grounding a stroke in the model. `t` anchors sit at the
 *  stroke's start/mid/end by arc length; `kind: "centroid"` anchors sit at the
 *  enclosed-region centroid of a closed stroke. `hit` is null when the sample
 *  ray missed all geometry — a deliberate signal, not an error. */
export interface AnnotationAnchor {
  stroke: number;
  t?: number;
  kind?: "centroid";
  screen: [number, number];
  hit: { subPart: string; pointLocal: [number, number, number] } | null;
}

/** A camera pose. `world` replays exactly against the annotated build; `parts`
 *  is the same pose in the shared CAD frame (survives per-view recentring when
 *  the model is rebuilt), or null when no meshes were live. */
export interface AnnotationCamera {
  world: { pos: number[]; target: number[]; up: number[]; fov: number };
  parts: { pos: number[]; target: number[]; up: number[]; fov: number } | null;
}

/** What onAnnotationSend receives. The drawing and the 3D render are separate
 *  images over the same framing, so a host can composite them now and
 *  re-render the model from the same camera against later updates. */
export interface AnnotationPayload {
  version: 1;
  strokes: AnnotationStroke[];
  anchors: AnnotationAnchor[];
  images: { drawing: string; model: string };
  camera: AnnotationCamera;
  viewport: { width: number; height: number; dpr: number };
  context: { view: string; params: Record<string, unknown> };
}

export interface AnnotateRuntime {
  isEnabled(): boolean;
  setEnabled(on: boolean): void;
  clear(): void;
  strokeCount(): number;
  send(): boolean;
  onModeChange(cb: () => void): () => void;
}
```

Add to `MountOptions` (after `onViewChange`): `onAnnotationSend?: (payload: AnnotationPayload) => void;`
Add to `PartRuntime` (next to `measure: MeasureRuntime;` at line ~271): `annotate: AnnotateRuntime;`

- [ ] **Step 5: Wire the demo app**

`demo.html` — add to `#viewbar` (line 18), before the measure button:
```html
        <button id="annotate" title="Annotate" aria-label="Annotate the view">✎</button>
```

`src/app-demo.js` — pass the sink (dev-only console sink; stashed on window like `__pfRuntime` so manual testing and future smoke checks can read it):
```js
window.__pfRuntime = mount(demoPart, {
  createWorker: (name) =>
    new Worker(new URL("./demo-worker.js", import.meta.url), { type: "module", name }),
  onAnnotationSend: (payload) => {
    window.__pfLastAnnotation = payload;
    console.log("annotation payload", payload);
  },
});
```

- [ ] **Step 6: Run the wiring test and the neighbors that touch mount**

Run: `npx vitest run test/framework/annotate/mount-wiring.test.js test/framework/mount.test.js test/framework/measure test/framework/cutaway-controls.test.js`
Expected: PASS — the new surface exists and nothing existing regressed.

- [ ] **Step 7: Smoke-check the demo app in a real browser**

Run: `node scripts/check-app.mjs demo.html`
Expected: exits 0 (viewbar containment check still passes with the sixth button).

- [ ] **Step 8: Commit**

```bash
git add src/framework/mount.js types/index.d.ts demo.html src/app-demo.js test/framework/annotate/mount-wiring.test.js
git commit -m "feat(annotate): mount wiring — onAnnotationSend option, runtime.annotate, demo app button"
```

---

### Task 6: full suite, docs touch-up, version bump

**Files:**
- Modify: `AGENTS.md` (architecture bullet), `package.json` (version)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: PASS. If `test/worker-layering.test.js` or `test/framework/docs-coherence.test.js` fail, read the failure — the first means something under `src/framework/annotate/` leaked into the worker graph (it must not import three-DOM code into worker files; annotate is main-thread-only and nothing in the worker graph may import it), the second means the mount doc comment and types drifted (fix the text, not the test). On any other failure, grep `docs/ERROR-PATTERNS.md` for the symptom first.

- [ ] **Step 2: Run the smoke checks CI runs**

Run: `node scripts/check-app.mjs demo.html && node scripts/check-app.mjs planter.html`
Expected: both exit 0.

- [ ] **Step 3: Update `AGENTS.md`**

In the `src/framework/` architecture bullet, after the `measure/` description, add:

```
`annotate/` (the annotation mode: freehand ink on a
  transparent canvas over the frozen view, sent to the host via
  `onAnnotationSend` — `ink.js` is the pure stroke model, `ink-canvas.js` the
  overlay renderer, `annotate-mode.js` the orchestrator, `annotate-controls.js`
  the viewbar chrome),
```

- [ ] **Step 4: Bump the version**

Check what main has published: `npm view partforge version`. Set `package.json`'s `version` to the next **minor** above the higher of that and the current file value (new host-facing API = minor). Do not tag; the publish workflow tags on merge.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md package.json
git commit -m "docs+release: annotate module in the architecture map; version bump for the annotation-mode API"
```

---

## Post-plan checks (for the finishing session)

- `npm test` green, both smoke checks green.
- Manual pass in `npm run dev` → `/demo.html`: draw, undo, clear, Escape, Send; confirm the console payload has both images, anchors with hits on the spacer, and `camera.parts` non-null.
- Follow `superpowers:finishing-a-development-branch` — PR against `main` with the reader-friendly tone from the user's global CLAUDE.md; the spec + this plan are already committed on the branch.
