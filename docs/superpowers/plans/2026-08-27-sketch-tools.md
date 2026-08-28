# Sketch Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand annotate ("Sketch") mode from freehand-only ink to a typed element model — pen / line / rect / ellipse tools, three colors, a hand tool (move / resize / rotate), an interval eraser — with a top-centre toolbar replacing the viewbar and a v3 semantic send payload.

**Architecture:** A new pure module `elements.js` owns the element store, per-type geometry (sampling, gaps, handles, describe), gesture builders and edit appliers; `ink-canvas.js` renders typed elements plus overlay adornments; `annotate-mode.js` becomes a tool state machine and assembles the v3 payload; a new `sketch-toolbar.js` is the mode's chrome. `ink.js` is retired into `elements.js`.

**Tech Stack:** Plain ESM, vitest (+ `// @vitest-environment happy-dom` for DOM-touching tests), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-27-sketch-tools-design.md` — read it first; it defines the element model, stage-space coordinates, gestures, chrome, and payload this plan implements.

## Global Constraints

- Node 24 (`nvm use` before anything; PATH-prefix `~/.nvm/versions/node/v24*/bin` in sandboxed shells).
- **Stage space everywhere in `elements.js`**: `y ∈ [0,1]`, `x ∈ [0,aspect]`; pixels only at the renderer/mode boundary.
- Ink colors exactly: red `#d92d20`, blue `#1570ef`, green `#079455`; halo `rgba(255,255,255,0.85)`, ratio 2.2.
- Constants: snap ratio 0.12; drop element below 2% visible; handle pick 8 px; rotate band 22 px; eraser radius 16 px; outline reach `max(10px, 1.5 × stroke width px)`; Shift snaps: line 45°, rotation 15°.
- `ANNOTATION_VERSION = 3`; `strokes` payload field is REPLACED by `elements`.
- No DOM/three imports in `elements.js` (the feature-dims.js stance).
- Host API surface of `runtime.annotate` unchanged (`setEnabled/isEnabled/undo/clear/strokeCount/send/onInkChange/onModeChange`).
- Run a task's test file with: `npx vitest run test/framework/annotate/<file>.test.js`
- Commit after every task (message style in each task).

---

### Task 1: Element store + interval math (`elements.js` part 1)

**Files:**
- Create: `src/framework/annotate/elements.js`
- Test: `test/framework/annotate/elements-store.test.js`

**Interfaces:**
- Produces (later tasks rely on these exact names):
  - `INK_COLORS = { red: "#d92d20", blue: "#1570ef", green: "#079455" }`
  - `DEFAULT_STROKE_WIDTH = 0.004` (fraction of viewport short edge)
  - `SNAP_RATIO = 0.12`, `MIN_VISIBLE = 0.02`
  - `mergeGaps(gaps) → [[a,b],…]` sorted, overlaps merged (touching within 1e-4 merge)
  - `inGaps(t, gaps) → boolean`
  - `visibleFraction(el) → number` (1 − Σ gap spans)
  - `createElementStore() → { snapshot, add, touch, setList, list, isEmpty, count, undo, canUndo, clear, onChange }`
    - `snapshot()` pushes a deep clone of the current list onto the undo stack (call once per committed user action, BEFORE mutating)
    - `add(el)` appends and notifies; `touch(el)` invalidates el's sample cache and notifies (call after mutating `el.params`); `setList(next)` replaces the array and notifies (eraser drops)
    - `undo()` restores the last snapshot (no-op on empty stack); `canUndo()`; `clear()` snapshots, empties, notifies (no-op when already empty)
    - `onChange(cb) → unsubscribe`; `list()` returns the internal array (callers treat as read-only)
  - `invalidateSample(el)` — module-level sample-cache eviction (used by `touch`)

Element shape (created by later tasks, used here in tests):
`{ type, color, width, params, gaps }` per the spec.

- [ ] **Step 1: Write the failing tests**

```js
// test/framework/annotate/elements-store.test.js
// Element store: undo snapshots, notifications, interval math.
import { expect, test } from "vitest";
import {
  createElementStore, mergeGaps, inGaps, visibleFraction,
  INK_COLORS, DEFAULT_STROKE_WIDTH, SNAP_RATIO, MIN_VISIBLE,
} from "../../../src/framework/annotate/elements.js";

const line = (over = {}) => ({
  type: "line", color: "red", width: DEFAULT_STROKE_WIDTH,
  params: { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 }, gaps: [], ...over,
});

test("constants are pinned to the spec", () => {
  expect(INK_COLORS).toEqual({ red: "#d92d20", blue: "#1570ef", green: "#079455" });
  expect(DEFAULT_STROKE_WIDTH).toBe(0.004);
  expect(SNAP_RATIO).toBe(0.12);
  expect(MIN_VISIBLE).toBe(0.02);
});

test("mergeGaps sorts, merges overlaps and near-touching spans", () => {
  expect(mergeGaps([])).toEqual([]);
  expect(mergeGaps([[0.5, 0.6], [0.1, 0.2]])).toEqual([[0.1, 0.2], [0.5, 0.6]]);
  expect(mergeGaps([[0.1, 0.3], [0.2, 0.4]])).toEqual([[0.1, 0.4]]);
  expect(mergeGaps([[0.1, 0.2], [0.20005, 0.3]])).toEqual([[0.1, 0.3]]); // touching within 1e-4
});

test("inGaps and visibleFraction", () => {
  const gaps = [[0.2, 0.3], [0.6, 0.7]];
  expect(inGaps(0.25, gaps)).toBe(true);
  expect(inGaps(0.5, gaps)).toBe(false);
  expect(visibleFraction({ gaps })).toBeCloseTo(0.8);
  expect(visibleFraction({ gaps: [] })).toBe(1);
});

test("snapshot/undo restores the previous list; canUndo tracks the stack", () => {
  const store = createElementStore();
  expect(store.canUndo()).toBe(false);
  store.snapshot();
  store.add(line());
  expect(store.count()).toBe(1);
  store.snapshot();
  store.add(line({ color: "blue" }));
  expect(store.count()).toBe(2);
  store.undo();
  expect(store.count()).toBe(1);
  expect(store.list()[0].color).toBe("red");
  store.undo();
  expect(store.isEmpty()).toBe(true);
  expect(store.canUndo()).toBe(false);
  store.undo(); // empty stack: no throw, no change
  expect(store.isEmpty()).toBe(true);
});

test("undo restores deep clones — later mutation of the live list cannot corrupt history", () => {
  const store = createElementStore();
  store.snapshot();
  store.add(line());
  store.snapshot();
  store.list()[0].params.x1 = 0.5; // an edit after the snapshot
  store.undo();
  expect(store.list()[0].params.x1).toBe(0.1);
});

test("add/touch/setList/clear notify; unsubscribe stops notifications", () => {
  const store = createElementStore();
  let calls = 0;
  const off = store.onChange(() => { calls += 1; });
  store.add(line());          // 1
  store.touch(store.list()[0]); // 2
  store.setList([]);          // 3
  store.clear();              // empty already: no-op, still 3
  expect(calls).toBe(3);
  off();
  store.add(line());
  expect(calls).toBe(3);
});

test("clear snapshots so undo brings everything back", () => {
  const store = createElementStore();
  store.snapshot();
  store.add(line());
  store.clear();
  expect(store.isEmpty()).toBe(true);
  store.undo();
  expect(store.count()).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/annotate/elements-store.test.js`
Expected: FAIL — cannot resolve `../../../src/framework/annotate/elements.js`.

- [ ] **Step 3: Implement**

```js
// src/framework/annotate/elements.js
// The typed sketch-element model (spec 2026-08-27): store, per-type geometry,
// gesture builders, edit appliers, eraser, and semantics. Pure — no DOM, no
// three (the feature-dims.js stance). All coordinates are STAGE SPACE:
// y ∈ [0,1], x ∈ [0,aspect]; pixels exist only at the renderer/mode boundary,
// which is what keeps a circle circular regardless of viewport shape.

export const INK_COLORS = { red: "#d92d20", blue: "#1570ef", green: "#079455" };
// Stroke width as a fraction of the viewport short edge (unchanged from ink.js).
export const DEFAULT_STROKE_WIDTH = 0.004;
// rect→square / ellipse→circle magnetic snap when aspect is within this of 1:1.
export const SNAP_RATIO = 0.12;
// An element erased below this visible fraction is dropped entirely.
export const MIN_VISIBLE = 0.02;

const GAP_TOUCH = 1e-4; // spans this close merge (half-sample slack)

export function mergeGaps(gaps) {
  if (!gaps.length) return [];
  const sorted = [...gaps].sort((a, b) => a[0] - b[0]);
  const out = [sorted[0].slice()];
  for (const [a, b] of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (a <= last[1] + GAP_TOUCH) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export const inGaps = (t, gaps) => gaps.some(([a, b]) => t >= a && t <= b);

export const visibleFraction = (el) =>
  1 - el.gaps.reduce((sum, [a, b]) => sum + (b - a), 0);

// Sample cache: params are immutable per edit step, so outlines memoize on the
// element object; every mutation path goes through touch()/invalidateSample.
const sampleCache = new WeakMap();
export const invalidateSample = (el) => sampleCache.delete(el);
export const cachedSample = (el, compute) => {
  let hit = sampleCache.get(el);
  if (!hit) { hit = compute(el); sampleCache.set(el, hit); }
  return hit;
};

export function createElementStore() {
  let items = [];
  const undoStack = [];
  const listeners = new Set();
  const notify = () => { for (const cb of [...listeners]) cb(); };
  return {
    snapshot() { undoStack.push(JSON.stringify(items)); },
    add(el) { items.push(el); notify(); },
    touch(el) { invalidateSample(el); notify(); },
    setList(next) { items = next; notify(); },
    list: () => items,
    isEmpty: () => items.length === 0,
    count: () => items.length,
    canUndo: () => undoStack.length > 0,
    undo() {
      if (!undoStack.length) return;
      items = JSON.parse(undoStack.pop());
      notify();
    },
    clear() {
      if (!items.length) return;
      undoStack.push(JSON.stringify(items));
      items = [];
      notify();
    },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/framework/annotate/elements-store.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/annotate/elements.js test/framework/annotate/elements-store.test.js
git commit -m "feat(annotate): element store with undo snapshots and gap-interval math"
```

---

### Task 2: Per-type geometry — sampling, visible runs, centers (`elements.js` part 2)

**Files:**
- Modify: `src/framework/annotate/elements.js` (append)
- Test: `test/framework/annotate/elements-geometry.test.js`

**Interfaces:**
- Consumes: Task 1's `cachedSample`, `inGaps`.
- Produces:
  - `rot2(x, y, a) → [x', y']`, `invRot2(x, y, a) → [x', y']`
  - `sample(el) → { pts: [{x, y, t}, …], closed }` — dense outline in stage space; `t ∈ [0,1]` is the element's domain (freehand/line: normalized arc length; rect: perimeter from top-left clockwise; ellipse: parametric angle). Cached per element.
  - `visibleRuns(el) → [[{x,y,t},…], …]` — maximal runs of consecutive un-erased samples.
  - `centerOf(el) → [x, y]` (rect/ellipse center; line midpoint; freehand bbox center)
  - Sampling densities: rect/ellipse 320 segments; line/freehand `max(24, min(600, round(length / 0.004)))` segments (≈ one sample per 0.004 stage units).

- [ ] **Step 1: Write the failing tests**

