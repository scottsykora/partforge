import { isPathContour, tessellateContour } from "./profile.js";
import { ringArea } from "./shape2d-regions.js";
import { arcToCubicSegments, arcCenterAndSweep, paperScope, toPaperPath } from "./paper-bridge.js";

const WINDING_SEGS = 64;   // tessellation LOD for orientation/containment sampling

export function pointsToContour(points) {
  return { start: [points[0][0], points[0][1]],
    segments: [...points.slice(1).map((p) => ({ to: [p[0], p[1]] })), { to: [points[0][0], points[0][1]] }] };
}

const isPointList = (x) => Array.isArray(x) && x.length > 0 && Array.isArray(x[0]);
const liftContour = (c) => (isPointList(c) ? pointsToContour(c) : c);

export function liftProfile(input) {
  if (input && input._shape2d) return { kind: "regions", regions: input.toContours() };
  if (isPointList(input)) return { kind: "points", regions: [{ outer: pointsToContour(input), holes: [] }] };
  if (isPathContour(input)) return { kind: "contour", regions: [{ outer: input, holes: [] }] };
  if (Array.isArray(input) && input.every((r) => r && r.outer))
    return { kind: "regions", regions: input.map((r) => ({ outer: liftContour(r.outer), holes: (r.holes ?? []).map(liftContour) })) };
  if (input && input.outer)
    return { kind: "region", regions: [{ outer: liftContour(input.outer), holes: (input.holes ?? []).map(liftContour) }] };
  throw new Error("contour-ops: input must be [[x,y],…], a {start,segments} contour, {outer,holes}, or a region array");
}

export function restoreProfile(kind, regions) {
  if (kind === "regions") return regions;
  if (kind === "region") return regions[0];
  const outer = regions[0].outer;
  if (kind === "contour") return outer;
  // "points": only restorable if every segment stayed a straight line
  if (outer.segments.every((s) => !s.c1 && !s.via)) {
    const pts = [outer.start, ...outer.segments.map((s) => s.to)];
    const [fx, fy] = pts[0], [lx, ly] = pts[pts.length - 1];
    if (Math.hypot(lx - fx, ly - fy) < 1e-9) pts.pop();   // drop the closing duplicate
    return pts;
  }
  return outer;   // curves were introduced — upgrade to a contour
}

export const contourIsCCW = (c) => ringArea(tessellateContour(c, WINDING_SEGS)) >= 0;

export function reverseContour(contour) {
  const pts = [contour.start, ...contour.segments.map((s) => s.to)];
  const segments = [];
  for (let i = contour.segments.length - 1; i >= 0; i--) {
    const s = contour.segments[i];
    const m = { to: [pts[i][0], pts[i][1]] };
    if (s.via) m.via = [s.via[0], s.via[1]];
    if (s.c1) { m.c1 = [s.c2[0], s.c2[1]]; m.c2 = [s.c1[0], s.c1[1]]; }
    segments.push(m);
  }
  return { start: [pts[pts.length - 1][0], pts[pts.length - 1][1]], segments };
}

export function ensureRegionWinding(region) {
  return {
    outer: contourIsCCW(region.outer) ? region.outer : reverseContour(region.outer),
    holes: region.holes.map((h) => (contourIsCCW(h) ? reverseContour(h) : h)),
  };
}

// Affine transform core: M = [a, b, c, d, tx, ty], p' = [a·x + c·y + tx, b·x + d·y + ty]
const apply = (M, [x, y]) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
const isSimilarity = (M) => {
  const [a, b, c, d] = M;
  return Math.abs(a * a + b * b - (c * c + d * d)) < 1e-9 && Math.abs(a * c + b * d) < 1e-9;
};

function transformContour(contour, M) {
  const similar = isSimilarity(M);
  const segments = [];
  let prev = contour.start;
  for (const s of contour.segments) {
    if (s.via && !similar) {           // arc under a non-similarity map → cubics first
      for (const piece of arcToCubicSegments(prev, s.via, s.to)) segments.push(piece);
    } else segments.push(s);
    prev = s.to;
  }
  return { start: apply(M, contour.start), segments: segments.map((s) => {
    const m = { to: apply(M, s.to) };
    if (s.via) m.via = apply(M, s.via);
    if (s.c1) { m.c1 = apply(M, s.c1); m.c2 = apply(M, s.c2); }
    return m;
  }) };
}

