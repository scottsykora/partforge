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

// ---- draw-gesture builders -------------------------------------------------
const MIN_EXTENT = 0.002; // stage units; degenerate drags stay visible as slivers

function snappedBox(x0, y0, x, y, force) {
  let w = Math.abs(x - x0), h = Math.abs(y - y0);
  const near = Math.min(w, h) / Math.max(w, h, MIN_EXTENT) > 1 - SNAP_RATIO;
  const snapped = force || near;
  if (snapped) w = h = Math.max(w, h);
  w = Math.max(w, MIN_EXTENT); h = Math.max(h, MIN_EXTENT);
  // Center = drag origin + half the (possibly snapped) extent, signed by drag
  // direction. This is corner-order independent — equivalent to (min+max)/2
  // of the two corners when w/h are unchanged by snapping — and when
  // snapping grows w/h past the raw drag delta, it hangs the box off the
  // origin corner in the direction the user dragged.
  const cx = x0 + Math.sign(x - x0 || 1) * w / 2;
  const cy = y0 + Math.sign(y - y0 || 1) * h / 2;
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
