// The k.loftSmooth densifier (see the loftSmooth row in docs/KERNEL-CONTRACT.md and
// docs/superpowers/specs/2026-08-24-loft-smooth-design.md).
// Shared spline densifier behind k.loftSmooth: sparse control sections in, a dense
// ring list for k.loft out. Pure JS and backend-free, so both backends receive the
// IDENTICAL densified station list — parity by construction, the sweep/screwSweep
// precedent — rather than each backend interpolating its own surface.
//
// Interpolation is Catmull-Rom both ways:
//   • around each ring — centripetal (α=0.5) through the section's control points,
//     closed/periodic, resampled to a shared vertex count uniformly by arc length
//     (centripetal because airfoil-style sections cluster points unevenly, and
//     uniform CR overshoots on uneven chords);
//   • across stations — through each vertex index's control polyline, with ONE
//     shared knot vector taken from the centroid spine (centroid + z chord length).
//     Shared knots mean every vertex's z blend is identical, so output rings stay
//     planar — which the k.loft ring format requires.
// End stations are clamped with reflection phantoms, so the surface interpolates
// the first and last control sections exactly.
import { isArcContour, sampleArc, sampleBezier, closeContourGap } from "./profile.js";
import { profileCorners } from "./contour-ops.js";
import { LOFT_SEGS } from "./loft-rings.js";

// Tessellate a path contour tracking each segment joint's output index
// (vertex i = start of segment i; jointIdx[i] is its position in pts).
function tessellateWithJoints(contour, segs) {
  const pts = [[contour.start[0], contour.start[1]]];
  const jointIdx = [0];
  let prev = contour.start;
  for (const seg of contour.segments) {
    if (seg.c1) for (const p of sampleBezier(prev, seg.c1, seg.c2, seg.to, segs)) pts.push(p);
    else if (seg.via) for (const p of sampleArc(prev, seg.via, seg.to, segs)) pts.push(p);
    else pts.push([seg.to[0], seg.to[1]]);
    jointIdx.push(pts.length - 1);
    prev = seg.to;
  }
  pts.pop();      // explicit closure lands on start — drop the duplicate for a closed ring
  jointIdx.pop(); // and the wrap entry with it
  return { pts, jointIdx };
}

// Mirror of loft's ring spec resolution (loft.js resolveRings), minus the
// equal-vertex-count rule — the whole point here is that control sections may
// disagree; the resampler reconciles them. Point sections may carry sharp
// corner tags; curve contours/Shape2D sections carry corners implicitly
// (their line/curve joints).
function resolveSections(sections) {
  if (!Array.isArray(sections) || sections.length < 2)
    throw new Error("loftSmooth: sections must be an array of at least 2 control sections");
  return sections.map((s, i) => {
    if (!s || typeof s !== "object") throw new Error(`loftSmooth: section ${i} must be an object { polygon|sides+radius, z }`);
    if (!Number.isFinite(s.z)) throw new Error(`loftSmooth: section ${i} needs a finite z`);
    let pts = s.polygon;
    let corners;
    if (pts && pts._shape2d) {
      const regions = pts._regions;
      if (regions.length === 0) throw new Error(`loftSmooth: section ${i} is an empty Shape2D — nothing to loft`);
      if (regions.length > 1) throw new Error(
        `loftSmooth: section ${i} is a Shape2D with ${regions.length} regions — a loft section must be a single closed outline (union the regions into one, or loft each separately)`);
      if (regions[0].holes.length > 0) throw new Error(
        `loftSmooth: section ${i} has holes — loft sections must be hole-free outlines (cut the holes from the lofted solid instead)`);
      pts = JSON.parse(JSON.stringify(regions[0].outer));
    }
    if (isArcContour(pts)) {
      if (s.sharp != null)
        throw new Error(`loftSmooth: section ${i} is a curve contour — its corners are implicit; sharp is only for point sections`);
      const contour = closeContourGap(pts);
      const t = tessellateWithJoints(contour, LOFT_SEGS);
      corners = profileCorners(contour).map((c) => t.jointIdx[c.index]).sort((a, b) => a - b);
      pts = t.pts;
    } else {
      if (!pts && Number.isFinite(s.sides) && Number.isFinite(s.radius)) {
        pts = [];
        for (let j = 0; j < s.sides; j++) {
          const a = (j / s.sides) * 2 * Math.PI;
          pts.push([Math.cos(a) * s.radius, Math.sin(a) * s.radius]);
        }
      }
      if (!Array.isArray(pts) || pts.length < 3)
        throw new Error(`loftSmooth: section ${i} needs polygon:[[x,y],…] (≥3 points), a curve contour, a Shape2D, or sides+radius shorthand`);
      if (s.sharp != null) {
        if (!Array.isArray(s.sharp) || s.sharp.some((x) => !Number.isInteger(x) || x < 0 || x >= pts.length))
          throw new Error(`loftSmooth: section ${i} sharp indices must be integers in 0…${pts.length - 1}`);
        corners = [...new Set(s.sharp)].sort((a, b) => a - b);
      } else corners = [];
    }
    const sc = s.scale ?? 1;
    const [sx, sy] = Array.isArray(sc) ? sc : [sc, sc];
    const rot = ((s.rotate ?? 0) * Math.PI) / 180, cos = Math.cos(rot), sin = Math.sin(rot);
    let pts2d = pts.map(([x, y]) => {
      const X = x * sx, Y = y * sy;
      return [X * cos - Y * sin, X * sin + Y * cos];
    });
    // Corner 0 anchors the seam (spec §2): rotate the ring so it leads at vertex 0.
    if (corners.length && corners[0] !== 0) {
      const shift = corners[0];
      pts2d = [...pts2d.slice(shift), ...pts2d.slice(0, shift)];
      corners = corners.map((c) => c - shift);
    }
    return { pts2d, corners, z: s.z };
  });
}