function transformProfile(input, M) {
  const { kind, regions } = liftProfile(input);
  const flips = M[0] * M[3] - M[1] * M[2] < 0;
  let out = regions.map((rg) => ({ outer: transformContour(rg.outer, M), holes: rg.holes.map((h) => transformContour(h, M)) }));
  if (flips) {
    out = (kind === "region" || kind === "regions")
      ? out.map(ensureRegionWinding)
      // bare inputs: restore the ORIGINAL orientation sense of each ring
      : out.map((rg, i) => ({
          outer: contourIsCCW(rg.outer) === contourIsCCW(regions[i].outer) ? rg.outer : reverseContour(rg.outer),
          holes: rg.holes,
        }));
  }
  return restoreProfile(kind, out);
}

export const translateProfile = (input, [dx, dy]) => transformProfile(input, [1, 0, 0, 1, dx, dy]);
export function rotateProfile(input, deg, center = [0, 0]) {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), [cx, cy] = center;
  return transformProfile(input, [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]);
}
export function scaleProfile(input, s, center = [0, 0]) {
  const [sx, sy] = Array.isArray(s) ? s : [s, s];
  if (!(sx !== 0 && sy !== 0) || !Number.isFinite(sx) || !Number.isFinite(sy))
    throw new Error("scaleProfile: scale factors must be finite and non-zero");
  const [cx, cy] = center;
  return transformProfile(input, [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy]);
}
export function mirrorProfile(input, axis) {
  if (axis === "x") return transformProfile(input, [1, 0, 0, -1, 0, 0]);
  if (axis === "y") return transformProfile(input, [-1, 0, 0, 1, 0, 0]);
  const { point: [px, py], dir: [ux0, uy0] } = axis;
  const L = Math.hypot(ux0, uy0);
  if (!(L > 0)) throw new Error('mirrorProfile: axis must be "x", "y", or {point, dir} with a non-zero dir');
  const ux = ux0 / L, uy = uy0 / L;
  const a = ux * ux - uy * uy, b = 2 * ux * uy;        // reflection across line through point along dir
  return transformProfile(input, [a, b, b, -a, px - a * px - b * py, py - b * px + a * py]);
}

// ── Corner model ────────────────────────────────────────────────────────────
// profileCorners() walks a contour's joints and reports each non-smooth one: the interior
// angle, whether it's convex (material-relative — see below), and the segment kinds either
// side of it. jointTangents() is the shared per-vertex tangent computation, reused by Task 6.

export const SMOOTH_JOINT_DEG = 1;

// Unit tangent of segment `s` (from `from`) at its start (dir=+1) or end (dir=-1 → arrival direction).
function segTangent(from, s, atStart) {
  const norm = ([x, y]) => { const L = Math.hypot(x, y) || 1; return [x / L, y / L]; };
  if (s.c1) {
    if (atStart) {
      const d = [s.c1[0] - from[0], s.c1[1] - from[1]];
      return norm(Math.hypot(d[0], d[1]) > 1e-9 ? d : [s.c2[0] - from[0], s.c2[1] - from[1]]);
    }
    const d = [s.to[0] - s.c2[0], s.to[1] - s.c2[1]];
    return norm(Math.hypot(d[0], d[1]) > 1e-9 ? d : [s.to[0] - s.c1[0], s.to[1] - s.c1[1]]);
  }
  if (s.via) {
    // tangent ⊥ radius, oriented along the sweep (recover center like arcToCubicSegments)
    const c = arcCenterAndSweep(from, s.via, s.to);          // {center:[x,y], dA} or null
    if (!c) return norm([s.to[0] - from[0], s.to[1] - from[1]]);
    const p = atStart ? from : s.to;
    const r = [p[0] - c.center[0], p[1] - c.center[1]];
    const t = c.dA >= 0 ? [-r[1], r[0]] : [r[1], -r[0]];
    return norm(t);
  }
  return norm([s.to[0] - from[0], s.to[1] - from[1]]);
}

export function jointTangents(contour) {  // per vertex i: tangent arriving at and leaving vertex i
  const n = contour.segments.length;
  const pts = [contour.start, ...contour.segments.map((s) => s.to)];
  return contour.segments.map((_, i) => {
    const prevSeg = contour.segments[(i - 1 + n) % n];
    const prevFrom = pts[(i - 1 + n) % n];
    return {
      point: pts[i],
      inTan: segTangent(prevFrom, prevSeg, false),
      outTan: segTangent(pts[i], contour.segments[i], true),
    };
  });
}

const segType = (s) => (s.c1 ? "cubic" : s.via ? "arc" : "line");

