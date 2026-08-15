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
      // A crossing sitting exactly ON a source vertex (t within emit's own 1e-12 skip
      // threshold of 0 or 1) belongs to TWO source segments, and the tangents must come
      // from the right one: the piece DEPARTS along the next segment when a.t≈1 (the
      // a.seg sliver above was skipped), and ARRIVES along the previous segment when
      // b.t≈0. Evaluating both on the recorded segment gave a whole-loop piece identical
      // departure and arrival tangents — garbage rotational order at the pinch vertex.
      const nSegs = contour.segments.length;
      const depSeg = a.t >= 1 - 1e-12 ? (a.seg + 1) % nSegs : a.seg;
      const depT = a.t >= 1 - 1e-12 ? 0 : a.t;
      const arrSeg = b.t <= 1e-12 ? (b.seg - 1 + nSegs) % nSegs : b.seg;
      const arrT = b.t <= 1e-12 ? 1 : b.t;
      pieces.push({ ring: r, from: [from[0], from[1]], segs, vStart: a.vertex, vEnd: b.vertex,
        tanA: srcTangentAt(pts[depSeg], contour.segments[depSeg], depT),
        kA: srcCurvatureAt(pts[depSeg], contour.segments[depSeg], depT),
        tanB: srcTangentAt(pts[arrSeg], contour.segments[arrSeg], arrT),
        kB: srcCurvatureAt(pts[arrSeg], contour.segments[arrSeg], arrT) });
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

// The literal message every unresolvable-arrangement site in this module throws — the BFS
// label conflict below and _chain's dangling-vertex guards — and the string
// ERROR-PATTERNS.md documents. Exported so contour-offset.js's fallback ladder can
// recognise THIS failure (the one with a documented, measured degradation) without
// pattern-matching on message text at a distance.
export const CHAIN_INCOMPLETE_MESSAGE =
  "contour-winding: could not chain offset boundary (incomplete intersection set)";

// Below this tessellated length a piece carries no usable geometry: it is the endpoint
// snap collapsing a short trimmed run between two near-identical pool vertices (distinct
// vertices, so the segs.length===0 guard in _splitRings cannot fire). Such an edge
// separates nothing — its two sides are the same region — so it is excluded from the
// arrangement (kept:false), while its endpoints are still unioned into one component so
// the vertices it connected stay connected.
const MIN_PIECE_LEN = 1e-9;

// Fallback tangents for hand-built pieces (tests build pieces without tanA/tanB);
// _splitRings output always carries the exact source-curve values.
const pieceTanA = (p) => p.tanA ?? segTangent(p.from, p.segs[0], true);
const pieceTanB = (p) => {
  if (p.tanB) return p.tanB;
  const pts = [p.from, ...p.segs.map((s) => s.to)];
  return segTangent(pts[pts.length - 2], p.segs[p.segs.length - 1], false);
};

// Bottom-most tessellation sample over a set of polylines → { e, k, x, y } with globally
// minimal (y, then x). e indexes into `polys`. Anchors a component's local exterior face.
function bottomSample(polys) {
  let best = null;
  polys.forEach((poly, e) => {
    for (let k = 0; k < poly.length; k++) {
      const [x, y] = poly[k];
      if (!best || y < best.y || (y === best.y && x < best.x)) best = { e, k, x, y };
    }
  });
  return best;
}

const polyLen = (poly) => {
  let L = 0;
  for (let i = 1; i < poly.length; i++) L += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
  return L;
};

// Project p onto the nearest edge of `ring` — a tessellated point ring — returning the
// projected point and that edge's unit direction. Anchors an audit probe exactly on the
// polyline _windingAt queries: the projected point IS a point of that polyline, so
// offsetting it along the edge normal cannot straddle a tessellation gap the way an
// independently-sampled point can (the whole-ring tessellation's sagitta grows with
// radius, ~1.2e-3·r at WINDING_SEGS=64 — past r≈8.3 mm it exceeds a fixed probe offset).
// Scanning the WHOLE ring can latch onto a nearby antiparallel branch, but origin and
// normal then flip together, so the left/right bookkeeping still comes out right.
function projectToRing(p, ring) {
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const L2 = ex * ex + ey * ey;
    let t = L2 > 1e-18 ? ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / L2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const point = [a[0] + t * ex, a[1] + t * ey];
    const dx = p[0] - point[0], dy = p[1] - point[1];
    const d2 = dx * dx + dy * dy;
    if (best === null || d2 < best.d2) {
      const L = Math.sqrt(L2) || 1;
      best = { point, dir: [ex / L, ey / L], d2 };
    }
  }
  return best;
}

