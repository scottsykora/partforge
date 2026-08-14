import { isPathContour, tessellateContour } from "./profile.js";
import { ringArea } from "./shape2d-regions.js";

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
