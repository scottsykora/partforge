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
import { SMOOTH_SIDES_MIN } from "./shading-policy.js";

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
    if (isContour(poly)) {
      const contour = bakeContour(poly, r);
      const allLines = contour.segments.every((s) => !s.via && !s.c1);
      if (allLines && contour.segments.length < 3)
        throw new Error(`loft: ring ${i}'s contour has only ${contour.segments.length} line segment(s) — an all-line contour needs at least 3 to close a polygon (a curved contour, e.g. a circle, may legitimately have fewer)`);
      return { raw: r, contour, pts: null, z: r.z };
    }
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
    ? { ...r, polygon: r.polygon && r.polygon._shape2d ? "s2d:" + r.polygon._hash : r.polygon }
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
  return matchedTessellationDetail(lifted).rings;
}

// Detail form: also reports the shared per-segment sample counts, which the shading
// provenance below needs to map contour joints onto sample indices.
function matchedTessellationDetail(lifted) {
  const segCount = lifted[0].contour.segments.length;
  const counts = [];
  for (let j = 0; j < segCount; j++) {
    let n = 1, prevs = lifted.map((r) => (j === 0 ? r.contour.start : r.contour.segments[j - 1].to));
    lifted.forEach((r, k) => { n = Math.max(n, segNaturalCount(prevs[k], r.contour.segments[j])); });
    counts.push(n);
  }
  const rings = lifted.map((r) => {
    const ring = [[r.contour.start[0], r.contour.start[1]]];
    let prev = r.contour.start;
    r.contour.segments.forEach((seg, j) => { for (const p of sampleSegN(prev, seg, counts[j])) ring.push(p); prev = seg.to; });
    // stored contours close explicitly (last segment lands on start) — drop the closure
    ring.pop();
    return ring;
  });
  return { rings, counts };
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
  const owner = new Map();   // sample index -> snap distance
  const ownerOf = new Map(); // corner list index -> sample index it won
  corners.forEach((c, ci) => {
    let bi = -1, bd = Infinity;
    for (let i = 0; i < orig.length; i++) {
      const d = Math.hypot(orig[i][0] - c[0], orig[i][1] - c[1]);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bd < spacing && (!owner.has(bi) || bd < owner.get(bi))) {
      out[bi] = [c[0], c[1]];
      owner.set(bi, bd);
      for (const [k, v] of ownerOf) if (v === bi) ownerOf.delete(k); // evicted corner loses the sample
      ownerOf.set(ci, bi);
    }
  });
  return { out, ownerOf };
};

// Resample mode: every ring tessellated at the fixed LOD, resampled to a common N.
export function resampleTessellation(lifted) {
  return resampleTessellationDetail(lifted).rings;
}

// Detail form: also reports each ring's snapped-corner sample indices, which the
// shading provenance below uses as sector boundaries.
function resampleTessellationDetail(lifted) {
  const source = lifted.map((r) => {
    let ring = r.pts ?? tessellateContour(r.contour, LOFT_SEGS);
    // tessellateContour of a contour returns an explicitly closed ring — drop the closure
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1])
      ring = ring.slice(0, -1);
    if (shoelace(ring) < 0) ring = [...ring].reverse();
    return ring;
  });
  const N = Math.max(...source.map((r) => r.length));
  const rings = [], snapped = [];
  lifted.forEach((r, i) => {
    const corners = profileCorners(r.contour);
    const res = resampleRing(source[i], N, corners.map((c) => c.point));
    rings.push(res.out);
    // Only SHARP corners become sector boundaries (see sharpTurn below): a
    // polygonized circle's 7.5°-per-vertex "corners" all snap, but must not
    // shatter the ring into per-facet sectors.
    const sharpSet = new Set();
    corners.forEach((c, ci) => { if (sharpTurn(c) && res.ownerOf.has(ci)) sharpSet.add(res.ownerOf.get(ci)); });
    snapped.push(sharpSet);
  });
  return { rings, snapped };
}

// ── Shading provenance ──────────────────────────────────────────────────────
// Column j is the wall strip between samples j and j+1 (wrapping). A sector is a
// maximal run of columns between sharp contour features — sharp joints in curve
// mode, snapped corners in resample mode — so the mesh builder (loft.js) can give
// each sector its own shading surface. sectorSmooth[k] says whether sector k's
// facets approximate a smooth curve (its shading policy creases gently and draws
// no facet wireframe) or are flat/faceted geometry.

// A joint is SHARP (a sector boundary) only when it turns more than a smooth
// tessellation ever produces per facet — the same 360/SMOOTH_SIDES_MIN bar as the
// legacy "≥32 sides reads smooth" rule. profileCorners' own 1° bar is author-intent
// (corner ops); reusing it here would shatter a polygonized circle into sectors.
const SHARP_TURN_DEG = 360 / SMOOTH_SIDES_MIN;
const sharpTurn = (corner) => Math.abs(180 - corner.interiorAngleDeg) > SHARP_TURN_DEG;