// Classify pieces by FACE LABELS of the planar arrangement, never by per-piece probes.
//
// Half-edges: every non-duplicate crossed piece of usable length is one arrangement edge
// (forward = the piece's own direction, backward = its twin). At each pool vertex the
// departures are sorted CCW by the exact source-curve tangent angle (tanA/tanB from
// _splitRings), ties broken by signed curvature — an edge curving harder left is
// infinitesimally more CCW. next(h) = the rotational predecessor of twin(h) in that CCW
// order: the standard DCEL rule, identical in effect to _chain's verified "smallest
// positive rotation from the reversed inbound direction" with the literal U-turn ranked
// last. Orbits of next() are face boundary cycles with the face on the LEFT.
//
// Winding: one face per graph-connected component is anchored. The face just below the
// component's bottom-most tessellated point is its LOCAL EXTERIOR, whose own-component
// winding is 0 by TOPOLOGY (nothing of the component lies below that point), not by
// measurement. Rings outside this component never cross it (a crossing would join the
// components), so their winding contribution is a single constant over this component's
// entire connected curve network — continuity along a connected set that crosses nothing —
// measured ONCE by ray cast at the bottom point against the other rings only (`ambient`)
// and folded into every label. Rings whose every piece is a coincidence duplicate of this
// component's edges count as THIS component's rings (their contribution is already in
// `mult`), never as ambient geometry. BFS then propagates across edges: crossing a
// directed edge from its left face to its right subtracts its net multiplicity (`mult`).
// A label conflict means paper returned an incomplete/inconsistent intersection set
// (documented 40-level/4096-call bail) — throw the pinned message rather than emit a
// wrong ring. With consistent labels, a kept-set dead-end is impossible: kept edges are
// complete boundaries of face unions, so _chain always closes.
//
// The record shape matches the historical classifier: { piece, keep, reverse } plus
// wLeft/wRight in debug mode. wLeft - wRight === mult holds by construction for every
// arrangement edge; excluded records (duplicates, degenerate pieces) report null.
export function _classify(pieces, tessRings, { debug = false, inside = (w) => w !== 0, auditTol = CLUSTER_TOL, probeOverride = false } = {}) {
  const { mult, duplicate } = _coincidence(pieces);
  const recs = pieces.map((piece) => ({ piece, keep: false, reverse: false, wLeft: null, wRight: null }));

  // crossed pieces enter the union-find (component structure) even when excluded from the
  // face graph (duplicates, degenerate lengths) — their rings and vertices belong to the
  // component their vertices sit in.
  const crossed = [];
  pieces.forEach((p, i) => { if (p.vStart !== null && p.segs.length > 0) crossed.push(i); });

  const parent = new Map();
  const find = (v) => {
    let r = v;
    while (parent.get(r) !== r) r = parent.get(r);
    let c = v;
    while (parent.get(c) !== c) { const n = parent.get(c); parent.set(c, r); c = n; }
    return r;
  };
  for (const i of crossed) for (const v of [pieces[i].vStart, pieces[i].vEnd])
    if (!parent.has(v)) parent.set(v, v);
  for (const i of crossed) {
    const a = find(pieces[i].vStart), b = find(pieces[i].vEnd);
    if (a !== b) parent.set(a, b);
  }

  // face-graph edges: non-duplicate crossed pieces of usable length
  const eIdx = [];
  const polyOf = new Map();                 // piece index → tessellated polyline
  for (const i of crossed) {
    if (duplicate[i]) continue;
    const poly = tessellateContour({ start: pieces[i].from, segments: pieces[i].segs }, WINDING_SEGS);
    if (polyLen(poly) < MIN_PIECE_LEN) continue;          // degenerate: separates nothing
    polyOf.set(i, poly);
    eIdx.push(i);
  }
  const E = eIdx.length;

  if (E > 0) {
    const P = (h) => pieces[eIdx[h >> 1]];
    const tailOf = (h) => ((h & 1) ? P(h).vEnd : P(h).vStart);
    const headOf = (h) => ((h & 1) ? P(h).vStart : P(h).vEnd);
    const outVec = (h) => {
      const p = P(h);
      if (h & 1) { const t = pieceTanB(p); return [-t[0], -t[1]]; }
      return pieceTanA(p);
    };
    const outK = (h) => { const p = P(h); return (h & 1) ? -(p.kB ?? 0) : (p.kA ?? 0); };

    // Departures per vertex, sorted CCW by tangent angle with a CURVATURE tie-break:
    // tangential contact is the NORMAL case at an offset pinch (a round join meets the
    // edge it is tangent to), so two departures routinely differ only by float noise in
    // angle while differing decisively in curvature — the harder-left-curving edge is
    // infinitesimally more CCW. Noise-scale angle differences must not decide the order,
    // so near-equal angles are grouped into runs and each run is ordered by curvature.
    // The angular origin is first rotated into the vertex's largest empty gap so no run
    // straddles the list seam (a pair at ±π is circularly adjacent, but a plain sort
    // would strand its members at opposite ends).
    const ANGLE_EPS = 1e-7;
    const dep = new Map();
    for (let h = 0; h < 2 * E; h++) {
      const v = tailOf(h);
      if (!dep.has(v)) dep.set(v, []);
      dep.get(v).push(h);
    }
    const pos = new Map();
    for (const list of dep.values()) {
      const items = list.map((h) => { const [x, y] = outVec(h); return { h, th: Math.atan2(y, x), k: outK(h) }; });
      items.sort((a, b) => a.th - b.th);
      let gapAt = 0, gapSize = -1;
      for (let i = 0; i < items.length; i++) {
        const a = items[i].th;
        const b = i + 1 < items.length ? items[i + 1].th : items[0].th + 2 * Math.PI;
        if (b - a > gapSize) { gapSize = b - a; gapAt = i; }
      }
      const phi = items[gapAt].th + gapSize / 2;
      const key = (th) => { let d = (th - phi) % (2 * Math.PI); if (d < 0) d += 2 * Math.PI; return d; };
      items.sort((a, b) => key(a.th) - key(b.th));
      for (let i = 0; i < items.length; ) {
        let j = i + 1;
        while (j < items.length && key(items[j].th) - key(items[j - 1].th) < ANGLE_EPS) j++;
        if (j - i > 1) {
          const run = items.slice(i, j).sort((a, b) => a.k - b.k);
          for (let t = i; t < j; t++) items[t] = run[t - i];
        }
        i = j;
      }
      list.length = 0;
      items.forEach(({ h }, i) => { list.push(h); pos.set(h, i); });
    }
    // next(h): the rotational predecessor of twin(h) in CCW departure order at head(h) —
    // i.e. the first departure clockwise from the reversed arrival direction. A bijection
    // by construction, so orbits are simple cycles.
    const next = (h) => {
      const list = dep.get(headOf(h));
      const m = list.length;
      return list[(pos.get(h ^ 1) - 1 + m) % m];
    };

    // face orbits (face on the LEFT of each half-edge)
    const faceOf = new Int32Array(2 * E).fill(-1);
    let F = 0;
    for (let h0 = 0; h0 < 2 * E; h0++) {
      if (faceOf[h0] !== -1) continue;
      let h = h0;
      while (faceOf[h] === -1) { faceOf[h] = F; h = next(h); }
      if (faceOf[h] !== F) throw new Error(CHAIN_INCOMPLETE_MESSAGE);   // non-bijective walk: corrupt input
      F++;
    }

    // group edges (and every crossed piece's ring) by component
    const comps = new Map();                // root → { edges: [edge ids], rings: Set }
    const compAt = (v) => {
      const c = find(v);
      if (!comps.has(c)) comps.set(c, { edges: [], rings: new Set() });
      return comps.get(c);
    };
    for (let e = 0; e < E; e++) compAt(pieces[eIdx[e]].vStart).edges.push(e);
    for (const i of crossed) compAt(pieces[i].vStart).rings.add(pieces[i].ring);

    const wFace = new Map();
    for (const { edges, rings: compRings } of comps.values()) {
      if (edges.length === 0) continue;     // only degenerate/duplicate pieces here: nothing to label
      // ── anchor: the face below the component's bottom-most tessellated point ──
      const compPolys = edges.map((e) => polyOf.get(eIdx[e]));
      const bs = bottomSample(compPolys);
      const e0 = edges[bs.e], poly = compPolys[bs.e];
      let anchor;
      if (bs.k > 0 && bs.k < poly.length - 1) {
        // interior sample: the travel direction there is horizontal (an interior global
        // minimum), so its x-component says which side faces down. Travel in −x ⇒ the
        // forward half-edge's LEFT faces down ⇒ its face is the exterior.
        let dx = poly[bs.k + 1][0] - poly[bs.k - 1][0];
        if (Math.abs(dx) < 1e-12) dx = poly[bs.k + 1][0] - poly[bs.k][0];
        if (Math.abs(dx) < 1e-12) dx = poly[bs.k][0] - poly[bs.k - 1][0];
        anchor = dx < 0 ? 2 * e0 : 2 * e0 + 1;
      } else {
        // the bottom is a pool vertex: every departure leaves upward (angles in [0, π] up
        // to noise), and the region below the vertex is the LEFT face of the departure
        // with the LARGEST such angle (the up-left-most edge of the wedge fan). Only the
        // horizontal-LEFT side may wrap (an angle a hair below −π/2 cannot occur at a
        // global minimum, so −π/2 is a safe cut): wrapping anything a hair below ZERO —
        // ordinary tangent noise on a horizontal-right departure — would promote it to
        // ~2π and hand the anchor to the wrong face, silently vanishing the component.
        const v = bs.k === 0 ? pieces[eIdx[e0]].vStart : pieces[eIdx[e0]].vEnd;
        let bestH = null, bestA = -Infinity;
        for (const h of dep.get(v)) {
          const [x, y] = outVec(h);
          let a = Math.atan2(y, x);
          if (a < -Math.PI / 2) a += 2 * Math.PI;       // noise just below horizontal-LEFT only
          if (a > bestA) { bestA = a; bestH = h; }
        }
        anchor = bestH;
      }
      const others = tessRings.filter((_, r) => !compRings.has(r));
      const ambient = _windingAt([bs.x, bs.y], others);

      // ── BFS winding propagation from the anchored exterior face ──
      const faceEdges = new Map();          // face id → edge ids bordering it
      for (const e of edges) for (const f of [faceOf[2 * e], faceOf[2 * e + 1]]) {
        if (!faceEdges.has(f)) faceEdges.set(f, []);
        faceEdges.get(f).push(e);
      }
      const setW = (f, w) => {
        if (wFace.has(f)) {
          if (wFace.get(f) !== w) throw new Error(CHAIN_INCOMPLETE_MESSAGE);
          return false;
        }
        wFace.set(f, w);
        return true;
      };
      setW(faceOf[anchor], ambient);
      const queue = [faceOf[anchor]];
      while (queue.length) {
        const f = queue.shift();
        const wf = wFace.get(f);
        for (const e of faceEdges.get(f)) {
          const m = mult[eIdx[e]];
          const fL = faceOf[2 * e], fR = faceOf[2 * e + 1];
          // crossing the edge from its left face to its right subtracts the multiplicity
          if (fL === f) { if (setW(fR, wf - m)) queue.push(fR); }
          if (fR === f) { if (setW(fL, wf + m)) queue.push(fL); }
        }
      }
      for (const e of edges) for (const f of [faceOf[2 * e], faceOf[2 * e + 1]])
        if (!wFace.has(f)) throw new Error(CHAIN_INCOMPLETE_MESSAGE);   // unreachable face: disconnected labels

      // ── classify this component's edges from their two face labels ──
      for (const e of edges) {
        const i = eIdx[e];
        const wL = wFace.get(faceOf[2 * e]), wR = wFace.get(faceOf[2 * e + 1]);
        const keep = inside(wL) !== inside(wR);
        recs[i] = { piece: pieces[i], keep, reverse: keep && !inside(wL), wLeft: wL, wRight: wR };
      }
    }

    // ── audit / override: geometric probes cross-check the combinatorial labels ──────────
    //
    // Face labels are consistent by construction but can be consistently WRONG when a
    // measure-zero degeneracy (an exact tangency between rings — the fuzz corpus constructs
    // one at delta −2) scrambles the rotational order at the contact — measured: a region
    // eroded to exact tangency with a growing hole lost its whole 28 mm² face silently, at
    // EVERY weld scale, because the mis-ordering is systematic rather than numeric. A
    // midpoint ray-cast probe is immune to that (it measures true winding far from any
    // contact) but fails at exactly the pinch vertices face labels handle — the two
    // mechanisms have complementary blind spots. So: probe only pieces LONG enough for the
    // probe to be well-conditioned, at two interior points, corroborated.
    //
    // Default (audit): a corroborated disagreement throws the same incomplete-arrangement
    // message as a BFS conflict — the fallback ladder responds. probeOverride (the ladder's
    // "probe-labels" rung): the corroborated probe value REPLACES the face label on that
    // piece (wRight stays wLeft − mult, so the coincidence invariant holds); short pieces
    // keep their face labels, and _chain's dangling-vertex throw still catches any global
    // inconsistency a mixed labeling could introduce.
    const AUDIT_MIN_LEN = auditTol === null ? Infinity : 20 * auditTol;
    for (let e = 0; e < E && auditTol !== null; e++) {
      const i = eIdx[e];
      const rec = recs[i];
      if (rec.wLeft === null) continue;
      const poly = polyOf.get(i);
      const len = polyLen(poly);
      if (len < AUDIT_MIN_LEN) continue;                 // short pieces: faces are authoritative
      // Probe BOTH sides at two interior points. A probe pair is trustworthy only when it
      // satisfies the arrangement's own jump identity (wLeft − wRight = net multiplicity):
      // a pair that violates it is straddling OTHER geometry — a surviving sliver thinner
      // than the probe offset reads the far side on both probes (measured: a 0.006 mm²
      // sliver region under a 1e-2 probe) — and says nothing about this piece's labels.
      const eps = Math.min(2 * auditTol, len / 8);
      const probes = [];
      for (const f of [1 / 3, 2 / 3]) {
        const k = Math.max(1, Math.min(poly.length - 1, Math.round(f * (poly.length - 1))));
        const mid = [(poly[k - 1][0] + poly[k][0]) / 2, (poly[k - 1][1] + poly[k][1]) / 2];
        const { point: onRing, dir } = projectToRing(mid, tessRings[pieces[i].ring]);
        const wL = _windingAt([onRing[0] - dir[1] * eps, onRing[1] + dir[0] * eps], tessRings);
        const wR = _windingAt([onRing[0] + dir[1] * eps, onRing[1] - dir[0] * eps], tessRings);
        if (wL - wR === mult[i]) probes.push(wL);
      }
      if (probes.length < 2 || probes[0] !== probes[1] || probes[0] === rec.wLeft) continue;
      if (!probeOverride) throw new Error(CHAIN_INCOMPLETE_MESSAGE);
      const wL = probes[0], wR = wL - mult[i];
      const keep = inside(wL) !== inside(wR);
      recs[i] = { piece: pieces[i], keep, reverse: keep && !inside(wL), wLeft: wL, wRight: wR };
    }
  }

  // ── uncrossed whole rings: interior = ambient ± 1 directly ──
  // Crossing any directed ring left→right of travel subtracts 1, so wLeft = ambient + 1
  // for a CCW ring (interior on the left) and wLeft = ambient for a CW one — one rule, no
  // per-orientation casing. Ambient is cast at the ring's own bottom point against every
  // OTHER ring (its winding is constant along a curve that crosses nothing — same
  // continuity argument as the component ambient above).
  pieces.forEach((p, i) => {
    if (p.vStart !== null || duplicate[i] || p.segs.length === 0) return;
    const own = tessRings[p.ring];
    const ccw = ringArea(own) >= 0;
    const bs = bottomSample([own]);
    const ambient = _windingAt([bs.x, bs.y], tessRings.filter((_, r) => r !== p.ring));
    const wL = ambient + (ccw ? 1 : 0);
    const wR = wL - 1;
    const keep = inside(wL) !== inside(wR);
    recs[i] = { piece: p, keep, reverse: keep && !inside(wL), wLeft: wL, wRight: wR };
  });

  return debug ? recs : recs.map(({ piece, keep, reverse }) => ({ piece, keep, reverse }));
}