```js
// test/framework/annotate/elements-geometry.test.js
// Per-type outline sampling, gap-aware visible runs, rotation, centers.
import { expect, test } from "vitest";
import {
  sample, visibleRuns, centerOf, rot2, invRot2, DEFAULT_STROKE_WIDTH,
} from "../../../src/framework/annotate/elements.js";

const el = (type, params, gaps = []) =>
  ({ type, color: "red", width: DEFAULT_STROKE_WIDTH, params, gaps });

test("rot2/invRot2 round-trip", () => {
  const [x, y] = rot2(1, 0, Math.PI / 2);
  expect(x).toBeCloseTo(0); expect(y).toBeCloseTo(1);
  const [bx, by] = invRot2(x, y, Math.PI / 2);
  expect(bx).toBeCloseTo(1); expect(by).toBeCloseTo(0);
});

test("line samples run endpoint to endpoint with t = normalized length", () => {
  const { pts, closed } = sample(el("line", { x1: 0, y1: 0, x2: 1, y2: 0 }));
  expect(closed).toBe(false);
  expect(pts[0]).toMatchObject({ x: 0, y: 0, t: 0 });
  expect(pts[pts.length - 1]).toMatchObject({ x: 1, y: 0, t: 1 });
  const mid = pts[Math.round((pts.length - 1) / 2)];
  expect(mid.x).toBeCloseTo(0.5, 1);
});

test("rect perimeter walk starts top-left, goes clockwise, honors rot", () => {
  const flat = sample(el("rect", { cx: 0.5, cy: 0.5, w: 0.4, h: 0.2, rot: 0 }));
  expect(flat.closed).toBe(true);
  expect(flat.pts[0].x).toBeCloseTo(0.3); // top-left corner
  expect(flat.pts[0].y).toBeCloseTo(0.4);
  // t = w/perimeter lands exactly on the top-right corner
  const per = 2 * (0.4 + 0.2);
  const corner = flat.pts.reduce((best, p) =>
    Math.abs(p.t - 0.4 / per) < Math.abs(best.t - 0.4 / per) ? p : best);
  expect(corner.x).toBeCloseTo(0.7, 2);
  expect(corner.y).toBeCloseTo(0.4, 2);
  // 90° rotation maps the top-left corner accordingly
  const rot = sample(el("rect", { cx: 0.5, cy: 0.5, w: 0.4, h: 0.2, rot: Math.PI / 2 }));
  expect(rot.pts[0].x).toBeCloseTo(0.5 + 0.1); // (-w/2,-h/2) rotated 90° = (h/2, -w/2)
  expect(rot.pts[0].y).toBeCloseTo(0.5 - 0.2);
});

test("ellipse samples lie on the ellipse; a circle stays round", () => {
  const { pts, closed } = sample(el("ellipse", { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2, rot: 0 }));
  expect(closed).toBe(true);
  for (const p of [pts[0], pts[80], pts[160]]) {
    expect(Math.hypot(p.x - 0.5, p.y - 0.5)).toBeCloseTo(0.2, 3);
  }
});

test("visibleRuns splits at gaps and drops erased samples", () => {
  const gapped = el("line", { x1: 0, y1: 0, x2: 1, y2: 0 }, [[0.4, 0.6]]);
  const runs = visibleRuns(gapped);
  expect(runs.length).toBe(2);
  expect(runs[0][0].t).toBe(0);
  expect(runs[0][runs[0].length - 1].t).toBeLessThan(0.4);
  expect(runs[1][0].t).toBeGreaterThan(0.6);
  // fully erased → no runs
  expect(visibleRuns(el("line", { x1: 0, y1: 0, x2: 1, y2: 0 }, [[0, 1]]))).toEqual([]);
});

test("centerOf per type", () => {
  expect(centerOf(el("rect", { cx: 0.3, cy: 0.4, w: 0.1, h: 0.1, rot: 0 }))).toEqual([0.3, 0.4]);
  expect(centerOf(el("line", { x1: 0, y1: 0, x2: 1, y2: 1 }))).toEqual([0.5, 0.5]);
  expect(centerOf(el("freehand", { points: [[0, 0], [0.2, 0.6], [0.4, 0.2]] })))
    .toEqual([0.2, 0.3]);
});

test("a one-point freehand samples as a single dot", () => {
  const { pts } = sample(el("freehand", { points: [[0.5, 0.5]] }));
  expect(pts).toEqual([{ x: 0.5, y: 0.5, t: 0 }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/annotate/elements-geometry.test.js`
Expected: FAIL — `sample` not exported.

- [ ] **Step 3: Implement (append to `elements.js`)**

```js
// ---- rotation helpers ------------------------------------------------------
export const rot2 = (x, y, a) =>
  [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
export const invRot2 = (x, y, a) => rot2(x, y, -a);

const SHAPE_SEGMENTS = 320;
const polylineSegments = (length) =>
  Math.max(24, Math.min(600, Math.round(length / 0.004)));

function computeSample(el) {
  const pts = [];
  const push = (x, y, t) => pts.push({ x, y, t });
  const p = el.params;
  if (el.type === "freehand") {
    const P = p.points;
    if (P.length === 1) push(P[0][0], P[0][1], 0);
    else {
      const cum = [0];
      for (let i = 1; i < P.length; i++) {
        cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
      }
      const total = cum[cum.length - 1] || 1;
      const N = polylineSegments(total);
      let seg = 1;
      for (let i = 0; i <= N; i++) {
        const d = (i / N) * total;
        while (seg < cum.length - 1 && cum[seg] < d) seg++;
        const span = cum[seg] - cum[seg - 1] || 1;
        const f = Math.min(1, Math.max(0, (d - cum[seg - 1]) / span));
        push(
          P[seg - 1][0] + (P[seg][0] - P[seg - 1][0]) * f,
          P[seg - 1][1] + (P[seg][1] - P[seg - 1][1]) * f,
          i / N,
        );
      }
    }
  } else if (el.type === "line") {
    const N = polylineSegments(Math.hypot(p.x2 - p.x1, p.y2 - p.y1));
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      push(p.x1 + (p.x2 - p.x1) * t, p.y1 + (p.y2 - p.y1) * t, t);
    }
  } else if (el.type === "rect") {
    const { cx, cy, w, h, rot = 0 } = p;
    const per = 2 * (w + h) || 1;
    for (let i = 0; i <= SHAPE_SEGMENTS; i++) {
      const t = i / SHAPE_SEGMENTS;
      const d = t * per;
      let lx, ly; // local frame, top-left origin, clockwise
      if (d <= w) { lx = -w / 2 + d; ly = -h / 2; }
      else if (d <= w + h) { lx = w / 2; ly = -h / 2 + (d - w); }
      else if (d <= 2 * w + h) { lx = w / 2 - (d - w - h); ly = h / 2; }
      else { lx = -w / 2; ly = h / 2 - (d - 2 * w - h); }
      const [wx, wy] = rot2(lx, ly, rot);
      push(cx + wx, cy + wy, t);
    }
  } else if (el.type === "ellipse") {
    const { cx, cy, rx, ry, rot = 0 } = p;
    for (let i = 0; i <= SHAPE_SEGMENTS; i++) {
      const t = i / SHAPE_SEGMENTS;
      const a = t * Math.PI * 2;
      const [wx, wy] = rot2(rx * Math.cos(a), ry * Math.sin(a), rot);
      push(cx + wx, cy + wy, t);
    }
  }
  return { pts, closed: el.type === "rect" || el.type === "ellipse" };
}

export const sample = (el) => cachedSample(el, computeSample);

export function visibleRuns(el) {
  const { pts } = sample(el);
  const runs = [];
  let run = null;
  for (const p of pts) {
    if (inGaps(p.t, el.gaps)) { run = null; continue; }
    if (!run) { run = []; runs.push(run); }
    run.push(p);
  }
  return runs;
}

export function centerOf(el) {
  const p = el.params;
  if (el.type === "rect" || el.type === "ellipse") return [p.cx, p.cy];
  if (el.type === "line") return [(p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of p.points) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/framework/annotate/elements-geometry.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/annotate/elements.js test/framework/annotate/elements-geometry.test.js
git commit -m "feat(annotate): per-type outline sampling, visible runs, centers"
```

---

### Task 3: Draw-gesture builders + snapping (`elements.js` part 3)

**Files:**
- Modify: `src/framework/annotate/elements.js` (append)
- Test: `test/framework/annotate/elements-builders.test.js`

**Interfaces:**
- Consumes: `SNAP_RATIO`.
- Produces:
  - `rectFromDrag(x0, y0, x, y, { force = false } = {}) → { params: {cx,cy,w,h,rot:0}, snapped }`
  - `ellipseFromDrag(x0, y0, x, y, { force = false } = {}) → { params: {cx,cy,rx,ry,rot:0}, snapped }`
  - `lineFromDrag(x0, y0, x, y, { snap45 = false } = {}) → { params: {x1,y1,x2,y2} }`
  - `appendThinned(points, x, y, minDistance) → boolean` (pushed or thinned; freehand point collection)
  - Minimum shape extent: `w/h/rx/ry` floor at 0.002 stage units; snapped means `w === h` / `rx === ry`.

- [ ] **Step 1: Write the failing tests**

```js
// test/framework/annotate/elements-builders.test.js
// Drag → params builders: bounding boxes, magnetic 1:1 snap, 45° line snap.
import { expect, test } from "vitest";
import {
  rectFromDrag, ellipseFromDrag, lineFromDrag, appendThinned,
} from "../../../src/framework/annotate/elements.js";

test("rectFromDrag: any corner order yields the same box", () => {
  const a = rectFromDrag(0.2, 0.2, 0.6, 0.5).params;
  const b = rectFromDrag(0.6, 0.5, 0.2, 0.2).params;
  expect(a).toEqual(b);
  expect(a.cx).toBeCloseTo(0.4); expect(a.cy).toBeCloseTo(0.35);
  expect(a.w).toBeCloseTo(0.4); expect(a.h).toBeCloseTo(0.3);
  expect(a.rot).toBe(0);
});

test("magnetic square snap inside 12%, none outside, force always", () => {
  // 0.40 × 0.37 → ratio 0.925 > 0.88 → snaps
  const near = rectFromDrag(0, 0, 0.40, 0.37);
  expect(near.snapped).toBe(true);
  expect(near.params.w).toBeCloseTo(0.40);
  expect(near.params.h).toBeCloseTo(0.40);
  // 0.40 × 0.30 → ratio 0.75 → no snap
  const far = rectFromDrag(0, 0, 0.40, 0.30);
  expect(far.snapped).toBe(false);
  expect(far.params.h).toBeCloseTo(0.30);
  // force wins from any aspect
  const forced = rectFromDrag(0, 0, 0.40, 0.10, { force: true });
  expect(forced.snapped).toBe(true);
  expect(forced.params.h).toBeCloseTo(0.40);
});

test("ellipseFromDrag fills the box; circle snap mirrors the rect rule", () => {
  const e = ellipseFromDrag(0.2, 0.2, 0.6, 0.4).params;
  expect(e.cx).toBeCloseTo(0.4); expect(e.cy).toBeCloseTo(0.3);
  expect(e.rx).toBeCloseTo(0.2); expect(e.ry).toBeCloseTo(0.1);
  const circle = ellipseFromDrag(0, 0, 0.4, 0.38);
  expect(circle.snapped).toBe(true);
  expect(circle.params.rx).toBe(circle.params.ry);
});

test("lineFromDrag: plain drag keeps the endpoint; snap45 quantizes the angle", () => {
  expect(lineFromDrag(0, 0, 0.5, 0.1).params).toEqual({ x1: 0, y1: 0, x2: 0.5, y2: 0.1 });
  const snapped = lineFromDrag(0, 0, 0.5, 0.1, { snap45: true }).params;
  expect(snapped.y2).toBeCloseTo(0);                 // 11° → 0°
  expect(snapped.x2).toBeCloseTo(Math.hypot(0.5, 0.1)); // length preserved
  const diag = lineFromDrag(0, 0, 0.5, 0.45, { snap45: true }).params;
  expect(diag.x2).toBeCloseTo(diag.y2); // 42° → 45°
});

test("appendThinned drops sub-threshold points and keeps the rest", () => {
  const pts = [[0.5, 0.5]];
  expect(appendThinned(pts, 0.5005, 0.5, 0.0015)).toBe(false);
  expect(pts.length).toBe(1);
  expect(appendThinned(pts, 0.52, 0.5, 0.0015)).toBe(true);
  expect(pts).toEqual([[0.5, 0.5], [0.52, 0.5]]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/annotate/elements-builders.test.js`