const sectorsFromBoundaries = (N, boundarySet) => {
  const B = [...boundarySet].sort((a, b) => a - b);
  const sectorOf = new Array(N).fill(0);
  if (B.length > 1) {
    for (let k = 0; k < B.length; k++) {
      const from = B[k], to = B[(k + 1) % B.length];
      for (let j = from; j !== to; j = (j + 1) % N) sectorOf[j] = k;
    }
  }
  return sectorOf;
};

// Curve mode: sector boundaries at sharp joints (profileCorners, unioned across all
// rings — structurally identical contours can still disagree on which joints bend).
// A sector is smooth when any column in it samples a curved (arc/cubic) segment.
const curveShading = (lifted, counts) => {
  const N = counts.reduce((a, b) => a + b, 0);
  const jointSample = [0]; // joint j (start of segment j) lands at this sample index
  for (let j = 1; j < counts.length; j++) jointSample.push(jointSample[j - 1] + counts[j - 1]);
  const sharp = new Set();
  for (const r of lifted) for (const c of profileCorners(r.contour)) if (sharpTurn(c)) sharp.add(jointSample[c.index]);
  const sectorOf = sectorsFromBoundaries(N, sharp);
  const segSmooth = lifted[0].contour.segments.map((s) => !!(s.via || s.c1));
  const K = Math.max(...sectorOf) + 1;
  const sectorSmooth = new Array(K).fill(false);
  let seg = 0;
  for (let j = 0; j < N; j++) {
    while (seg < counts.length - 1 && j >= jointSample[seg + 1]) seg++;
    if (segSmooth[seg]) sectorSmooth[sectorOf[j]] = true;
  }
  return { sectorOf, sectorSmooth };
};

// Resample mode: sector boundaries at the union of every ring's snapped corners. A
// sector is smooth when every interior sample on every ring turns gently — the same
// bar as the legacy "≥ SMOOTH_SIDES_MIN sides reads smooth" rule (360/32 per facet).
const resampleShading = (rings, snappedSets) => {
  const N = rings[0].length;
  const boundaries = new Set();
  for (const s of snappedSets) for (const i of s) boundaries.add(i);
  const sectorOf = sectorsFromBoundaries(N, boundaries);
  const K = Math.max(...sectorOf) + 1;
  const limit = (2 * Math.PI) / SMOOTH_SIDES_MIN;
  const sectorSmooth = new Array(K).fill(true);
  for (const ring of rings)
    for (let i = 0; i < N; i++) {
      if (boundaries.has(i)) continue; // corners split sectors; they are not interior turns
      const p = ring[(i - 1 + N) % N], q = ring[i], r2 = ring[(i + 1) % N];
      const ux = q[0] - p[0], uy = q[1] - p[1], vx = r2[0] - q[0], vy = r2[1] - q[1];
      const turn = Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
      if (turn > limit) { // the kink sits AT sample i — both adjacent columns' sectors go faceted
        sectorSmooth[sectorOf[i]] = false;
        sectorSmooth[sectorOf[(i - 1 + N) % N]] = false;
      }
    }
  return { sectorOf, sectorSmooth };
};

// Orchestrates lift -> classify -> tessellate into the single shape both backends consume:
// resolved[i] = { pts2d, z, contour } — pts2d for Manifold's hand-mesh, contour (curve mode
// only) for OCCT's native wire loft. See docs/superpowers/plans/2026-08-23-shape2d-loft-design.md.
export function resolveLoftRings(rings) {
  const lifted = liftLoftRings(rings);
  const { mode, hasCurve } = classifyLoftRings(lifted);
  let ptRings, shading = null;
  if (mode === "poly-exact") {
    // Point-list rings keep their legacy un-normalized winding for bit-exactness — UNLESS
    // the ring set also mixes in a contour/Shape2D-sourced ring (r.pts === null), whose
    // winding bakeContour already forced CCW. Left alone, a CW point ring paired with a
    // CCW contour ring cancels the side walls (mixed winding) into an empty solid instead
    // of erroring or self-correcting (loftMesh's volume<0 latch only catches a FULLY
    // inverted mesh, not this partial cancellation) — so only in the mixed case do we
    // also normalize each point ring to CCW here. All-point-list ring sets are untouched.
    const mixed = lifted.some((r) => r.pts) && lifted.some((r) => !r.pts);
    ptRings = lifted.map((r) => {
      if (!r.pts) return matchedTessellation([r, r])[0];
      return mixed && shoelace(r.pts) < 0 ? [...r.pts].reverse() : r.pts;
    });
  }
  else if (mode === "curve") {
    const d = matchedTessellationDetail(lifted);
    ptRings = d.rings;
    shading = curveShading(lifted, d.counts);
  } else {
    const d = resampleTessellationDetail(lifted);
    ptRings = d.rings;
    shading = resampleShading(d.rings, d.snapped);
  }
  return {
    mode, hasCurve, shading,
    resolved: lifted.map((r, i) => ({ pts2d: ptRings[i], z: r.z, contour: mode === "curve" ? r.contour : null })),
  };
}
