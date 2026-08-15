// Winding resolution for offset outlines — the cleanup path of contour-offset.js.
//
// The correct result of an offset is the POSITIVE WINDING REGION (w >= 1) of the raw
// offset outline — the same fill rule Clipper2's ClipperOffset uses (FillRule::Positive),
// the oracle this feature is measured against. Self-overlap loops, collapsed holes,
// unmerged seams and pinched necks are all the same failure: approximating that rule with
// booleans instead of computing it. This module computes it: find crossings (paper's curve
// clipper), split each ring there, label the FACES of the resulting planar arrangement by
// combinatorial winding propagation, keep a piece iff its two adjacent face labels straddle
// the fill boundary, chain the survivors, and emit the ORIGINAL curves trimmed at the
// crossing parameters. Classification is face-global, never per-piece probing: N
// independent geometric probes can be individually plausible and mutually inconsistent,
// and an inconsistent keep-set has no valid chaining (the pinch-vertex dead-end that sank
// the probe-based design). Face labels are consistent by construction. Spans that several
// rings run along at once — collinear edges, arcs sharing a circle — are handled by
// `_coincidence` below.
//
// Pure leaf in the worker graph: DOM-free, three-free, node:-free.
import { ringCrossings, arcCenterAndSweep } from "./paper-bridge.js";
import { trimSegment, segTangent } from "./contour-ops.js";
import { tessellateContour, closeContourGap, reverseContour } from "./profile.js";
import { assembleRegions, ringArea } from "./shape2d-regions.js";

// Crossings closer than this are one vertex. Derived: it must exceed OFFSET_TOL (1e-3 mm,
// the cubic-offset approximation error) or two crossings that are genuinely the same point
// on an approximated curve stay split; and it must stay far below the thinnest feature the
// engine is expected to keep. 5x OFFSET_TOL sits an order below a 0.05 mm feature.
export const CLUSTER_TOL = 5e-3;

// Tessellation density for sampled geometry in this module: the ambient-winding ray-cast
// targets, the per-component bottom-anchor scan, and the piece samples _coincidence uses.
export const WINDING_SEGS = 64;

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Assign every crossing a pool vertex, merging any within `tol`. Greedy against the pool:
// crossings are few (tens per ring) so the O(n·pool) scan is not worth indexing.
export function _mergeCrossings(crossings, tol = CLUSTER_TOL) {
  const pool = [];
  const members = [];
  const out = crossings.map((x) => {
    let v = pool.findIndex((p) => dist(p, x.point) <= tol);
    if (v === -1) { v = pool.length; pool.push([x.point[0], x.point[1]]); members.push([]); }
    members[v].push(x.point);
    return { ...x, vertex: v };
  });
  // settle each pooled vertex on its cluster centroid so the shared position is unbiased.
  // Membership above is assigned against a fixed anchor (the first member found within
  // tol), not the eventual centroid, so a cluster's diameter is bounded at 2*tol — a
  // member can end up slightly further than tol from the final centroid. Benign: `vertex`
  // is used only as an identity for chaining, never as a distance check against pool[v].
  for (let v = 0; v < pool.length; v++) {
    const m = members[v];
    pool[v] = [m.reduce((s, p) => s + p[0], 0) / m.length, m.reduce((s, p) => s + p[1], 0) / m.length];
  }
  return { crossings: out, pool };
}

// Point on a ring at (segment, t) — the ring's own parameterization.
const ringPoints = (contour) => [contour.start, ...contour.segments.map((s) => s.to)];

// Exact unit tangent / signed curvature of ORIGINAL segment `seg` (running from `from`)
// at parameter t. Computed on the untrimmed source curve so it stays well-conditioned for
// arbitrarily short trimmed pieces — a trimmed arc's own from/via/to become nearly
// collinear as the piece shrinks (arcCenterAndSweep on it degenerates to a chord), but the
// source arc's center never degrades. These feed the face graph's departure ordering and
// _chain's junction ordering, where a few degrees of tangent error at a pinch vertex is
// the difference between the right and the wrong successor.
function srcTangentAt(from, seg, t) {
  if (seg.c1) {
    const u = 1 - t;
    const d = [0, 1].map((k) => 3 * u * u * (seg.c1[k] - from[k]) + 6 * u * t * (seg.c2[k] - seg.c1[k]) + 3 * t * t * (seg.to[k] - seg.c2[k]));
    const L = Math.hypot(d[0], d[1]);
    if (L > 1e-12) return [d[0] / L, d[1] / L];
    return segTangent(from, seg, t < 0.5);              // cusp / degenerate handle: endpoint rule
  }
  if (seg.via) {
    const c = arcCenterAndSweep(from, seg.via, seg.to);
    if (c) {
      const a = Math.atan2(from[1] - c.center[1], from[0] - c.center[0]) + c.dA * t;
      return c.dA >= 0 ? [-Math.sin(a), Math.cos(a)] : [Math.sin(a), -Math.cos(a)];
    }
  }
  const L = Math.hypot(seg.to[0] - from[0], seg.to[1] - from[1]) || 1;
  return [(seg.to[0] - from[0]) / L, (seg.to[1] - from[1]) / L];
}