// Barry–Goldman pyramid for one Catmull-Rom segment: evaluates the curve through
// p1..p2 at knot value t ∈ [t1, t2], for arbitrary (e.g. centripetal) knots.
function crPoint(p0, p1, p2, p3, t0, t1, t2, t3, t) {
  const lerpP = (a, b, ta, tb) => {
    const w = tb === ta ? 0 : (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
  };
  const a1 = lerpP(p0, p1, t0, t1), a2 = lerpP(p1, p2, t1, t2), a3 = lerpP(p2, p3, t2, t3);
  const b1 = lerpP(a1, a2, t0, t2), b2 = lerpP(a2, a3, t1, t3);
  return lerpP(b1, b2, t1, t2);
}

const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

// Closed centripetal Catmull-Rom through `pts`, resampled to `n` points uniformly
// by arc length (measured on a dense polyline — SUB samples per control segment).
const SUB = 8;
export function resampleClosedSpline(pts, n) {
  const N = pts.length;
  const dense = [];
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i - 1 + N) % N], p1 = pts[i], p2 = pts[(i + 1) % N], p3 = pts[(i + 2) % N];
    // Centripetal knots (α=0.5); coincident control points get a tiny ε so the
    // pyramid never divides by zero.
    const t0 = 0;
    const t1 = t0 + Math.max(Math.sqrt(dist(p0, p1)), 1e-6);
    const t2 = t1 + Math.max(Math.sqrt(dist(p1, p2)), 1e-6);
    const t3 = t2 + Math.max(Math.sqrt(dist(p2, p3)), 1e-6);
    for (let s = 0; s < SUB; s++)
      dense.push(crPoint(p0, p1, p2, p3, t0, t1, t2, t3, t1 + ((t2 - t1) * s) / SUB));
  }
  // Uniform-by-arc-length resample of the dense closed polyline.
  const M = dense.length;
  const cum = [0];
  for (let i = 1; i <= M; i++) cum.push(cum[i - 1] + dist(dense[i - 1], dense[i % M]));
  const total = cum[M];
  if (!(total > 0)) throw new Error("loftSmooth: a control section has zero perimeter");
  const out = [];
  let seg = 0;
  for (let j = 0; j < n; j++) {
    const target = (j / n) * total;
    while (cum[seg + 1] < target) seg++;
    const a = dense[seg], b = dense[(seg + 1) % M];
    const w = (target - cum[seg]) / (cum[seg + 1] - cum[seg] || 1);
    out.push([a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w]);
  }
  return out;
}

const reflectPt = (p, q) => [2 * p[0] - q[0], 2 * p[1] - q[1]];

// Dense polyline of the clamped open centripetal CR through `pts` (reflection
// phantoms at both ends), endpoints exact. Shared by resampleOpenArc and the
// arc-length weights in reconcile().
function openArcDense(pts) {
  const A = pts.length;
  const ctrl = [reflectPt(pts[0], pts[1]), ...pts, reflectPt(pts[A - 1], pts[A - 2])];
  const dense = [];
  for (let i = 1; i < A; i++) {
    const p0 = ctrl[i - 1], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[i + 2];
    const t0 = 0;
    const t1 = t0 + Math.max(Math.sqrt(dist(p0, p1)), 1e-6);
    const t2 = t1 + Math.max(Math.sqrt(dist(p1, p2)), 1e-6);
    const t3 = t2 + Math.max(Math.sqrt(dist(p2, p3)), 1e-6);
    for (let s = 0; s < SUB; s++)
      dense.push(crPoint(p0, p1, p2, p3, t0, t1, t2, t3, t1 + ((t2 - t1) * s) / SUB));
  }
  dense.push([pts[A - 1][0], pts[A - 1][1]]);
  return dense;
}

