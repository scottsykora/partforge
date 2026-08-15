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
import { trimSegment, segTangent } from "./contour-ops.js";
import { tessellateContour, closeContourGap, reverseContour } from "./profile.js";
import { assembleRegions, ringArea } from "./shape2d-regions.js";

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
//
// The ±1 invariant above (wLeft = wRight + 1) is a property of an actual probe: it holds
// for every record that reaches the probe below. The two early-return branches never probe
// at all — the piece is dropped for having no reliable direction to probe along — so their
// debug record reports wLeft: null, wRight: null rather than fabricating a pair that would
// satisfy the arithmetic without a probe behind it. Callers that assert the invariant in
// debug mode (see test/contour-winding.test.js) must therefore do so only over records with
// a non-null wLeft, not over every record `_classify` returns.
export function _classify(pieces, tessRings, { debug = false } = {}) {
  return pieces.map((piece) => {
    if (piece.segs.length === 0) {
      // Unreachable from _splitRings (every emitted piece has >=1 seg), but _classify is
      // exported and a hand-built `segs: []` piece would otherwise throw inside pieceMid
      // (poly.length < 2) before MIN_PIECE_LEN gets a chance to reject it. Same outcome as
      // the zero-length case below: drop it, don't guess an orientation.
      const rec = { piece, keep: false, reverse: false };
      return debug ? { ...rec, wLeft: null, wRight: null } : rec;
    }
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
      if (guard++ > open.length + 1) throw new Error("contour-winding: could not chain offset boundary (incomplete intersection set)");
      used[cur] = true;
      chainSegs.push(...open[cur].segs);
      const at = open[cur].vEnd;
      if (at === startV) break;
      const cands = (outgoing.get(at) ?? []).filter((i) => !used[i]);
      if (cands.length === 0) throw new Error("contour-winding: could not chain offset boundary (incomplete intersection set)");
      const inDir = dirIn(open[cur]);
      // leftmost turn: smallest positive rotation from the reversed inbound direction
      cur = cands.reduce((best, i) => {
        const turn = (x) => { let a = inDir + Math.PI - dirOut(open[x]); a %= 2 * Math.PI; return a < 0 ? a + 2 * Math.PI : a; };
        return turn(i) < turn(best) ? i : best;
      }, cands[0]);
    }
    out.push({ start: startPt, segs: chainSegs });
  }

  if (used.some((u) => !u)) throw new Error("contour-winding: could not chain offset boundary (incomplete intersection set)");
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

// Resolve a raw offset region list into the non-zero winding region it denotes.
// This is contour-offset.js's cleanup path.
export function resolveOffsetWinding(rawRegions) {
  const rings = [];
  for (const rg of rawRegions) { rings.push(rg.outer); for (const h of rg.holes) rings.push(h); }
  if (rings.length === 0) return [];

  const merged = _mergeCrossings(ringCrossings(rings));
  const pieces = _splitRings(rings, merged);
  const tessRings = rings.map((r) => tessellateContour(r, WINDING_SEGS));
  // _classify's reversal is a symmetric nonzero-winding rule: it treats a piece bounding a
  // wLeft=0/wRight=-1 pair as filled-when-reversed exactly like a wLeft=1/wRight=0 pair,
  // which is what a bowtie's locally-CW sub-lobe needs (it's a genuine self-intersection
  // artifact, not an orientation error — see the bowtie test below). But an UNCROSSED whole
  // ring (piece.vStart === null: _splitRings found no crossings for it at all) that would
  // need reversing has no crossing-derived counterpart to legitimize that reversal — it is
  // simply a ring stored backwards, with nothing else in the input to pair it against. In
  // this engine that shape is either a lone hole with no covering outer, or a raw offset
  // that collapsed past zero and inverted; both denote NO material, not a phantom positive
  // region of the same size reflected into existence. Drop those rather than reverse them.
  const classified = _classify(pieces, tessRings)
    .map((c) => (c.piece.vStart === null && c.reverse ? { ...c, keep: false } : c));
  const contours = _chain(classified, merged.pool);

  // drop numerically empty loops, then nest by containment and restore the storage
  // winding invariant (outer CCW, holes CW) from each contour's own area sign
  const live = contours.filter((c) => Math.abs(ringArea(tessellateContour(c, WINDING_SEGS))) > 1e-9);
  if (live.length === 0) return [];
  const tessOf = new Map(live.map((c) => [c, tessellateContour(c, WINDING_SEGS)]));
  const regions = assembleRegions(live.map((c) => tessOf.get(c)));
  const byRing = new Map(live.map((c) => [tessOf.get(c), c]));
  return regions.map((rg) => {
    const outer = byRing.get(rg.outer);
    const orient = (c, wantCCW) =>
      closeContourGap(ringArea(tessellateContour(c, WINDING_SEGS)) >= 0 === wantCCW ? c : reverseContour(c));
    return { outer: orient(outer, true), holes: rg.holes.map((h) => orient(byRing.get(h), false)) };
  });
}
