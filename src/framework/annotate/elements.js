// The typed sketch-element model (spec 2026-08-27): store, per-type geometry,
// gesture builders, edit appliers, eraser, and semantics. Pure — no DOM, no
// three (the feature-dims.js stance). All coordinates are STAGE SPACE:
// y ∈ [0,1], x ∈ [0,aspect]; pixels exist only at the renderer/mode boundary,
// which is what keeps a circle circular regardless of viewport shape.

export const INK_COLORS = { red: "#d92d20", blue: "#1570ef", green: "#079455" };
// Stroke width as a fraction of the viewport short edge (unchanged from ink.js).
export const DEFAULT_STROKE_WIDTH = 0.004;
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
    // Exit-mode discard: unlike clear(), this takes no snapshot and drops the
    // undo history outright — annotate-mode.js's setEnabled(false) uses this
    // (never clear()) because ink must not survive a mode exit AND a
    // re-entered mode must not carry a phantom "undo" back to stale strokes.
    reset() {
      items = [];
      undoStack.length = 0;
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

// Square/circle magnet, measured in cursor DISTANCE like the line snap: the
// perpendicular distance from the dragged corner to the box diagonal is
// |w − h|/√2, so the drag snaps to 1:1 when the cursor sits within
// `snapDistance` (stage units) of where the square's corner would be. A big
// box snaps only when genuinely near-square; a small one stays forgiving.
function snappedBox(x0, y0, x, y, force, snapDistance) {
  let w = Math.abs(x - x0), h = Math.abs(y - y0);
  const near = snapDistance > 0 && Math.abs(w - h) / Math.SQRT2 <= snapDistance;
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

export function rectFromDrag(x0, y0, x, y, { force = false, snapDistance = 0 } = {}) {
  const { cx, cy, w, h, snapped } = snappedBox(x0, y0, x, y, force, snapDistance);
  return { params: { cx, cy, w, h, rot: 0 }, snapped };
}

export function ellipseFromDrag(x0, y0, x, y, { force = false, snapDistance = 0 } = {}) {
  const { cx, cy, w, h, snapped } = snappedBox(x0, y0, x, y, force, snapDistance);
  return { params: { cx, cy, rx: w / 2, ry: h / 2, rot: 0 }, snapped };
}

// Magnetic 0/45/90° snap, measured in DISTANCE rather than angle: the drag
// snaps when the cursor sits within `snapDistance` (stage units — the caller
// converts its pixel threshold) of the nearest snapped line through the start
// point. Distance-based snapping self-scales the way angle-based cannot: a
// long line snaps only when it is genuinely close to flat, a short one stays
// forgiving. `force` (shift) snaps from any angle; length is preserved.
export function lineFromDrag(x0, y0, x, y, { force = false, snapDistance = 0 } = {}) {
  let x2 = x, y2 = y;
  const len = Math.hypot(x - x0, y - y0);
  const a = Math.atan2(y - y0, x - x0);
  const nearest = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
  const perpDistance = len * Math.abs(Math.sin(a - nearest));
  const snapped = force || (snapDistance > 0 && perpDistance <= snapDistance);
  if (snapped) {
    x2 = x0 + len * Math.cos(nearest);
    y2 = y0 + len * Math.sin(nearest);
  }
  return { params: { x1: x0, y1: y0, x2, y2 }, snapped };
}

// Freehand point thinning (the ink.js minDistance contract, Euclidean in
// stage space — stage space is already aspect-uniform).
export function appendThinned(points, x, y, minDistance) {
  const last = points[points.length - 1];
  if (Math.hypot(x - last[0], y - last[1]) < minDistance) return false;
  points.push([x, y]);
  return true;
}

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

export function resizeRectFromAnchor(el, ax, ay, rot, x, y, { force = false, snapDistance = 0 } = {}) {
  const p = el.params;
  let [dx, dy] = invRot2(x - ax, y - ay, rot);
  const w = Math.abs(dx), h = Math.abs(dy);
  // same cursor-distance magnet as snappedBox, in the rect's local frame
  const near = snapDistance > 0 && Math.abs(w - h) / Math.SQRT2 <= snapDistance;
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

export function resizeEllipseHandle(el, handleId, x, y, { force = false, snapDistance = 0 } = {}) {
  const p = el.params;
  const [lx, ly] = invRot2(x - p.cx, y - p.cy, p.rot || 0);
  if (handleId === "r") {
    p.rx = p.ry = Math.max(MIN_EDIT_EXTENT, Math.hypot(lx, ly));
    return;
  }
  if (handleId === "rx") p.rx = Math.max(MIN_EDIT_EXTENT, Math.abs(lx));
  else p.ry = Math.max(MIN_EDIT_EXTENT, Math.abs(ly));
  // circle magnet by cursor distance: the dragged radius handle sits |rx − ry|
  // from where the circle's rim would be
  const near = snapDistance > 0 && Math.abs(p.rx - p.ry) <= snapDistance;
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
  // One distance scan per element serves both tests: topmost-first, an
  // outline hit returns immediately (band membership of anything beneath is
  // moot — outline wins), otherwise band candidates accumulate. Rotate only
  // when "just outside" is unambiguous: exactly one element that close.
  let nearCount = 0;
  let nearEl = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const d = minVisibleDistance(list[i], x, y);
    if (d <= reach) return { kind: "outline", el: list[i] };
    if (d <= reach + band) { nearCount += 1; nearEl = list[i]; }
  }
  return nearCount === 1 ? { kind: "rotate", el: nearEl } : null;
}

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

// ---- semantics -------------------------------------------------------------
function rotNote(rot) {
  let d = Math.round((rot || 0) * 180 / Math.PI) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d ? ` · rot ${d}°` : "";
}

// Where an erased span sits, in each type's own vocabulary: rects name the
// edges the gap crosses (the t-domain walks the perimeter clockwise from the
// top-left corner), ellipses give the arc in degrees (t=0 at 3 o'clock,
// increasing screen-clockwise, before rotation), open paths give a % range
// along their length. Raw t-spans stay in the payload's `erased`; this is the
// human/LLM-readable rendering of the same data.
const RECT_EDGES = ["top", "right", "bottom", "left"];
export function describeGap(el, [a, b]) {
  if (el.type === "ellipse") {
    return `arc ${Math.round(a * 360)}°–${Math.round(b * 360)}°`;
  }
  if (el.type === "rect") {
    const { w, h } = el.params;
    const per = 2 * (w + h) || 1;
    const ends = [w / per, (w + h) / per, (2 * w + h) / per, 1];
    const edges = RECT_EDGES.filter((_, i) =>
      a < ends[i] - GAP_TOUCH && b > (i ? ends[i - 1] : 0) + GAP_TOUCH);
    return edges.length === 1 ? `${edges[0]} edge` : `${edges.join("–")} edges`;
  }
  return `${Math.round(a * 100)}%–${Math.round(b * 100)}%`;
}

const GAP_NOTE_MAX = 3; // heavy freehand scrubbing can leave dozens of gaps
function gapNote(el) {
  if (!el.gaps.length) return "";
  const pct = Math.round(visibleFraction(el) * 100);
  const noted = el.gaps.slice(0, GAP_NOTE_MAX).map((g) => describeGap(el, g));
  const more = el.gaps.length - noted.length;
  return ` · ${pct}% visible · erased ${noted.join(", ")}${more > 0 ? ` +${more} more` : ""}`;
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
  // `run` disambiguates anchors on a gapped element: a twice-erased circle has
  // three visible fragments, each with its own start/mid/end. The center
  // anchor belongs to the whole shape, not a fragment, so it carries no run.
  visibleRuns(el).forEach((run, i) => {
    const mid = run[Math.floor(run.length / 2)];
    out.push({ at: "start", run: i, x: run[0].x, y: run[0].y });
    out.push({ at: "mid", run: i, x: mid.x, y: mid.y });
    out.push({ at: "end", run: i, x: run[run.length - 1].x, y: run[run.length - 1].y });
  });
  if (el.type === "rect" || el.type === "ellipse") {
    const [x, y] = centerOf(el);
    out.push({ at: "center", x, y });
  }
  return out;
}