function contourCorners(contour) {
  const ccw = contourIsCCW(contour);
  const n = contour.segments.length;
  const out = [];
  jointTangents(contour).forEach(({ point, inTan, outTan }, i) => {
    const cross = inTan[0] * outTan[1] - inTan[1] * outTan[0];
    const dot = Math.min(1, Math.max(-1, inTan[0] * outTan[0] + inTan[1] * outTan[1]));
    const turnDeg = (Math.atan2(Math.abs(cross), dot) * 180) / Math.PI;
    if (turnDeg < SMOOTH_JOINT_DEG) return;
    const leftTurn = cross > 0;
    out.push({
      index: i, point: [point[0], point[1]],
      interiorAngleDeg: ccw === leftTurn ? 180 - turnDeg : 180 + turnDeg,
      convex: leftTurn === ccw,
      segTypes: [segType(contour.segments[(i - 1 + n) % n]), segType(contour.segments[i])],
    });
  });
  return out;
}

export function profileCorners(input) {
  const { kind, regions } = liftProfile(input);
  if (kind === "points" || kind === "contour") return contourCorners(regions[0].outer);
  const out = [];
  regions.forEach((rg, regionIndex) => {
    for (const c of contourCorners(rg.outer)) out.push({ regionIndex, ring: "outer", ...c });
    rg.holes.forEach((h, hi) => { for (const c of contourCorners(h)) out.push({ regionIndex, ring: { hole: hi }, ...c }); });
  });
  return out;
}

// ── Fillet / chamfer ─────────────────────────────────────────────────────────
// Resolve opts.corners against a flat corner list (contourCorners()'s order, or
// profileCorners()'s flattened order for region/regions input — {indices} always
// indexes this array POSITIONALLY, matching profileCorners' documented contract).
// r/dist may be an array paired positionally with {indices}; every other selector
// broadcasts the scalar to every match. Throws when nothing matches.
function resolveCornerSelector(corners, param, opts, label) {
  const sel = (opts && opts.corners) ?? "all";
  let picked;
  if (sel === "all") picked = corners.map((corner) => ({ corner, param }));
  else if (sel === "convex") picked = corners.filter((c) => c.convex).map((corner) => ({ corner, param }));
  else if (sel === "concave") picked = corners.filter((c) => !c.convex).map((corner) => ({ corner, param }));
  else if (sel && Array.isArray(sel.indices)) {
    const perCorner = Array.isArray(param) ? param : null;
    picked = sel.indices
      .map((idx, j) => ({ corner: corners[idx], param: perCorner ? perCorner[j] : param }))
      .filter((p) => p.corner);
  } else if (sel && Array.isArray(sel.near)) {
    const [nx, ny] = sel.near;
    const count = sel.count ?? 1;
    const distSq = (c) => (c.point[0] - nx) ** 2 + (c.point[1] - ny) ** 2;
    picked = corners.slice().sort((a, b) => distSq(a) - distSq(b)).slice(0, count).map((corner) => ({ corner, param }));
  } else picked = [];
  if (picked.length === 0) throw new Error(`${label}: no corner matched selector ${JSON.stringify(sel)}`);
  return picked;
}

const roundNice = (x) => Math.round(x * 1e6) / 1e6;

// ── Curve-adjacent corners (Task 7) ─────────────────────────────────────────
// Line-line corners keep buildCornerOpRing's exact closed-form path below.
// A corner with at least one curved (cubic/arc) neighbor goes through this
// numeric machinery instead: a 2-D evaluator per segment (`at(t)`/`tan(t)`),
// a damped-Newton tangency solver for fillet, and an arc-length solver (via
// paper.js) for chamfer. Both trim their curved neighbor exactly via
// de Casteljau splitting (cubic) or angle interpolation (arc).

const normalize2 = ([x, y]) => { const L = Math.hypot(x, y) || 1; return [x / L, y / L]; };
const rot90 = ([x, y]) => [-y, x];
const addScaled = (p, v, s) => [p[0] + v[0] * s, p[1] + v[1] * s];

function cubicAt(p0, c1, c2, p1, t) {
  const u = 1 - t;
  return [0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * c1[k] + 3 * u * t * t * c2[k] + t * t * t * p1[k]);
}
function cubicDeriv(p0, c1, c2, p1, t) {
  const u = 1 - t;
  return [0, 1].map((k) => 3 * u * u * (c1[k] - p0[k]) + 6 * u * t * (c2[k] - c1[k]) + 3 * t * t * (p1[k] - c2[k]));
}
// Exact de Casteljau split of cubic (p0,c1,c2,p1) at t → two exact cubic pieces.
function splitCubic(p0, c1, c2, p1, t) {
  const lerp = (a, b) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const p01 = lerp(p0, c1), p12 = lerp(c1, c2), p23 = lerp(c2, p1);
  const p012 = lerp(p01, p12), p123 = lerp(p12, p23);
  const p0123 = lerp(p012, p123);
  return [{ p0, c1: p01, c2: p012, p1: p0123 }, { p0: p0123, c1: p123, c2: p23, p1 }];
}