const polyLen = (poly) => {
  let L = 0;
  for (let i = 1; i < poly.length; i++) L += dist(poly[i - 1], poly[i]);
  return L;
};

// Clamped open CR through `pts`, resampled uniformly by arc length to spans+1
// points; both endpoints are interpolated exactly.
export function resampleOpenArc(pts, spans) {
  const dense = openArcDense(pts);
  const M = dense.length - 1;
  const cum = [0];
  for (let i = 1; i <= M; i++) cum.push(cum[i - 1] + dist(dense[i - 1], dense[i]));
  const total = cum[M];
  if (!(total > 0)) throw new Error("loftSmooth: a control section has zero perimeter");
  const out = [];
  let seg = 0;
  for (let j = 0; j <= spans; j++) {
    const target = (j / spans) * total;
    while (seg < M - 1 && cum[seg + 1] < target) seg++;
    const a = dense[seg], b = dense[seg + 1];
    const w = (target - cum[seg]) / (cum[seg + 1] - cum[seg] || 1);
    out.push([a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w]);
  }
  out[0] = [pts[0][0], pts[0][1]];
  out[spans] = [pts[pts.length - 1][0], pts[pts.length - 1][1]];
  return out;
}

// Cyclic slice of a ring from corner j to corner j+1, both endpoints included.
function arcPoints(pts, corners, j) {
  const N = pts.length, m = corners.length;
  const a = corners[j], b = corners[(j + 1) % m];
  const out = [];
  for (let k = a; ; k = (k + 1) % N) {
    out.push(pts[k]);
    if (k === b && out.length > 1) break;
  }
  return out;
}

// Reconcile all sections to a shared vertex count: samples spans apportioned
// among the m corner-delimited arcs by mean arc-length fraction (largest
// remainder, ties to the lower arc index, minimum 1 span per arc — spec §2).
function reconcile(resolved, V) {
  const m = resolved[0].corners.length;
  for (let i = 1; i < resolved.length; i++)
    if (resolved[i].corners.length !== m)
      throw new Error(
        `loftSmooth: every section must have the same corner count — section ${i} has ${resolved[i].corners.length}, section 0 has ${m}`);
  if (m === 0)
    return { rings: resolved.map((r) => resampleClosedSpline(r.pts2d, V)), corners: [] };
  const V2 = Math.max(V, m);
  const arcs = resolved.map((r) => Array.from({ length: m }, (_, j) => arcPoints(r.pts2d, r.corners, j)));
  const fracs = Array.from({ length: m }, () => 0);
  for (const sectionArcs of arcs) {
    const lens = sectionArcs.map((a) => polyLen(openArcDense(a)));
    const perim = lens.reduce((a, b) => a + b, 0);
    for (let j = 0; j < m; j++) fracs[j] += lens[j] / perim;
  }
  for (let j = 0; j < m; j++) fracs[j] /= resolved.length;
  const extra = V2 - m;
  const exact = fracs.map((f) => extra * f);
  const alloc = exact.map(Math.floor);
  let left = extra - alloc.reduce((a, b) => a + b, 0);
  const order = exact.map((e, j) => [e - alloc[j], j]).sort((p, q) => q[0] - p[0] || p[1] - q[1]);
  for (let j = 0; j < left; j++) alloc[order[j][1]]++;
  const spans = alloc.map((a) => a + 1);
  const rings = arcs.map((sectionArcs) =>
    sectionArcs.flatMap((arcPts2, j) => resampleOpenArc(arcPts2, spans[j]).slice(0, -1)));
  const corners = [];
  let acc = 0;
  for (let j = 0; j < m; j++) { corners.push(acc); acc += spans[j]; }
  return { rings, corners };
}

/**
 * Densify sparse control sections into a ring list for k.loft.
 * @param {Array} sections  loft-style ring specs ({polygon|sides+radius, z, rotate?, scale?});
 *                          vertex counts may differ between sections. Point arrays may
 *                          carry sharp:[indices]; curve contours/Shape2D sections carry
 *                          corners implicitly.
 * @param {{stations?: number|"controls", samples?: number}} opts
 *   stations — output ring count along the spine (default 8 per span + 1, ≥ 2;
 *     raised to the section count when lower; every control knot is always emitted).
 *     The string "controls" skips cross-station interpolation entirely and emits
 *     one ring per control section at its own z — the B-rep path, where the
 *     backend's native smooth loft (`ruled: false`) does the skinning through
 *     exact wires and only the around-ring reconciliation is needed;
 *   samples  — output vertex count around each ring (default max(64, largest section)).
 * @returns {Array<{polygon: number[][], z: number}>}
 */