// Signed curvature (left-turn rate) of the source curve at t: 0 for a line, ±1/r for an
// arc (positive = CCW sweep = curving left), the standard cross(B′,B″)/|B′|³ for a cubic.
// Used only as a tie-break where two departures at a vertex share an exact tangent.
function srcCurvatureAt(from, seg, t) {
  if (seg.c1) {
    const u = 1 - t;
    const d1 = [0, 1].map((k) => 3 * u * u * (seg.c1[k] - from[k]) + 6 * u * t * (seg.c2[k] - seg.c1[k]) + 3 * t * t * (seg.to[k] - seg.c2[k]));
    const d2 = [0, 1].map((k) => 6 * u * (seg.c2[k] - 2 * seg.c1[k] + from[k]) + 6 * t * (seg.to[k] - 2 * seg.c2[k] + seg.c1[k]));
    const L = Math.hypot(d1[0], d1[1]);
    return L > 1e-12 ? (d1[0] * d2[1] - d1[1] * d2[0]) / (L * L * L) : 0;
  }
  if (seg.via) {
    const c = arcCenterAndSweep(from, seg.via, seg.to);
    if (c) return (c.dA >= 0 ? 1 : -1) / c.r;
  }
  return 0;
}

// Split each ring at its merged crossings into pieces. Crossings are sorted along the
// ring by (seg, t); consecutive pairs bound a piece, wrapping at the end. Each piece is
// materialized immediately as trimmed IR segments via trimSegment, plus the EXACT
// source-curve tangent/curvature at both crossing ends (tanA/kA outgoing at vStart,
// tanB/kB arriving at vEnd) — the face graph and _chain order junctions with these.
export function _splitRings(rings, merged) {
  const byRing = rings.map(() => []);
  for (const x of merged.crossings) {
    // A crossing with seg === contour.segments.length is on the closing curve toPaperPath's
    // closePath() synthesizes for a ring that never explicitly returns to its own start (see
    // its own comment, and irTime's matching seg===n branch in paper-bridge.js). Every ring
    // this module receives from contour-offset.js is explicitly closed (assembleRing /
    // closeContourGap both guarantee a real closing segment back to `start`), so that branch
    // is unreachable in practice — but `resolveOffsetWinding` is reachable from a PUBLIC entry
    // point (offsetRegions), so a future caller feeding an implicitly-closed ring must fail
    // loudly here rather than silently wrapping `k % n` back onto segment 0 below (a wrong
    // segment for that crossing, not merely an imprecise one).
    if (x.seg >= rings[x.ring].segments.length) {
      throw new Error("_splitRings: crossing lands on an implicit ring closure — every ring must be explicitly closed before resolveOffsetWinding");
    }
    byRing[x.ring].push(x);
  }
  const pieces = [];

  rings.forEach((contour, r) => {
    const pts = ringPoints(contour);
    // Sorted along the ring, then collapsed where two records are the SAME POSITION on it.
    // ringCrossings reports a crossing once per ring PAIR, so a point three or more rings
    // pass through (four features offset until their corners meet — see the coincidence
    // block below for the two-ring sibling of this) comes back twice or more on the same
    // ring with identical (seg, t). Left in, `emit` reads the run between two such records
    // as b.t <= a.t, i.e. "wrap all the way around", and emits the WHOLE RING as an extra
    // piece — no error, just a grossly wrong duplicate boundary in the output. Position, not
    // pooled vertex, is the right key: a ring that touches ITSELF visits one pooled vertex
    // twice at genuinely different (seg, t), and both visits are needed to split the loop.
    const xs = byRing[r].slice().sort((a, b) => (a.seg - b.seg) || (a.t - b.t))
      .filter((x, i, all) => i === 0 || x.seg !== all[i - 1].seg || Math.abs(x.t - all[i - 1].t) > 1e-12);
    if (xs.length === 0) {
      pieces.push({ ring: r, from: [contour.start[0], contour.start[1]],
                    segs: contour.segments.map((s) => ({ ...s })), vStart: null, vEnd: null,
                    tanA: null, kA: 0, tanB: null, kB: 0 });
      return;
    }
    // emit the run from crossing a to crossing b (b may wrap past the ring end)
    const emit = (a, b) => {
      const segs = [];
      let from = merged.pool[a.vertex];
      const spanEnd = b.seg + (b.seg < a.seg || (b.seg === a.seg && b.t <= a.t)
        ? contour.segments.length : 0);
      for (let k = a.seg; k <= spanEnd; k++) {
        const i = k % contour.segments.length;
        const seg = contour.segments[i];
        const tS = k === a.seg ? a.t : 0;
        const tE = k === spanEnd ? b.t : 1;
        if (tE - tS <= 1e-12) continue;
        segs.push(trimSegment(pts[i], seg, tS, tE).seg);
      }
      if (segs.length === 0) {
        // The only legitimate reason a run trims to nothing is a crossing pair that
        // already collapsed onto the same pooled vertex (a===b). Anything else means
        // clustering merged two crossings that should have stayed distinct, silently
        // dropping a run — fail here, at the source, not downstream as a broken chain.
        if (a.vertex !== b.vertex) {
          throw new Error(`_splitRings: degenerate run between distinct vertices ${a.vertex} and ${b.vertex} — clustering regression`);
        }
        return;
      }
      // The endpoint snap below is exact only for the bookkeeping: `from`/`to` are pool
      // coordinates shared bit-for-bit by both pieces meeting at a vertex, which is what
      // makes chaining reliable. It is NOT true of the curve shape near that joint — c1/c2
      // (cubics) and via (arcs) are carried through trimSegment unchanged, not re-derived
      // from the snapped endpoint, so a trimmed curve can deviate from the snapped position
      // by up to 2*CLUSTER_TOL (the cluster-diameter bound documented above _mergeCrossings'
      // loop). For an arc this deviation is not confined to the seam either: overwriting
      // `to` while leaving `via`/`from` untouched defines a slightly different circle, so
      // the error is distributed along the whole trimmed arc, not just at the joint. Fine
      // for winding classification and re-chaining, just not bit-for-bit. tanA/tanB below
      // deliberately come from the UNSNAPPED source curve at the crossing parameter — the
      // direction the boundary really leaves the junction in, unpolluted by the snap.
      segs[segs.length - 1].to = [merged.pool[b.vertex][0], merged.pool[b.vertex][1]];  // snap to the shared vertex
      pieces.push({ ring: r, from: [from[0], from[1]], segs, vStart: a.vertex, vEnd: b.vertex,
        tanA: srcTangentAt(pts[a.seg], contour.segments[a.seg], a.t),
        kA: srcCurvatureAt(pts[a.seg], contour.segments[a.seg], a.t),
        tanB: srcTangentAt(pts[b.seg], contour.segments[b.seg], b.t),
        kB: srcCurvatureAt(pts[b.seg], contour.segments[b.seg], b.t) });
    };
    for (let i = 0; i < xs.length; i++) emit(xs[i], xs[(i + 1) % xs.length]);
  });
  return pieces;
}