// Evaluable curve E = {at(t), tan(t)} for a segment `seg` running from `from`
// (t=0) to seg.to (t=1). Mirrors segTangent's arc-tangent recovery exactly.
function curveEvaluator(from, seg) {
  if (seg.c1) {
    const p0 = from, c1 = seg.c1, c2 = seg.c2, p1 = seg.to;
    return { at: (t) => cubicAt(p0, c1, c2, p1, t), tan: (t) => normalize2(cubicDeriv(p0, c1, c2, p1, t)) };
  }
  if (seg.via) {
    const c = arcCenterAndSweep(from, seg.via, seg.to);
    if (c) {
      const a0 = Math.atan2(from[1] - c.center[1], from[0] - c.center[0]);
      return {
        at: (t) => { const a = a0 + c.dA * t; return [c.center[0] + c.r * Math.cos(a), c.center[1] + c.r * Math.sin(a)]; },
        tan: (t) => { const a = a0 + c.dA * t, rx = Math.cos(a), ry = Math.sin(a); return c.dA >= 0 ? [-ry, rx] : [ry, -rx]; },
      };
    }   // collinear (degenerate) triple → fall through to line below
  }
  const p0 = from, p1 = seg.to, d = normalize2([p1[0] - p0[0], p1[1] - p0[1]]);
  return { at: (t) => [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t], tan: () => d };
}

