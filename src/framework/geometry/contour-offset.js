// Native curve-aware contour offset — the engine behind Shape2D.offset. Pure leaf in
// the worker graph (DOM-free, three-free, node:-free). Offsets every ring by one signed
// rule: each point displaced `delta` along the normal to the RIGHT of the direction of
// travel — under the storage winding invariant (outer CCW, holes CW) that always points
// away from the filled interior, so positive delta grows outers and shrinks holes with
// no per-ring casing. Lines and arcs offset EXACTLY; cubics use adaptive Tiller–Hanson.
//
// The cubic subdivision approach is ported from glenzli/paperjs-offset
// (https://github.com/glenzli/paperjs-offset, MIT License, Copyright (c) glenzli),
// adapted from paper.js Segments to the partforge contour IR.
import { arcCenterAndSweep } from "./paper-bridge.js";
import { cubicAt, splitCubic, jointTangents, SMOOTH_JOINT_DEG } from "./contour-ops.js";

export const OFFSET_TOL = 1e-3;   // mm — max deviation of a cubic offset approximation
const MAX_DEPTH = 12;             // cubic subdivision recursion cap
const JOIN_EPS = 1e-6;            // endpoints closer than this are coincident

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const scl = (v, s) => [v[0] * s, v[1] * s];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const len = (v) => Math.hypot(v[0], v[1]);
const norm = (v) => { const L = len(v) || 1; return [v[0] / L, v[1] / L]; };
const rightOf = ([tx, ty]) => [ty, -tx];   // unit right-of-travel normal
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function offsetLine(from, to, delta) {
  const n = scl(rightOf(norm(sub(to, from))), delta);
  return { start: add(from, n), segments: [{ to: add(to, n) }], dirty: false };
}

function offsetArc(from, seg, delta) {
  const c = arcCenterAndSweep(from, seg.via, seg.to);
  if (!c) return offsetLine(from, seg.to, delta);          // collinear via → straight
  const { center, r, dA } = c;
  // CCW sweep (dA>0): right-of-travel is the outward radial → r+delta; CW: inward → r-delta
  const rNew = r + (dA >= 0 ? delta : -delta);
  if (Math.abs(rNew) <= JOIN_EPS) {
    // fully collapsed arc: bridge the offset endpoints with a line, let cleanup cope
    const tanAt = (p) => { const rad = sub(p, center); return norm(dA >= 0 ? [-rad[1], rad[0]] : [rad[1], -rad[0]]); };
    const q = (p) => add(p, scl(rightOf(tanAt(p)), delta));
    return { start: q(from), segments: [{ to: q(seg.to) }], dirty: true };
  }
  // rNew < 0 lands every point on the opposite side of center — the inverted loop
  // that stage-3 cleanup removes. Same projection formula either way.
  const proj = (p) => add(center, scl(norm(sub(p, center)), rNew));
  return { start: proj(from), segments: [{ via: proj(seg.via), to: proj(seg.to) }], dirty: rNew < 0 };
}

// Tiller–Hanson single-piece offset of cubic (p0,c1,c2,p1): displace endpoints along
// their endpoint normals and the handle line by the normal of the c1→c2 chord, then
// accept only if sampled deviation stays within OFFSET_TOL; otherwise split at t=0.5.
// (Ported from paperjs-offset's offsetSegment/adaptiveOffsetCurve.)
function offsetCubic(p0, c1, c2, p1, delta, depth) {
  const nz = (v) => (len(v) > 1e-9 ? v : null);
  const t0 = norm(nz(sub(c1, p0)) ?? nz(sub(c2, p0)) ?? sub(p1, p0));
  const t1 = norm(nz(sub(p1, c2)) ?? nz(sub(p1, c1)) ?? sub(p1, p0));
  const off0 = scl(rightOf(t0), delta), off1 = scl(rightOf(t1), delta);
  const hChord = nz(sub(c2, c1)) ?? sub(p1, p0);
  const hN = scl(rightOf(norm(hChord)), delta);
  const q0 = add(p0, off0), q1 = add(p1, off1);
  const qc1 = add(c1, scl(add(hN, off0), 0.5)), qc2 = add(c2, scl(add(hN, off1), 0.5));
  let ok = true;
  for (const t of [0.25, 0.5, 0.75]) {
    const d = dist(cubicAt(q0, qc1, qc2, q1, t), cubicAt(p0, c1, c2, p1, t));
    if (Math.abs(d - Math.abs(delta)) > OFFSET_TOL) { ok = false; break; }
  }
  if (ok || depth >= MAX_DEPTH) return { start: q0, segments: [{ to: q1, c1: qc1, c2: qc2 }], dirty: !ok };
  const [L, R] = splitCubic(p0, c1, c2, p1, 0.5);
  const a = offsetCubic(L.p0, L.c1, L.c2, L.p1, delta, depth + 1);
  const b = offsetCubic(R.p0, R.c1, R.c2, R.p1, delta, depth + 1);
  return { start: a.start, segments: [...a.segments, ...b.segments], dirty: a.dirty || b.dirty };
}

