// Native curve-aware contour offset — the engine behind Shape2D.offset. Pure leaf in
// the worker graph (DOM-free, three-free, node:-free). Offsets every ring by one signed
// rule: each point displaced `delta` along the normal to the RIGHT of the direction of
// travel — under the storage winding invariant (outer CCW, holes CW) that always points
// away from the filled interior, so positive delta grows outers and shrinks holes with
// no per-ring casing. Lines and arcs offset EXACTLY; cubics use adaptive Tiller–Hanson.
//
// The cubic subdivision approach is ported from glenzli/paperjs-offset
// (https://github.com/glenzli/paperjs-offset, MIT License, Copyright (c) glenzli),
// adapted from paper.js Segments to the partforge contour IR.
import { arcCenterAndSweep, resolveSelfRegions } from "./paper-bridge.js";
import { cubicAt, splitCubic, jointTangents, SMOOTH_JOINT_DEG } from "./contour-ops.js";
import { tessellateContour, closeContourGap } from "./profile.js";
import { ringArea, pointInRing } from "./shape2d-regions.js";

export const OFFSET_TOL = 1e-3;   // mm — max deviation of a cubic offset approximation
const MAX_DEPTH = 12;             // cubic subdivision recursion cap
const JOIN_EPS = 1e-6;            // endpoints closer than this are coincident

const VALIDATE_SEGS = 32;
const AREA_EPS = 1e-9;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const scl = (v, s) => [v[0] * s, v[1] * s];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = (v) => Math.hypot(v[0], v[1]);
const norm = (v) => { const L = len(v) || 1; return [v[0] / L, v[1] / L]; };
const rightOf = ([tx, ty]) => [ty, -tx];   // unit right-of-travel normal
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function offsetLine(from, to, delta) {
  const n = scl(rightOf(norm(sub(to, from))), delta);
  return { start: add(from, n), segments: [{ to: add(to, n) }], dirty: false };
}

function offsetArc(from, seg, delta) {
  const c = arcCenterAndSweep(from, seg.via, seg.to);
  if (!c) return offsetLine(from, seg.to, delta);          // collinear via → straight
  const { center, r, dA } = c;
  // CCW sweep (dA>0): right-of-travel is the outward radial → r+delta; CW: inward → r-delta
  const rNew = r + (dA >= 0 ? delta : -delta);
  if (Math.abs(rNew) <= JOIN_EPS) {
    // fully collapsed arc: bridge the offset endpoints with a line, let cleanup cope
    const tanAt = (p) => { const rad = sub(p, center); return norm(dA >= 0 ? [-rad[1], rad[0]] : [rad[1], -rad[0]]); };
    const q = (p) => add(p, scl(rightOf(tanAt(p)), delta));
    return { start: q(from), segments: [{ to: q(seg.to) }], dirty: true };
  }
  // rNew < 0 lands every point on the opposite side of center — the inverted loop
  // that stage-3 cleanup removes. Same projection formula either way.
  const proj = (p) => add(center, scl(norm(sub(p, center)), rNew));
  return { start: proj(from), segments: [{ via: proj(seg.via), to: proj(seg.to) }], dirty: rNew < 0 };
}

// Tiller–Hanson single-piece offset of cubic (p0,c1,c2,p1): displace endpoints along
// their endpoint normals and the handle line by the normal of the c1→c2 chord, then
// accept only if sampled deviation stays within OFFSET_TOL; otherwise split at t=0.5.
// (Ported from paperjs-offset's offsetSegment/adaptiveOffsetCurve.)
function offsetCubic(p0, c1, c2, p1, delta, depth) {
  const nz = (v) => (len(v) > 1e-9 ? v : null);
  const t0 = norm(nz(sub(c1, p0)) ?? nz(sub(c2, p0)) ?? sub(p1, p0));
  const t1 = norm(nz(sub(p1, c2)) ?? nz(sub(p1, c1)) ?? sub(p1, p0));
  const off0 = scl(rightOf(t0), delta), off1 = scl(rightOf(t1), delta);
  const hChord = nz(sub(c2, c1)) ?? sub(p1, p0);
  const hN = scl(rightOf(norm(hChord)), delta);
  const q0 = add(p0, off0), q1 = add(p1, off1);
  const qc1 = add(c1, scl(add(hN, off0), 0.5)), qc2 = add(c2, scl(add(hN, off1), 0.5));
  let ok = true;
  for (const t of [0.25, 0.5, 0.75]) {
    const d = dist(cubicAt(q0, qc1, qc2, q1, t), cubicAt(p0, c1, c2, p1, t));
    if (Math.abs(d - Math.abs(delta)) > OFFSET_TOL) { ok = false; break; }
  }
  if (ok || depth >= MAX_DEPTH) return { start: q0, segments: [{ to: q1, c1: qc1, c2: qc2 }], dirty: !ok };
  const [L, R] = splitCubic(p0, c1, c2, p1, 0.5);
  const a = offsetCubic(L.p0, L.c1, L.c2, L.p1, delta, depth + 1);
  const b = offsetCubic(R.p0, R.c1, R.c2, R.p1, delta, depth + 1);
  return { start: a.start, segments: [...a.segments, ...b.segments], dirty: a.dirty || b.dirty };
}