// Trim segment `seg` (running `from` → seg.to) to the sub-range [tStart,tEnd]
// of its own parameterization, returning {from, seg} for the kept portion.
// Cubic: two exact de Casteljau splits. Arc: angle interpolation, `via`
// recomputed at the kept sweep's angular midpoint. Line: trivial endpoints.
function trimSegment(from, seg, tStart, tEnd) {
  if (seg.c1) {
    let cur = { p0: from, c1: seg.c1, c2: seg.c2, p1: seg.to };
    if (tStart > 1e-12) { cur = splitCubic(cur.p0, cur.c1, cur.c2, cur.p1, tStart)[1]; }
    const localEnd = tStart > 1e-12 ? (tEnd - tStart) / (1 - tStart) : tEnd;
    if (localEnd < 1 - 1e-12) cur = splitCubic(cur.p0, cur.c1, cur.c2, cur.p1, localEnd)[0];
    return { from: cur.p0, seg: { to: cur.p1, c1: cur.c1, c2: cur.c2 } };
  }
  if (seg.via) {
    const c = arcCenterAndSweep(from, seg.via, seg.to);
    if (c) {
      const a0 = Math.atan2(from[1] - c.center[1], from[0] - c.center[0]);
      const pointAt = (a) => [c.center[0] + c.r * Math.cos(a), c.center[1] + c.r * Math.sin(a)];
      const aS = a0 + c.dA * tStart, aE = a0 + c.dA * tEnd;
      return { from: pointAt(aS), seg: { to: pointAt(aE), via: pointAt((aS + aE) / 2) } };
    }
  }
  const p0 = from, p1 = seg.to;
  const at = (t) => [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
  return { from: at(tStart), seg: { to: at(tEnd) } };
}

const T_LO = 1e-6, T_HI = 1 - 1e-6;
const clampT = (v) => Math.min(T_HI, Math.max(T_LO, v));
const pinnedT = (t) => t[0] <= T_LO + 1e-12 || t[0] >= T_HI - 1e-12 || t[1] <= T_LO + 1e-12 || t[1] >= T_HI - 1e-12;

// Damped Newton on F: R² → R² (numeric Jacobian, h=1e-6), 40 iterations, step
// clamp 0.25, halving while |F| doesn't decrease (max 8 halvings). Returns
// {t, pinned} on convergence (|F| < 1e-9·max(1,r)) or null.
function newton2D(F, t0, r) {
  const h = 1e-6, tol = 1e-9 * Math.max(1, r);
  let t = [clampT(t0[0]), clampT(t0[1])];
  let Fv = F(t), normF = Math.hypot(Fv[0], Fv[1]);
  for (let iter = 0; iter < 40; iter++) {
    if (normF < tol) return { t, pinned: pinnedT(t) };
    const Fx = F([t[0] + h, t[1]]), Fy = F([t[0], t[1] + h]);
    const J00 = (Fx[0] - Fv[0]) / h, J10 = (Fx[1] - Fv[1]) / h;
    const J01 = (Fy[0] - Fv[0]) / h, J11 = (Fy[1] - Fv[1]) / h;
    const det = J00 * J11 - J01 * J10;
    if (Math.abs(det) < 1e-300) break;
    // Cramer's rule: [J00 J01; J10 J11]·delta = -Fv
    let delta = [(-Fv[0] * J11 + Fv[1] * J01) / det, (J00 * -Fv[1] - J10 * -Fv[0]) / det];
    delta = delta.map((d) => Math.max(-0.25, Math.min(0.25, d)));
    let tNew = [clampT(t[0] + delta[0]), clampT(t[1] + delta[1])];
    let FvNew = F(tNew), normNew = Math.hypot(FvNew[0], FvNew[1]);
    for (let halvings = 0; normNew >= normF && halvings < 8; halvings++) {
      delta = [delta[0] / 2, delta[1] / 2];
      tNew = [clampT(t[0] + delta[0]), clampT(t[1] + delta[1])];
      FvNew = F(tNew); normNew = Math.hypot(FvNew[0], FvNew[1]);
    }
    t = tNew; Fv = FvNew; normF = normNew;
  }
  return normF < tol ? { t, pinned: pinnedT(t) } : null;
}

// Solve for tangency points (tA on incoming curve A, tB on outgoing curve B)
// of a radius-r circle tangent to both, per the brief's F(tA,tB) = C_A − C_B.
// Tries all 4 inward-normal sign combos at the seed, keeping the one that
// minimizes |F| there (the combo landing on the corner's bisector side).
function solveFilletTangency(A, B, r) {
  const seed = [1 - 1e-3, 1e-3];
  const Ffor = (sA, sB) => (t) => {
    const CA = addScaled(A.at(t[0]), rot90(A.tan(t[0])), sA * r);
    const CB = addScaled(B.at(t[1]), rot90(B.tan(t[1])), sB * r);
    return [CA[0] - CB[0], CA[1] - CB[1]];
  };
  let best = null, bestNorm = Infinity;
  for (const sA of [1, -1]) for (const sB of [1, -1]) {
    const F = Ffor(sA, sB), f0 = F(seed), n = Math.hypot(f0[0], f0[1]);
    if (n < bestNorm) { bestNorm = n; best = { sA, sB, F }; }
  }
  const solved = newton2D(best.F, seed, r);
  if (!solved || solved.pinned) return null;
  const [tA, tB] = solved.t;
  const TA = A.at(tA), C = addScaled(TA, rot90(A.tan(tA)), best.sA * r);
  return { tA, tB, TA, TB: B.at(tB), C };
}

// Arc length of segment `seg` (from `from`); cubic arc length via a scratch
// open paper path (paper's numeric integration), line/arc in closed form.
function curveLength(from, seg) {
  if (seg.via) { const c = arcCenterAndSweep(from, seg.via, seg.to); return c ? Math.abs(c.dA) * c.r : Math.hypot(seg.to[0] - from[0], seg.to[1] - from[1]); }
  if (seg.c1) return toPaperPath(paperScope(), { start: from, segments: [seg] }, null, { open: true }).length;
  return Math.hypot(seg.to[0] - from[0], seg.to[1] - from[1]);
}
// Arc length traveled from `from` (t=0) up to parameter t.
function lengthUpTo(from, seg, t) {
  if (seg.via) { const c = arcCenterAndSweep(from, seg.via, seg.to); return c ? Math.abs(c.dA) * c.r * t : Math.hypot(seg.to[0] - from[0], seg.to[1] - from[1]) * t; }
  if (seg.c1) return toPaperPath(paperScope(), { start: from, segments: [seg] }, null, { open: true }).curves[0].getOffsetAtTime(t);
  return Math.hypot(seg.to[0] - from[0], seg.to[1] - from[1]) * t;
}
// t-parameter at arc-length `dist` along segment `seg` (from `from`, t=0).
function paramAtArcLength(from, seg, dist) {
  if (seg.via) { const c = arcCenterAndSweep(from, seg.via, seg.to); return c ? dist / (Math.abs(c.dA) * c.r) : dist / Math.hypot(seg.to[0] - from[0], seg.to[1] - from[1]); }
  if (seg.c1) return toPaperPath(paperScope(), { start: from, segments: [seg] }, null, { open: true }).curves[0].getParameterAt(dist);
  return dist / Math.hypot(seg.to[0] - from[0], seg.to[1] - from[1]);
}

// Curve-adjacent corners have no equivalent of line-line's `selected` bookkeeping
// (buildCornerOpRing's per-edge Set), so there's no cheap way to tell whether a
// curved neighbor's far end is also spoken for by another operation. Conservatively
// cap each side's setback at half its own arc length — the same "never bet on a
// neighbor being free" caution line-line only relaxes once it can PROVE the far
// end is unclaimed (Task 6's isolated-corner fix). Applied uniformly (fillet's
// tangent setback and chamfer's arc-length setback alike).
function fitsHalfLength(fromA, segA, tA, fromB, segB, tB) {
  const lenA = curveLength(fromA, segA), lenB = curveLength(fromB, segB);
  const setbackA = lenA - lengthUpTo(fromA, segA, tA), setbackB = lengthUpTo(fromB, segB, tB);
  return setbackA <= lenA / 2 + 1e-9 && setbackB <= lenB / 2 + 1e-9;
}

function trySolveFillet(fromA, segA, fromB, segB, A, B, r) {
  const solved = solveFilletTangency(A, B, r);
  if (!solved || !fitsHalfLength(fromA, segA, solved.tA, fromB, segB, solved.tB)) return null;
  return solved;
}

function bisectMaxRFillet(fromA, segA, fromB, segB, A, B, r) {
  let lo = 0, hi = r;
  for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (trySolveFillet(fromA, segA, fromB, segB, A, B, mid)) lo = mid; else hi = mid; }
  return lo;
}