Expected: FAIL — `rectFromDrag` not exported.

- [ ] **Step 3: Implement (append to `elements.js`)**

```js
// ---- draw-gesture builders -------------------------------------------------
const MIN_EXTENT = 0.002; // stage units; degenerate drags stay visible as slivers

function snappedBox(x0, y0, x, y, force) {
  let w = Math.abs(x - x0), h = Math.abs(y - y0);
  const near = Math.min(w, h) / Math.max(w, h, MIN_EXTENT) > 1 - SNAP_RATIO;
  const snapped = force || near;
  if (snapped) w = h = Math.max(w, h);
  w = Math.max(w, MIN_EXTENT); h = Math.max(h, MIN_EXTENT);
  const left = x < x0 && !snapped ? x : x0 - (x < x0 ? w : 0);
  // center from the drag origin and signed direction, so the box hangs off the
  // start corner in the drag direction even after snapping changed w/h
  const cx = x0 + Math.sign(x - x0 || 1) * w / 2;
  const cy = y0 + Math.sign(y - y0 || 1) * h / 2;
  void left;
  return { cx, cy, w, h, snapped };
}

export function rectFromDrag(x0, y0, x, y, { force = false } = {}) {
  const { cx, cy, w, h, snapped } = snappedBox(x0, y0, x, y, force);
  return { params: { cx, cy, w, h, rot: 0 }, snapped };
}

export function ellipseFromDrag(x0, y0, x, y, { force = false } = {}) {
  const { cx, cy, w, h, snapped } = snappedBox(x0, y0, x, y, force);
  return { params: { cx, cy, rx: w / 2, ry: h / 2, rot: 0 }, snapped };
}

export function lineFromDrag(x0, y0, x, y, { snap45 = false } = {}) {
  let x2 = x, y2 = y;
  if (snap45) {
    const len = Math.hypot(x - x0, y - y0);
    const a = Math.round(Math.atan2(y - y0, x - x0) / (Math.PI / 4)) * (Math.PI / 4);
    x2 = x0 + len * Math.cos(a);
    y2 = y0 + len * Math.sin(a);
  }
  return { params: { x1: x0, y1: y0, x2, y2 } };
}

// Freehand point thinning (the ink.js minDistance contract, Euclidean in
// stage space — stage space is already aspect-uniform).
export function appendThinned(points, x, y, minDistance) {
  const last = points[points.length - 1];
  if (Math.hypot(x - last[0], y - last[1]) < minDistance) return false;
  points.push([x, y]);
  return true;
}
```

NOTE for the implementer: `rectFromDrag(0.2, 0.2, 0.6, 0.5)` and the reversed
call must produce the identical box — the test pins it. The `snappedBox`
center derivation above must satisfy both that symmetry and the snap tests;
verify against the tests and simplify the leftover `left` scaffolding away
(it exists in this listing only to show the derivation was considered — the
final code must not keep dead variables).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/framework/annotate/elements-builders.test.js`
Expected: PASS. If the corner-order symmetry test fails, fix `snappedBox` so
the box derives from `min/max` of the two corners when not snapped, and from
the drag origin + signed direction when snapped.

- [ ] **Step 5: Commit**

```bash
git add src/framework/annotate/elements.js test/framework/annotate/elements-builders.test.js
git commit -m "feat(annotate): drag builders with magnetic square/circle and 45-degree snaps"
```

---

### Task 4: Edit appliers, handles, and the hand probe (`elements.js` part 4)

**Files:**
- Modify: `src/framework/annotate/elements.js` (append)
- Test: `test/framework/annotate/elements-edit.test.js`

**Interfaces:**
- Consumes: `rot2`, `invRot2`, `sample`, `visibleRuns`, `centerOf`, `SNAP_RATIO`.
- Produces:
  - `handlesOf(el) → [{ id, x, y, sx?, sy? }, …]` — line: `p1`/`p2`; rect: 4 corners (`sx, sy ∈ {-1,1}` carried for anchor derivation); ellipse: `rx`/`ry`, or a single `r` handle at the rotated +x axis when `rx === ry`.
  - `translateElement(el, dx, dy)` — mutates params in place (caller calls `store.touch`).
  - `rectAnchorFor(el, handle) → [ax, ay]` — world position of the opposite corner.
  - `resizeRectFromAnchor(el, ax, ay, rot, x, y, { force }) → void` — resizes keeping the anchor fixed, with the 1:1 magnetic snap.
  - `resizeEllipseHandle(el, handleId, x, y, { force }) → void` — `r` keeps a circle; `rx`/`ry` edit one axis, near-1:1 (or force) snaps back to circle.
  - `applyRotation(el, origParams, center, totalAngle) → void` — total-angle applied to gesture-start params (rect/ellipse: `rot`; line/freehand: point transform).
  - `probe(list, x, y, { reach, handleR, band }) → { kind: "handle"|"outline"|"rotate", el, handle? } | null` — priority handle > outline > rotate; rotate only when EXACTLY one element is within `reach + band`; topmost (last in list) wins for handle/outline.

- [ ] **Step 1: Write the failing tests**

```js
// test/framework/annotate/elements-edit.test.js
// Hand-tool machinery: handles, anchored resize, rotation, the probe.
import { expect, test } from "vitest";
import {
  handlesOf, translateElement, rectAnchorFor, resizeRectFromAnchor,
  resizeEllipseHandle, applyRotation, probe, centerOf, invalidateSample,
  DEFAULT_STROKE_WIDTH,
} from "../../../src/framework/annotate/elements.js";

const el = (type, params, gaps = []) =>
  ({ type, color: "red", width: DEFAULT_STROKE_WIDTH, params, gaps });

test("handles: line endpoints, rect corners, ellipse radii, circle single", () => {
  const line = el("line", { x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.6 });
  expect(handlesOf(line)).toEqual([
    { id: "p1", x: 0.1, y: 0.2 }, { id: "p2", x: 0.5, y: 0.6 },
  ]);
  const rect = el("rect", { cx: 0.5, cy: 0.5, w: 0.4, h: 0.2, rot: 0 });
  const corners = handlesOf(rect);
  expect(corners.length).toBe(4);
  expect(corners[0]).toMatchObject({ x: 0.3, y: 0.4, sx: -1, sy: -1 });
  const circle = el("ellipse", { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2, rot: 0 });
  expect(handlesOf(circle)).toEqual([{ id: "r", x: 0.7, y: 0.5 }]);
  const oval = el("ellipse", { cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.2, rot: 0 });
  expect(handlesOf(oval).map((h) => h.id)).toEqual(["rx", "ry"]);
});

test("rect corner handles rotate with the shape", () => {
  const rect = el("rect", { cx: 0.5, cy: 0.5, w: 0.4, h: 0.2, rot: Math.PI / 2 });
  const h = handlesOf(rect)[0]; // (-0.2,-0.1) rotated 90° = (0.1,-0.2)
  expect(h.x).toBeCloseTo(0.6);
  expect(h.y).toBeCloseTo(0.3);
});

test("translateElement moves every type; gaps untouched", () => {
  const line = el("line", { x1: 0, y1: 0, x2: 1, y2: 0 }, [[0.2, 0.4]]);
  translateElement(line, 0.1, 0.2);
  expect(line.params).toEqual({ x1: 0.1, y1: 0.2, x2: 1.1, y2: 0.2 });
  expect(line.gaps).toEqual([[0.2, 0.4]]);
  const free = el("freehand", { points: [[0, 0], [0.5, 0.5]] });
  translateElement(free, 0.1, 0);
  expect(free.params.points).toEqual([[0.1, 0], [0.6, 0.5]]);
});

test("anchored rect resize keeps the opposite corner fixed, snaps near 1:1", () => {
  const rect = el("rect", { cx: 0.5, cy: 0.5, w: 0.4, h: 0.2, rot: 0 });
  const brCorner = handlesOf(rect)[2]; // (0.7, 0.6)
  const [ax, ay] = rectAnchorFor(rect, brCorner); // top-left (0.3, 0.4)
  expect([ax, ay]).toEqual([0.3, 0.4]);
  resizeRectFromAnchor(rect, ax, ay, 0, 0.8, 0.7, {}); // drag BR corner outward
  invalidateSample(rect);
  expect(rect.params.w).toBeCloseTo(0.5);
  expect(rect.params.h).toBeCloseTo(0.3);
  expect(rect.params.cx).toBeCloseTo(0.55);
  expect(rect.params.cy).toBeCloseTo(0.55);
  // near-square drag snaps
  resizeRectFromAnchor(rect, ax, ay, 0, 0.72, 0.81, {}); // 0.42 × 0.41
  expect(rect.params.w).toBe(rect.params.h);
});

test("ellipse handles: r keeps a circle; rx edits one axis; near-1:1 re-snaps", () => {
  const circle = el("ellipse", { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2, rot: 0 });
  resizeEllipseHandle(circle, "r", 0.8, 0.5, {});
  expect(circle.params.rx).toBeCloseTo(0.3);
  expect(circle.params.ry).toBeCloseTo(0.3);
  const oval = el("ellipse", { cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.2, rot: 0 });
  resizeEllipseHandle(oval, "rx", 0.9, 0.5, {});
  expect(oval.params.rx).toBeCloseTo(0.4);
  expect(oval.params.ry).toBeCloseTo(0.2);
  resizeEllipseHandle(oval, "rx", 0.71, 0.5, {}); // rx 0.21 vs ry 0.2 → snap circle
  expect(oval.params.rx).toBe(oval.params.ry);
});

test("applyRotation: rot param for shapes, point transform for line/freehand, no drift", () => {
  const rect = el("rect", { cx: 0.5, cy: 0.5, w: 0.4, h: 0.2, rot: 0.1 });
  const orig = JSON.parse(JSON.stringify(rect.params));
  applyRotation(rect, orig, centerOf(rect), Math.PI / 2);
  expect(rect.params.rot).toBeCloseTo(0.1 + Math.PI / 2);
  // re-applying a different total from the SAME orig replaces, not accumulates
  applyRotation(rect, orig, centerOf(rect), Math.PI / 4);
  expect(rect.params.rot).toBeCloseTo(0.1 + Math.PI / 4);
  const line = el("line", { x1: 0.4, y1: 0.5, x2: 0.6, y2: 0.5 });
  const lorig = JSON.parse(JSON.stringify(line.params));
  applyRotation(line, lorig, centerOf(line), Math.PI / 2);
  expect(line.params.x1).toBeCloseTo(0.5);
  expect(line.params.y1).toBeCloseTo(0.4);
  expect(line.params.x2).toBeCloseTo(0.5);
  expect(line.params.y2).toBeCloseTo(0.6);
});

