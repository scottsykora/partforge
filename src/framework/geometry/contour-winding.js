// Winding resolution for offset outlines — the cleanup path of contour-offset.js.
//
// The correct result of an offset is the POSITIVE WINDING REGION (w >= 1) of the raw
// offset outline — the same fill rule Clipper2's ClipperOffset uses (FillRule::Positive),
// the oracle this feature is measured against. Self-overlap loops, collapsed holes,
// unmerged seams and pinched necks are all the same failure: approximating that rule with
// booleans instead of computing it. This module computes it: find crossings (paper's curve
// clipper), split each ring there, keep a piece iff its two sides straddle the fill
// boundary (one side filled, the other not), chain the survivors, and emit the ORIGINAL
// curves trimmed at the crossing parameters. `_classify` itself stays a general classifier
// parameterized by a fill rule (see its own comment); the positive rule is chosen by
// `resolveOffsetWinding`, this module's entry point. Spans that several rings run along at
// once — collinear edges, arcs sharing a circle — are handled by `_coincidence` below.
//
// Pure leaf in the worker graph: DOM-free, three-free, node:-free.
import { ringCrossings } from "./paper-bridge.js";
import { trimSegment, segTangent } from "./contour-ops.js";
import { tessellateContour, closeContourGap, reverseContour } from "./profile.js";
import { assembleRegions, ringArea } from "./shape2d-regions.js";

// Crossings closer than this are one vertex. Derived: it must exceed OFFSET_TOL (1e-3 mm,
// the cubic-offset approximation error) or two crossings that are genuinely the same point
// on an approximated curve stay split; and it must stay far below the thinnest feature the
// engine is expected to keep. 5x OFFSET_TOL sits an order below a 0.05 mm feature.
export const CLUSTER_TOL = 5e-3;

// Tessellation density for the winding-probe geometry: the raw offset outline sampled
// for _windingAt, and each piece sampled by pieceSamples to find interior locators.
// Declared here (not near _classify) because pieceSamples needs it earlier in this file.
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

// Split each ring at its merged crossings into pieces. Crossings are sorted along the
// ring by (seg, t); consecutive pairs bound a piece, wrapping at the end. Each piece is
// materialized immediately as trimmed IR segments via trimSegment, so provenance never
// has to be carried further — a trimmed arc is still an arc.
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
                    segs: contour.segments.map((s) => ({ ...s })), vStart: null, vEnd: null });
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
      // for winding classification and re-chaining, just not bit-for-bit.
      segs[segs.length - 1].to = [merged.pool[b.vertex][0], merged.pool[b.vertex][1]];  // snap to the shared vertex
      pieces.push({ ring: r, from: [from[0], from[1]], segs, vStart: a.vertex, vEnd: b.vertex });
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
// What such input breaks is the wRight = wLeft - 1 derivation in _classify. That identity
// says "crossing a directed edge changes the winding by exactly 1", which is false where k
// directed edges lie on top of each other: the winding jumps by their NET count. Two
// same-direction copies (the sharp-corner case) give a doubled boundary — w goes 0 -> 2
// across it, so the true wRight is wLeft - 2 and the old derivation read wRight = 1, i.e.
// "material on both sides", dropping a piece the offset boundary needs. Opposite-direction
// copies CANCEL: net 0, wRight === wLeft, and the span really is interior to the fill
// (an eroded hole that grew onto its own outer's edge does this).
//
// So this reports, per piece, the net multiplicity in that piece's OWN direction, plus a
// `duplicate` flag for the copies that are not the group's representative. The winding
// PROBE is left alone: _windingAt ray-casts every ring, which already counts a doubled edge
// twice and so returns the true winding of the face it lands in. Only the arithmetic
// derivation of the far side was wrong — measurement stays, bookkeeping is fixed. Keeping
// exactly one representative (rather than excluding duplicates from the ray-cast set) is
// what the emitted boundary needs anyway: chaining must traverse the shared span once.

// Interior sample points shared by coincidence matching and adaptive winding probes. Taken
// at symmetric fractions of arc length, so a piece traversed the other way samples the same
// points in reverse order and coincidence can compare both orders. Probe callers additionally
// move a sample off an exact contour vertex, where the incident tangent would be ambiguous.
const INTERIOR_SAMPLES = 5;