// Chamfer's curve solver: no Newton needed — tA/tB are set directly by
// arc-length setbacks of `dist` from the corner, measured along each curve
// (`dist` IS the setback here, so the half-length cap above is just a bound on it).
function solveChamferArcLength(fromA, segA, fromB, segB, dist) {
  if (!(dist > 0)) return null;
  const totalA = curveLength(fromA, segA), totalB = curveLength(fromB, segB);
  if (dist > totalA / 2 + 1e-9 || dist > totalB / 2 + 1e-9) return null;
  const tA = paramAtArcLength(fromA, segA, totalA - dist);
  const tB = paramAtArcLength(fromB, segB, dist);
  if (!(tA > T_LO && tA < T_HI && tB > T_LO && tB < T_HI)) return null;
  return { tA, tB, TA: curveEvaluator(fromA, segA).at(tA), TB: curveEvaluator(fromB, segB).at(tB) };
}

function bisectMaxDistChamfer(fromA, segA, fromB, segB, dist) {
  let lo = 0, hi = dist;
  for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (solveChamferArcLength(fromA, segA, fromB, segB, mid)) lo = mid; else hi = mid; }
  return lo;
}

// Solve one curve-adjacent corner (at least one of its two neighbors is a
// cubic or arc) and return {tA, tB, TA, TB, connector} — tA/tB in the
// neighbors' own parameterizations, ready for trimSegment(); connector is
// the {to,via?} spliced between the trimmed neighbors.
function solveCurveCorner(pts, contour, n, i, param, isFillet, label) {
  const inIdx = (i - 1 + n) % n, fromA = pts[inIdx], segA = contour.segments[inIdx];
  const fromB = pts[i], segB = contour.segments[i];
  const A = curveEvaluator(fromA, segA), B = curveEvaluator(fromB, segB);
  const p1 = pts[i];
  if (isFillet) {
    const solved = trySolveFillet(fromA, segA, fromB, segB, A, B, param);
    if (!solved) {
      const maxR = roundNice(bisectMaxRFillet(fromA, segA, fromB, segB, A, B, param));
      throw new Error(`${label}: corner ${i} at (${p1[0]}, ${p1[1]}): could not fit r=${param} against the curved segment; max ≈ ${maxR}`);
    }
    const { tA, tB, TA, TB, C } = solved;
    const a0 = Math.atan2(TA[1] - C[1], TA[0] - C[0]);
    let dA = Math.atan2(TB[1] - C[1], TB[0] - C[0]) - a0;
    while (dA <= -Math.PI) dA += 2 * Math.PI;
    while (dA > Math.PI) dA -= 2 * Math.PI;
    const mid = a0 + dA / 2;
    const M = [C[0] + param * Math.cos(mid), C[1] + param * Math.sin(mid)];
    return { tA, tB, TA, connector: { to: TB, via: M } };
  }
  const solved = solveChamferArcLength(fromA, segA, fromB, segB, param);
  if (!solved) {
    const maxDist = roundNice(bisectMaxDistChamfer(fromA, segA, fromB, segB, param));
    throw new Error(`${label}: corner ${i} at (${p1[0]}, ${p1[1]}): could not fit dist=${param} against the curved segment; max ≈ ${maxDist}`);
  }
  const { tA, tB, TA, TB } = solved;
  return { tA, tB, TA, connector: { to: TB } };
}