// One IR segment (running from `from` to seg.to) → its raw offset piece.
export function _offsetSegment(from, seg, delta) {
  if (seg.c1) return offsetCubic(from, seg.c1, seg.c2, seg.to, delta, 0);
  if (seg.via) return offsetArc(from, seg, delta);
  return offsetLine(from, seg.to, delta);
}

const MITER_LIMIT = 2;

// Intersection of the line through P (direction u) with the line through Q (direction v).
function lineIntersect(P, u, Q, v) {
  const d = cross(u, v);
  if (Math.abs(d) < 1e-12) return null;
  const w = sub(Q, P);
  return add(P, scl(u, cross(w, v) / d));
}

// Segments bridging aEnd → bStart around `corner` on the gap side.
function joinSegs(corner, aEnd, bStart, inTan, outTan, delta, corners) {
  if (corners === "chamfer") return [{ to: bStart }];
  if (corners === "sharp") {
    const X = lineIntersect(aEnd, inTan, bStart, outTan);
    if (X && dist(X, corner) <= MITER_LIMIT * Math.abs(delta)) return [{ to: X }, { to: bStart }];
    return [{ to: bStart }];                               // miter-limit fallback = bevel
  }
  // round: exact arc about the corner, via on the displacement bisector
  const d1 = sub(aEnd, corner), d2 = sub(bStart, corner);
  let m = add(d1, d2);
  if (len(m) < 1e-9) m = delta > 0 ? rightOf(norm(d1)) : scl(rightOf(norm(d1)), -1); // 180° turn
  return [{ via: add(corner, scl(norm(m), Math.abs(delta))), to: bStart }];
}