const reversePieceSegs = (piece) => {
  // reverse a piece's segment run, mirroring reverseContour's per-kind handling; the
  // stored endpoint tangents/curvatures swap ends and flip sign (reversed traversal keeps
  // the geometric circle but exchanges left and right)
  const pts = [piece.from, ...piece.segs.map((s) => s.to)];
  const segs = [];
  for (let i = piece.segs.length - 1; i >= 0; i--) {
    const s = piece.segs[i];
    const m = { to: [pts[i][0], pts[i][1]] };
    if (s.via) m.via = [s.via[0], s.via[1]];
    if (s.c1) { m.c1 = [s.c2[0], s.c2[1]]; m.c2 = [s.c1[0], s.c1[1]]; }
    segs.push(m);
  }
  return { from: pts[pts.length - 1], segs, vStart: piece.vEnd, vEnd: piece.vStart,
    tanA: piece.tanB ? [-piece.tanB[0], -piece.tanB[1]] : null, kA: -(piece.kB ?? 0),
    tanB: piece.tanA ? [-piece.tanA[0], -piece.tanA[1]] : null, kB: -(piece.kA ?? 0) };
};

// Direction a piece LEAVES its start vertex / ARRIVES at its end vertex: the exact
// source-curve tangents _splitRings stored (see its comment — well-conditioned at any
// piece length), falling back to segTangent on the trimmed run for hand-built pieces.
const dirOut = (p) => { const [x, y] = pieceTanA(p); return Math.atan2(y, x); };
const dirIn = (p) => { const [x, y] = pieceTanB(p); return Math.atan2(y, x); };

