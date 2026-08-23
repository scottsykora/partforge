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
import { pointsToContour, reverseContour, closeContourGap, arcGeometry, sampleBezier, tessellateContour } from "./profile.js";
import { rotateProfile, scaleProfile, contourIsCCW, cubicAt, profileCorners } from "./contour-ops.js";

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

const shoelace = (ring) => ring.reduce((a, [x, y], i) => {
  const [nx, ny] = ring[(i + 1) % ring.length];
  return a + x * ny - nx * y;
}, 0) / 2;

// Deterministic seam: the outermost crossing of the +X ray from the ring's centroid.
// Returns { edge, t } — a parametric position on the ring's edge list. Falls back to
// all crossings of the full horizontal line, then to vertex 0, so it is total.
const seamOf = (ring) => {
  let cx = 0, cy = 0;
  for (const [x, y] of ring) { cx += x; cy += y; }
  cx /= ring.length; cy /= ring.length;
  let best = null;
  for (let pass = 0; pass < 2 && !best; pass++) {
    for (let i = 0; i < ring.length; i++) {
      const [px, py] = ring[i], [qx, qy] = ring[(i + 1) % ring.length];
      if ((py <= cy) === (qy <= cy)) continue;            // half-open: each crossing once
      const t = (cy - py) / (qy - py);
      const x = px + t * (qx - px);
      if (pass === 0 && x <= cx) continue;                // pass 0: +X ray only
      if (!best || x > best.x) best = { edge: i, t, x };
    }
  }
  return best ?? { edge: 0, t: 0, x: ring[0][0] };
};

// Arc-length resample one CCW ring to N points starting at its seam, then snap each
// sharp corner onto its nearest sample (closest corner wins a contested sample).
const resampleRing = (ring, N, corners) => {
  const seam = seamOf(ring);
  const pts = [];
  // unroll the ring into an open polyline starting exactly at the seam point
  const start = [ring[seam.edge][0] + seam.t * (ring[(seam.edge + 1) % ring.length][0] - ring[seam.edge][0]),
                 ring[seam.edge][1] + seam.t * (ring[(seam.edge + 1) % ring.length][1] - ring[seam.edge][1])];
  pts.push(start);
  for (let k = 1; k <= ring.length; k++) {
    const i = (seam.edge + k) % ring.length;
    pts.push([ring[i][0], ring[i][1]]);
  }
  // pts is now start → all vertices → start's edge-begin; close it back to start
  pts.push([start[0], start[1]]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = cum[cum.length - 1];
  const out = [];
  let seg = 0;
  for (let k = 0; k < N; k++) {
    const target = (k * L) / N;
    while (seg < cum.length - 2 && cum[seg + 1] < target) seg++;
    const span = cum[seg + 1] - cum[seg] || 1;
    const t = (target - cum[seg]) / span;
    out.push([pts[seg][0] + t * (pts[seg + 1][0] - pts[seg][0]), pts[seg][1] + t * (pts[seg + 1][1] - pts[seg][1])]);
  }
  // corner snapping: a sharp corner within one sample-spacing of a sample replaces it
  // Snapshot the original sample positions before snapping, so distance calculations
  // measure against original positions, not mutated ones (contest rule: closer corner wins)
  const spacing = L / N;
  const orig = out.map((p) => [p[0], p[1]]);
  const owner = new Map(); // sample index -> snap distance
  for (const c of corners) {
    let bi = -1, bd = Infinity;
    for (let i = 0; i < orig.length; i++) {
      const d = Math.hypot(orig[i][0] - c[0], orig[i][1] - c[1]);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bd < spacing && (!owner.has(bi) || bd < owner.get(bi))) {
      out[bi] = [c[0], c[1]];
      owner.set(bi, bd);
    }
  }
  return out;
};

// Resample mode: every ring tessellated at the fixed LOD, resampled to a common N.
export function resampleTessellation(lifted) {
  const rings = lifted.map((r) => {
    let ring = r.pts ?? tessellateContour(r.contour, LOFT_SEGS);
    // tessellateContour of a contour returns an explicitly closed ring — drop the closure
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1])
      ring = ring.slice(0, -1);
    if (shoelace(ring) < 0) ring = [...ring].reverse();
    return ring;
  });
  const N = Math.max(...rings.map((r) => r.length));
  return lifted.map((r, i) => {
    const corners = profileCorners(r.contour).map((c) => c.point);
    return resampleRing(rings[i], N, corners);
  });
}
