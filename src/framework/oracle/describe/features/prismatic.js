// Pocket, boss, and extrusion rules.
//
// All three are the same observation read at different scopes: a set of side walls sharing
// one sweep direction, capped at one or both ends, is an extrusion of the capped profile.
//
// What separates a POCKET from a BOSS is NOT arc convexity (controller ruling R10). Both
// leave 270 degrees of material where their walls meet the surrounding face — a pocket
// floor and a boss base are each concave seams — so the label is identical on both and
// carries no information. The real distinction is DISPLACEMENT: measure the feature's cap
// plane against the surrounding base plane along their shared normal. A cap sunk into the
// material is a pocket; a cap standing proud of it is a boss. If the walls ARE the part's
// outer envelope, it is the base extrusion and neither.
//
// The extrusion direction comes from the walls, not the cap: a cylindrical wall's own
// fitted axis IS the sweep direction directly (a cylinder is, by definition, swept along
// it — no covariance trick needed, and none is possible from a single fitted axis vector,
// whose own covariance is a degenerate rank-1 matrix with no real "least-spread" direction
// to recover). Only when every wall is PLANAR does the covariance trick apply, and there
// it recovers the direction every wall normal is perpendicular to — the same normal-
// covariance trick fit.js's `ruledSurfaceAxis` uses for a cylinder's axis, just over the
// walls' own fitted normals rather than raw per-face ones. Reading direction from the cap
// normal instead of the walls would fail on a part whose base is not the largest face.
//
// CAP SELECTION runs in two passes, both over the same claimed-surface bookkeeping. Pass
// one looks for the single BASE extrusion, largest area first: the biggest planar face is
// the most likely base of the part's dominant extrusion, and claiming it (plus its walls)
// first keeps the base from being described as a pocket in some smaller face's frame. Pass
// two looks for pockets/bosses among what is left, SMALLEST area first — the reverse order,
// deliberately: a counterbore's floor disk and its own wide mouth annulus both border the
// same bore wall, and if the mouth (the bigger of the two) claimed that wall first, the
// genuine floor would find nothing left to claim and the feature would be reported
// backwards (or not at all). Smallest-first means the floor claims the shared wall before
// its own surrounding mouth gets a chance to.
//
// The `profile` is explicitly a PROPOSAL, not a measurement — it is the cap's boundary
// loop reduced to a circle or a polygon. It exists so hints.js can suggest a sketch;
// nothing in the facts layer depends on it being exact.
//
// Pure leaf. See spec §2.5.
import { arcsOf } from "../surface-graph.js";
import { jacobiEigen } from "../fit.js";

// Wall-vs-direction agreement bands. A planar wall's own normal must be nearly
// PERPENDICULAR to the sweep direction (it is the extrusion's flank, not its cap); a
// cylindrical wall's axis must be nearly PARALLEL to it (a bore or a boss shaft runs
// straight along the sweep, it does not cut across it). Same numeric margin, opposite
// sense, so one constant serves both: "within 0.08 of exactly perpendicular" and
// "within 0.08 of exactly parallel" are the same tolerance read two ways.
const PERPENDICULAR_DOT = 0.08;
// A candidate cap's own boundary arcs must overwhelmingly agree on ONE convexity — see
// `dominantConvexityFraction`'s own comment for the full reasoning and the fixture
// numbers this threshold was picked against. 0.9 leaves room for real machining noise
// (a slightly rounded corner reads as a hair off pure convex/concave) while sitting far
// below the 100% every genuine cap in this suite measures, and far above the ~64% the
// one fixture-proven false positive measures.
const DOMINANT_CONVEXITY_FRAC = 0.9;
const round3 = (v) => Math.round(v * 1000) / 1000;
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const byId = (graph) => new Map(graph.surfaces.map((s) => [s.id, s]));
const other = (arc, id) => (arc.between[0] === id ? arc.between[1] : arc.between[0]);