// One IR segment (running from `from` to seg.to) → its raw offset piece.
export function _offsetSegment(from, seg, delta) {
  if (seg.c1) return offsetCubic(from, seg.c1, seg.c2, seg.to, delta, 0);
  if (seg.via) return offsetArc(from, seg, delta);
  return offsetLine(from, seg.to, delta);
}

const MITER_LIMIT = 2;

// Intersection of the line through P (direction u) with the line through Q (direction v).
function lineIntersect(P, u, Q, v) {
  const d = cross(u, v);
  if (Math.abs(d) < 1e-12) return null;
  const w = sub(Q, P);
  return add(P, scl(u, cross(w, v) / d));
}

// Segments bridging aEnd → bStart around `corner` on the gap side.
function joinSegs(corner, aEnd, bStart, inTan, outTan, delta, corners) {
  if (corners === "chamfer") return [{ to: bStart }];
  if (corners === "sharp") {
    const X = lineIntersect(aEnd, inTan, bStart, outTan);
    if (X && dist(X, corner) <= MITER_LIMIT * Math.abs(delta)) return [{ to: X }, { to: bStart }];
    return [{ to: bStart }];                               // miter-limit fallback = bevel
  }
  // round: exact arc about the corner, via on the displacement bisector
  const d1 = sub(aEnd, corner), d2 = sub(bStart, corner);
  let m = add(d1, d2);
  if (len(m) < 1e-9) m = delta > 0 ? rightOf(norm(d1)) : scl(rightOf(norm(d1)), -1); // 180° turn
  return [{ via: add(corner, scl(norm(m), Math.abs(delta))), to: bStart }];
}

// Offset one explicitly-closed ring. Returns { contour, dirty }.
export function _offsetContour(contour, delta, corners) {
  const pts = [contour.start, ...contour.segments.map((s) => s.to)];
  // drop zero-length line segments (they carry no direction)
  const keep = contour.segments.map((s, i) => s.c1 || s.via || dist(pts[i], s.to) > 1e-9);
  const segs = contour.segments.filter((_, i) => keep[i]);
  const froms = [];
  { let p = contour.start; for (const s of contour.segments) { froms.push(p); p = s.to; } }
  const fromsKept = froms.filter((_, i) => keep[i]);
  // NB: feed jointTangents the KEPT chain's start — if the first segment was dropped
  // as zero-length, contour.start no longer heads the filtered ring.
  const joints = jointTangents({ start: fromsKept[0] ?? contour.start, segments: segs });
  const pieces = segs.map((s, i) => _offsetSegment(fromsKept[i], s, delta));
  let dirty = pieces.some((p) => p.dirty);
  const n = segs.length;
  const joins = new Array(n).fill(null);   // joins[i] bridges piece[i-1] → piece[i] at vertex i

  for (let i = 0; i < n; i++) {
    const prev = pieces[(i - 1 + n) % n], next = pieces[i];
    const aEnd = prev.segments.at(-1).to, bStart = next.start;
    const { point, inTan, outTan } = joints[i];
    const turn = cross(inTan, outTan);
    const turnDeg = (Math.atan2(Math.abs(turn), Math.max(-1, Math.min(1, inTan[0] * outTan[0] + inTan[1] * outTan[1]))) * 180) / Math.PI;
    if (dist(aEnd, bStart) <= JOIN_EPS || turnDeg < SMOOTH_JOINT_DEG) continue;   // smooth
    if (turn * delta > 0) { joins[i] = joinSegs(point, aEnd, bStart, inTan, outTan, delta, corners); continue; }
    // overlap side: trim when both neighbors are plain lines, else chord + dirty
    const aSeg = prev.segments.at(-1), bSeg = next.segments[0];
    if (!aSeg.via && !aSeg.c1 && !bSeg.via && !bSeg.c1) {
      const X = lineIntersect(aEnd, inTan, bStart, outTan);
      if (X) { aSeg.to = X; next.start = X; continue; }    // exact trim, stays clean
    }
    joins[i] = [{ to: bStart }]; dirty = true;
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(...pieces[i].segments);
    const j = joins[(i + 1) % n];
    if (j) out.push(...j);
  }
  const start = pieces[0].start;
  const last = out.at(-1);
  if (dist(last.to, start) <= JOIN_EPS) last.to = [start[0], start[1]];  // snap the closure exactly
  else out.push({ to: [start[0], start[1]] });
  return { contour: { start, segments: out }, dirty };
}
