// Shared Shape2D/curve-aware loft ring resolution — the pure-JS leaf both backends
// call before touching a kernel. Lifts every accepted ring form to the curve-contour
// IR, bakes each ring's scale-then-rotate(Z) transform ONCE, and classifies the loft
// into one of three modes (see docs/superpowers/plans/2026-08-23-shape2d-loft-design.md):
//   poly-exact — all-line identical signatures: today's path, bit-for-bit;
//   curve      — identical signatures with arcs/cubics: matched per-segment sampling
//                (Manifold) + original curve wires (OCCT, STEP-exact);
//   resample   — structurally different rings: shared arc-length resample, both
//                backends loft the IDENTICAL rings (parity by construction).
import { regularPolygon } from "./polygon.js";
import { pointsToContour, reverseContour, closeContourGap, arcGeometry, sampleBezier } from "./profile.js";
import { rotateProfile, scaleProfile, contourIsCCW, cubicAt } from "./contour-ops.js";

export const LOFT_SEGS = 64; // fixed pure-JS LOD for curve rings (hull.js precedent)

const isPointList = (x) => Array.isArray(x) && Array.isArray(x[0]);
const isContour = (x) => x && !Array.isArray(x) && Array.isArray(x.segments);

// Legacy transform bake for point rings — EXACTLY resolveRings' math, kept verbatim so
// every existing part's loft stays bit-identical (mesh-fillet tools, rim-bevel, roundedBox).
const bakePts = (pts, r) => {
  const s = r.scale ?? 1;
  const [sx, sy] = Array.isArray(s) ? s : [s, s];
  const rot = ((r.rotate ?? 0) * Math.PI) / 180, cos = Math.cos(rot), sin = Math.sin(rot);
  return pts.map(([x, y]) => {
    const X = x * sx, Y = y * sy;
    return [X * cos - Y * sin, X * sin + Y * cos];
  });
};

// Contour bake: scale about origin then rotate about origin — the same composite map,
// applied through contour-ops so arcs survive similarity maps exactly and become
// cubics under non-uniform scale (transformContour's rule).
const bakeContour = (contour, r) => {
  let c = closeContourGap(contour); // Ensure explicit closing so signature is consistent
  const s = r.scale ?? 1;
  if (!(s === 1 || (Array.isArray(s) && s[0] === 1 && s[1] === 1))) c = scaleProfile(c, s, [0, 0]);
  if ((r.rotate ?? 0) !== 0) c = rotateProfile(c, r.rotate, [0, 0]);
  return contourIsCCW(c) ? c : reverseContour(c);
};

export function liftLoftRings(rings) {
  if (!Array.isArray(rings) || rings.length < 2)
    throw new Error("loft: rings must be an array of at least 2 rings");
  return rings.map((r, i) => {
    if (!r || typeof r !== "object") throw new Error(`loft: ring ${i} must be an object { polygon|sides+radius, z }`);
    if (!Number.isFinite(r.z)) throw new Error(`loft: ring ${i} needs a finite z`);
    let poly = r.polygon;
    if (poly && poly._shape2d) {
      const regions = poly._regions;
      if (regions.length === 0) throw new Error(`loft: ring ${i} is an empty Shape2D — nothing to loft`);
      if (regions.length > 1) throw new Error(
        `loft: ring ${i} is a Shape2D with ${regions.length} regions — a loft ring must be a single closed outline (union the regions into one, or loft each separately)`);
      if (regions[0].holes.length > 0) throw new Error(
        `loft: ring ${i} has holes — loft rings must be hole-free outlines (cut the holes from the lofted solid instead)`);
      poly = JSON.parse(JSON.stringify(regions[0].outer));
    }
    if (!poly && Number.isFinite(r.sides) && Number.isFinite(r.radius)) poly = regularPolygon(r.sides, r.radius);
    if (isContour(poly)) return { raw: r, contour: bakeContour(poly, r), pts: null, z: r.z };
    if (!isPointList(poly) || poly.length < 3)
      throw new Error(`loft: ring ${i} needs polygon:[[x,y],…] (≥3 points), a curve contour, a Shape2D, or sides+radius shorthand`);
    const pts = bakePts(poly, r);
    return { raw: r, contour: bakeContour(pointsToContour(poly), r), pts, z: r.z };
  });
}

