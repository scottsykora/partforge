import { isPathContour, tessellateContour } from "./profile.js";
import { ringArea } from "./shape2d-regions.js";
import { arcToCubicSegments, arcCenterAndSweep } from "./paper-bridge.js";

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

// Fillet/chamfer a single ring given its already-resolved {corner, param} picks.
// Mirrors cornerArc's tangent/center math (polygon.js:107) but WITHOUT its silent
// per-corner clamp — filletProfile/chamferProfile throw instead of clamping, so the
// clamp math is reproduced here unclamped, gated by our own explicit fit checks.
function buildCornerOpRing(contour, picks, isFillet, label) {
  const n = contour.segments.length;
  const pts = [contour.start, ...contour.segments.map((s) => s.to)].slice(0, n);
  const plans = new Map();   // vertex index -> {A, B, M, setback}
  const selected = new Set(picks.map((p) => p.corner.index));   // this ring's selected vertex indices

  for (const { corner, param } of picks) {
    const i = corner.index;
    if (corner.segTypes[0] !== "line" || corner.segTypes[1] !== "line")
      throw new Error(`${label}: corner ${i} involves a curved segment — supported in Task 7`);
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
    const effEnd = endPlan ? endPlan.A : pts[(i + 1) % n];
    segments.push(startPlan || endPlan ? { to: effEnd } : contour.segments[i]);
    if (i === 0) start = startPlan ? startPlan.B : pts[0];
    if (endPlan) segments.push(isFillet ? { to: endPlan.B, via: endPlan.M } : { to: endPlan.B });
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
