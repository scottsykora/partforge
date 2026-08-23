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
import { pointsToContour, reverseContour, closeContourGap } from "./profile.js";
import { rotateProfile, scaleProfile, contourIsCCW } from "./contour-ops.js";

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