function pieceSamples(piece, { avoidVertices = false } = {}) {
  const poly = tessellateContour({ start: piece.from, segments: piece.segs }, WINDING_SEGS);
  const cum = [0];
  for (let i = 1; i < poly.length; i++)
    cum.push(cum[i - 1] + Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]));
  const total = cum[cum.length - 1];
  const pts = [];
  for (let k = 1; k <= INTERIOR_SAMPLES; k++) {
    const target = (total * k) / (INTERIOR_SAMPLES + 1);
    let i = 1;
    while (i < cum.length - 1 && cum[i] < target) i++;
    const span = cum[i] - cum[i - 1];
    let f = span > 1e-15 ? (target - cum[i - 1]) / span : 0;
    // A probe locator exactly on a contour vertex has two valid incident tangents. Which
    // edge projectToRing wins is then an iteration-order accident, and offsetting along that
    // edge's normal can leave the polygon immediately (a square's 50%-of-perimeter point is
    // the simplest reproduction). Move only probe locators to the containing edge's interior.
    // Coincidence matching keeps the exact symmetric fractions it historically used.
    if (avoidVertices && (f <= 1e-9 || f >= 1 - 1e-9)) f = 0.5;
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
// for; dropped without probing).
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
        // face. Left for _classify's straddle test to drop (mult 0 → wRight === wLeft)
        // rather than flagged as a duplicate — cancellation is a winding fact, not redundancy.
        for (const g of group) mult[g.i] = 0;
        continue;
      }
      const repSign = Math.sign(net);
      const rep = group.find((g) => g.sign === repSign).i;
      for (const g of group) { duplicate[g.i] = g.i !== rep; mult[g.i] = g.i === rep ? Math.abs(net) : 0; }
    }
  }
  return { mult, duplicate };
}

// Probe offset for the winding query. PROBE_EPS has a CEILING and no floor. The ceiling is
// set by NEIGHBOURING geometry: too large a probe risks crossing into an unrelated nearby
// piece or feature. A smaller probe is never the risk: the probe origin is anchored on
// tessRings[piece.ring] itself (via projectToRing), the same UNSNAPPED polyline _windingAt
// queries below, so the endpoint snap in _splitRings cannot misplace it — `eps` legitimately
// shrinks to as little as 1e-9 for a short piece (see the length-proportional scaling in
// _classify) and still classifies correctly. CLUSTER_TOL*2 sits comfortably below any
// feature worth keeping.
export const PROBE_EPS = CLUSTER_TOL * 2;

// Below this length a piece carries no reliable direction to probe along — the endpoint
// snap in _splitRings can collapse a short trimmed run to (near-)zero length without
// tripping the `segs.length === 0` guard there (distinct vertices, near-identical pool
// positions). Probing it would place the origin ON the boundary itself, and the result
// would be whichever side the half-open ray rule happens to pick — not a measurement.
// Dropped rather than kept with an arbitrary, unverifiable orientation.
const MIN_PIECE_LEN = 1e-9;

const pointEdgeDistance = (p, a, b) => {
  const ex = b[0] - a[0], ey = b[1] - a[1];
  const L2 = ex * ex + ey * ey;
  let t = L2 > 1e-18 ? ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / L2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  return Math.hypot(p[0] - (a[0] + t * ex), p[1] - (a[1] + t * ey));
};

// One arrangement scan can answer the winding query at `p` and, when `near` is supplied,
// measure how much room the probe's boundary anchor has before it reaches any other edge.
// The projected source edge and its immediate neighbours are incident geometry, not an
// obstruction. Everything else participates, including another ring: glyph dilation brings
// formerly-disjoint contours together, so inter-ring crowding is one of the production cases
// this measurement exists to detect.
function scanArrangement(p, tessRings, near = null) {
  let w = 0;
  let clearance = Infinity;
  for (let r = 0; r < tessRings.length; r++) {
    const ring = tessRings[r];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const side = (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]);
      if (a[1] <= p[1]) { if (b[1] > p[1] && side > 0) w++; }
      else if (b[1] <= p[1] && side < 0) w--;

      if (near) {
        const n = ring.length;
        const delta = r === near.ring ? (i - near.edge + n) % n : -1;
        const incident = r === near.ring && (delta === 0 || delta === 1 || delta === n - 1);
        if (!incident) clearance = Math.min(clearance, pointEdgeDistance(near.point, a, b));
      }
    }
  }
  return { w, clearance };
}

