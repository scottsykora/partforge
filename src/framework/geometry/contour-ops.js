import { isPathContour, tessellateContour } from "./profile.js";
import { ringArea } from "./shape2d-regions.js";
import { arcToCubicSegments } from "./paper-bridge.js";

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