// What fraction of a candidate cap's own TOTAL boundary (by arc length, not arc count —
// a short corner arc must not outvote a long edge) agrees on its single most common
// convexity, and which convexity that is.
//
// A genuine cap sits at ONE END of a sweep, and every one of its own boundary arcs
// shares the SAME relationship to its walls: a base extrusion's cap, or a boss's own
// top, meets every one of its walls at an ordinary OUTWARD corner (all convex); a
// pocket floor, or a boss's own base, meets every one of its walls at the 270-degree
// INWARD corner every pocket floor and boss base share (all concave, ruling R10). A
// surface whose neighbours are a genuine MIX of both is not itself the cap of any
// single coherent sweep — it is some other feature's surface, caught here only because
// it happens to border this one.
//
// Found empirically, not derived on paper: a wide-shallow pocket's own small SIDE wall
// (`boxWithPocket(30,20,8, 10,6, 10,8, 3)`'s 8x3=24mm^2 wall) was passing every other
// check in this file — `sweepDirection`'s covariance trick and the perpendicularity
// filter both degenerate to trivially-satisfied on axis-aligned geometry once a
// candidate's neighbours only span two of three orthogonal axes, which a plain
// perpendicular-vs-direction test cannot tell apart from a genuine cap's walls (both
// come out 100% "perpendicular"; verified directly by dumping the graph). That wall's
// own arcs, measured by length: one 8mm CONVEX arc to the pocket's mouth (the
// surrounding top face) and three arcs totalling 14mm CONCAVE (the floor, 8mm, plus the
// two neighbouring pocket walls, 3mm each) — the dominant (concave) side is 14/22 =
// 63.6% of this candidate's own perimeter, nowhere near a majority worth trusting, let
// alone the genuine floor's own 100% (all four of ITS arcs — to the same four
// neighbours — are concave). Without this gate the wall was accepted as a "cap" in its
// own right, reporting a pocket of depth 20 (the plate's own unrelated width) with
// `floorFace` bound to a 24mm^2 wall instead of the real 80mm^2 floor.
function dominantConvexityFraction(arcs) {
  const byKind = { convex: 0, concave: 0, flat: 0 };
  let total = 0;
  for (const a of arcs) { byKind[a.convexity] = (byKind[a.convexity] ?? 0) + a.length; total += a.length; }
  if (!(total > 0)) return 0;
  return Math.max(byKind.convex, byKind.concave, byKind.flat) / total;
}

// The direction this feature is swept along, read off its walls rather than its cap
// (see header). Cylindrical walls hand it over directly and exactly: average their own
// axes, flipping any that happen to have fit with the opposite sign first so genuine
// agreement cannot cancel to zero. Only when there is no cylindrical wall to ask does
// this fall back to the covariance trick over the planar walls' own fitted normals.
function sweepDirection(walls) {
  const axial = walls.filter((w) => w.type === "cylinder");
  if (axial.length > 0) {
    const ref = axial[0].fit.axis.direction;
    const sum = [0, 0, 0];
    for (const w of axial) {
      const d = w.fit.axis.direction;
      const s = dot(d, ref) < 0 ? -1 : 1;
      sum[0] += s*d[0]; sum[1] += s*d[1]; sum[2] += s*d[2];
    }
    const len = Math.hypot(sum[0], sum[1], sum[2]) || 1;
    return [sum[0]/len, sum[1]/len, sum[2]/len];
  }
  // Every planar wall's normal lies perpendicular to the sweep direction, so the
  // least-spread eigenvector of their covariance recovers it.
  const cov = [[0,0,0],[0,0,0],[0,0,0]];
  for (const w of walls) {
    const n = w.fit.normal;
    if (!n) continue;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += n[i]*n[j];
  }
  const v = jacobiEigen(cov).vectors[0];
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0]/len, v[1]/len, v[2]/len];
}