test("probe priority and the lonely-rotate rule", () => {
  const line = el("line", { x1: 0.2, y1: 0.5, x2: 0.8, y2: 0.5 });
  const opts = { reach: 0.02, handleR: 0.016, band: 0.05 };
  // handle beats outline at an endpoint
  expect(probe([line], 0.2, 0.5, opts)).toMatchObject({ kind: "handle", handle: { id: "p1" } });
  // on the outline
  expect(probe([line], 0.5, 0.51, opts)).toMatchObject({ kind: "outline" });
  // just outside → rotate
  expect(probe([line], 0.5, 0.55, opts)).toMatchObject({ kind: "rotate" });
  // beyond the band → nothing
  expect(probe([line], 0.5, 0.7, opts)).toBeNull();
  // a second element inside the band kills rotation
  const other = el("line", { x1: 0.2, y1: 0.6, x2: 0.8, y2: 0.6 });
  expect(probe([line, other], 0.5, 0.55, opts)).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/annotate/elements-edit.test.js`
Expected: FAIL — `handlesOf` not exported.

- [ ] **Step 3: Implement (append to `elements.js`)**

```js
// ---- hand tool: handles, appliers, probe ----------------------------------
export function handlesOf(el) {
  const p = el.params;
  if (el.type === "line") return [
    { id: "p1", x: p.x1, y: p.y1 },
    { id: "p2", x: p.x2, y: p.y2 },
  ];
  if (el.type === "rect") {
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
      const [dx, dy] = rot2(sx * p.w / 2, sy * p.h / 2, p.rot || 0);
      return { id: `corner${sx > 0 ? "R" : "L"}${sy > 0 ? "B" : "T"}`, sx, sy, x: p.cx + dx, y: p.cy + dy };
    });
  }
  if (el.type === "ellipse") {
    if (p.rx === p.ry) {
      const [dx, dy] = rot2(p.rx, 0, p.rot || 0);
      return [{ id: "r", x: p.cx + dx, y: p.cy + dy }];
    }
    const [ax, ay] = rot2(p.rx, 0, p.rot || 0);
    const [bx, by] = rot2(0, p.ry, p.rot || 0);
    return [
      { id: "rx", x: p.cx + ax, y: p.cy + ay },
      { id: "ry", x: p.cx + bx, y: p.cy + by },
    ];
  }
  return [];
}

export function translateElement(el, dx, dy) {
  const p = el.params;
  if (el.type === "freehand") for (const q of p.points) { q[0] += dx; q[1] += dy; }
  else if (el.type === "rect" || el.type === "ellipse") { p.cx += dx; p.cy += dy; }
  else if (el.type === "line") { p.x1 += dx; p.y1 += dy; p.x2 += dx; p.y2 += dy; }
}

export function rectAnchorFor(el, handle) {
  const p = el.params;
  const [dx, dy] = rot2(-handle.sx * p.w / 2, -handle.sy * p.h / 2, p.rot || 0);
  return [p.cx + dx, p.cy + dy];
}

const MIN_EDIT_EXTENT = 0.002;

export function resizeRectFromAnchor(el, ax, ay, rot, x, y, { force = false } = {}) {
  const p = el.params;
  let [dx, dy] = invRot2(x - ax, y - ay, rot);
  const w = Math.abs(dx), h = Math.abs(dy);
  const near = Math.min(w, h) / Math.max(w, h, MIN_EDIT_EXTENT) > 1 - SNAP_RATIO;
  if (force || near) {
    const m = Math.max(w, h);
    dx = Math.sign(dx || 1) * m;
    dy = Math.sign(dy || 1) * m;
  }
  p.w = Math.max(Math.abs(dx), MIN_EDIT_EXTENT);
  p.h = Math.max(Math.abs(dy), MIN_EDIT_EXTENT);
  const [ox, oy] = rot2(dx / 2, dy / 2, rot);
  p.cx = ax + ox;
  p.cy = ay + oy;
}

export function resizeEllipseHandle(el, handleId, x, y, { force = false } = {}) {
  const p = el.params;
  const [lx, ly] = invRot2(x - p.cx, y - p.cy, p.rot || 0);
  if (handleId === "r") {
    p.rx = p.ry = Math.max(MIN_EDIT_EXTENT, Math.hypot(lx, ly));
    return;
  }
  if (handleId === "rx") p.rx = Math.max(MIN_EDIT_EXTENT, Math.abs(lx));
  else p.ry = Math.max(MIN_EDIT_EXTENT, Math.abs(ly));
  const near = Math.min(p.rx, p.ry) / Math.max(p.rx, p.ry) > 1 - SNAP_RATIO;
  if (force || near) p.rx = p.ry = handleId === "rx" ? p.rx : p.ry;
}

export function applyRotation(el, origParams, center, totalAngle) {
  const [cx, cy] = center;
  const p = el.params;
  if (el.type === "rect" || el.type === "ellipse") {
    p.rot = (origParams.rot || 0) + totalAngle;
  } else if (el.type === "line") {
    const [ax, ay] = rot2(origParams.x1 - cx, origParams.y1 - cy, totalAngle);
    const [bx, by] = rot2(origParams.x2 - cx, origParams.y2 - cy, totalAngle);
    p.x1 = cx + ax; p.y1 = cy + ay; p.x2 = cx + bx; p.y2 = cy + by;
  } else if (el.type === "freehand") {
    p.points = origParams.points.map(([px, py]) => {
      const [dx, dy] = rot2(px - cx, py - cy, totalAngle);
      return [cx + dx, cy + dy];
    });
  }
}

function minVisibleDistance(el, x, y) {
  let min = Infinity;
  for (const run of visibleRuns(el)) {
    for (const q of run) min = Math.min(min, Math.hypot(q.x - x, q.y - y));
  }
  return min;
}