export function smoothLoftRings(sections, { stations, samples } = {}) {
  const resolved = resolveSections(sections);
  const n = resolved.length;
  const S = stations ?? (n - 1) * 8 + 1;
  const V = samples ?? Math.max(64, ...resolved.map((r) => r.pts2d.length));
  if (stations !== "controls" && !(Number.isFinite(S) && S >= 2 && S <= 1024))
    throw new Error('loftSmooth: stations must be 2…1024 (or "controls")');
  if (!(Number.isFinite(V) && V >= 8 && V <= 2048)) throw new Error("loftSmooth: samples must be 8…2048");

  // 1. Reconcile every section to a shared vertex count on its smooth closed
  //    outline — around each corner-delimited arc when corners are present,
  //    or the whole closed spline (v1-identical) when m = 0.
  const { rings } = reconcile(resolved, V);
  const VOut = rings[0].length; // V raised to the corner count when larger
  if (stations === "controls")
    return resolved.map((r, i) => ({ polygon: rings[i], z: r.z }));

  // 2. Shared across-station knots from the centroid spine (chord length in
  //    centroid-xy + z space). Shared knots ⇒ planar output rings (see header).
  const spine = resolved.map((r, i) => {
    let cx = 0, cy = 0;
    for (const [x, y] of rings[i]) { cx += x; cy += y; }
    return [cx / VOut, cy / VOut, r.z];
  });
  const knots = [0];
  for (let i = 1; i < n; i++)
    knots.push(knots[i - 1] + Math.max(Math.hypot(
      spine[i][0] - spine[i - 1][0], spine[i][1] - spine[i - 1][1], spine[i][2] - spine[i - 1][2]), 1e-6));

  // Reflection phantoms clamp the ends: the curve passes through ring 0 and ring
  // n−1 exactly, with a natural-looking end tangent.
  const reflect = (a, b) => [2 * a[0] - b[0], 2 * a[1] - b[1]];
  const knotAt = (i) => { // phantom knots mirror the end spacing
    if (i < 0) return knots[0] - (knots[1] - knots[0]);
    if (i >= n) return knots[n - 1] + (knots[n - 1] - knots[n - 2]);
    return knots[i];
  };
  const ptAt = (j, i) => {
    if (i < 0) return reflect(rings[0][j], rings[1][j]);
    if (i >= n) return reflect(rings[n - 1][j], rings[n - 2][j]);
    return rings[i][j];
  };
  const zCtrl = (i) => {
    if (i < 0) return 2 * resolved[0].z - resolved[1].z;
    if (i >= n) return 2 * resolved[n - 1].z - resolved[n - 2].z;
    return resolved[i].z;
  };

  // 3. Station parameter list: every control knot is always emitted, plus interior
  //    stations distributed per span proportionally to knot length (largest-
  //    remainder apportionment; ties to the lower index — deterministic), so each
  //    control section appears as an actual output ring, not just a point the
  //    underlying spline passes through. `stations` below the section count is
  //    raised to it (the knots alone already cost n rings).
  const tEnd = knots[n - 1];
  const S2 = Math.max(S, n);
  const extra = S2 - n;
  const spans = [];
  for (let i = 0; i < n - 1; i++) spans.push(knots[i + 1] - knots[i]);
  const exact = spans.map((len) => (extra * len) / tEnd);
  const alloc = exact.map(Math.floor);
  let left = extra - alloc.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => [e - alloc[i], i]).sort((p, q) => q[0] - p[0] || p[1] - q[1]);
  for (let j = 0; j < left; j++) alloc[order[j][1]]++;
  const ts = [];
  for (let i = 0; i < n - 1; i++) {
    ts.push(knots[i]);
    for (let m = 1; m <= alloc[i]; m++) ts.push(knots[i] + (spans[i] * m) / (alloc[i] + 1));
  }
  ts.push(tEnd);

  // 4. Evaluate the stations. z uses the same segment/knots as every vertex,
  //    evaluated once per station (1-D Barry–Goldman via crPoint).
  const out = [];
  for (const t of ts) {
    let seg = 0; // segment index: t ∈ [knots[seg], knots[seg+1]]
    while (seg < n - 2 && t > knots[seg + 1]) seg++;
    const t0 = knotAt(seg - 1), t1 = knots[seg], t2 = knots[seg + 1], t3 = knotAt(seg + 2);
    const z1d = (a, b, c, d) =>
      crPoint([a, 0], [b, 0], [c, 0], [d, 0], t0, t1, t2, t3, t)[0];
    const z = z1d(zCtrl(seg - 1), zCtrl(seg), zCtrl(seg + 1), zCtrl(seg + 2));
    const polygon = [];
    for (let j = 0; j < VOut; j++)
      polygon.push(crPoint(ptAt(j, seg - 1), ptAt(j, seg), ptAt(j, seg + 1), ptAt(j, seg + 2), t0, t1, t2, t3, t));
    out.push({ polygon, z });
  }
  return out;
}