// Fillet/chamfer a single ring given its already-resolved {corner, param} picks.
// Mirrors cornerArc's tangent/center math (polygon.js:107) but WITHOUT its silent
// per-corner clamp — filletProfile/chamferProfile throw instead of clamping, so the
// clamp math is reproduced here unclamped, gated by our own explicit fit checks.
function buildCornerOpRing(contour, picks, isFillet, label) {
  const n = contour.segments.length;
  const pts = [contour.start, ...contour.segments.map((s) => s.to)].slice(0, n);
  const plans = new Map();   // vertex index -> {A, B, M, setback} (line-line corners only)
  const curvePlans = new Map();   // vertex index -> {tA, tB, connector} (curve-adjacent corners)
  const selected = new Set(picks.map((p) => p.corner.index));   // this ring's selected vertex indices

  for (const { corner, param } of picks) {
    const i = corner.index;
    if (corner.segTypes[0] !== "line" || corner.segTypes[1] !== "line") {
      // Curve-adjacent corner: routed through the numeric tangency solver, never
      // through the line-line closed-form math below (exactness/speed for lines).
      curvePlans.set(i, solveCurveCorner(pts, contour, n, i, param, isFillet, label));
      continue;
    }
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const v0x = p0[0] - p1[0], v0y = p0[1] - p1[1], v2x = p2[0] - p1[0], v2y = p2[1] - p1[1];
    const l0 = Math.hypot(v0x, v0y), l2 = Math.hypot(v2x, v2y);
    const v0 = [v0x / l0, v0y / l0], v2 = [v2x / l2, v2y / l2];
    const cosA = Math.max(-1, Math.min(1, v0[0] * v2[0] + v0[1] * v2[1]));
    const half = Math.acos(cosA) / 2;                        // angle between the two edges, halved
    const setback = isFillet ? param / Math.tan(half) : param;
    // Per-corner ceiling: never past either edge's own end (hard cap, always full — a
    // tangent point can never pass an edge's own extent regardless of who else is
    // selected), and never past half the LONGER edge's "fair share" (soft cap). The soft
    // cap only halves an edge when its OTHER endpoint is ALSO among this operation's
    // selected corners — an isolated corner with an unselected neighbour gets that edge's
    // full length, since nothing else is claiming it. Exceeding one edge's fair share
    // alone isn't fatal (soft cap uses the more generous of the two); that's exactly what
    // the segment-level overlap check below is for.
    const prevShared = selected.has((i - 1 + n) % n), nextShared = selected.has((i + 1) % n);
    const softL0 = prevShared ? l0 / 2 : l0, softL2 = nextShared ? l2 / 2 : l2;
    const maxSetback = Math.min(l0, l2, Math.max(softL0, softL2));
    if (setback > maxSetback + 1e-9) {
      const maxParam = roundNice(isFillet ? maxSetback * Math.tan(half) : maxSetback);
      const paramTxt = isFillet ? `r=${param}` : `dist=${param}`;
      throw new Error(`${label}: corner ${i} at (${p1[0]}, ${p1[1]}): ${paramTxt} does not fit; max ≈ ${maxParam}`);
    }
    const A = [p1[0] + v0[0] * setback, p1[1] + v0[1] * setback];
    const B = [p1[0] + v2[0] * setback, p1[1] + v2[1] * setback];
    let M;
    if (isFillet) {
      let bx = v0[0] + v2[0], by = v0[1] + v2[1];
      const bl = Math.hypot(bx, by);
      bx /= bl; by /= bl;
      const C = [p1[0] + bx * (param / Math.sin(half)), p1[1] + by * (param / Math.sin(half))];
      const a0 = Math.atan2(A[1] - C[1], A[0] - C[0]);
      let dA = Math.atan2(B[1] - C[1], B[0] - C[0]) - a0;      // short sweep from A to B
      while (dA <= -Math.PI) dA += 2 * Math.PI;
      while (dA > Math.PI) dA -= 2 * Math.PI;
      const mid = a0 + dA / 2;
      M = [C[0] + param * Math.cos(mid), C[1] + param * Math.sin(mid)];
    }
    plans.set(i, { A, B, M, setback });
  }

  for (let k = 0; k < n; k++) {                                // overlap: sum of claims on segment k vs its length
    const kNext = (k + 1) % n;
    const startClaim = plans.get(k)?.setback ?? 0, endClaim = plans.get(kNext)?.setback ?? 0;
    if (startClaim > 0 && endClaim > 0) {
      const segLen = Math.hypot(pts[kNext][0] - pts[k][0], pts[kNext][1] - pts[k][1]);
      if (startClaim + endClaim > segLen + 1e-9)
        throw new Error(`${label}: corners ${k} and ${kNext} overlap on segment ${k} (reduce r)`);
    }
  }

  const segments = [];
  let start = null;
  for (let i = 0; i < n; i++) {
    const startPlan = plans.get(i), endPlan = plans.get((i + 1) % n);
    const startCurve = curvePlans.get(i), endCurve = curvePlans.get((i + 1) % n);
    const seg = contour.segments[i];
    if ((seg.c1 || seg.via) && (startCurve || endCurve)) {
      // Segment itself is curved and trimmed by a curve-corner solve on one or
      // both ends: exact de Casteljau split (cubic) / angle interpolation (arc).
      const tStart = startCurve ? startCurve.tB : 0, tEnd = endCurve ? endCurve.tA : 1;
      segments.push(trimSegment(pts[i], seg, tStart, tEnd).seg);
    } else {
      const effEnd = endPlan ? endPlan.A : endCurve ? endCurve.TA : pts[(i + 1) % n];
      segments.push(startPlan || endPlan || startCurve || endCurve ? { to: effEnd } : seg);
    }
    if (i === 0) start = startPlan ? startPlan.B : startCurve ? startCurve.connector.to : pts[0];
    if (endPlan) segments.push(isFillet ? { to: endPlan.B, via: endPlan.M } : { to: endPlan.B });
    if (endCurve) segments.push(endCurve.connector);
  }
  return { start, segments };
}