export function probe(list, x, y, { reach, handleR, band }) {
  for (let i = list.length - 1; i >= 0; i--) {
    for (const h of handlesOf(list[i])) {
      if (Math.hypot(h.x - x, h.y - y) <= handleR) return { kind: "handle", el: list[i], handle: h };
    }
  }
  for (let i = list.length - 1; i >= 0; i--) {
    if (minVisibleDistance(list[i], x, y) <= reach) return { kind: "outline", el: list[i] };
  }
  // Rotate only when "just outside" is unambiguous: exactly one element close.
  const near = list.filter((el) => minVisibleDistance(el, x, y) <= reach + band);
  if (near.length === 1) return { kind: "rotate", el: near[0] };
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/framework/annotate/elements-edit.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/annotate/elements.js test/framework/annotate/elements-edit.test.js
git commit -m "feat(annotate): hand-tool handles, anchored resize, rotation, probe"
```

---

### Task 5: Interval eraser (`elements.js` part 5)

**Files:**
- Modify: `src/framework/annotate/elements.js` (append)
- Test: `test/framework/annotate/elements-eraser.test.js`

**Interfaces:**
- Consumes: `sample`, `mergeGaps`, `visibleFraction`, `MIN_VISIBLE`.
- Produces:
  - `eraseSegment(list, ax, ay, bx, by, { radius, halfWidth }) → { changed, list }` — marks every sample within `radius + halfWidth` of the swept segment as erased (span padded by half a sample step), merges into each element's `gaps`, and drops elements whose visible fraction falls below `MIN_VISIBLE`. Returns the (possibly filtered) new list and whether anything changed. Does NOT notify — the mode calls `store.setList` / `store.touch`.

- [ ] **Step 1: Write the failing tests**

```js
// test/framework/annotate/elements-eraser.test.js
// The interval eraser: spans in the parameter domain, params never touched.
import { expect, test } from "vitest";
import {
  eraseSegment, visibleFraction, translateElement, invalidateSample,
  DEFAULT_STROKE_WIDTH,
} from "../../../src/framework/annotate/elements.js";

const el = (type, params, gaps = []) =>
  ({ type, color: "red", width: DEFAULT_STROKE_WIDTH, params, gaps });

test("a brush pass over the middle of a line erases a middle span", () => {
  const line = el("line", { x1: 0, y1: 0.5, x2: 1, y2: 0.5 });
  const { changed, list } = eraseSegment([line], 0.5, 0.4, 0.5, 0.6, { radius: 0.03, halfWidth: 0.002 });
  expect(changed).toBe(true);
  expect(list).toHaveLength(1);
  expect(line.gaps).toHaveLength(1);
  const [a, b] = line.gaps[0];
  expect(a).toBeGreaterThan(0.4); expect(a).toBeLessThan(0.5);
  expect(b).toBeGreaterThan(0.5); expect(b).toBeLessThan(0.6);
  expect(line.params).toEqual({ x1: 0, y1: 0.5, x2: 1, y2: 0.5 }); // params survive
});

test("a miss changes nothing", () => {
  const line = el("line", { x1: 0, y1: 0.5, x2: 1, y2: 0.5 });
  const { changed } = eraseSegment([line], 0.5, 0.1, 0.6, 0.1, { radius: 0.03, halfWidth: 0.002 });
  expect(changed).toBe(false);
  expect(line.gaps).toEqual([]);
});

test("overlapping passes merge into one gap", () => {
  const line = el("line", { x1: 0, y1: 0.5, x2: 1, y2: 0.5 });
  eraseSegment([line], 0.3, 0.5, 0.3, 0.5, { radius: 0.05, halfWidth: 0.002 });
  eraseSegment([line], 0.35, 0.5, 0.35, 0.5, { radius: 0.05, halfWidth: 0.002 });
  expect(line.gaps).toHaveLength(1);
});

test("erasing nearly everything drops the element", () => {
  const line = el("line", { x1: 0.4, y1: 0.5, x2: 0.6, y2: 0.5 });
  const { list } = eraseSegment([line], 0.3, 0.5, 0.7, 0.5, { radius: 0.05, halfWidth: 0.002 });
  expect(list).toHaveLength(0);
});

test("gaps are parametric: they ride along when the element moves", () => {
  const line = el("line", { x1: 0, y1: 0.5, x2: 1, y2: 0.5 });
  eraseSegment([line], 0.5, 0.5, 0.5, 0.5, { radius: 0.05, halfWidth: 0.002 });
  const before = JSON.parse(JSON.stringify(line.gaps));
  translateElement(line, 0.2, 0.1);
  invalidateSample(line);
  expect(line.gaps).toEqual(before);
});

test("a circle keeps its params through a partial erase", () => {
  const circle = el("ellipse", { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2, rot: 0 });
  eraseSegment([circle], 0.5, 0.3, 0.5, 0.3, { radius: 0.04, halfWidth: 0.002 });
  expect(circle.gaps.length).toBeGreaterThan(0);
  expect(visibleFraction(circle)).toBeLessThan(1);
  expect(circle.params.rx).toBe(0.2); // still a known circle
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/annotate/elements-eraser.test.js`
Expected: FAIL — `eraseSegment` not exported.

- [ ] **Step 3: Implement (append to `elements.js`)**

```js
// ---- eraser ----------------------------------------------------------------
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

// One eraser sweep step: subtract the covered t-spans from every element it
// touches. Params are never modified — only `gaps` — which is the whole
// point: a half-erased circle is still "a circle, center c, radius r".
export function eraseSegment(list, ax, ay, bx, by, { radius, halfWidth }) {
  let changed = false;
  const next = list.filter((el) => {
    const { pts } = sample(el);
    const halfStep = (pts.length > 1 ? pts[1].t - pts[0].t : 1) / 2;
    const hits = [];
    for (const p of pts) {
      if (distToSegment(p.x, p.y, ax, ay, bx, by) <= radius + halfWidth) {
        hits.push([Math.max(0, p.t - halfStep), Math.min(1, p.t + halfStep)]);
      }
    }
    if (!hits.length) return true;
    changed = true;
    el.gaps = mergeGaps(el.gaps.concat(hits));
    return visibleFraction(el) > MIN_VISIBLE;
  });
  return { changed, list: changed ? next : list };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/framework/annotate/elements-eraser.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/annotate/elements.js test/framework/annotate/elements-eraser.test.js
git commit -m "feat(annotate): interval eraser — spans in the parameter domain, params survive"
```

---

### Task 6: Semantics — describe strings and anchors (`elements.js` part 6)

**Files:**
- Modify: `src/framework/annotate/elements.js` (append)
- Test: `test/framework/annotate/elements-semantics.test.js`

**Interfaces:**
- Consumes: `visibleRuns`, `visibleFraction`, `centerOf`.
- Produces:
  - `describeElement(el, aspect) → string` — e.g. `"rect · c (34%, 79%) · 20% × 25% · rot 62°"`, `"circle · c (50%, 51%) · r 13%"`, `"square · …"`, gap note appended when gaps exist: `" · 63% visible · 2 gaps"`. Percentages: x-positions and widths relative to viewport width (`v / aspect`), y-positions and heights relative to height (`v / 1`), radii relative to the short edge (`v / min(1, aspect)`). Rotation folded to `(-180°, 180]`, omitted at 0.
  - `elementAnchors(el) → [{ at, x, y }, …]` — stage-space anchor points: per visible run `start` / `mid` (middle sample) / `end`; plus `center` for rect/ellipse. The mode converts to normalized screen + raycasts.

- [ ] **Step 1: Write the failing tests**

```js
// test/framework/annotate/elements-semantics.test.js
// Semantic descriptions and anchor specs — what the LLM reads.
import { expect, test } from "vitest";
import {
  describeElement, elementAnchors, DEFAULT_STROKE_WIDTH,
} from "../../../src/framework/annotate/elements.js";

const el = (type, params, gaps = []) =>
  ({ type, color: "red", width: DEFAULT_STROKE_WIDTH, params, gaps });

test("circle and square naming, aspect-aware percentages", () => {
  // aspect 2: stage width is 2 units
  const circle = el("ellipse", { cx: 1, cy: 0.5, rx: 0.2, ry: 0.2, rot: 0 });
  expect(describeElement(circle, 2)).toBe("circle · c (50%, 50%) · r 20%");
  const square = el("rect", { cx: 1, cy: 0.5, w: 0.4, h: 0.4, rot: 0 });
  expect(describeElement(square, 2)).toBe("square · c (50%, 50%) · 20%");
});

test("rect with rotation and erased gaps", () => {
  const rect = el("rect", { cx: 0.5, cy: 0.5, w: 0.4, h: 0.2, rot: Math.PI / 3 },
    [[0.1, 0.2], [0.5, 0.6]]);
  expect(describeElement(rect, 1))
    .toBe("rect · c (50%, 50%) · 40% × 20% · rot 60° · 80% visible · 2 gaps");
});

test("rotation folds to (-180, 180] and is silent at zero", () => {
  const r = (rot) => describeElement(el("rect", { cx: 0.5, cy: 0.5, w: 0.4, h: 0.2, rot }), 1);
  expect(r(0)).not.toContain("rot");
  expect(r(Math.PI * 1.5)).toContain("rot -90°");
});

test("line and freehand descriptions", () => {
  expect(describeElement(el("line", { x1: 0, y1: 0, x2: 1, y2: 1 }), 1))
    .toBe("line · (0%, 0%) → (100%, 100%)");
  expect(describeElement(el("freehand", { points: [[0, 0], [0.5, 0.5], [1, 0]] }), 1))
    .toBe("freehand · 3 pts");
});

test("anchors: start/mid/end per visible run, center for closed shapes", () => {
  const line = el("line", { x1: 0, y1: 0.5, x2: 1, y2: 0.5 }, [[0.4, 0.6]]);
  const anchors = elementAnchors(line);
  expect(anchors.filter((a) => a.at === "start")).toHaveLength(2); // two runs
  expect(anchors.filter((a) => a.at === "center")).toHaveLength(0);
  const rect = el("rect", { cx: 0.5, cy: 0.5, w: 0.4, h: 0.2, rot: 0 });
  const rectAnchors = elementAnchors(rect);
  expect(rectAnchors.find((a) => a.at === "center")).toMatchObject({ x: 0.5, y: 0.5 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/annotate/elements-semantics.test.js`
Expected: FAIL — `describeElement` not exported.

- [ ] **Step 3: Implement (append to `elements.js`)**

```js
// ---- semantics -------------------------------------------------------------
function rotNote(rot) {
  let d = Math.round((rot || 0) * 180 / Math.PI) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d ? ` · rot ${d}°` : "";
}

function gapNote(el) {
  if (!el.gaps.length) return "";
  const pct = Math.round(visibleFraction(el) * 100);
  return ` · ${pct}% visible · ${el.gaps.length} gap${el.gaps.length > 1 ? "s" : ""}`;
}

export function describeElement(el, aspect) {
  const p = el.params;
  const px = (v) => `${Math.round((v / aspect) * 100)}%`;   // x-positions, widths
  const py = (v) => `${Math.round(v * 100)}%`;               // y-positions, heights
  const pr = (v) => `${Math.round((v / Math.min(1, aspect)) * 100)}%`; // radii: short edge
  let base;
  if (el.type === "freehand") base = `freehand · ${p.points.length} pts`;
  else if (el.type === "line") {
    base = `line · (${px(p.x1)}, ${py(p.y1)}) → (${px(p.x2)}, ${py(p.y2)})`;
  } else if (el.type === "rect") {
    base = (p.w === p.h
      ? `square · c (${px(p.cx)}, ${py(p.cy)}) · ${px(p.w)}`
      : `rect · c (${px(p.cx)}, ${py(p.cy)}) · ${px(p.w)} × ${py(p.h)}`) + rotNote(p.rot);
  } else {
    base = (p.rx === p.ry
      ? `circle · c (${px(p.cx)}, ${py(p.cy)}) · r ${pr(p.rx)}`
      : `ellipse · c (${px(p.cx)}, ${py(p.cy)}) · rx ${pr(p.rx)} · ry ${pr(p.ry)}` + rotNote(p.rot));
  }
  return base + gapNote(el);
}

export function elementAnchors(el) {
  const out = [];
  for (const run of visibleRuns(el)) {
    const mid = run[Math.floor(run.length / 2)];
    out.push({ at: "start", x: run[0].x, y: run[0].y });
    out.push({ at: "mid", x: mid.x, y: mid.y });
    out.push({ at: "end", x: run[run.length - 1].x, y: run[run.length - 1].y });
  }
  if (el.type === "rect" || el.type === "ellipse") {
    const [x, y] = centerOf(el);
    out.push({ at: "center", x, y });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/framework/annotate/elements-semantics.test.js`
Expected: PASS. Watch the exact string formats — the tests pin them; the
payload `description` field reuses these strings verbatim.

- [ ] **Step 5: Commit**

```bash
git add src/framework/annotate/elements.js test/framework/annotate/elements-semantics.test.js
git commit -m "feat(annotate): semantic describe strings and per-run anchor specs"
```

---

### Task 7: Renderer — typed elements + overlay adornments (`ink-canvas.js`)

**Files:**
- Modify: `src/framework/annotate/ink-canvas.js` (rework the drawing core; keep resize/DPR/export plumbing and the injectable `getContext2d`/`createCanvas` test seams)
- Test: `test/framework/annotate/ink-canvas.test.js` (rework: the existing file tests `setStrokes`; replace those cases, keep its fake-context idiom)

**Interfaces:**
- Consumes: `visibleRuns`, `INK_COLORS`, `handlesOf` from `elements.js`.
- Produces (consumed by Task 8's mode):
  - `createInkCanvas(stage, { getContext2d, createCanvas })` — unchanged signature.
  - `canvas.setScene(scene)` REPLACES `setStrokes`. `scene = { elements, overlay }`:
    - `elements`: the element list (stage space). Rendering maps stage→pixels by `px = x * heightPx`, `py = y * heightPx` (bitmap width = aspect × height by construction).
    - `overlay` (all optional, all stage space unless noted): `{ guide: { kind: "rect"|"cross", cx, cy, w, h } | null, label: { x, y, text } | null, glowEl, handlesEl, eraser: { x, y } | null, rotateGlyph: { x, y } | null }`
  - Live draw order: glow (accent, α 0.35, wide) → all halos → all cores (per-element `INK_COLORS[el.color]`) → handles (7 px squares, surface fill / accent stroke) → guide (dashed accent) → label (10 px mono, surface plate, accent text) → rotate glyph → eraser ring.
  - `toDataUrl({ maxEdge })` — EXPORTS ELEMENTS ONLY (no overlay); same scratch-canvas re-rasterize contract as today.
  - `size()`, `show()`, `hide()`, `dispose()` unchanged.
  - Overlay chrome colors resolve via `getComputedStyle(canvas)` on `--pf-accent`, `--pf-surface`, `--pf-text` with literal fallbacks (`#3f7bf0`, `#ffffff`, `#111111`) for bare test environments.

- [ ] **Step 1: Rework the tests**

Replace the `setStrokes`-based cases in `test/framework/annotate/ink-canvas.test.js` with scene-based ones, keeping the file's existing fake-2d-context recording idiom (a stub object recording method calls, injected via `getContext2d`). New cases (write them in that file's established style — read it first):

```js
// Key new assertions (adapt into the existing fixture style):
test("setScene draws halo before core, per element color", () => {
  const { canvas, calls } = fixture(); // existing idiom: records ctx ops
  canvas.setScene({
    elements: [
      { type: "line", color: "blue", width: 0.004, params: { x1: 0, y1: 0, x2: 0.5, y2: 0.5 }, gaps: [] },
    ],
    overlay: {},
  });
  const strokeStyles = calls.filter((c) => c.prop === "strokeStyle").map((c) => c.value);
  expect(strokeStyles[0]).toBe("rgba(255, 255, 255, 0.85)"); // halo pass first
  expect(strokeStyles).toContain("#1570ef");                  // blue core after
});

test("gapped elements draw one path per visible run", () => {
  const { canvas, countOps } = fixture();
  canvas.setScene({
    elements: [
      { type: "line", color: "red", width: 0.004, params: { x1: 0, y1: 0.5, x2: 1, y2: 0.5 }, gaps: [[0.4, 0.6]] },
    ],
    overlay: {},
  });
  // 2 runs × 2 passes (halo+core) = 4 beginPath+stroke pairs
  expect(countOps("beginPath")).toBe(4);
});

test("toDataUrl exports elements only — overlay adornments never reach the PNG", () => {
  const { canvas, callsSince } = fixture();
  canvas.setScene({
    elements: [{ type: "line", color: "red", width: 0.004, params: { x1: 0, y1: 0, x2: 1, y2: 1 }, gaps: [] }],
    overlay: { eraser: { x: 0.5, y: 0.5 }, label: { x: 0.1, y: 0.1, text: "r 10" } },
  });
  const mark = callsSince();
  canvas.toDataUrl({ maxEdge: 100 });
  const exported = mark();
  expect(exported.some((c) => c.op === "fillText")).toBe(false); // no label in export
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/annotate/ink-canvas.test.js`
Expected: FAIL — `setScene` is not a function.

- [ ] **Step 3: Implement**

Rework `ink-canvas.js`'s drawing core. Keep: constructor shape, `resize()` +
ResizeObserver + hidden-skip comment, `toDataUrl` maxEdge scratch logic,
`size/show/hide/dispose`. Replace `setStrokes`/`drawPass`/`drawInto`:

```js
import { visibleRuns, handlesOf, INK_COLORS } from "./elements.js";

const HALO_COLOR = "rgba(255, 255, 255, 0.85)";
const HALO_RATIO = 2.2;

// stage space → pixels: y ∈ [0,1] spans the bitmap height; x is pre-scaled by
// aspect so the same factor applies (bitmap width = aspect × height).
const mapper = (target) => {
  const s = target.height;
  return (p) => [p.x * s, p.y * s];
};

function strokePass(target, ctx, elements, widthScale, colorOf) {
  const short = Math.min(target.width, target.height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const toPx = mapper(target);
  for (const el of elements) {
    const w = el.width * short * widthScale;
    ctx.strokeStyle = colorOf(el);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = w;
    for (const run of visibleRuns(el)) {
      if (run.length === 1) {
        const [x, y] = toPx(run[0]);
        ctx.beginPath(); ctx.arc(x, y, w / 2, 0, Math.PI * 2); ctx.fill();
        continue;
      }
      ctx.beginPath();
      run.forEach((p, i) => {
        const [x, y] = toPx(p);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }
}

// Elements only — this is the export path AND the base of the live draw.
function drawElements(ctx, target, elements) {
  ctx.clearRect(0, 0, target.width, target.height);
  strokePass(target, ctx, elements, HALO_RATIO, () => HALO_COLOR);
  strokePass(target, ctx, elements, 1, (el) => INK_COLORS[el.color]);
}
```

Then a `drawOverlay(ctx, target, overlay, elements)` that draws (in order)
glow (`overlay.glowEl`: its visible runs, accent, `globalAlpha 0.35`, width
`strokeWidthPx × HALO_RATIO × 1.6`), handles (`overlay.handlesEl`:
`handlesOf(el)` → 7 px squares centered on each mapped point, surface fill +
accent 1.5 px stroke), guide (`kind: "rect"` → dashed `strokeRect` of the
mapped box; `kind: "cross"` → 5 px cross at cx,cy), label (measureText,
surface plate rect, accent `fillText` offset +8/−3 px from the mapped point),
rotate glyph (8 px arc −0.15π→1.15π + filled arrowhead triangle, `--pf-text`),
eraser ring (16 px circle, `--pf-text`, α 0.7). Live `draw()` becomes
`drawElements` then `drawOverlay`; the scene is held as
`let scene = { elements: [], overlay: {} }`, set by `setScene(next)` which
re-draws. `toDataUrl` calls `drawElements` only into the scratch (and the live
canvas re-draws with overlay afterward if it exported from the live canvas —
simplest: always export via a scratch canvas now that overlay must be
excluded; keep the maxEdge scaling behavior).

Color resolution helper:

```js
const chromeColor = (canvas, name, fallback) => {
  try {
    const v = globalThis.getComputedStyle?.(canvas)?.getPropertyValue(name)?.trim();
    return v || fallback;
  } catch { return fallback; }
};
// accent: chromeColor(canvas, "--pf-accent", "#3f7bf0")
// surface: chromeColor(canvas, "--pf-surface", "#ffffff")
// text:   chromeColor(canvas, "--pf-text", "#111111")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/framework/annotate/ink-canvas.test.js`
Expected: PASS. Also run the whole annotate directory — `annotate-mode.test.js`
WILL now fail (it still drives `setStrokes` via the old mode); that is
expected and fixed in Task 8. Do not "fix" it here.

- [ ] **Step 5: Commit**

```bash
git add src/framework/annotate/ink-canvas.js test/framework/annotate/ink-canvas.test.js
git commit -m "feat(annotate): renderer draws typed elements with per-color ink and overlay adornments"
```

---

### Task 8: Mode — tool state machine, gestures, payload v3 (`annotate-mode.js`)

**Files:**
- Modify: `src/framework/annotate/annotate-mode.js` (major rework)
- Delete: `src/framework/annotate/ink.js`, `test/framework/annotate/ink.test.js`
- Test: `test/framework/annotate/annotate-mode.test.js` (rework — keep fixtures/idioms, retarget to elements)

**Interfaces:**
- Consumes: everything from `elements.js`; `createInkCanvas` with `setScene`.
- Produces (the full mode object — mount and both chrome files consume this):
  - Existing surface unchanged: `setEnabled(on)`, `isEnabled()`, `undo()`, `clear()`, `strokeCount()` (now element count), `send()`, `onInkChange(cb)`, `onModeChange(cb)`, `detach()`.
  - New for chrome: `setTool(t)` / `tool()` (`"pen"|"line"|"rect"|"ellipse"|"hand"|"eraser"`), `setColor(c)` / `color()` (`"red"|"blue"|"green"`), `canUndo()`, `onToolChange(cb) → unsubscribe` (fires on tool OR color change).
  - `ANNOTATION_VERSION = 3`.
  - Pixel thresholds (converted to stage units per event by dividing by `rect.height`): `HANDLE_PX = 8`, `ROTATE_BAND_PX = 22`, `ERASER_PX = 16`, reach `max(10, 1.5 × width·shortEdgePx)`.
  - Payload v3 per the spec (shape below in Step 3).

- [ ] **Step 1: Rework the tests**

Keep the existing fixture machinery (fakeCanvas — now with `setScene: vi.fn()` instead of `setStrokes` — fakeViewer with real THREE cameras, `pointer()` helper, RECT `{left:10, top:20, width:200, height:100}` so aspect = 2). Key cases (rewrite the file around these; port the camera-block and send-abort cases from the existing file unchanged in intent):

```js
// stage-space conversion: RECT height 100 → stage x = (clientX-10)/100, y = (clientY-20)/100
const drag = (canvas, from, to) => {
  canvas.element.dispatchEvent(pointer("pointerdown", from[0], from[1]));
  canvas.element.dispatchEvent(pointer("pointermove", to[0], to[1]));
  canvas.element.dispatchEvent(pointer("pointerup", to[0], to[1]));
};

test("pen is the default tool; a drag commits a freehand element", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  expect(mode.tool()).toBe("pen");
  drag(canvas, [60, 45], [110, 70]);
  expect(mode.strokeCount()).toBe(1);
});

test("rect tool commits center-based params in stage space", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  mode.setTool("rect");
  drag(canvas, [30, 40], [110, 90]); // stage (0.2,0.2) → (1.0,0.7)
  const scene = lastScene(canvas);   // helper: canvas.setScene.mock.calls.at(-1)[0]
  expect(scene.elements[0].type).toBe("rect");
  expect(scene.elements[0].params.cx).toBeCloseTo(0.6);
  expect(scene.elements[0].params.cy).toBeCloseTo(0.45);
  expect(scene.elements[0].params.w).toBeCloseTo(0.8);
  expect(scene.elements[0].params.h).toBeCloseTo(0.5);
});

test("color selection applies to subsequent elements", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  mode.setColor("green");
  drag(canvas, [60, 45], [110, 70]);
  expect(lastScene(canvas).elements[0].color).toBe("green");
});

test("eraser drag adds gaps; undo restores them away", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  mode.setTool("line");
  drag(canvas, [10, 70], [210, 70]);  // full-width line at y=0.5
  mode.setTool("eraser");
  drag(canvas, [110, 60], [110, 80]); // brush through the middle
  const gapped = lastScene(canvas).elements[0];
  expect(gapped.gaps.length).toBe(1);
  mode.undo();
  expect(lastScene(canvas).elements[0].gaps).toEqual([]);
});

test("hand tool moves an element by its outline", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  mode.setTool("line");
  drag(canvas, [10, 70], [210, 70]);
  mode.setTool("hand");
  drag(canvas, [110, 70], [110, 90]); // grab the middle, pull down 0.2 stage
  const moved = lastScene(canvas).elements[0];
  expect(moved.params.y1).toBeCloseTo(0.7);
  expect(moved.params.y2).toBeCloseTo(0.7);
});

test("send payload is v3: elements with params, erased, description, anchors", () => {
  const { mode, canvas, onSend } = fixture();
  mode.setEnabled(true);
  mode.setTool("rect");
  drag(canvas, [30, 40], [110, 90]);
  expect(mode.send()).toBe(true);
  const payload = onSend.mock.calls[0][0];
  expect(payload.version).toBe(3);
  expect(payload.strokes).toBeUndefined();
  const [rect] = payload.elements;
  expect(rect.type).toBe("rect");
  expect(rect.color).toEqual({ name: "red", hex: "#d92d20" });
  expect(rect.erased).toEqual([]);
  expect(rect.visibleFraction).toBe(1);
  expect(rect.description).toContain("rect · c");
  const center = rect.anchors.find((a) => a.at === "center");
  // anchors are normalized per axis 0..1 (screen frame, as v2)
  expect(center.screen[0]).toBeCloseTo(0.3); // stage 0.6 / aspect 2
  expect(center.screen[1]).toBeCloseTo(0.45);
  expect(center).toHaveProperty("hit");
  expect(payload.images).toEqual({ drawing: expect.any(String), model: "data:image/jpeg;base64,MODEL" });
});

test("escape-like cancel: setEnabled(false) mid-gesture discards everything", () => {
  const { mode, canvas } = fixture();
  mode.setEnabled(true);
  canvas.element.dispatchEvent(pointer("pointerdown", 60, 45));
  mode.setEnabled(false);
  mode.setEnabled(true);
  expect(mode.strokeCount()).toBe(0);
});

test("onToolChange fires for tool and color changes", () => {
  const { mode } = fixture();
  let calls = 0;
  mode.onToolChange(() => { calls += 1; });
  mode.setTool("rect");
  mode.setColor("blue");
  mode.setTool("rect"); // no-op: unchanged
  expect(calls).toBe(2);
});
```

Port from the existing file WITHOUT behavioral change: the camera-block tests
(perspective + orthographic, world + parts frames), the
send-aborts-on-null-capture test, the detach-while-enabled test, and the
mutual-exclusion-ready `onModeChange` tests. They should only need
`setStrokes` → `setScene` fixture renames.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/annotate/annotate-mode.test.js`
Expected: FAIL — `mode.setTool` is not a function (and payload still v2).

- [ ] **Step 3: Implement**

Rework `annotate-mode.js`. Structure (keep `cameraBlock()` and the
`SEND_MAX_EDGE` / capture-first logic verbatim; keep the enable/disable and
detach contracts):

```js
import {
  createElementStore, DEFAULT_STROKE_WIDTH, INK_COLORS, MIN_VISIBLE,
  rectFromDrag, ellipseFromDrag, lineFromDrag, appendThinned,
  probe, handlesOf, centerOf, translateElement, rectAnchorFor,
  resizeRectFromAnchor, resizeEllipseHandle, applyRotation,
  eraseSegment, describeElement, elementAnchors, visibleFraction,
} from "./elements.js";

export const ANNOTATION_VERSION = 3;
const HANDLE_PX = 8;
const ROTATE_BAND_PX = 22;
const ERASER_PX = 16;
const MIN_DRAG_PX = 6;          // sub-6px shape drags commit nothing
const FREEHAND_MIN_DIST = 0.003; // stage units (~ink.js thinning at aspect 1)
```

State: `let tool = "pen"`, `let color = "red"`, `let gesture = null`,
`let hoverProbe = null`, `let pointerPos = null`; `const store = createElementStore()`.
`toolListeners` Set alongside the existing mode listeners.

Coordinate conversion per event (aspect from the live rect):

```js
const stagePoint = (event, rect) => [
  Math.min(rect.width / rect.height, Math.max(0, (event.clientX - rect.left) / rect.height)),
  Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
];
const stageUnits = (px, rect) => px / rect.height;
```

Pointer handlers implement exactly the prototype's routing, in stage units
(each `pointerdown` that commits an action calls `store.snapshot()` first):

- pen: `store.snapshot(); store.add({type:"freehand", color, width: DEFAULT_STROKE_WIDTH, params:{points:[[x,y]]}, gaps: []})`; moves `appendThinned` + `store.touch(el)`; pointerup ends (dot stays).
- line/rect/ellipse: gesture holds `{kind, x0, y0}`; moves rebuild a preview element `{ type, color, width, params, gaps: [] }` from the builder (`force: event.shiftKey`; line `snap45: event.shiftKey`) and set it on the scene overlay (guide + label, below); pointerup commits via `store.snapshot(); store.add(el)` unless the drag was under `MIN_DRAG_PX` (`Math.hypot(dxPx, dyPx) < MIN_DRAG_PX`).
- eraser: snapshot on down; every move `eraseSegment(store.list(), lx, ly, x, y, { radius: stageUnits(ERASER_PX, rect), halfWidth: el-independent: stageUnits(strokeWidthPx(rect)/2, rect) })` — compute `strokeWidthPx(rect) = DEFAULT_STROKE_WIDTH * Math.min(rect.width, rect.height)`; on `changed`, `store.setList(result.list)`.
- hand: down → `probe(store.list(), x, y, { reach, handleR, band })` with `reach = Math.max(stageUnits(10, rect), 1.5 * DEFAULT_STROKE_WIDTH * Math.min(rect.width, rect.height) / rect.height)`, `handleR = stageUnits(HANDLE_PX, rect)`, `band = stageUnits(ROTATE_BAND_PX, rect)`. Build the gesture per kind exactly as the spec: outline → move (`translateElement` + `touch` per move); handle on line → endpoint assignment; handle on rect → capture `rectAnchorFor` + `rot` once, `resizeRectFromAnchor` per move (`force: shiftKey`); handle on ellipse → `resizeEllipseHandle`; rotate → capture `centerOf`, `a0 = atan2`, `orig = structuredClone(el.params)`, per move `total = atan2 − a0`, shift snaps `total` to `Math.PI/12` multiples, `applyRotation(el, orig, center, total)` + `touch`.
- hover (hand, no gesture): re-probe per move; update scene overlay (glow/handles) and notify tool listeners only when the probe identity changed.
- Escape (keydown on the canvas element): cancel an in-flight gesture (restore via `store.undo()` ONLY for gestures that snapshotted at pointerdown and already mutated — i.e. hand edits and eraser; draw gestures just drop the preview). If no gesture, do nothing here — mode exit stays the chrome's Escape (annotate-controls).

Scene sync — one function, called on every store change and gesture frame:

```js
function syncScene() {
  canvas?.setScene({
    elements: gesture?.preview ? [...store.list(), gesture.preview] : store.list(),
    overlay: buildOverlay(), // guide/label/glow/handles/eraser ring/rotate glyph from gesture+hoverProbe+pointerPos
  });
}
```

(Draw previews render as ordinary elements at the end of the list; the
overlay carries the dashed guide box/cross + live label text — `w × h`
`· square` when snapped, `r …` / `rx … ry …`, line `len · angle°`, rotation
`±deg°` — computed in PIXEL values for readability: multiply stage extents by
`rect.height` and round.)

`send()` (payload v3; capture-first contract kept):

```js
const rect = rectOf();
const aspect = rect.width / rect.height;
const round4 = (v) => +v.toFixed(4);
const roundParams = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) =>
  [k, Array.isArray(v) ? v.map((q) => q.map(round4)) : round4(v)]));
const elements = store.list().map((el) => ({
  type: el.type,
  color: { name: el.color, hex: INK_COLORS[el.color] },
  width: el.width,
  params: el.type === "ellipse" && el.params.rx === el.params.ry
    ? { cx: round4(el.params.cx), cy: round4(el.params.cy), r: round4(el.params.rx), rot: round4(el.params.rot || 0), circle: true }
    : el.type === "rect"
      ? { ...roundParams(el.params), square: el.params.w === el.params.h }
      : roundParams(el.params),
  erased: el.gaps.map(([a, b]) => [round4(a), round4(b)]),
  visibleFraction: +visibleFraction(el).toFixed(3),
  description: `${el.color} ${describeElement(el, aspect)}`,
  anchors: elementAnchors(el).map(({ at, x, y }) => {
    const screen = [x / aspect, y]; // per-axis normalized, the v2 frame
    const hit = raycastViewer(viewer,
      rect.left + screen[0] * rect.width, rect.top + screen[1] * rect.height);
    return { at, screen: screen.map(round4), hit: hit ? { subPart: hit.subPart, pointLocal: hit.pointLocal } : null };
  }),
}));
onSend?.({
  version: ANNOTATION_VERSION,
  elements,
  images: { drawing: canvas.toDataUrl({ maxEdge: SEND_MAX_EDGE }), model },
  camera: cameraBlock(),
  viewport: { width: rect.width, height: rect.height, dpr },
  context: { view, params: { ...params } },
});
```

Public additions:

```js
setTool(next) { if (next === tool) return; tool = next; gesture = null; hoverProbe = null; syncScene(); notifyTool(); },
tool: () => tool,
setColor(next) { if (next === color) return; color = next; notifyTool(); },
color: () => color,
canUndo: () => store.canUndo(),
onToolChange(cb) { toolListeners.add(cb); return () => toolListeners.delete(cb); },
```

`setEnabled(false)` resets: `store.clear()` is wrong (it snapshots) — use a
dedicated discard: call `store.setList([])` AND drop the undo history (add
`store.reset()` to `elements.js`: empties items and the undo stack, notifies;
add a one-line test for it in `elements-store.test.js`). Also reset
`tool = "pen"`, `color = "red"` on exit? NO — keep tool/color across
enable cycles within a session (cheap continuity); ink never survives exit
(spec), so only the element list resets.

Finally delete `ink.js` and its test file; nothing imports them after this task.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/framework/annotate/` — annotate-mode, ink-canvas,
elements-* all green. `annotate-controls.test.js` and `mount-wiring.test.js`
must still pass untouched (the mode's old surface is intact); if they fail,
the mode broke its host contract — fix the mode, not those tests.

- [ ] **Step 5: Commit**

```bash
git add -A src/framework/annotate test/framework/annotate
git commit -m "feat(annotate): tool state machine, hand-tool gestures, v3 element payload"
```

---

### Task 9: Sketch toolbar chrome (`sketch-toolbar.js` + CSS)

**Files:**
- Create: `src/framework/annotate/sketch-toolbar.js`
- Modify: `src/framework/app.css` (toolbar styles — put them beside the `#viewbar` block, ~line 315)
- Test: `test/framework/annotate/sketch-toolbar.test.js`

**Interfaces:**
- Consumes: mode surface from Task 8 (`setTool/tool/setColor/color/canUndo/undo/clear/send/strokeCount/isEnabled/onInkChange/onModeChange/onToolChange`), `attachButtonTooltips` from `../tooltip.js`, `runCleanupSteps` from `../teardown.js`, `INK_COLORS`.
- Produces: `attachSketchToolbar(mode, { stage, tooltip, send = "viewbar" }) → { element, detach }`
  - Builds `<div class="pf-sketch-toolbar" role="toolbar" hidden>` appended to the STAGE (the ink-canvas parent), plus a `<div class="pf-sketch-hint">` sibling.
  - Buttons in order: pen, line, rect, ellipse, hand, eraser (SVG icons, 34 px, `.on` = active tool, `aria-pressed`), separator, three `.pf-swatch` color buttons, separator, undo, clear icons — and a labeled `Send` button at the end ONLY when `send !== "host"`.
  - Tooltips: every button registered with `attachButtonTooltips(tooltip, entries)` when a tooltip is passed; otherwise `title` attributes (Pen / Line / Rectangle / Ellipse / Move / Eraser / Red ink / Blue ink / Green ink / Undo / Clear / Send).
  - Hint line text per tool (exact strings): pen `"drag to draw"`, line `"drag endpoint to endpoint · shift = 45° snap"`, rect `"drag corner to corner · snaps to square near 1:1 · shift forces"`, ellipse `"drag corner to corner · snaps to circle near 1:1 · shift forces"`, hand `"drag a shape to move it · handles resize · just outside rotates"`, eraser `"scrub to erase — shapes remember themselves"`.
  - Visibility: toolbar+hint shown iff `mode.isEnabled()` (sync on `onModeChange`).
  - Disabled sync on `onInkChange` + `onToolChange`: undo ↔ `!mode.canUndo()`, clear/Send ↔ `mode.strokeCount() === 0`.
  - `detach()` removes the DOM and unsubscribes (use `runCleanupSteps`).

- [ ] **Step 1: Write the failing tests**

```js
// test/framework/annotate/sketch-toolbar.test.js
// @vitest-environment happy-dom
// The sketch-mode toolbar: build, sync, tool wiring, host-send contract.
import { afterEach, expect, test, vi } from "vitest";
import { attachSketchToolbar } from "../../../src/framework/annotate/sketch-toolbar.js";

afterEach(() => { document.body.innerHTML = ""; });

function fakeMode(over = {}) {
  const toolCbs = new Set(), inkCbs = new Set(), modeCbs = new Set();
  let tool = "pen", color = "red", enabled = false;
  return {
    tool: () => tool, color: () => color,
    setTool: vi.fn((t) => { tool = t; toolCbs.forEach((cb) => cb()); }),
    setColor: vi.fn((c) => { color = c; toolCbs.forEach((cb) => cb()); }),
    isEnabled: () => enabled,
    _setEnabled(on) { enabled = on; modeCbs.forEach((cb) => cb()); },
    strokeCount: () => 0, canUndo: () => false,
    undo: vi.fn(), clear: vi.fn(), send: vi.fn(),
    onToolChange: (cb) => { toolCbs.add(cb); return () => toolCbs.delete(cb); },
    onInkChange: (cb) => { inkCbs.add(cb); return () => inkCbs.delete(cb); },
    onModeChange: (cb) => { modeCbs.add(cb); return () => modeCbs.delete(cb); },
    ...over,
  };
}

const stage = () => {
  const s = document.createElement("div");
  document.body.appendChild(s);
  return s;
};

test("builds six tools, three swatches, undo/clear, and follows mode visibility", () => {
  const mode = fakeMode();
  const { element } = attachSketchToolbar(mode, { stage: stage() });
  expect(element.hidden).toBe(true);
  mode._setEnabled(true);
  expect(element.hidden).toBe(false);
  expect(element.querySelectorAll("[data-tool]")).toHaveLength(6);
  expect(element.querySelectorAll("[data-color]")).toHaveLength(3);
  expect(element.querySelector('[data-action="undo"]').disabled).toBe(true);
});

test("clicking a tool selects it; clicking a swatch sets the color", () => {
  const mode = fakeMode();
  const { element } = attachSketchToolbar(mode, { stage: stage() });
  mode._setEnabled(true);
  element.querySelector('[data-tool="rect"]').click();
  expect(mode.setTool).toHaveBeenCalledWith("rect");
  expect(element.querySelector('[data-tool="rect"]').classList.contains("on")).toBe(true);
  element.querySelector('[data-color="green"]').click();
  expect(mode.setColor).toHaveBeenCalledWith("green");
});

test("send: 'viewbar' renders a Send button, 'host' renders none", () => {
  const withSend = attachSketchToolbar(fakeMode(), { stage: stage() });
  expect(withSend.element.querySelector('[data-action="send"]')).not.toBeNull();
  const hostOwned = attachSketchToolbar(fakeMode(), { stage: stage(), send: "host" });
  expect(hostOwned.element.querySelector('[data-action="send"]')).toBeNull();
});

test("hint line follows the tool", () => {
  const mode = fakeMode();
  const { element } = attachSketchToolbar(mode, { stage: stage() });
  mode._setEnabled(true);
  const hint = element.parentElement.querySelector(".pf-sketch-hint");
  expect(hint.textContent).toBe("drag to draw");
  element.querySelector('[data-tool="eraser"]').click();
  expect(hint.textContent).toBe("scrub to erase — shapes remember themselves");
});

test("detach removes the DOM and survives double-detach", () => {
  const mode = fakeMode();
  const s = stage();
  const bar = attachSketchToolbar(mode, { stage: s });
  bar.detach();
  bar.detach();
  expect(s.querySelector(".pf-sketch-toolbar")).toBeNull();
  expect(s.querySelector(".pf-sketch-hint")).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/annotate/sketch-toolbar.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`sketch-toolbar.js`: build the DOM per the interface (icons as inline SVG
constants — pen: the PENCIL_ICON path from `annotate-controls.js`; line:
`M5 19 14 14-14`-style diagonal `path d="M5 19 19 5"`; rect: `rect x=4 y=6
w=16 h=12 rx=1`; ellipse: `ellipse cx=12 cy=12 rx=9 ry=6.5`; hand + eraser +
undo (`M9 14 4 9l5-5` + arc) + trash: the lucide paths already used in the
prototype — copy them from this plan's spec section or draw equivalent 24×24
stroke icons). Wire clicks to `mode.setTool` / `mode.setColor` /
`mode.undo` / `mode.clear` / `mode.send`; subscribe to the three mode
listener channels for sync; `detach` with `runCleanupSteps`.

CSS (append near the `#viewbar` rules in `app.css`; reuse the pill tokens):

```css
/* Sketch-mode toolbar: the #viewbar pill idiom, top-centre, owning the mode
   while the viewbar itself is hidden (mount toggles both). */
.pf-sketch-toolbar {
  position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 4px; padding: 4px;
  background: var(--pf-surface); border: 1px solid var(--pf-border);
  border-radius: var(--pf-radius-pill); box-shadow: var(--pf-shadow-float);
  z-index: 20; max-width: calc(100% - 16px); flex-wrap: wrap; justify-content: center;
}
.pf-sketch-toolbar[hidden] { display: none; }
.pf-sketch-toolbar .sep { width: 1px; align-self: stretch; margin: 4px 2px; background: var(--pf-border); }
.pf-sketch-toolbar button {
  width: 34px; height: 34px; border: 0; border-radius: var(--pf-radius-control);
  background: transparent; color: var(--pf-muted-2); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.pf-sketch-toolbar button[data-action="send"] { width: auto; min-width: 56px; padding: 0 10px; }
.pf-sketch-toolbar button:hover { color: var(--pf-text-2); background: var(--pf-surface-2); }
.pf-sketch-toolbar button:disabled { opacity: .35; cursor: default; background: transparent; color: var(--pf-muted); }
.pf-sketch-toolbar button.on { background: var(--pf-accent); color: var(--pf-on-accent); }
.pf-sketch-toolbar .pf-swatch { width: 26px; height: 26px; margin: 4px 1px; border-radius: 50%; }
.pf-sketch-toolbar .pf-swatch::before {
  content: ""; width: 14px; height: 14px; border-radius: 50%;
  background: var(--sw); box-shadow: 0 0 0 2px color-mix(in oklab, var(--sw) 25%, transparent);
}
.pf-sketch-toolbar .pf-swatch.on { background: var(--pf-surface-2); }
.pf-sketch-toolbar .pf-swatch.on::before { box-shadow: 0 0 0 2.5px var(--pf-bg), 0 0 0 4.5px var(--sw); }
.pf-sketch-hint {
  position: absolute; top: 58px; left: 50%; transform: translateX(-50%);
  font-family: var(--pf-mono); font-size: 10px; letter-spacing: .04em;
  color: var(--pf-hint); z-index: 19; pointer-events: none; white-space: nowrap;
}
.pf-sketch-hint[hidden] { display: none; }
/* hand-tool cursors on the ink canvas */
.pf-ink-canvas.hand { cursor: default; }
.pf-ink-canvas.hand.over { cursor: grab; }
.pf-ink-canvas.hand.handle { cursor: crosshair; }
.pf-ink-canvas.hand.rotate { cursor: none; }
.pf-ink-canvas.hand.dragging { cursor: grabbing; }
.pf-ink-canvas.erasing { cursor: none; }
```

(The mode from Task 8 toggles those canvas classes: add that to
`annotate-mode.js` in this task if not already present — `hand`/`erasing` on
tool change; `over/handle/rotate` from the hover probe; `dragging` during a
move gesture. Focus-visible ring: the existing shared rule in `app.css:280`
lists selectors — add `.pf-sketch-toolbar button:focus-visible` to it.)

Swatch buttons get `style="--sw:#d92d20"` etc. from `INK_COLORS`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/framework/annotate/sketch-toolbar.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/annotate/sketch-toolbar.js src/framework/app.css test/framework/annotate/sketch-toolbar.test.js src/framework/annotate/annotate-mode.js
git commit -m "feat(annotate): top-centre sketch toolbar with tools, swatches, and tooltips"
```

---

### Task 10: Wire it: mount, viewbar hide, slimmed annotate-controls

**Files:**
- Modify: `src/framework/annotate/annotate-controls.js` (drop the Undo/Clear/Send actions row and the `send` option; keep the pencil toggle, tooltip binding, Escape handling, attribute restore)
- Modify: `src/framework/mount.js` (~lines 415–436: create the toolbar, hide the viewbar during sketch)
- Modify: `src/framework/app.css` (`#viewbar[hidden] { display: none; }` beside the `#viewbar` block)
- Test: `test/framework/annotate/annotate-controls.test.js` (drop actions-row cases), `test/framework/annotate/mount-wiring.test.js` (add viewbar-hide + toolbar cases)

**Interfaces:**
- Consumes: `attachSketchToolbar` (Task 9), mode surface (Task 8).
- Produces: mount behavior — while sketch is enabled the `#viewbar` element gets `hidden = true` (previous value restored on exit AND on unmount), and one `attachSketchToolbar(annotateMode, { stage: els.viewer, tooltip, send: annotateSend })` instance lives for the app's lifetime (detached via `cleanup.defer`). `attachAnnotateControls(viewer, mode, els, { tooltip, escapeScope })` — the `send` option is GONE.

- [ ] **Step 1: Update the tests**

In `annotate-controls.test.js`: delete the cases asserting Undo/Clear/Send
buttons exist in the viewbar actions row and the `send: "host"` variant; keep
(and re-run) toggle aria-pressed, hidden-when-no-mode, Escape handling, and
attribute-restore-on-detach cases.

In `mount-wiring.test.js` (follow the file's existing mount fixture idiom —
it already mounts a minimal app with an `#annotate` button; read it first),
add:

```js
test("sketch mode hides the viewbar and shows the toolbar; exit restores both", async () => {
  const { runtime, dom } = await mountFixture(); // the file's existing helper
  const viewbar = dom.querySelector("#viewbar");
  const toolbar = dom.querySelector(".pf-sketch-toolbar");
  expect(toolbar).not.toBeNull();
  expect(toolbar.hidden).toBe(true);
  runtime.annotate.setEnabled(true);
  expect(viewbar.hidden).toBe(true);
  expect(toolbar.hidden).toBe(false);
  runtime.annotate.setEnabled(false);
  expect(viewbar.hidden).toBe(false);
  expect(toolbar.hidden).toBe(true);
});

test("annotateSend: 'host' keeps Send out of the toolbar", async () => {
  const { dom } = await mountFixture({ annotateSend: "host" });
  expect(dom.querySelector('.pf-sketch-toolbar [data-action="send"]')).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/annotate/mount-wiring.test.js test/framework/annotate/annotate-controls.test.js`
Expected: mount-wiring FAILs (no toolbar, viewbar never hides); controls may
fail on removed cases until Step 3 lands.

- [ ] **Step 3: Implement**

`annotate-controls.js`: remove the `actions` span construction, its three
buttons, their listeners/cleanup, and the `send` parameter; `sync()` keeps
only the toggle button state. Keep Escape + tooltip + attribute restore
exactly as-is.

`mount.js` (inside the existing `if (onAnnotationSend)` block and after
`attachAnnotateControls`):

```js
// Sketch owns the top of the stage: the toolbar replaces the viewbar while
// the mode is on (spec 2026-08-27). Restore honors whatever hidden state the
// host had set before entering.
const sketchToolbar = attachSketchToolbar(annotateMode, {
  stage: els.viewer, tooltip, send: annotateSend,
});
cleanup.defer(() => sketchToolbar.detach());
if (annotateMode) {
  const viewbarForSketch = els.viewer.querySelector("#viewbar");
  let viewbarWasHidden = false;
  cleanup.defer(annotateMode.onModeChange(() => {
    if (!viewbarForSketch) return;
    if (annotateMode.isEnabled()) {
      viewbarWasHidden = viewbarForSketch.hidden;
      viewbarForSketch.hidden = true;
    } else {
      viewbarForSketch.hidden = viewbarWasHidden;
    }
  }));
}
```

(`attachSketchToolbar` must tolerate `annotateMode === null` — when the host
passed no `onAnnotationSend` there is no mode; guard in mount instead: only
attach when `annotateMode` exists. `attachAnnotateControls` call drops
`send: annotateSend`.) Note the existing viewcube-hide block already listens
to `annotateMode.onModeChange` — leave it; two subscribers are fine.

`app.css`: add `#viewbar[hidden] { display: none; }` (the bar has an
author-origin `display: flex`, the same trap the buttons' rule documents).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/framework/annotate/` then the full suite
`npm test`. Everything green.

- [ ] **Step 5: Commit**

```bash
git add src/framework/annotate/annotate-controls.js src/framework/mount.js src/framework/app.css test/framework/annotate
git commit -m "feat(annotate): toolbar replaces viewbar during sketch; slim viewbar controls"
```

---

### Task 11: Full-suite pass, smoke check, docs, version bump

**Files:**
- Modify: `AGENTS.md` (the `annotate/` bullet in Architecture), `package.json` (minor version bump)
- Modify: `docs/AUTHORING-PARTS.md` ONLY IF it documents the annotation payload (grep `ANNOTATION_VERSION\|onAnnotationSend` — update the version and `strokes → elements` if mentioned).

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: all green. On any failure, grep `docs/ERROR-PATTERNS.md` for the
symptom FIRST (repo rule), then fix.

- [ ] **Step 2: Run the browser smoke check**

Run: `node scripts/check-app.mjs demo.html` (requires Playwright Chromium; if
not installed: `npm i -D playwright && npx playwright install chromium`).
Expected: PASS — the demo app boots with the reworked annotate wiring.

- [ ] **Step 3: Update AGENTS.md**

Rewrite the `annotate/` clause in the Architecture bullet to describe the new
shape (keep the surrounding prose style):

> `annotate/` (the sketch mode: typed drawing elements — pen/line/rect/ellipse
> with three ink colors, a hand tool for move/resize/rotate, and an interval
> eraser that subtracts parameter spans so shapes stay parametric — sent to
> the host via `onAnnotationSend` as a v3 semantic payload; `elements.js` is
> the pure element model, `ink-canvas.js` the overlay renderer,
> `annotate-mode.js` the orchestrator, `sketch-toolbar.js` the top-centre
> toolbar that replaces the viewbar while the mode is on,
> `annotate-controls.js` the viewbar pencil toggle; sketch mode stops
> animation playback and hides the transport bar …

(keep the existing trailing text about the transport bar / composer slot).

- [ ] **Step 4: Bump the version**

```bash
npm pkg get version          # note current, e.g. "0.83.1"
npm pkg set version=0.84.0   # next minor — adjust to actual current
```

(The publish workflow tags and ships on merge; forgetting this bump is the
known silent failure mode — see AGENTS.md "Releasing".)

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md package.json docs/AUTHORING-PARTS.md
git commit -m "docs+release: sketch tools — AGENTS.md annotate section, version bump"
```

- [ ] **Step 6: Final review gate**

Re-read the spec top to bottom against `git log --oneline` and the diff
(`git diff main...HEAD --stat`). Every spec section maps to a landed commit.
Then request code review per the project workflow before opening the PR.

---

## Self-review notes (already applied)

- Spec coverage: element model (T1–6), coordinate frame (T2/T7/T8), tools +
  gestures incl. hand/rotate (T3/T4/T8), eraser (T5), chrome + viewbar hide +
  tooltips + Send contract (T9/T10), payload v3 (T8), tests throughout, docs +
  release (T11). The prototype's semantic side panel is spec non-goal — no task.
- Type consistency: store API (`snapshot/add/touch/setList/list/undo/canUndo/clear/onChange` + `reset` added in T8), `setScene` (T7) consumed in T8, `attachSketchToolbar` (T9) consumed in T10, `probe` option names (`reach/handleR/band`) uniform.
- Known judgment points left to the implementer ON PURPOSE: exact `snappedBox`
  center algebra (tests pin behavior), overlay drawing details (tests pin
  export exclusion and pass ordering only), icon SVG paths (visual).