// Offset one explicitly-closed ring. Returns { contour, dirty }.
export function _offsetContour(contour, delta, corners) {
  const pts = [contour.start, ...contour.segments.map((s) => s.to)];
  // drop zero-length line segments (they carry no direction)
  const keep = contour.segments.map((s, i) => s.c1 || s.via || dist(pts[i], s.to) > 1e-9);
  const segs = contour.segments.filter((_, i) => keep[i]);
  const froms = [];
  { let p = contour.start; for (const s of contour.segments) { froms.push(p); p = s.to; } }
  const fromsKept = froms.filter((_, i) => keep[i]);
  // NB: feed jointTangents the KEPT chain's start — if the first segment was dropped
  // as zero-length, contour.start no longer heads the filtered ring.
  const joints = jointTangents({ start: fromsKept[0] ?? contour.start, segments: segs });
  const pieces = segs.map((s, i) => _offsetSegment(fromsKept[i], s, delta));
  let dirty = pieces.some((p) => p.dirty);
  const n = segs.length;
  const joins = new Array(n).fill(null);   // joins[i] bridges piece[i-1] → piece[i] at vertex i

  for (let i = 0; i < n; i++) {
    const prev = pieces[(i - 1 + n) % n], next = pieces[i];
    const aEnd = prev.segments.at(-1).to, bStart = next.start;
    const { point, inTan, outTan } = joints[i];
    const turn = cross(inTan, outTan);
    const turnDeg = (Math.atan2(Math.abs(turn), Math.max(-1, Math.min(1, inTan[0] * outTan[0] + inTan[1] * outTan[1]))) * 180) / Math.PI;
    if (dist(aEnd, bStart) <= JOIN_EPS || turnDeg < SMOOTH_JOINT_DEG) continue;   // smooth
    if (turn * delta > 0) { joins[i] = joinSegs(point, aEnd, bStart, inTan, outTan, delta, corners); continue; }
    // overlap side: trim when both neighbors are plain lines, else chord + dirty
    const aSeg = prev.segments.at(-1), bSeg = next.segments[0];
    if (!aSeg.via && !aSeg.c1 && !bSeg.via && !bSeg.c1) {
      const X = lineIntersect(aEnd, inTan, bStart, outTan);
      if (X) { aSeg.to = X; next.start = X; continue; }    // exact trim, stays clean
    }
    joins[i] = [{ to: bStart }]; dirty = true;
  }

  // Whole-ring collapse check: when delta exceeds the ring's own inradius, EVERY plain-line
  // piece's trimmed direction reverses relative to its pre-offset direction — reflection
  // through the collapse point preserves winding, so the reflected ring passes every other
  // validity check there is (paper.js included: it's a genuinely simple polygon, just the
  // wrong one). That whole-ring signal is reliable; a PER-PIECE version of it is not — it
  // also fires on ordinary trims (acute barbs, narrow slots, non-square holes, 45° chamfers)
  // that never reflected, and "fixing" those by un-trimming produces over-inclusive geometry
  // instead of the correct, already-exact Task 1-4 result. So: only act when ALL plain-line
  // pieces agree; when some but not all do, this is a normal partial trim — leave it alone.
  // Critically, "the whole ring" means EVERY piece of the ring, not just its line pieces: a
  // ring where lines are a minority (a mostly-arc disc with a small tab, say) can have every
  // one of its few line pieces reverse while the ring as a whole is nowhere near collapsed —
  // requiring lineReversals.length === n makes this a genuine whole-ring predicate again. An
  // all-arc ring that truly collapses is still caught downstream: offsetArc already marks
  // rNew<0 / fully-collapsed arcs dirty, routing to cleanup instead of a false fast-path pass.
  // pieceDot[i] is the reversal signal (dot of post-trim vs pre-offset direction) for
  // plain-line piece i, or null for arc/cubic pieces — a dot of zero here also flags a
  // piece trimmed down to zero length, since a zero vector's dot with anything is 0.
  const pieceDot = pieces.map((p, i) => {
    if (p.segments.length !== 1 || p.segments[0].via || p.segments[0].c1) return null;
    const origDir = sub(segs[i].to, fromsKept[i]);
    const newDir = sub(p.segments[0].to, p.start);
    return dot(newDir, origDir);
  });
  const lineReversals = pieceDot.filter((d) => d !== null).map((d) => d <= 0);
  if (lineReversals.length === n && n > 0 && lineReversals.every(Boolean)) return { contour: null, dirty: true };

  // Part 1 of the partial-reflection fix (task 5B): the whole-ring gate above only fires
  // when EVERY plain-line piece reverses — by design, since a per-piece version of that
  // gate also fires on ordinary trims that never reflected (see the comment above). But a
  // ring that does NOT collapse wholesale can still carry one or two individually-reversed
  // pieces (an over-offset corner that trimmed past its own neighbor) — that's the seed of
  // the partial-reflection residual: those pieces survive into the ring and validateRawOffset
  // can't see anything locally wrong with them. Delete them (not un-trim — un-trimming was
  // rejected in an earlier round for other over-inclusive regressions) and re-link the
  // surviving neighbors with a direct chord, marking the ring dirty so resolveSelfRegions
  // (and, ahead of it, the offsetRegions distance prune) gets a chance to untangle whatever
  // that chord leaves behind. Every non-line piece always survives this pass; the whole-ring
  // gate above already guarantees at least one piece survives here too.
  const allIdx = pieces.map((_, i) => i);
  const dropped = pieceDot.map((d) => d !== null && d <= 0);
  if (!dropped.some(Boolean)) return { contour: assembleRing(pieces, joins, allIdx, n), dirty };

  const keptIdx = allIdx.filter((i) => !dropped[i]);
  if (keptIdx.length === 0) return { contour: null, dirty: true };

  // Guard (review round 1, Important 3): deletion is unrecoverable — unlike a chord/dirty
  // join, which resolveSelfRegions can still untangle downstream, a deleted piece is gone for
  // good, so a bad deletion can turn perfectly good geometry into a false "offset collapses
  // the shape" throw (measured: 18 new throws per 3000 random polygons; repro: a 9-gon at
  // delta -2.79/chamfer with true eroded area 2.76). A raw *piece count* floor doesn't work as
  // the discriminator — an arc-dominated ring can be legitimately reduced to a single
  // surviving piece (this file's own storage convention stores a full circle as just two arcs;
  // the keyed-bore regression test below reduces to one surviving arc + closing chord and that
  // IS the correct answer). Routing through resolveSelfRegions doesn't work either — it was
  // tried first, and rejected: it assumes the CCW/positive-area "outer" convention (an
  // uninverted self-union is real material, an inverted one that flips positive is a
  // discarded artifact), but _offsetContour has no idea here whether it's assembling an outer
  // or a hole, and a perfectly valid CW/negative-area hole ring (like the keyed bore's) reads
  // as "inverted" under that assumption and gets wrongly discarded. What actually
  // distinguishes "deletion destroyed real geometry" from "deletion correctly trimmed it
  // down" is winding-agnostic: is the assembled result still a SIMPLE (non-self-intersecting)
  // ring with nonzero area — exactly what validateRawOffset's own segment-crossing test
  // (ringSelfIntersects, defined below) already checks without any orientation assumption.
  // Fall back to the un-deleted ring (still marked dirty, since a piece DID look reversed)
  // when deletion isn't simple: cleanup gets a chance to untangle whatever the un-deleted
  // piece leaves behind, which is strictly more recoverable than deletion's dead end.
  const deleted = assembleRing(pieces, joins, keptIdx, n);
  const deletedRing = tessellateContour(deleted, VALIDATE_SEGS);
  const deletedArea = Math.abs(ringArea(deletedRing));
  if (deletedArea <= AREA_EPS || ringSelfIntersects(deletedRing))
    return { contour: assembleRing(pieces, joins, allIdx, n), dirty: true };
  return { contour: deleted, dirty: true };
}