// --- coincident (collinear-overlap) pieces ------------------------------------------
//
// Two rings can run along the SAME curve over a shared span — two features offset outward
// with `corners: "sharp"` until their straight flanks meet is the everyday case, and two
// arcs can equally share a span of one circle. paper's getIntersections DOES report those:
// Curve.getOverlaps returns both ends of the overlapped span as ordinary intersections on
// both curves, so the arrangement is complete and _splitRings already cuts there, leaving
// two (or more) pieces occupying the same span.
//
// What such input breaks is the "crossing one directed edge changes winding by exactly 1"
// identity: where k directed edges lie on top of each other the winding jumps by their NET
// count. Two same-direction copies (the sharp-corner case) give a doubled boundary — w goes
// 0 -> 2 across it. Opposite-direction copies CANCEL: net 0, equal winding on both sides
// (an eroded hole that grew onto its own outer's edge does this).
//
// So this reports, per piece, the net multiplicity in that piece's OWN direction, plus a
// `duplicate` flag for the copies that are not the group's representative. Exactly one
// representative per group stays in the arrangement (the face graph must traverse the
// shared span once, and parallel duplicate edges would corrupt its rotational orders);
// a cancelled group's representative carries mult 0 — a weight-0 edge whose two adjacent
// faces simply get equal labels, never kept in the output.
//
// Interior sample points used to decide whether two pieces are the same curve. Taken at
// symmetric fractions of arc length, so a piece traversed the other way samples the same
// points in reverse order and the two cases are told apart by comparing both orders.
const COINCIDENT_SAMPLES = 5;

