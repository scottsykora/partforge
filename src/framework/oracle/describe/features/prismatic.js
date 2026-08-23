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
// ISLANDS (round 3 review). `mergeCoFamily` (surface-graph.js) folds two patches into one
// SURFACE whenever they fit the same plane, regardless of whether they touch — a plane
// interrupted by a boss IS one plane, and requiring adjacency there would re-break every
// interrupted surface. But that means a cap surface can silently span TWO physically
// disjoint regions: two same-height boss tops on the same plate merge into one `s<n>`
// with two unconnected islands, and treating the whole surface as one feature built a
// candidate spanning the gap between them — a "bridging box" 4-5x too large, rejected by
// acceptCandidates for negative gain, silently dropping the smaller island's entire volume
// (round 3 review's own repro: 3000 of 27000mm3, 11.1% of the part, unaccounted for and
// under the LOW_COVERAGE threshold so nothing flagged it). `loops.length` alone cannot
// tell "two islands" from "one island with a hole" apart (an annulus is one island, two
// loops), so `islandsOf` walks actual face ADJACENCY instead — connectivity, not boundary
// count. A cap with N islands yields N features, not one; a genuinely interrupted single
// plane (a base with two boss holes cut into it, still one connected blob of material
// around them) stays one island and still yields exactly one feature, unchanged. The same
// merge can happen one level down, on a WALL — two different steps whose footprints share
// one x or y coordinate put both steps' own side walls on the same plane too (found while
// building this fix's own regression fixture) — so every wall is independently re-scoped
// to just the island it actually borders (`wallIslandFor`) before it contributes to a
// feature's depth or geometry. Both helpers need `topo` (the welded mesh topology); omit
// it and every cap is treated as its own single island, matching this file's behaviour
// before this fix.
//
// The `profile` is explicitly a PROPOSAL, not a measurement — it is the cap's boundary
// loop reduced to a circle or a polygon. It exists so hints.js can suggest a sketch;
// nothing in the facts layer depends on it being exact. For a multi-island cap it is
// computed from the WHOLE merged surface's arcs/loops rather than the specific island
// (splitting `graph.arcs`/`loops` by island would need the same per-edge walk
// `wallIslandFor` already does, for a field nothing downstream treats as authoritative) —
// a known, deliberately accepted imprecision in a proposal field, not in a fact.
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
// mixed, and hints.js will decline to propose a sketch for it. Whole-cap, not
// per-island — see this file's header for why that is an accepted imprecision here.
function profileOf(graph, cap) {
  const arcs = arcsOf(graph, cap.id);
  const circles = arcs.filter((a) => a.kind === "circle");
  if (circles.length === 1 && arcs.length === 1) return { kind: "circle", radius: circles[0].radius };
  if (arcs.length && arcs.every((a) => a.kind === "line")) {
    return { kind: "polygon", points: (cap.loops[0] ?? []).length };
  }
  return { kind: "mixed" };
}