// Assemble a closed ring from a subset of offset pieces (by index into `pieces`, in ring
// order), bridging consecutive survivors with their original join (when adjacent in the
// source ring) or a single chord (when one or more pieces were skipped in between — Part 1's
// deletion path). `idx = [0..n-1]` (every piece kept) reproduces the plain, no-deletion
// assembly exactly, since every piece is then "adjacent" to the next by construction.
function assembleRing(pieces, joins, idx, n) {
  const out = [];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    out.push(...pieces[i].segments);
    const nextI = idx[(k + 1) % idx.length];
    if (nextI === (i + 1) % n) {
      const j = joins[nextI];
      if (j) out.push(...j);
    } else {
      // one or more pieces were skipped between i and nextI: bridge with a single chord
      out.push({ to: [pieces[nextI].start[0], pieces[nextI].start[1]] });
    }
  }
  const start = pieces[idx[0]].start;
  const last = out.at(-1);
  if (dist(last.to, start) <= JOIN_EPS) last.to = [start[0], start[1]];  // snap the closure exactly
  else out.push({ to: [start[0], start[1]] });
  return { start, segments: out };
}

function segsCross(a1, a2, b1, b2) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = o(a1, a2, b1), o2 = o(a1, a2, b2), o3 = o(b1, b2, a1), o4 = o(b1, b2, a2);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0; // strict crossings only
}

// True when two (non-adjacent) segments are collinear and overlap along more than a point.
// segsCross's strict-crossing test deliberately ignores collinear touches, but an offset
// ring can retrace the same line twice (a neck/hole pinched shut by delta past its own
// width flips the offset pieces from either side onto each other) — that produces exact
// duplicate or overlapping collinear edges with no transversal crossing anywhere, which
// segsCross alone can't see.
function segsOverlap(a1, a2, b1, b2) {
  const d = sub(a2, a1);
  const L = len(d);
  if (L < 1e-9) return false;
  const u = norm(d);
  const perp = (p) => Math.abs(cross(u, sub(p, a1)));      // distance off the a1→a2 line
  if (perp(b1) > 1e-9 || perp(b2) > 1e-9) return false;     // not collinear with a
  const t = (p) => dot(sub(p, a1), u);                      // param along a1→a2
  const [ta1, ta2] = [0, L];
  const [tb1, tb2] = [t(b1), t(b2)].sort((x, y) => x - y);
  return Math.min(ta2, tb2) - Math.max(ta1, tb1) > 1e-9;    // overlap longer than a touch
}

