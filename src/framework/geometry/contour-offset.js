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
  const dropped = pieceDot.map((d) => d !== null && d <= 0);
  if (dropped.some(Boolean)) dirty = true;
  const keptIdx = [];
  for (let i = 0; i < n; i++) if (!dropped[i]) keptIdx.push(i);
  if (keptIdx.length === 0) return { contour: null, dirty: true };

  const out = [];
  for (let k = 0; k < keptIdx.length; k++) {
    const i = keptIdx[k];
    out.push(...pieces[i].segments);
    const nextI = keptIdx[(k + 1) % keptIdx.length];
    if (nextI === (i + 1) % n) {
      const j = joins[nextI];
      if (j) out.push(...j);
    } else {
      // one or more pieces were dropped between i and nextI: bridge with a single chord
      out.push({ to: [pieces[nextI].start[0], pieces[nextI].start[1]] });
    }
  }
  const start = pieces[keptIdx[0]].start;
  const last = out.at(-1);
  if (dist(last.to, start) <= JOIN_EPS) last.to = [start[0], start[1]];  // snap the closure exactly
  else out.push({ to: [start[0], start[1]] });
  return { contour: { start, segments: out }, dirty };
}

const VALIDATE_SEGS = 32;
const AREA_EPS = 1e-9;

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

// Part 2 of the partial-reflection fix (task 5B): a per-corner trim in _offsetContour can
// produce a ring that is locally valid everywhere — validateRawOffset finds nothing wrong,
// winding and simplicity all check out — while still lying INSIDE the region the offset was
// supposed to sweep clear of. That's the residual Part 1's per-piece deletion doesn't fully
// reach (it only removes individually-reversed pieces; a trimmed corner can land short of
// |delta| without any single piece reversing). The invariant a partial reflection violates:
// every point on a valid offset boundary sits at distance ≥ |delta| from the SOURCE region's
// own boundary (all its rings — a point escaping toward some other, unrelated ring of the
// same region is just as wrong as one that didn't clear its own source ring). This is a
// GLOBAL check by construction — nothing here is scoped to a single corner or segment.

// Distance from point p to the closest point on segment [a,b].
function distToSeg(p, a, b) {
  const ab = sub(b, a);
  const L2 = dot(ab, ab);
  const t = L2 > 1e-18 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / L2)) : 0;
  return dist(p, add(a, scl(ab, t)));
}

function distToRing(p, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) best = Math.min(best, distToSeg(p, ring[i], ring[(i + 1) % ring.length]));
  return best;
}

// A tessellated chord standing in for a curved SOURCE edge dips inside the true curve by its
// sagitta, so a legitimately-cleared sample point can read as slightly closer to the polygonal
// approximation than |delta|. Each chord's angular step is capped at 2π/VALIDATE_SEGS by
// construction (profile.js's sampleArc scales step count to keep every step ≤ that bound), so
// for a chord of length L the sagitta L·(1−cos(θ/2)) is bounded above by L·θ/8 — independent of
// the curve's actual radius, and derived purely from the sampling density rather than a
// hard-coded constant. Straight source edges contribute exactly zero (their "chord" IS the
// edge, no approximation to dip below).
function chordTolerance(ring) {
  const theta = (2 * Math.PI) / VALIDATE_SEGS;
  let maxL = 0;
  for (let i = 0; i < ring.length; i++) maxL = Math.max(maxL, dist(ring[i], ring[(i + 1) % ring.length]));
  return (maxL * theta) / 8;
}

// True when every sampled point of `ring` clears every ring in `sourceRings` by ≥ |delta|
// (within tol).
function ringClearsSource(ring, sourceRings, absDelta, tol) {
  for (const p of ring) {
    let best = Infinity;
    for (const sr of sourceRings) best = Math.min(best, distToRing(p, sr));
    if (best < absDelta - tol) return false;
  }
  return true;
}

