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
