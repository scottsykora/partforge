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
      if (segs.length === 0) return;                      // degenerate zero-length run
      segs[segs.length - 1].to = [merged.pool[b.vertex][0], merged.pool[b.vertex][1]];  // snap to the shared vertex
      pieces.push({ ring: r, from: [from[0], from[1]], segs, vStart: a.vertex, vEnd: b.vertex });
    };
    for (let i = 0; i < xs.length; i++) emit(xs[i], xs[(i + 1) % xs.length]);
  });
  return pieces;
}
