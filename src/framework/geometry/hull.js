// Pure, backend-free 2-D convex hull (Andrew's monotone chain) + input sampling for
// k.hull / k.hullChain (wired in kernel-front). No WASM, no kernel — a pure function
// of its inputs, so hull output for point-list/contour inputs is backend-independent.
import { tessellateContour } from "./profile.js";

// Fixed LOD for curve-contour inputs. Sampling in pure JS (not via a backend's
// materialization) is what makes point/contour hull results bit-identical across backends.
const HULL_SEGS = 64;

// One HullInput → its contributing points.
//   Shape2D          → its materialized boundary rings (outer + holes; holes are interior
//                      to a convex hull, harmless);
//   curve contour    → tessellated at a fixed LOD (pure JS);
//   point list       → used as-is (any length ≥ 1; e.g. circleProfile's 48-gon).
export function hullPoints(input) {
  if (input && input._shape2d)
    return input.toRegions().flatMap((r) => [...r.outer, ...r.holes.flat()]);
  if (Array.isArray(input) && input.length > 0 && Array.isArray(input[0]))
    return input;
  if (input && Array.isArray(input.segments))
    return tessellateContour(input, HULL_SEGS);
  throw new Error("hull: each input must be a Shape2D, a curve contour, or an [[x,y],…] point list");
}

// Convex hull of a point set → CCW convex polygon [[x,y],…]. Andrew's monotone chain,
// O(n log n). Drops interior and on-edge points (strict turns only), so a collinear set
// collapses to < 3 vertices → throw (it cannot bound a 2-D region).
export function convexHull(points) {
  const seen = new Set();
  const pts = [];
  for (const p of points) {
    const key = `${p[0]},${p[1]}`;
    if (!seen.has(key)) { seen.add(key); pts.push([p[0], p[1]]); }
  }
  if (pts.length < 3) throw new Error(`hull: need ≥3 distinct points, got ${pts.length}`);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (src) => {
    const out = [];
    for (const p of src) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop(); // last point is shared with the other half's first
    return out;
  };
  const hull = half(pts).concat(half([...pts].reverse()));
  if (hull.length < 3) throw new Error("hull: points are collinear — no 2-D region");
  return hull;
}