// Partitions a surface's own triangles into connected components by face ADJACENCY —
// the actual test for "one island" vs "two", which boundary-loop count cannot make
// (an annulus is one island with two loops; two disjoint same-plane patches are two
// islands each with one). Restricted to `faces`' own membership, exactly like
// describe.js's `residualRegions` island walk and segment.js's own connectivity
// passes — the same primitive, reused rather than reinvented.
function islandsOf(topo, faces) {
  const inSet = new Set(faces);
  const seen = new Set();
  const islands = [];
  for (const seed of faces) {
    if (seen.has(seed)) continue;
    const island = [];
    const stack = [seed];
    seen.add(seed);
    while (stack.length) {
      const t = stack.pop();
      island.push(t);
      for (const ei of topo.faceEdges[t]) {
        const e = topo.edges[ei];
        const nb = e.triA === t ? e.triB : e.triA;
        if (nb >= 0 && inSet.has(nb) && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
      }
    }
    islands.push(island);
  }
  return islands;
}

// The subset of `wallSurf`'s own triangles that actually border `islandFaces` — not
// the whole wall surface, which (the same merge, one level down) can itself span more
// than one physical wall. Seeds from triangles with a direct edge into the island, then
// grows within the wall surface's own face set only, so a wall genuinely shared between
// two different islands (this file's header) is still fully credited to each of them
// rather than pulling in the other island's own unrelated geometry.
function wallIslandFor(topo, wallSurf, islandFaces) {
  const islandSet = new Set(islandFaces);
  const wallSet = new Set(wallSurf.faces);
  const seeds = [];
  for (const t of wallSurf.faces) {
    for (const ei of topo.faceEdges[t]) {
      const e = topo.edges[ei];
      const nb = e.triA === t ? e.triB : e.triA;
      if (nb >= 0 && islandSet.has(nb)) { seeds.push(t); break; }
    }
  }
  if (seeds.length === 0) return [];
  const seen = new Set(seeds);
  const stack = [...seeds];
  const out = [];
  while (stack.length) {
    const t = stack.pop();
    out.push(t);
    for (const ei of topo.faceEdges[t]) {
      const e = topo.edges[ei];
      const nb = e.triA === t ? e.triB : e.triA;
      if (nb >= 0 && wallSet.has(nb) && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
  }
  return out;
}

// Sum of `topo.faceArea` over a face list — the island-scoped twin of a surface's own
// (whole-surface) `.area`.
const facesArea = (topo, faces) => faces.reduce((a, t) => a + topo.faceArea[t], 0);

// Vertex-average centroid of a face list (unweighted; a rough "where in the plane is
// this" for key disambiguation, not a measurement anything else reads). Two same-size,
// same-height, same-depth islands (a truly symmetric pair of identical bosses) would
// otherwise share an identical key — `round3(area)` alone does not separate them, but
// their positions do.
function facesCentroid(topo, faces) {
  const c = [0, 0, 0];
  let n = 0;
  for (const t of faces) for (let k = 0; k < 3; k++) {
    const v = topo.tris[3*t + k] * 3;
    c[0] += topo.verts[v]; c[1] += topo.verts[v+1]; c[2] += topo.verts[v+2];
    n++;
  }
  return n ? [c[0]/n, c[1]/n, c[2]/n] : [0, 0, 0];
}

// `topo` is optional (matches sweeps.js's own `opts.bvh` precedent, Task 12 round 1):
// omit it and every cap is treated as a single island, exactly this file's behaviour
// before round 3's fix — every existing 1-arg `detectPrismatic(graph)` call (this
// file's own tests included) keeps working unchanged.
export function detectPrismatic(graph, topo) {
  const surfaces = byId(graph);
  const claimed = new Set();
  const out = [];

  const allCaps = graph.surfaces.filter((s) => s.type === "plane").sort((a, b) => b.area - a.area);

  // The plane a pocket sinks into or a boss stands on: must be something THIS
  // feature's OWN walls actually meet, not merely any co-oriented plane anywhere on
  // the part (fix round 2, CRITICAL — R37 added a perpendicularity requirement for
  // the WALLS and never required the SURROUND to actually surround anything. The old
  // `allCaps.find(dot > 0.98)` could match an unrelated co-oriented plane elsewhere
  // on the part — e.g. a compound-fillet corner's own near-flat micro-facet — with
  // no adjacency at all, and WHICH unrelated plane won that search was itself
  // orientation-dependent: the same real boss could report as a pocket depending on
  // how the part happened to be rotated, which is the worst single thing this
  // feature can tell a rebuilding agent). Reachable means: walk each of this
  // feature's own walls' arcs (`arcsOf`) for a co-oriented plane on the other side —
  // a plane those walls also meet, exactly like a pocket floor or boss base
  // physically has to. More than one candidate can survive that (two different walls,
  // or one wall at a compound corner, each bordering their own genuinely-adjacent
  // co-oriented plane) — broken by shared boundary LENGTH, not first-found: the
  // plane the walls spend the most edge actually touching is the one surrounding
  // the feature.
  function findSurround(cap, islandWalls) {
    const byLength = new Map(); // surface id -> accumulated shared arc length
    for (const { w } of islandWalls) {
      for (const a of arcsOf(graph, w.id)) {
        const id = other(a, w.id);
        if (id === cap.id) continue;
        const s = surfaces.get(id);
        if (!s || s.type !== "plane" || dot(s.fit.normal, cap.fit.normal) <= 0.98) continue;
        byLength.set(id, (byLength.get(id) ?? 0) + a.length);
      }
    }
    let best = null, bestLen = -1;
    for (const [id, len] of byLength) if (len > bestLen) { bestLen = len; best = surfaces.get(id); }
    return best;
  }

  // Builds ONE feature from one island's own faces plus the wall segments (already
  // scoped to that same island by the caller) that border it. Factored out of `tryCap`
  // so the ordinary single-island case and the multi-island split share exactly one
  // implementation rather than two copies that could drift apart.
  function buildFeature(cap, isBase, islandFaces, islandWalls, direction, arcs) {
    // Depth from a cylindrical wall's own axial extent, when there is one.
    let lo = Infinity, hi = -Infinity;
    for (const { w } of islandWalls) {
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
        // offsets.
        const opposite = allCaps.find((c) => c.id !== cap.id && dot(c.fit.normal, cap.fit.normal) < -0.98);
        if (!opposite) return null;
        depth = cap.fit.offset + opposite.fit.offset;
        if (!(depth > 0)) return null;   // not a solid pair; no depth to report
      }
    } else {
      // Recessed or raised? Compare this cap's plane against the plane its OWN walls
      // are actually adjacent to (see `findSurround`'s own comment, above) — the
      // surrounding face a pocket sinks into or a boss stands on.
      const surround = findSurround(cap, islandWalls);
      const displacement = surround ? cap.fit.offset - surround.fit.offset : 0;
      type = displacement < 0 ? "pocket" : "boss";
      if (hasCylExtent) depth = hi - lo;
      else if (surround) depth = displacement;
      else return null;   // no cylindrical wall and no surrounding plane: nothing to measure
    }
    depth = Math.abs(depth);

    const islandArea = topo ? facesArea(topo, islandFaces) : cap.area;
    const centroid = topo ? facesCentroid(topo, islandFaces) : [0, 0, 0];
    const faceScope = { [cap.id]: islandFaces };
    for (const { w, faces } of islandWalls) faceScope[w.id] = faces;

    return {
      id: null,
      // Geometry-derived, not `cap.id` (a segmentation surface id assigned in
      // triangle-DISCOVERY order — round 2 review: permuting a mesh's own triangle
      // order, same geometry, moved a boss's key). `cap.fit.offset`/`normal` pin
      // down the cap's own PLANE (canonicalised by `orientPlaneOutward`,
      // surface-graph.js, independent of input order); the island's own area AND
      // centroid (round 3 review) separate two same-depth, same-plane islands —
      // two co-height bosses on the same face, or even two identically-sized ones
      // at different positions, which area alone cannot tell apart. `round3`
      // absorbs the float-associativity noise a permuted summation order
      // introduces (Task 4's own ruling, R29).
      key: `${type}:${round3(depth)}:${round3(cap.fit.offset)}:` +
        `${cap.fit.normal.map(round3).join(",")}:${round3(islandArea)}:${centroid.map(round3).join(",")}`,
      type, depth, direction,
      floorFace: cap.id,
      wallFaces: islandWalls.map(({ w }) => w.id),
      profile: profileOf(graph, cap),
      surfaces: [cap.id, ...islandWalls.map(({ w }) => w.id)],
      // Per-surface face lists SCOPED to this specific island — describe.js's
      // candidate builder reads this (when present) instead of a named surface's
      // WHOLE face list, which is what let a merged wall or cap silently pull in
      // a neighbouring island's geometry (round 3 review; describe.js's own
      // `surfaceVertices` docs the consuming side).
      faceScope,
      evidence: {
        walls: islandWalls.length,
        // Whole-cap arc counts, shared across every island of the same merged
        // surface — a diagnostic field, not a measurement anything downstream
        // depends on being island-exact.
        concaveArcs: arcs.filter((a) => a.convexity === "concave").length,
        convexArcs: arcs.filter((a) => a.convexity === "convex").length,
      },
    };
  }

  // Attempt one cap as a feature's own defining plane. `isBase` picks which depth
  // fallback and which type this cap is allowed to resolve to; returns an ARRAY of
  // pushed features (one per island — almost always exactly one), or null if this cap
  // does not resolve into any (already claimed, no unclaimed walls left to it, or no
  // way to measure a depth on any of its islands).
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

    // ISLANDS — see this file's header for the full reasoning. Almost always exactly
    // one; `topo`'s absence (a caller that hasn't wired it) is treated the same as
    // "definitely one island", which is this file's pre-fix behaviour exactly.
    const capIslands = topo ? islandsOf(topo, cap.faces) : [cap.faces];

    const features = [];
    for (const islandFaces of capIslands) {
      // Re-scope every side wall to just the component actually touching THIS
      // island — a wall can itself be multi-island (this file's header), and a
      // wall with nothing bordering this particular island contributes nothing
      // to it.
      const islandWalls = sideWalls
        .map((w) => ({ w, faces: topo ? wallIslandFor(topo, w, islandFaces) : w.faces }))
        .filter((x) => x.faces.length > 0);
      if (islandWalls.length === 0) continue;

      const f = buildFeature(cap, isBase, islandFaces, islandWalls, direction, arcs);
      if (f) features.push(f);
    }
    if (features.length === 0) return null;

    claimed.add(cap.id);
    for (const w of sideWalls) claimed.add(w.id);
    return features;
  }

  // Pass one: the single base extrusion, largest cap first.
  for (const cap of allCaps) {
    const feats = tryCap(cap, out.length === 0);
    if (feats) { out.push(...feats); break; }
  }
  // Pass two: everything left, smallest cap first (see header for why the order flips).
  for (const cap of [...allCaps].sort((a, b) => a.area - b.area)) {
    const feats = tryCap(cap, false);
    if (feats) out.push(...feats);
  }

  return out;
}