function ringSelfIntersects(ring) {
  const m = ring.length;
  for (let i = 0; i < m; i++) for (let j = i + 2; j < m; j++) {
    if (i === 0 && j === m - 1) continue;                  // adjacent via wraparound
    const a1 = ring[i], a2 = ring[(i + 1) % m], b1 = ring[j], b2 = ring[(j + 1) % m];
    if (segsCross(a1, a2, b1, b2) || segsOverlap(a1, a2, b1, b2)) return true;
  }
  return false;
}

function ringsCross(a, b) {
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++)
    if (segsCross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
  return false;
}

// True when a raw offset result is already valid (fast path). Sampled at VALIDATE_SEGS.
export function validateRawOffset(regions) {
  const sampled = regions.map((rg) => ({
    outer: tessellateContour(rg.outer, VALIDATE_SEGS),
    holes: rg.holes.map((h) => tessellateContour(h, VALIDATE_SEGS)),
  }));
  const allRings = [];
  for (const rg of sampled) {
    if (ringArea(rg.outer) <= AREA_EPS) return false;                  // flipped or collapsed outer
    for (const h of rg.holes) {
      if (ringArea(h) >= -AREA_EPS) return false;                      // flipped or collapsed hole
      if (!pointInRing(h[0], rg.outer)) return false;                  // hole escaped its outer
    }
    allRings.push(rg.outer, ...rg.holes);
  }
  for (const r of allRings) if (ringSelfIntersects(r)) return false;
  for (let i = 0; i < allRings.length; i++) for (let j = i + 1; j < allRings.length; j++)
    if (ringsCross(allRings[i], allRings[j])) return false;
  return true;
}

// A raw all-line outer ring can retrace the very same edge twice, in the same direction,
// when a narrow neck (or a hole) offsets past its own width: the two sides of the pinch
// land exactly on top of each other (see the whole-ring collapse check in _offsetContour
// for the convex-corner sibling of this — same underlying reflection, reached through a
// reflex-corner join instead of a trim, so it isn't a single collapsed ring to drop but a
// self-touching one to cut). That's a *valid, simple* polygon as far as paper.js is
// concerned — a zero-width slit, not a crossing — so resolveSelfRegions has nothing to
// untangle and leaves the two halves connected. Cut the ring at each duplicate edge
// instead: it always severs the ring into two closed sub-loops (repeat until none remain).
// Winding tells real material from the leftover artifact: the artifact comes back CW
// (negative area — the neck's own boundary retraced backwards) and is discarded; the two
// severed pieces come back CCW, matching the storage invariant for outers.
function splitAtDuplicateEdges(contour) {
  if (contour.segments.some((s) => s.via || s.c1)) return null;   // lines only
  const pts = [contour.start, ...contour.segments.map((s) => s.to)];
  const ring = pts.slice(0, -1);                                  // drop the closing repeat of start
  const eq = (a, b) => dist(a, b) <= JOIN_EPS;
  const loops = [ring];
  const pieces = [];
  let splitAny = false;
  while (loops.length) {
    const r = loops.pop();
    const m = r.length;
    let found = null;
    for (let i = 0; i < m && !found; i++) for (let j = i + 1; j < m; j++) {
      if (eq(r[i], r[j]) && eq(r[(i + 1) % m], r[(j + 1) % m])) { found = [i, j]; break; }
    }
    if (!found) { pieces.push(r); continue; }
    splitAny = true;
    const [i, j] = found;
    const a = r.slice(i + 1, j + 1), b = [...r.slice(j + 1), ...r.slice(0, i + 1)];
    if (a.length >= 3) loops.push(a);
    if (b.length >= 3) loops.push(b);
  }
  if (!splitAny) return null;
  return pieces
    .filter((r) => ringArea(r) > AREA_EPS)                         // discard the CW artifact
    .map((r) => ({ start: r[0], segments: [...r.slice(1).map((p) => ({ to: p })), { to: [r[0][0], r[0][1]] }] }));
}