function pieceSamples(piece) {
  const poly = tessellateContour({ start: piece.from, segments: piece.segs }, WINDING_SEGS);
  const cum = [0];
  for (let i = 1; i < poly.length; i++)
    cum.push(cum[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]));
  const total = cum[cum.length - 1];
  const pts = [];
  for (let k = 1; k <= COINCIDENT_SAMPLES; k++) {
    const target = (total * k) / (COINCIDENT_SAMPLES + 1);
    let i = 1;
    while (i < cum.length - 1 && cum[i] < target) i++;
    const span = cum[i] - cum[i - 1];
    const f = span > 1e-15 ? (target - cum[i - 1]) / span : 0;
    pts.push([poly[i - 1][0] + f * (poly[i][0] - poly[i - 1][0]),
              poly[i - 1][1] + f * (poly[i][1] - poly[i - 1][1])]);
  }
  return { pts, len: total };
}

const maxDist = (a, b) => a.reduce((m, p, i) => Math.max(m, dist(p, b[i])), 0);

// +1 if b traces the same curve as a in the same direction, -1 if it traces it backwards,
// 0 if the two are different curves. Length first (cheap rejection), then the sampled points
// in both orders. When BOTH orders match the samples are palindromic (only possible for a
// piece that doubles back on itself); fall back to the pieces' shared pool vertices.
function coincidenceSign(A, B, a, b, tol) {
  if (Math.abs(A.len - B.len) > tol) return 0;
  const fOK = maxDist(A.pts, B.pts) <= tol;
  const rOK = maxDist(A.pts, [...B.pts].reverse()) <= tol;
  if (fOK && rOK) return (a.vStart === b.vStart && a.vEnd === b.vEnd) ? 1 : -1;
  return fOK ? 1 : (rOK ? -1 : 0);
}

// Per piece: `mult` (net count of coincident directed pieces along that piece's span,
// measured in its own direction — 1 for the ordinary case of a piece nothing else lies on,
// 0 when the group cancels) and `duplicate` (a copy the group already has a representative
// for; excluded from the arrangement).
//
// Only pieces sharing BOTH pool vertices can be coincident, which is what makes this cheap:
// the arrangement is split at the overlap's ends on every ring involved, so the copies come
// out with identical endpoints by construction. Coincidence is then confirmed GEOMETRICALLY
// (sampled points), not from the vertex pair alone — two different curves between the same
// pair of crossings (a lens) share endpoints without sharing a span. tol is CLUSTER_TOL, the
// module's "same point" scale; a lens thinner than that has no area worth keeping.
export function _coincidence(pieces, tol = CLUSTER_TOL) {
  const mult = new Array(pieces.length).fill(1);
  const duplicate = new Array(pieces.length).fill(false);
  const buckets = new Map();
  pieces.forEach((p, i) => {
    if (p.vStart === null || p.vEnd === null) return;        // uncrossed whole ring: nothing to pair with
    const key = p.vStart <= p.vEnd ? `${p.vStart}:${p.vEnd}` : `${p.vEnd}:${p.vStart}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  });
  const cache = new Map();
  const S = (i) => { if (!cache.has(i)) cache.set(i, pieceSamples(pieces[i])); return cache.get(i); };
  for (const idxs of buckets.values()) {
    if (idxs.length < 2) continue;
    const taken = new Set();
    for (const a of idxs) {
      if (taken.has(a)) continue;
      taken.add(a);
      const group = [{ i: a, sign: 1 }];
      for (const b of idxs) {
        if (taken.has(b)) continue;
        const sign = coincidenceSign(S(a), S(b), pieces[a], pieces[b], tol);
        if (sign !== 0) { group.push({ i: b, sign }); taken.add(b); }
      }
      if (group.length < 2) continue;
      const net = group.reduce((t, g) => t + g.sign, 0);
      if (net === 0) {
        // The group cancels: winding is identical on both sides, so no piece here bounds a
        // face. One representative stays as a weight-0 edge (see the block comment above);
        // the rest would only create parallel edges in the face graph.
        const rep0 = group[0].i;
        for (const g of group) { duplicate[g.i] = g.i !== rep0; mult[g.i] = 0; }
        continue;
      }
      const repSign = Math.sign(net);
      const rep = group.find((g) => g.sign === repSign).i;
      for (const g of group) { duplicate[g.i] = g.i !== rep; mult[g.i] = g.i === rep ? Math.abs(net) : 0; }
    }
  }
  return { mult, duplicate };
}

// Signed crossing count of a +x ray from p against tessellated rings. Standard
// half-open rule (a[1] <= p[1] < b[1]) so a vertex is counted exactly once. Used once per
// arrangement component (the ambient cast at its bottom anchor), never per piece.
export function _windingAt(p, tessRings) {
  let w = 0;
  for (const ring of tessRings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const side = (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]);
      if (a[1] <= p[1]) { if (b[1] > p[1] && side > 0) w++; }
      else if (b[1] <= p[1] && side < 0) w--;
    }
  }
  return w;
}