// Does this wall actually belong to a sweep along `direction`? A planar wall must be
// perpendicular to it (a flank); a cylindrical wall must be parallel to it (a bore/boss
// running straight through). Anything else is some other feature's surface, pulled in
// only because it happened to neighbour this cap.
function isSideWallOf(w, direction) {
  if (w.type === "plane") return Math.abs(dot(w.fit.normal, direction)) < PERPENDICULAR_DOT;
  if (w.type === "cylinder") return Math.abs(dot(w.fit.axis.direction, direction)) > 1 - PERPENDICULAR_DOT;
  return false;
}

// A cap's boundary reduced to something a sketch could be built from. One loop that is
// a circle -> circle; a loop whose arcs are all straight -> polygon; anything else ->
// mixed, and hints.js will decline to propose a sketch for it.
function profileOf(graph, cap) {
  const arcs = arcsOf(graph, cap.id);
  const circles = arcs.filter((a) => a.kind === "circle");
  if (circles.length === 1 && arcs.length === 1) return { kind: "circle", radius: circles[0].radius };
  if (arcs.length && arcs.every((a) => a.kind === "line")) {
    return { kind: "polygon", points: (cap.loops[0] ?? []).length };
  }
  return { kind: "mixed" };
}

export function detectPrismatic(graph) {
  const surfaces = byId(graph);
  const claimed = new Set();
  const out = [];

  const allCaps = graph.surfaces.filter((s) => s.type === "plane").sort((a, b) => b.area - a.area);

  // Attempt one cap as a feature's own defining plane. `isBase` picks which depth
  // fallback and which type this cap is allowed to resolve to; returns the pushed
  // feature, or null if this cap does not resolve into one (already claimed, no
  // unclaimed walls left to it, or no way to measure a depth).
  function tryCap(cap, isBase) {
    if (claimed.has(cap.id)) return null;
    const arcs = arcsOf(graph, cap.id);
    if (arcs.length === 0) return null;
    // Reject outright — not "proceed with a filtered subset" — when this candidate's own
    // boundary does not overwhelmingly agree on one convexity. See
    // `dominantConvexityFraction`'s own comment: this is what actually distinguishes a
    // genuine cap from a wall being mistaken for one, since the perpendicularity check
    // below cannot (both come out 100% "perpendicular" on axis-aligned geometry).
    if (dominantConvexityFraction(arcs) < DOMINANT_CONVEXITY_FRAC) return null;
    // Only UNCLAIMED neighbours count as this cap's own walls. Without this filter, the
    // base extrusion's OTHER end cap (a plain box's top, once its bottom has already
    // claimed all four side walls) would be re-examined here, find those same walls
    // still attached, and get reported as a second, spurious feature — with no
    // surrounding co-oriented plane to compare against, it would default to "boss" with
    // zero displacement. Filtering to unclaimed walls means a cap with nothing left to
    // claim is recognised as just the far side of an already-described feature.
    const walls = arcs.map((a) => surfaces.get(other(a, cap.id))).filter(Boolean).filter((w) => !claimed.has(w.id));
    if (walls.length === 0) return null;

    const direction = sweepDirection(walls);
    const sideWalls = walls.filter((w) => isSideWallOf(w, direction));
    if (sideWalls.length === 0) return null;

    // Depth from a cylindrical wall's own axial extent, when there is one.
    let lo = Infinity, hi = -Infinity;
    for (const w of sideWalls) {
      if (w.type === "cylinder") { lo = Math.min(lo, w.fit.extent[0]); hi = Math.max(hi, w.fit.extent[1]); }
    }
    const hasCylExtent = Number.isFinite(lo);

    let type = "extrusion", depth;
    if (isBase) {
      if (hasCylExtent) {
        depth = hi - lo;
      } else {
        // Planar walls carry no extent, so read the thickness off the opposing cap.
        // Once R31 has oriented every plane normal outward, this is exact rather than a
        // guess: two opposing faces of a solid have ANTI-PARALLEL outward normals, and
        // for `offset = n . p` the separation between them is simply the SUM of the
        // offsets. (Box spanning z in [0,h]: top n=(0,0,1) offset h, bottom n=(0,0,-1)
        // offset 0, sum h. Centred box z in [-h/2,h/2]: offsets h/2 and h/2, sum h. Both
        // correct, neither depending on where the origin sits.)
        const opposite = allCaps.find((c) => c.id !== cap.id && dot(c.fit.normal, cap.fit.normal) < -0.98);
        if (!opposite) return null;
        depth = cap.fit.offset + opposite.fit.offset;
        if (!(depth > 0)) return null;   // not a solid pair; no depth to report
      }
    } else {
      // Recessed or raised? Compare this cap's plane against the largest CO-oriented
      // plane that is not itself — the surrounding face a pocket sinks into or a boss
      // stands on (deliberately co-oriented here, in contrast to the anti-parallel
      // lookup above: a pocket floor and the face it is sunk into both point the same
      // way, as do a boss top and the face it stands on). Both offsets are then measured
      // along the same direction, so their difference IS the signed displacement —
      // negative means sunk into the material, positive proud of it. This is the whole
      // pocket-vs-boss test, and it is meaningless without R31.
      const surround = allCaps.find((c) => c.id !== cap.id && dot(c.fit.normal, cap.fit.normal) > 0.98);
      const displacement = surround ? cap.fit.offset - surround.fit.offset : 0;
      type = displacement < 0 ? "pocket" : "boss";
      if (hasCylExtent) depth = hi - lo;
      else if (surround) depth = displacement;
      else return null;   // no cylindrical wall and no surrounding plane: nothing to measure
    }
    depth = Math.abs(depth);

    const feature = {
      id: null,
      // Geometry-derived, not `cap.id` (a segmentation surface id assigned in
      // triangle-DISCOVERY order — round 2 review: permuting a mesh's own
      // triangle order, same geometry, moved a boss's key from `boss:15:s1` to
      // `boss:15:s0`, since it renumbers surfaces). `cap.fit.offset`/`normal`
      // pin down the cap's own PLANE (offset is stable across permutation:
      // `orientPlaneOutward`, surface-graph.js, already canonicalises the
      // normal's sign independent of input order, same as every other reader
      // of `fit.normal` in this file relies on); `cap.area` breaks the tie
      // between two same-depth, coplanar caps (two pockets sunk into the same
      // face). `round3` absorbs the float-associativity noise a permuted
      // summation order introduces (Task 4's own ruling, R29) — real geometry
      // never differs at 3-decimal precision, only float dust does.
      key: `${type}:${round3(depth)}:${round3(cap.fit.offset)}:` +
        `${cap.fit.normal.map(round3).join(",")}:${round3(cap.area)}`,
      type, depth, direction,
      floorFace: cap.id,
      wallFaces: sideWalls.map((w) => w.id),
      profile: profileOf(graph, cap),
      surfaces: [cap.id, ...sideWalls.map((w) => w.id)],
      evidence: {
        walls: sideWalls.length,
        concaveArcs: arcs.filter((a) => a.convexity === "concave").length,
        convexArcs: arcs.filter((a) => a.convexity === "convex").length,
      },
    };
    claimed.add(cap.id);
    for (const w of sideWalls) claimed.add(w.id);
    return feature;
  }

  // Pass one: the single base extrusion, largest cap first.
  for (const cap of allCaps) {
    const f = tryCap(cap, out.length === 0);
    if (f) { out.push(f); break; }
  }
  // Pass two: everything left, smallest cap first (see header for why the order flips).
  for (const cap of [...allCaps].sort((a, b) => a.area - b.area)) {
    const f = tryCap(cap, false);
    if (f) out.push(f);
  }

  return out;
}