// Part 2 of the partial-reflection fix (task 5B) — REMOVED (review round 2). A global
// distance-from-source prune existed here through two review rounds, narrowing its scope each
// time (round 1: per-hole rather than whole-region, to stop swallowing legitimate hole
// merges/breakthroughs; round 2: exact closed-form line/arc distance and an adaptively-
// flattened cubic distance instead of a chord-length-bounded tolerance, to stop losing curved
// holes to discretization noise). Round 2 confirmed the prune's own justification was sound —
// the wide-arm-L-pocket case it exists to fix is a genuine defect (max inscribed circle in a
// 5-wide-arm L has radius 2.5 < delta 3, so the hole DOES fully vanish; a truth value is
// derivable and the pre-fix engine got it wrong) — but even with exact-geometry distances, an
// 84-combination sweep of real glyph counters (uppercase/lowercase/digit counters on 10mm text
// at delta 0.1–0.5mm) still lost 36 of them entirely, all silent total-hole-loss, none
// recoverable by further tolerance tuning: the wide-L-pocket's own raw hole ring is ALREADY
// `dirty` from Part 1 before any distance check runs, and so are the failing glyph counters —
// there is no scoping condition (dirty vs not, tolerance size, source curve type) that
// distinguishes "prune this, it's really gone" from "don't prune this, cleanup will recover
// it" using only the raw, pre-cleanup ring. The prune's collateral (silently deleting real
// text counters at sub-millimetre offsets) is strictly worse than the single defect it fixes,
// so it's gone rather than shipped delicately tuned. The wide-L-pocket case is parked as a
// test.todo pending a proper oracle (Clipper2 or the OCCT backend) rather than this engine's
// own per-ring heuristics. See task-5B-report.md's round-2 section for the full sweep.

// Region-in / region-out offset: the engine behind Shape2D.offset on BOTH backends.
// Fast path: raw per-ring offsets that validate cleanly are returned as-is (lines/arcs
// exact). Cleanup path: anything dirty or invalid is self-united through paper.js, with
// one recovery attempted first (see splitAtDuplicateEdges) for the specific degenerate
// shape paper.js's boolean engine can't see as invalid.
export function offsetRegions(regions, delta, { corners = "round" } = {}) {
  if (!["round", "chamfer", "sharp"].includes(corners))
    throw new Error('Shape2D.offset: corners must be "round" | "chamfer" | "sharp"');
  if (!Number.isFinite(delta)) throw new Error("Shape2D.offset: delta must be a finite number");
  if (delta === 0) return JSON.parse(JSON.stringify(regions));

  // _offsetContour signals a whole-ring collapse with contour:null (see its comment) — a
  // dropped outer removes its whole region, a dropped hole is simply omitted. If everything
  // drops, raw ends up [] and the "no regions survive" throw below fires naturally.
  let dirty = false;
  const raw = [];
  for (const rg of regions) {
    const o = _offsetContour(closeContourGap(rg.outer), delta, corners);
    dirty = dirty || o.dirty;
    if (!o.contour) continue;
    const hs = rg.holes.map((h) => _offsetContour(closeContourGap(h), delta, corners));
    dirty = dirty || hs.some((h) => h.dirty);
    raw.push({ outer: o.contour, holes: hs.filter((h) => h.contour).map((h) => h.contour) });
  }

  let out = (!dirty && validateRawOffset(raw)) ? raw : null;
  if (!out) {
    const split = raw.length === 1 && raw[0].holes.length === 0 ? splitAtDuplicateEdges(raw[0].outer) : null;
    const recovered = split && split.map((outer) => ({ outer, holes: [] }));
    // recovered can be [] (every split piece came back CW, i.e. a spurious artifact rather
    // than real material) — validateRawOffset([]) is vacuously true, so an explicit length
    // check is required or a fully-collapsed split silently short-circuits past cleanup and
    // this throws "collapses the shape" even when resolveSelfRegions would find real area.
    out = recovered && recovered.length > 0 && validateRawOffset(recovered) ? recovered : resolveSelfRegions(raw);
  }
  if (out.length === 0) throw new Error("Shape2D.offset: offset collapses the shape (reduce |delta|)");
  return out;
}