const signatureOf = (contour) => contour.segments.map((s) => (s.c1 ? "C" : s.via ? "A" : "L")).join("");

export function classifyLoftRings(lifted) {
  const sigs = lifted.map((r) => signatureOf(r.contour));
  const hasCurve = sigs.some((s) => /[AC]/.test(s));
  const identical = sigs.every((s) => s === sigs[0]);
  // Identical all-line signatures imply equal vertex counts (an N-point ring lifts to
  // exactly N line segments), so this IS today's equal-N legacy case, bit-for-bit.
  if (identical && !hasCurve) return { mode: "poly-exact", hasCurve: false };
  if (identical) return { mode: "curve", hasCurve };
  return { mode: "resample", hasCurve };
}

// Cache-key form of a ring list: replace live Shape2D values with their content hash
// so h()'s canonical serializer never walks a shape's methods.
export function loftRingsKey(rings) {
  if (!Array.isArray(rings)) return rings;
  return rings.map((r) => (r && typeof r === "object"
    ? { ...r, polygon: r.polygon && r.polygon._shape2d ? r.polygon._hash : r.polygon }
    : r));
}

// Natural facet count a segment would get at LOFT_SEGS — the per-segment budget the
// matched sampler levels up to across rings.
const segNaturalCount = (prev, seg) => {
  if (seg.c1) return Math.max(1, sampleBezier(prev, seg.c1, seg.c2, seg.to, LOFT_SEGS).length);
  if (seg.via) {
    const g = arcGeometry(prev, seg.via, seg.to);
    return g ? Math.max(2, Math.ceil((LOFT_SEGS * Math.abs(g.dA)) / (2 * Math.PI))) : 1;
  }
  return 1;
};

// Sample one segment with EXACTLY n points (uniform in angle/parameter), last point
// pinned to seg.to. Fixed counts are what keep corresponding vertices aligned across
// rings — the adaptive samplers must not be used here.
const sampleSegN = (prev, seg, n) => {
  const out = [];
  if (seg.c1) {
    for (let s = 1; s <= n; s++) out.push(cubicAt(prev, seg.c1, seg.c2, seg.to, s / n));
  } else if (seg.via) {
    const g = arcGeometry(prev, seg.via, seg.to);
    if (!g) { for (let s = 1; s <= n; s++) out.push([prev[0] + (seg.to[0] - prev[0]) * (s / n), prev[1] + (seg.to[1] - prev[1]) * (s / n)]); }
    else for (let s = 1; s <= n; s++) {
      const ang = g.a0 + g.dA * (s / n);
      out.push([g.cx + g.r * Math.cos(ang), g.cy + g.r * Math.sin(ang)]);
    }
  } else {
    for (let s = 1; s <= n; s++) out.push([prev[0] + (seg.to[0] - prev[0]) * (s / n), prev[1] + (seg.to[1] - prev[1]) * (s / n)]);
  }
  out[out.length - 1] = [seg.to[0], seg.to[1]];
  return out;
};

// Curve mode: identical signatures guaranteed by classifyLoftRings. Per segment index,
// every ring samples with the same count (the max natural count), so vertex i lies at
// the same curve parameter on every ring; the seam is each contour's start.
export function matchedTessellation(lifted) {
  const segCount = lifted[0].contour.segments.length;
  const counts = [];
  for (let j = 0; j < segCount; j++) {
    let n = 1, prevs = lifted.map((r) => (j === 0 ? r.contour.start : r.contour.segments[j - 1].to));
    lifted.forEach((r, k) => { n = Math.max(n, segNaturalCount(prevs[k], r.contour.segments[j])); });
    counts.push(n);
  }
  return lifted.map((r) => {
    const ring = [[r.contour.start[0], r.contour.start[1]]];
    let prev = r.contour.start;
    r.contour.segments.forEach((seg, j) => { for (const p of sampleSegN(prev, seg, counts[j])) ring.push(p); prev = seg.to; });
    // stored contours close explicitly (last segment lands on start) — drop the closure
    ring.pop();
    return ring;
  });
}
