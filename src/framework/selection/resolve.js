// Pure core: turn a backend-agnostic raycast hit into a semantic Selection.
// No three.js, no DOM, no kernel — only the param-deps read-key analysis.
import { subPartReadKeys, RELEVANT_ALL } from "../param-deps.js";

const COS_3DEG = 0.99863; // a normal within 3° of an axis snaps to that axis
const q2 = (x) => { const r = Math.round(x * 100) / 100; return r === 0 ? 0 : r; }; // 0.01mm, kill -0

export function quantizePoint(p) {
  return [q2(p[0]), q2(p[1]), q2(p[2])];
}

export function snapNormal(n) {
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const u = [n[0] / len, n[1] / len, n[2] / len];
  let ai = 0; // index of the dominant axis
  if (Math.abs(u[1]) > Math.abs(u[ai])) ai = 1;
  if (Math.abs(u[2]) > Math.abs(u[ai])) ai = 2;
  if (Math.abs(u[ai]) >= COS_3DEG) {
    const axis = [0, 0, 0];
    axis[ai] = u[ai] > 0 ? 1 : -1;
    return axis;
  }
  return [q2(u[0]), q2(u[1]), q2(u[2])];
}

// Only the params the clicked sub-part actually reads — "this geometry, at these inputs".
function scopeParams(part, view, params, subPart) {
  const reads = subPartReadKeys(part, view, params);
  const keys = reads === RELEVANT_ALL
    ? Object.keys(params)
    : [...(reads.get(subPart) ?? Object.keys(params))];
  const out = {};
  for (const k of keys) out[k] = params[k];
  return out;
}

export function resolveSelection(part, ctx, hit) {
  const point = quantizePoint(hit.pointLocal);
  const selection = {
    subPart: hit.subPart,
    point,
    normal: snapNormal(hit.normalLocal),
    params: scopeParams(part, ctx.view, ctx.params, hit.subPart),
  };
  if (hit.face) {
    // L1 — feature.selector is the author's own { dir, inPlane, at, near } vocabulary,
    // so the LLM can drop it straight into a faces(...)/edges(...) call.
    const feature = { kind: hit.face.kind, selector: { near: point } };
    if (hit.face.axis != null) { feature.axis = hit.face.axis; feature.selector.dir = hit.face.axis; }
    if (hit.face.radius != null) feature.radius = hit.face.radius;
    selection.feature = feature;
  }
  return selection;
}