// Prune one raw offset region's HOLES against its pre-offset source region: drop any hole
// ring whose candidate boundary fails the distance invariant above (a hole that should have
// fully vanished, or a spurious sliver). The outer is deliberately left untouched here — an
// outer that's already dirty (a reflex corner that couldn't trim, e.g. the dumbbell/hourglass
// case) is EXPECTED to dip near or below |delta| of its own source right at the pinch that
// resolveSelfRegions is about to split it at; deleting the outer outright there would discard
// real geometry that cleanup can correctly recover. Every measured repro for this defect (the
// L-pocket residual, the wide L-pocket residual, the keyed-bore sliver) is a HOLE that failed
// to vanish or a spurious hole-shaped sliver, never a legitimately self-intersecting outer, so
// scoping the prune to holes catches the defect without that collateral damage. { region, changed }.
function pruneRegionByDistance(rawRegion, sourceRegion, delta) {
  const absDelta = Math.abs(delta);
  const sourceRings = [
    tessellateContour(closeContourGap(sourceRegion.outer), VALIDATE_SEGS),
    ...sourceRegion.holes.map((h) => tessellateContour(closeContourGap(h), VALIDATE_SEGS)),
  ];
  const tol = Math.max(0, ...sourceRings.map(chordTolerance));

  let changed = false;
  const holes = rawRegion.holes.filter((h) => {
    const ok = ringClearsSource(tessellateContour(h, VALIDATE_SEGS), sourceRings, absDelta, tol);
    if (!ok) changed = true;
    return ok;
  });
  return { region: { outer: rawRegion.outer, holes }, changed };
}

// Region-in / region-out offset: the engine behind Shape2D.offset on BOTH backends.
// Fast path: raw per-ring offsets that validate cleanly (AND clear the distance-prune
// invariant above) are returned as-is (lines/arcs exact). Cleanup path: anything dirty or
// invalid is self-united through paper.js, with one recovery attempted first (see
// splitAtDuplicateEdges) for the specific degenerate shape paper.js's boolean engine can't
// see as invalid.
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
  const rawSources = [];
  for (const rg of regions) {
    const o = _offsetContour(closeContourGap(rg.outer), delta, corners);
    dirty = dirty || o.dirty;
    if (!o.contour) continue;
    const hs = rg.holes.map((h) => _offsetContour(closeContourGap(h), delta, corners));
    dirty = dirty || hs.some((h) => h.dirty);
    raw.push({ outer: o.contour, holes: hs.filter((h) => h.contour).map((h) => h.contour) });
    rawSources.push(rg);
  }

  // Distance prune runs BEFORE the fast-path decision (dirty/validateRawOffset), on every
  // raw region regardless of its dirty state — the fast-path bug is precisely that dirty
  // can be false and validateRawOffset can be true for a hole ring this prune catches.
  // Pruning forces `dirty` so a hit always routes through cleanup, which then untangles
  // whatever the now-missing hole leaves behind (or simply confirms the outer alone,
  // holeless, is already the correct answer).
  const pruned = raw.map((rg, i) => pruneRegionByDistance(rg, rawSources[i], delta));
  if (pruned.some((p) => p.changed)) dirty = true;
  const rawPruned = pruned.map((p) => p.region);

  let out = (!dirty && validateRawOffset(rawPruned)) ? rawPruned : null;
  if (!out) {
    const split = rawPruned.length === 1 && rawPruned[0].holes.length === 0 ? splitAtDuplicateEdges(rawPruned[0].outer) : null;
    const recovered = split && split.map((outer) => ({ outer, holes: [] }));
    // recovered can be [] (every split piece came back CW, i.e. a spurious artifact rather
    // than real material) — validateRawOffset([]) is vacuously true, so an explicit length
    // check is required or a fully-collapsed split silently short-circuits past cleanup and
    // this throws "collapses the shape" even when resolveSelfRegions would find real area.
    out = recovered && recovered.length > 0 && validateRawOffset(recovered) ? recovered : resolveSelfRegions(rawPruned);
  }
  if (out.length === 0) throw new Error("Shape2D.offset: offset collapses the shape (reduce |delta|)");
  return out;
}