// Signed crossing count of a +x ray from p against tessellated rings. Standard
// half-open rule (a[1] <= p[1] < b[1]) so a vertex is counted exactly once.
export function _windingAt(p, tessRings) { return scanArrangement(p, tessRings).w; }

// Project p onto the nearest edge of `ring` — a tessellated point ring — and return that
// point together with the edge's unit direction. This is what anchors a winding probe
// exactly on the polyline `_windingAt` queries, by construction, at any radius: the
// projected point IS a point on that polyline (up to floating-point rounding), so offsetting
// it by PROBE_EPS along the edge normal cannot straddle the wrong side of a tessellation gap
// the way offsetting an independently-sampled locator (pieceSamples') can. Also gives the
// left/right sense from the SAME edge the origin came from, so origin and normal agree.
// This is load-bearing on arcs: a short trimmed piece is tessellated more finely than the
// source ring segment it came from, and the ring chord's sagitta (~1.2e-3*r here) already
// exceeds PROBE_EPS above r≈8.3 mm.
//
// KNOWN, BOUNDED imprecision: this scans the WHOLE ring for the nearest edge, so on a thin
// crescent (two ring branches running close and antiparallel) it can legitimately latch onto
// the wrong branch — measured 176/840 pieces on a thin-crescent fixture. It causes zero
// misclassifications there because origin and normal are read off the SAME (wrong) edge:
// picking the antiparallel branch flips the edge direction, which flips `dir`, which flips
// which side of the probed point counts as "left" — the two flips cancel and `_classify`'s
// wLeft/wRight bookkeeping comes out the same as if the correct branch had been picked.
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
      best = { point, dir: [ex / L, ey / L], edge: i, d2 };
    }
  }
  return best;
}