function applyCornerOp(input, param, opts, label, isFillet) {
  const { kind, regions } = liftProfile(input);
  if (kind === "points" || kind === "contour") {
    const picks = resolveCornerSelector(contourCorners(regions[0].outer), param, opts, label);
    const outer = buildCornerOpRing(regions[0].outer, picks, isFillet, label);
    // Always surface a {start,segments} contour, even for a "points" input and an
    // all-line chamfer result: restoreProfile's points-downgrade is for shape-preserving
    // transforms, but a corner op changes the vertex count — it must not collapse back.
    return restoreProfile(kind === "points" ? "contour" : kind, [{ outer, holes: [] }]);
  }
  // region/regions: selector resolves against the flattened profileCorners() order;
  // picks are then grouped back by ring so each ring rebuilds independently.
  const newRegions = regions.map((rg) => ({ outer: rg.outer, holes: rg.holes.slice() }));
  const flat = [];
  newRegions.forEach((rg, ri) => {
    for (const c of contourCorners(rg.outer)) flat.push({ ...c, ringRef: { ri, key: "outer" } });
    rg.holes.forEach((h, hi) => { for (const c of contourCorners(h)) flat.push({ ...c, ringRef: { ri, key: "hole", hi } }); });
  });
  const picks = resolveCornerSelector(flat, param, opts, label);
  const byRing = new Map();
  for (const p of picks) {
    const r = p.corner.ringRef;
    const key = r.key === "outer" ? `${r.ri}:outer` : `${r.ri}:hole:${r.hi}`;
    if (!byRing.has(key)) byRing.set(key, { ringRef: r, picks: [] });
    byRing.get(key).picks.push(p);
  }
  for (const { ringRef, picks: ringPicks } of byRing.values()) {
    const rg = newRegions[ringRef.ri];
    const contour = ringRef.key === "outer" ? rg.outer : rg.holes[ringRef.hi];
    const rebuilt = buildCornerOpRing(contour, ringPicks, isFillet, label);
    if (ringRef.key === "outer") rg.outer = rebuilt; else rg.holes[ringRef.hi] = rebuilt;
  }
  return restoreProfile(kind, newRegions);
}

export function filletProfile(input, r, opts) {
  return applyCornerOp(input, r, opts, "filletProfile", true);
}

export function chamferProfile(input, dist, opts) {
  return applyCornerOp(input, dist, opts, "chamferProfile", false);
}