// Join kept pieces end-to-end by SHARED POOL VERTEX identity — never coordinate
// comparison, which is what makes this exact. A junction with several outgoing pieces
// (a pinch point) takes the LEFTMOST turn: the smallest positive rotation from the
// reversed inbound direction, i.e. the most counter-clockwise turn relative to the
// direction of travel — the standard planar-arrangement rule for tracing an outer
// boundary consistently, and the same rule _classify's face orbits use. With a
// face-consistent keep-set a dead-end vertex is impossible (kept edges are complete
// boundaries of face unions), so the throws below are defense in depth against corrupt
// hand-built input, not a live failure mode. A literal U-turn (straight back the way we
// arrived) rotates by exactly 0, the minimum possible, so it is the FIRST-preferred
// candidate — only actually taken when it's the sole outgoing option (a degree-1
// vertex), the standard DCEL `next = twin` behavior.
export function _chain(classified, pool) {
  const kept = classified.filter((c) => c.keep)
    .map((c) => (c.reverse ? reversePieceSegs(c.piece)
                           : { from: c.piece.from, segs: c.piece.segs, vStart: c.piece.vStart,
                               vEnd: c.piece.vEnd, tanA: c.piece.tanA, kA: c.piece.kA,
                               tanB: c.piece.tanB, kB: c.piece.kB }));
  const closed = kept.filter((p) => p.vStart === null);      // uncrossed whole rings
  const open = kept.filter((p) => p.vStart !== null);
  const out = closed.map((p) => ({ start: [p.from[0], p.from[1]], segs: p.segs }));

  const outgoing = new Map();
  open.forEach((p, i) => { if (!outgoing.has(p.vStart)) outgoing.set(p.vStart, []); outgoing.get(p.vStart).push(i); });
  const used = new Array(open.length).fill(false);

  for (let s = 0; s < open.length; s++) {
    if (used[s]) continue;
    const startV = open[s].vStart;
    let cur = s, guard = 0;
    const chainSegs = [];
    // The pool vertex, not the piece's own `from` — identical by the _splitRings snap
    // invariant, but this is the canonical identity, and it's what a hand-built fixture
    // (as in the test suite) is on the hook to keep consistent, not this function.
    const startPt = [pool[startV][0], pool[startV][1]];
    for (;;) {
      if (guard++ > open.length + 1) throw new Error(CHAIN_INCOMPLETE_MESSAGE);
      used[cur] = true;
      chainSegs.push(...open[cur].segs);
      const at = open[cur].vEnd;
      if (at === startV) break;
      const cands = (outgoing.get(at) ?? []).filter((i) => !used[i]);
      if (cands.length === 0) throw new Error(CHAIN_INCOMPLETE_MESSAGE);
      const inDir = dirIn(open[cur]);
      // leftmost turn: smallest positive rotation from the reversed inbound direction.
      // Ties within angle noise go to the harder-left-curving candidate — the same
      // second-order convention the face orbits use — so successor choice at a TANGENTIAL
      // junction (the normal case at an offset pinch: a round join meets the edge it is
      // tangent to) is decided by geometry, not by float noise in the tangent angle.
      const turn = (x) => { let a = inDir + Math.PI - dirOut(open[x]); a %= 2 * Math.PI; return a < 0 ? a + 2 * Math.PI : a; };
      cur = cands.reduce((best, i) => {
        const d = turn(i) - turn(best);
        if (Math.abs(d) > 1e-7) return d < 0 ? i : best;
        return (open[i].kA ?? 0) > (open[best].kA ?? 0) ? i : best;
      }, cands[0]);
    }
    out.push({ start: startPt, segs: chainSegs });
  }

  if (used.some((u) => !u)) throw new Error(CHAIN_INCOMPLETE_MESSAGE);
  return out.map(({ start, segs }) => {
    const last = segs[segs.length - 1].to;
    if (Math.hypot(last[0] - start[0], last[1] - start[1]) <= 1e-9) {
      // copy before mutating: `segs` here can be a kept piece's OWN segs array (the
      // uncrossed-whole-ring path above assigns `segs: p.segs` with no copy), so writing
      // into segs[last] in place would mutate the caller's input piece.
      const closedSegs = segs.slice(0, -1).concat([{ ...segs[segs.length - 1], to: [start[0], start[1]] }]);
      return { start, segments: closedSegs };
    }
    return { start, segments: [...segs, { to: [start[0], start[1]] }] };
  });
}