// Keep a piece iff its two sides straddle the boundary of the caller's FILL RULE — the
// `inside` predicate, which maps a winding number to "is this face filled". The default is
// nonzero fill (w !== 0), under which this reports both the w=0/w=1 boundary (interior on
// the left, kept as-is) and the w=0/w=-1 boundary (interior on the right, kept REVERSED so
// the emitted piece is canonically oriented interior-on-left). `resolveOffsetWinding` passes
// the POSITIVE rule (w >= 1) instead — see its own comment for why offset output wants that
// one — and under it `reverse` can never be true, since the right side's winding is always
// the lower of the two.
//
// Crossing a directed edge changes the winding number by exactly ±1, so ONE probe
// suffices: with the interior of a CCW ring on its left, wLeft = wRight + 1 identically.
// A second probe is not merely redundant but harmful — two independent probes can
// disagree (both reading "inside") when either lands badly, and there is no way to tell
// which is wrong. Deriving the far side arithmetically makes the two consistent by
// construction. The one exception is a span several rings run along at once, where the jump
// is the NET number of coincident directed edges rather than 1 — `_coincidence` above
// measures that, and it is the `mult` subtracted below; every other piece has mult 1 and the
// classic identity back. (With the default nonzero rule and mult 1 the keep test is exactly
// the historical wLeft ∈ {0, 1}, and reverse exactly wLeft === 0.)
//
// Every candidate probe origin is a pieceSamples point PROJECTED onto
// tessRings[piece.ring] (projectToRing) — the same polyline _windingAt below queries — not
// the true curve the locator approximates; see projectToRing for why that is load-bearing.
//
// The ±mult invariant above (wLeft = wRight + mult) is a property of an actual probe: it
// holds for every record that reaches the probe below. The early-return branches never probe
// at all — the piece is dropped for having no reliable direction to probe along, or for being
// a redundant copy of a coincident piece already represented — so their debug record reports
// wLeft: null, wRight: null rather than fabricating a pair that would satisfy the arithmetic
// without a probe behind it. Callers that assert the invariant in debug mode (see
// test/contour-winding.test.js) must therefore do so only over records with a non-null wLeft,
// not over every record `_classify` returns.
export function _classify(pieces, tessRings, { debug = false, inside = (w) => w !== 0 } = {}) {
  const { mult, duplicate } = _coincidence(pieces);
  return pieces.map((piece, i) => {
    if (duplicate[i]) {
      // A coincident copy whose group representative carries the span (see _coincidence):
      // emitting it too would trace the shared span more than once.
      const rec = { piece, keep: false, reverse: false };
      return debug ? { ...rec, wLeft: null, wRight: null } : rec;
    }
    if (piece.segs.length === 0) {
      // Unreachable from _splitRings (every emitted piece has >=1 seg), but _classify is
      // exported and a hand-built `segs: []` piece would otherwise throw inside pieceSamples
      // (poly.length < 2) before MIN_PIECE_LEN gets a chance to reject it. Same outcome as
      // the zero-length case below: drop it, don't guess an orientation.
      const rec = { piece, keep: false, reverse: false };
      return debug ? { ...rec, wLeft: null, wRight: null } : rec;
    }
    const { pts, len } = pieceSamples(piece, { avoidVertices: true });
    if (len < MIN_PIECE_LEN) {
      const rec = { piece, keep: false, reverse: false };
      return debug ? { ...rec, wLeft: null, wRight: null } : rec;
    }
    // Start at the midpoint, preserving the old clean path. Its arrangement scan measures
    // winding and local clearance together; if the full probe fits with a 4x safety margin,
    // no other sample can improve the classification and the historical one-scan cost stays.
    // At a contested midpoint, examine the other fixed arc-length samples and choose the one
    // with greatest clearance. Selection is geometry-only — never based on keep, chainability,
    // or an oracle answer — so a buried/interior edge cannot shop around for a winding it likes.
    const maxEps = Math.min(PROBE_EPS, Math.max(len / 4, 1e-9));
    const candidate = (point) => {
      const projected = projectToRing(point, tessRings[piece.ring]);
      const left = [projected.point[0] - projected.dir[1] * maxEps,
                    projected.point[1] + projected.dir[0] * maxEps];
      const scan = scanArrangement(left, tessRings,
        { point: projected.point, ring: piece.ring, edge: projected.edge });
      return { ...projected, wLeft: scan.w, clearance: scan.clearance };
    };
    const mid = Math.floor(pts.length / 2);
    let probe = candidate(pts[mid]);
    if (probe.clearance < maxEps * 4) {
      for (let j = 0; j < pts.length; j++) {
        if (j === mid) continue;
        const next = candidate(pts[j]);
        if (next.clearance > probe.clearance) probe = next;
      }
    }
    const eps = Math.min(maxEps, Math.max(probe.clearance / 4, 1e-9));
    let wLeft = probe.wLeft;
    if (eps !== maxEps) {
      const left = [probe.point[0] - probe.dir[1] * eps, probe.point[1] + probe.dir[0] * eps];
      wLeft = _windingAt(left, tessRings);
    }
    const wRight = wLeft - mult[i];
    const inL = inside(wLeft), inR = inside(wRight);
    const keep = inL !== inR;
    const rec = { piece, keep, reverse: keep && !inL };
    return debug ? { ...rec, wLeft, wRight } : rec;
  });
}

const reversePieceSegs = (piece) => {
  // reverse a piece's segment run, mirroring reverseContour's per-kind handling
  const pts = [piece.from, ...piece.segs.map((s) => s.to)];
  const segs = [];
  for (let i = piece.segs.length - 1; i >= 0; i--) {
    const s = piece.segs[i];
    const m = { to: [pts[i][0], pts[i][1]] };
    if (s.via) m.via = [s.via[0], s.via[1]];
    if (s.c1) { m.c1 = [s.c2[0], s.c2[1]]; m.c2 = [s.c1[0], s.c1[1]]; }
    segs.push(m);
  }
  return { from: pts[pts.length - 1], segs, vStart: piece.vEnd, vEnd: piece.vStart };
};

// Direction a piece LEAVES its start vertex: the EXACT tangent at that end, via
// contour-ops.js's segTangent — not a hand-rolled approximation. Round 1 used the raw
// chord; a from->c1/from->via shortcut is exact for cubics (modulo the c1===from
// degenerate case) but still biased for arcs — `via` is a THROUGH point near mid-sweep,
// not a control point, so from->via is systematically off by about sweep/4 (worse the
// larger the sweep, and this engine's round joins emit sweeps up to ~180deg at a spike;
// see contour-offset.js). segTangent recovers the arc's true center and returns the
// tangent perpendicular to the radius, exact at both ends, and also resolves the
// degenerate cubic correctly (c1===from → tangent comes from c2, not the chord).
const dirOut = (p) => { const [x, y] = segTangent(p.from, p.segs[0], true); return Math.atan2(y, x); };

