// Non-zero winding resolution for offset outlines — the cleanup path of contour-offset.js.
//
// The correct result of an offset is the NON-ZERO WINDING REGION of the raw offset
// outline. Self-overlap loops, collapsed holes, unmerged seams and pinched necks are all
// the same failure: approximating that rule with booleans instead of computing it. This
// module computes it: find crossings (paper's curve clipper), split each ring there, keep
// a piece iff its two sides straddle the winding boundary, chain the survivors, and emit
// the ORIGINAL curves trimmed at the crossing parameters.
//
// Pure leaf in the worker graph: DOM-free, three-free, node:-free.
import { ringCrossings } from "./paper-bridge.js";
import { trimSegment } from "./contour-ops.js";
import { tessellateContour } from "./profile.js";

// Crossings closer than this are one vertex. Derived: it must exceed OFFSET_TOL (1e-3 mm,
// the cubic-offset approximation error) or two crossings that are genuinely the same point
// on an approximated curve stay split; and it must stay far below the thinnest feature the
// engine is expected to keep. 5x OFFSET_TOL sits an order below a 0.05 mm feature.
export const CLUSTER_TOL = 5e-3;

// Tessellation density for the winding-probe geometry: the raw offset outline sampled
// for _windingAt, and the single piece sampled by pieceMid to find a point on-curve.
// Declared here (not near _classify) because pieceMid needs it in this file.
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
  for (const x of merged.crossings) byRing[x.ring].push(x);
  const pieces = [];

  rings.forEach((contour, r) => {
    const pts = ringPoints(contour);
    const xs = byRing[r].slice().sort((a, b) => (a.seg - b.seg) || (a.t - b.t));
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

// Probe offset for the winding query. The FLOOR is set by the piece's OWN geometry: the
// endpoint snap in _splitRings can displace a piece's boundary from its unsnapped curve by
// up to 2*CLUSTER_TOL (see the comment on that snap above), so the probe must clear that or
// it can land back on the wrong side of the SAME piece's own boundary. The CEILING is set
// by NEIGHBOURING geometry: too large a probe risks crossing into an unrelated nearby piece
// or feature. (A smaller probe is never the risk — a smaller probe only gets closer to the
// boundary it's already straddling correctly.) CLUSTER_TOL*2 clears the floor with headroom
// to spare below any feature worth keeping.
export const PROBE_EPS = CLUSTER_TOL * 2;

// Below this length a piece carries no reliable direction to probe along — the endpoint
// snap in _splitRings can collapse a short trimmed run to (near-)zero length without
// tripping the `segs.length === 0` guard there (distinct vertices, near-identical pool
// positions). Probing it would place the origin ON the boundary itself, and the result
// would be whichever side the half-open ray rule happens to pick — not a measurement.
// Dropped rather than kept with an arbitrary, unverifiable orientation.
const MIN_PIECE_LEN = 1e-9;

// Signed crossing count of a +x ray from p against tessellated rings. Standard
// half-open rule (a[1] <= p[1] < b[1]) so a vertex is counted exactly once.
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

// A point roughly on the piece (from the piece's OWN tessellation), plus its total length.
//
// This is only a LOCATOR, not the probe origin — it approximates the true curve to within
// this tessellation's own chord error, same as any sampled polyline. It must NOT be probed
// directly: `tessRings[piece.ring]`, the polyline `_windingAt` actually intersects, is a
// DIFFERENT, generally coarser tessellation of the same curve — the whole ring is sampled
// once at a fixed ANGULAR step (sampleArc), so a short trimmed piece here is sampled
// finely while the long ring segment it came from is a coarse chord. That gap is the
// ring's sagitta, ~1.2e-3*r at WINDING_SEGS=64, which GROWS WITH RADIUS while PROBE_EPS is
// fixed — it exceeds PROBE_EPS for any arc past r≈8.3mm, which silently flips large plain
// circles' pieces to keep:true,reverse:true. The caller (_classify) closes that gap by
// projecting this point onto tessRings[piece.ring] before offsetting — see projectToRing.
function pieceMid(piece) {
  const poly = tessellateContour({ start: piece.from, segments: piece.segs }, WINDING_SEGS);
  const i = Math.floor((poly.length - 1) / 2);      // segs.length >= 1 always, so poly.length >= 2
  const a = poly[i], b = poly[i + 1];
  // `len` is the whole piece's length, which is what the short-piece probe scaling needs
  let total = 0;
  for (let k = 0; k < poly.length - 1; k++) total += Math.hypot(poly[k + 1][0] - poly[k][0], poly[k + 1][1] - poly[k][1]);
  return { mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], len: total };
}

// Project p onto the nearest edge of `ring` — a tessellated point ring — and return that
// point together with the edge's unit direction. This is what anchors a winding probe
// exactly on the polyline `_windingAt` queries, by construction, at any radius: the
// projected point IS a point on that polyline (up to floating-point rounding), so offsetting
// it by PROBE_EPS along the edge normal cannot straddle the wrong side of a tessellation gap
// the way offsetting an independently-sampled point (pieceMid's) can. Also gives the
// left/right sense from the SAME edge the origin came from, so origin and normal agree.
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

// Keep a piece iff its two sides straddle the non-zero winding boundary.
//
// Crossing a directed edge changes the winding number by exactly ±1, so ONE probe
// suffices: with the interior of a CCW ring on its left, wLeft = wRight + 1 identically.
// A second probe is not merely redundant but harmful — two independent probes can
// disagree (both reading "inside") when either lands badly, and there is no way to tell
// which is wrong. Deriving the far side arithmetically makes the two consistent by
// construction. "Exactly one side non-zero" then reduces to wLeft ∈ {0, 1}; wLeft === 0
// means the interior is on the right, so the piece is emitted reversed.
//
// The probe origin is pieceMid's point PROJECTED onto tessRings[piece.ring] (projectToRing)
// — the same polyline _windingAt below queries — not the true curve pieceMid approximates;
// see the comments on both for why that distinction is load-bearing.
export function _classify(pieces, tessRings, { debug = false } = {}) {
  return pieces.map((piece) => {
    const { mid, len } = pieceMid(piece);
    if (len < MIN_PIECE_LEN) {
      const rec = { piece, keep: false, reverse: false };
      return debug ? { ...rec, wLeft: null, wRight: null } : rec;
    }
    const { point: onRing, dir } = projectToRing(mid, tessRings[piece.ring]);
    // a piece shorter than 2·PROBE_EPS gets a proportionally shorter probe so pinch-point
    // slivers are still classified rather than probed into a neighbouring region
    const eps = Math.min(PROBE_EPS, Math.max(len / 4, 1e-9));
    const left = [onRing[0] - dir[1] * eps, onRing[1] + dir[0] * eps];
    const wLeft = _windingAt(left, tessRings);
    const wRight = wLeft - 1;
    const keep = wLeft === 0 || wLeft === 1;
    const rec = { piece, keep, reverse: keep && wLeft === 0 };
    return debug ? { ...rec, wLeft, wRight } : rec;
  });
}