// Resolve a raw offset region list into the POSITIVE winding region it denotes (w >= 1;
// see the module header). This is contour-offset.js's cleanup path.
//
// `clusterTol` is _mergeCrossings' "these crossings are one vertex" radius, CLUSTER_TOL by
// default. It is an option only so the caller's fallback ladder can RETRY a failed
// arrangement more coarsely (see contour-offset.js); nothing should raise it as a matter of
// course, because every crossing it merges moves the emitted boundary by up to that radius.
// `audit` (default on) runs the probe cross-check in _classify; the fallback ladder's
// rungs disable it — their geometry is deliberately welded/snapped, where weld-local
// bounded label error is the documented cost of rescue, not a defect to throw on.
// `probeOverride` is the ladder's "probe-labels" rung: corroborated probe values replace
// disagreeing face labels on long pieces instead of throwing (see _classify).
export function resolveOffsetWinding(rawRegions, { clusterTol = CLUSTER_TOL, audit = true, probeOverride = false } = {}) {
  const rings = [];
  for (const rg of rawRegions) { rings.push(rg.outer); for (const h of rg.holes) rings.push(h); }
  if (rings.length === 0) return [];

  const merged = _mergeCrossings(ringCrossings(rings), clusterTol);
  const pieces = _splitRings(rings, merged);
  const tessRings = rings.map((r) => tessellateContour(r, WINDING_SEGS));
  // The rule this module implements (module header) is POSITIVE winding, w >= 1 —
  // Clipper2's FillRule::Positive. A face with winding <= 0 is never offset material:
  // winding 0 is plainly outside, and a NEGATIVE face is always collapsed material (a
  // lone hole with no covering outer, holes that grew into and past each other, or a raw
  // offset that shrank past zero and inverted), never real material to reflect back into
  // existence. _classify stays a general classifier parameterized by the fill rule; under
  // this one `reverse` is provably unreachable (mult >= 0, so wRight <= wLeft always).
  const classified = _classify(pieces, tessRings, { inside: (w) => w >= 1,
    auditTol: audit || probeOverride ? clusterTol : null, probeOverride });
  const contours = _chain(classified, merged.pool);

  // drop numerically empty loops, then nest by containment and restore the storage
  // winding invariant (outer CCW, holes CW) from each contour's own area sign. Under the
  // positive-winding rule above, `assembleRegions` never actually needs its own safety net
  // (a hole with no containing outer, silently dropped there) — every surviving contour here
  // already bounds real w=1 material — but the net stays in place as ordinary defense in depth.
  const live = contours.filter((c) => Math.abs(ringArea(tessellateContour(c, WINDING_SEGS))) > 1e-9);
  if (live.length === 0) return [];
  const tessOf = new Map(live.map((c) => [c, tessellateContour(c, WINDING_SEGS)]));
  const regions = assembleRegions(live.map((c) => tessOf.get(c)));
  const byRing = new Map(live.map((c) => [tessOf.get(c), c]));
  return regions.map((rg) => {
    const outer = byRing.get(rg.outer);
    const orient = (c, wantCCW) => {
      const isCCW = ringArea(tessOf.get(c)) >= 0;
      return closeContourGap(isCCW === wantCCW ? c : reverseContour(c));
    };
    return { outer: orient(outer, true), holes: rg.holes.map((h) => orient(byRing.get(h), false)) };
  });
}