// Direction a piece ARRIVES at its end vertex: the exact tangent on the LAST segment,
// computed from where that segment itself begins (segTangent needs a segment's own
// `from` to recover an arc's center — not some earlier point in the piece). Mirrors
// dirOut's reasoning at the other end.
const dirIn = (p) => {
  const pts = [p.from, ...p.segs.map((s) => s.to)];
  const lastFrom = pts[pts.length - 2];
  const [x, y] = segTangent(lastFrom, p.segs[p.segs.length - 1], false);
  return Math.atan2(y, x);
};

// The literal message every unclosable-arrangement site in _chain throws, and the string
// ERROR-PATTERNS.md § shape2d-offset-winding-chain-incomplete documents. Exported so
// contour-offset.js's fallback ladder can recognise THIS failure — the one it has a
// documented, measured degradation for — without pattern-matching on message text at a
// distance, and without swallowing an unrelated throw from the same call.
export const CHAIN_INCOMPLETE_MESSAGE =
  "contour-winding: could not chain offset boundary (incomplete intersection set)";

// Join kept pieces end-to-end by SHARED POOL VERTEX identity — never coordinate
// comparison, which is what makes this exact. A junction with several outgoing pieces
// (a pinch point) takes the LEFTMOST turn: the smallest positive rotation from the
// reversed inbound direction, i.e. the most counter-clockwise turn relative to the
// direction of travel — the standard planar-arrangement rule for tracing an outer
// boundary consistently. A literal U-turn (straight back the way we arrived) rotates by
// exactly 0, the minimum possible, so it is the FIRST-preferred candidate, not a last
// resort — it is only actually taken when it's the sole outgoing option (a degree-1
// vertex), which is the standard DCEL `next = twin` behavior.
export function _chain(classified, pool) {
  const kept = classified.filter((c) => c.keep)
    .map((c) => (c.reverse ? reversePieceSegs(c.piece) : { from: c.piece.from, segs: c.piece.segs,
                                                           vStart: c.piece.vStart, vEnd: c.piece.vEnd }));
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
      // leftmost turn: smallest positive rotation from the reversed inbound direction
      cur = cands.reduce((best, i) => {
        const turn = (x) => { let a = inDir + Math.PI - dirOut(open[x]); a %= 2 * Math.PI; return a < 0 ? a + 2 * Math.PI : a; };
        return turn(i) < turn(best) ? i : best;
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
export function resolveOffsetWinding(rawRegions, { clusterTol = CLUSTER_TOL } = {}) {
  const rings = [];
  for (const rg of rawRegions) { rings.push(rg.outer); for (const h of rg.holes) rings.push(h); }
  if (rings.length === 0) return [];

  const merged = _mergeCrossings(ringCrossings(rings), clusterTol);
  const pieces = _splitRings(rings, merged);
  const tessRings = rings.map((r) => tessellateContour(r, WINDING_SEGS));
  // _classify is a general classifier parameterized by a fill rule (see its own comment); the
  // rule this module implements (module header) is POSITIVE winding, w >= 1 — Clipper2's
  // FillRule::Positive. A face with winding <= 0 is never offset material: winding 0 is
  // plainly outside, and a NEGATIVE face is always collapsed material (a lone hole with no
  // covering outer, holes that grew into and past each other, or a raw offset that shrank past
  // zero and inverted), never real material to reflect back into existence.
  //
  // Passing the rule down is not the same as filtering `_classify`'s nonzero answer afterwards
  // (what this did before collinear overlaps were handled). The two agree wherever exactly one
  // directed edge lies on the probed span — there `wRight = wLeft - 1`, so "straddles zero"
  // and "straddles one" both reduce to wLeft === 1, and a nonzero-kept reverse piece is
  // exactly a w=0/w=-1 boundary to drop. They part company on a span several rings share,
  // where the winding jumps by more than 1: a doubled boundary between a w=1 and a w=-1 face
  // is interior under nonzero (both sides filled) but a genuine edge of the positive region,
  // and filtering afterwards would have dropped it — leaving the boundary unchainable.
  const classified = _classify(pieces, tessRings, { inside: (w) => w >= 1 });
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
