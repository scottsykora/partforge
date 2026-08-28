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
