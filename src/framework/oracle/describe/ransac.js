// Efficient RANSAC (Schnabel/Wahl/Klein 2007) over the faces region growing could
// not claim. Growth is connectivity-driven and therefore blind to a surface split
// into disjoint islands by a feature crossing it — a plane interrupted by a boss,
// a wall broken by a slot. RANSAC is consensus-driven and does not care whether its
// inliers touch, so the two are complementary rather than redundant.
//
// DETERMINISM IS A HARD REQUIREMENT, not a nicety. Oracle output feeds a
// content-hash memo (spec §4.1) and the framework's purity rule forbids Math.random
// outright, so candidate sampling walks a fixed stride over the face list instead
// of drawing randomly. Same input, same patches, every run, in every process.
//
// Pure leaf. See spec §2.3.
import { fitPlane, fitCylinder, fitCone, fitSphere, fitTorus, deviationOf } from "./fit.js";

const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const unit = (a) => { const n = Math.hypot(a[0], a[1], a[2]); return n > 0 ? [a[0]/n, a[1]/n, a[2]/n] : [0, 0, 0]; };

// A minimal sample is 2 FACES (6 vertices, 6 normals — three per triangle). Two,
// not three, because this mop-up's own primary target (per the file header — a
// plane cut by a boss, a wall cut by a slot) is a flat CAD face reduced by
// tessellation to as few as TWO triangles, so a threshold of three would make
// that exact, common case unrecoverable by construction, not by any real
// shortfall of consensus: three DISTINCT triangles drawn from a mesh where a
// real plane is only ever two triangles wide can never all land on that one
// plane (verified directly on `boxMesh`: every 3-triangle sample mixes at least
// two different quads, and the least-squares plane through two different box
// faces' points misses tolerance by millimetres, never by noise). `minInliers`
// is the same number, for the same reason.
const SAMPLE_FACES = 2;
const MIN_INLIERS = SAMPLE_FACES;
const STRIDE = 7;           // coprime-ish walk so successive samples are spread out

// Above this many faces, trying every pair stops being cheap enough to just do
// (see `candidatePairs`). `unassigned` is a residual — the faces region growing's
// own connectivity search already failed to place — so it is expected to be a
// small remainder of a part, not the part itself; this budget is generous
// against that expectation (~130 faces' worth of pairs) while still bounding the
// cost on a pathological input.
const PAIR_BUDGET = 8192;

// Angle band for "this face's own normal is compatible with the fit's local
// surface normal here", radians (30°) — reuses segment.js's own smoothness
// ceiling (`SMOOTH_DIHEDRAL_MAX`) rather than inventing a second unrelated
// constant for what is conceptually the same question: how much a face's flat
// normal may disagree with a claimed smooth surface before the two are
// considered different surfaces. Not re-imported (segment.js doesn't export
// it) because the two live in siblings with no shared parent to hoist a
// constant into without ransac.js importing FROM segment.js — a leaf importing
// its own caller — so the value is restated here with this comment as the
// tether between them.
const NORMAL_COS_MIN = Math.cos(Math.PI / 6);

const faceNormalOf = (topo, t) => [topo.faceNormal[3*t], topo.faceNormal[3*t+1], topo.faceNormal[3*t+2]];
function faceCentroid(topo, t) {
  const c = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const v = topo.tris[3*t + k] * 3;
    c[0] += topo.verts[v]; c[1] += topo.verts[v+1]; c[2] += topo.verts[v+2];
  }
  return [c[0]/3, c[1]/3, c[2]/3];
}
function facePoints(topo, faces) {
  const pts = [], normals = [];
  for (const t of faces) {
    const n = faceNormalOf(topo, t);
    for (let k = 0; k < 3; k++) {
      const v = topo.tris[3*t + k] * 3;
      pts.push([topo.verts[v], topo.verts[v+1], topo.verts[v+2]]);
      normals.push(n);
    }
  }
  return { pts, normals };
}

// Worst distance from a face's three vertices to a fitted primitive. Exported because
// segment.js's growth predicate needs exactly the same question answered exactly the same
// way; the point-to-primitive distance itself lives in fit.js (ruling R19), so there is
// one definition and neither consumer can drift from it.
export function faceDeviation(topo, t, fit) {
  let worst = 0;
  for (let k = 0; k < 3; k++) {
    const v = topo.tris[3*t + k] * 3;
    const d = Math.abs(deviationOf(fit, [topo.verts[v], topo.verts[v+1], topo.verts[v+2]]));
    if (d > worst) worst = d;
  }
  return worst;
}

// GRAD_H: the step of a central-difference gradient of `deviationOf`, taken as the
// fit's local unit outward normal. Not five hand-derived per-type normal formulas
// (one per fit in fit.js) — that would be five MORE places a normal convention
// could quietly drift from `deviationOf`'s own sign convention, exactly the
// duplication ruling R19 already forbids for distance. `deviationOf` is a smooth
// signed-distance-like field for every one of the five types by construction
// (fit.js's own docstring on the function), so its gradient anywhere near the
// surface IS that surface's local normal, generically, with no per-type case
// analysis needed. Fixed, not scaled to the fit's own size or the mesh's bbox:
// determinism forbids a step that depends on anything but the two arguments
// given, the same reason candidate sampling below walks a fixed stride rather
// than adapting to the pool.
const GRAD_H = 1e-4;
function fitNormalAt(fit, point) {
  const g = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const hi = [...point], lo = [...point];
    hi[a] += GRAD_H; lo[a] -= GRAD_H;
    g[a] = deviationOf(fit, hi) - deviationOf(fit, lo);
  }
  return unit(g);
}

// Why consensus needs BOTH a distance test and this one, not distance alone: a
// box's 8 corners lie, EXACTLY (to floating-point noise), on infinitely many
// circumscribing cylinders and spheres — any axis through the centroid parallel
// to a principal direction gives a cylinder every corner sits on; the
// circumsphere every corner sits on is a further such case. That is not a
// tessellation artifact, it is elementary solid geometry (a rectangular box's
// vertices are, by definition, equidistant from its centroid along suitably
// chosen axes), so it recurs on every rectangular fixture, not a fluke of one
// mesh — measured directly against every one of the 66 cross-quad pairs of
// `boxMesh`'s 12 triangles: the ones not sharing a quad fit a cylinder AND a
// sphere to machine precision. A distance-only consensus test can't tell that
// coincidence apart from a real surface. A real surface's own faces have flat
// normals that track the surface's local tangent as it's actually built; a box
// face dropped onto someone else's circumscribing sphere has a flat normal
// (say, straight down off the bottom) that has nothing to do with that
// sphere's local outward direction there (radially away from a center nowhere
// near below it) — measured directly at tens of degrees apart, well outside
// any plausible smoothness band. This is the standard Efficient RANSAC
// safeguard (Schnabel/Wahl/Klein score every inlier on normal compatibility,
// not distance alone), restated here because the immediate trigger for adding
// it was exactly this box fixture.
function faceNormalConsistent(topo, t, fit) {
  return dot(fitNormalAt(fit, faceCentroid(topo, t)), faceNormalOf(topo, t)) >= NORMAL_COS_MIN;
}

// The minimal-sample hypothesis is PLANE ONLY, never cylinder/cone/sphere/torus,
// even though every fit is available (and used) once a consensus set has grown —
// see the REFIT step below. This is not a simplification of convenience: two
// faces supply only two independent surface-normal directions, and that is
// structurally too little to trust a 5-DOF ruled-surface fit (a cylinder's or
// cone's axis) with. Measured directly on `boxMesh`: EVERY pair of triangles
// drawn from two different, unrelated quads satisfies `fitCylinder` (and
// `fitSphere`) to machine-precision residual — a rectangular box's vertices are
// always equidistant from its centroid along the right axis, so a "cylinder"
// or "sphere" hypothesis born from almost any two unrelated flat facets isn't
// evidence of curvature at all, it's an artifact of how much freedom two
// normal directions leave a 5-DOF fit. No fixed normal-consistency or distance
// threshold closes this reliably (the more elongated a box's cross-section,
// the closer two unrelated facets' radial deviation drifts toward zero,
// eliminating any fixed-angle margin as the aspect ratio grows), so the
// principled fix is not to widen the FILTER but to narrow what a minimal
// sample is trusted to CLAIM: a plane needs only three points to be exactly
// determined (fit.js's own MIN_PTS), so two flat facets are already enough
// data to trust a plane hypothesis with no analogous coincidence risk (two
// unrelated, non-coplanar quads do NOT satisfy a common plane to any close
// tolerance — verified on the same fixture). This mirrors segment.js's own
// seed/grow split (a lone seed triangle is only ever classified provisionally,
// never asked to prove a curved type) rather than inventing a new principle.
function planeHypothesis(topo, sample, tol) {
  const { pts, normals } = facePoints(topo, sample);
  const f = fitPlane(pts);
  if (!f || f.maxDev > tol) return null;
  // fitPlane's normal is an eigenvector of a covariance matrix, and an
  // eigenvector's sign is arbitrary — fit.js never canonicalizes it, because
  // nothing in a bare point cloud says which side is "outward". A mesh face
  // does say: `topo.faceNormal` is the winding-derived outward direction, the
  // one thing `faceNormalConsistent` actually needs the fitted plane's normal
  // to agree with. Without this, the two ends up antiparallel roughly half the
  // time (whichever way the eigensolver happened to land), and
  // `faceNormalConsistent` then rejects the SAME faces that produced the
  // hypothesis in the first place — reproduced directly: `boxMesh`'s bottom
  // quad fit a plane with normal (0,0,1) while its own triangles carry (0,0,-1),
  // and the consensus step threw away the seed pair itself. Flipping both
  // `normal` and `offset` together (so `dot(normal,p) = offset` still holds)
  // re-expresses the identical plane with the sign the mesh's own winding
  // agrees with; summing agreement across the whole sample rather than
  // checking one face keeps the corrected sign robust to a single face's
  // winding being the unusual one.
  let agree = 0;
  for (const n of normals) agree += dot(f.normal, n);
  return agree < 0 ? { ...f, normal: [-f.normal[0], -f.normal[1], -f.normal[2]], offset: -f.offset } : f;
}

// FINAL classification of a converged consensus set, once RANSAC has stopped
// growing it: the full ascending-DOF ladder (plane, then cylinder/cone, then
// sphere/torus), first candidate within tolerance — same policy, and the same
// justification, as segment.js's `bestFit`. By the time this runs, `sample`
// is the WHOLE inlier set (already filtered on both distance and normal
// consistency against the seed plane), not a bare minimal sample, so it carries
// far more independent constraint than the two-facet hypothesis above and does
// not share that hypothesis's degenerate-fit risk.
function candidateFrom(topo, sample, tol) {
  const { pts, normals } = facePoints(topo, sample);
  for (const f of [fitPlane(pts), fitCylinder(pts, normals), fitCone(pts, normals),
                   fitSphere(pts), fitTorus(pts, normals)]) {
    if (f && f.maxDev <= tol) return f;
  }
  return null;
}

// Every candidate pair of faces in the pool, deterministically ordered, up to
// `PAIR_BUDGET`. Exhaustive rather than sampled, whenever the pool is small
// enough to afford it (see `PAIR_BUDGET`) — because a coprime-stride WALK over
// the pool (this file's first cut, and the brief's own suggestion) can skip
// EVERY same-source pair outright: for `boxMesh`, a single quad's own two
// triangles are adjacent in face-index order, and `pool.length >> 2` staggers
// consecutive picks a quarter of the pool apart specifically so they are NOT
// adjacent — the walk that was meant to spread samples out over the pool
// instead never lands on the one relationship (two triangles of the SAME real
// face) this mop-up's own primary target actually needs (reproduced directly:
// with the stride walk, every one of the 12 rounds available for a 12-face box
// misses all six same-quad pairs, and RANSAC recovers nothing). A stride is a
// reasonable way to spread samples across a pool whose valid pairs are
// uniformly likely to be anywhere; it is the wrong tool once "anywhere" turns
// out to include a specific, common, structured case a fixed offset provably
// never reaches. Exhaustive enumeration has no such blind spot by construction.
// Falls back to a bounded stride walk only once the pool is too large to
// enumerate within budget, trading a (rare, defensive-only) chance of missing a
// pair for a hard cap on cost.
function candidatePairs(pool) {
  const n = pool.length;
  const pairs = [];
  if ((n * (n - 1)) / 2 <= PAIR_BUDGET) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([pool[i], pool[j]]);
    return pairs;
  }
  const span = Math.max(1, n >> 2);
  for (let round = 0; round < PAIR_BUDGET; round++) {
    const a = pool[(round * STRIDE) % n], b = pool[(round * STRIDE + span) % n];
    if (a !== b) pairs.push([a, b]);
  }
  return pairs;
}

export function ransacPatches(topo, faces, tol, opts = {}) {
  const minInliers = opts.minInliers ?? MIN_INLIERS;
  let pool = [...faces];
  const patches = [];

  while (pool.length >= minInliers) {
    let best = null;
    // Deterministic minimal samples: every candidate pair, not drawn at random
    // (see the file header — determinism is a hard requirement, not a style
    // preference) and not a coprime-stride subset either (see `candidatePairs`
    // for why that seemed reasonable and provably was not).
    for (const sample of candidatePairs(pool)) {
      const fit = planeHypothesis(topo, sample, tol);
      if (!fit) continue;
      const inliers = pool.filter((t) => faceDeviation(topo, t, fit) <= tol && faceNormalConsistent(topo, t, fit));
      if (inliers.length >= minInliers && (!best || inliers.length > best.inliers.length)) best = { fit, inliers };
    }
    if (!best) break;
    // Refit and reclassify on the full consensus set: the minimal sample only
    // located a plane, and every subsequent consumer reads these parameters as
    // measurements. `candidateFrom` here can, and sometimes should, come back
    // with a NON-plane type — an island whose faces all satisfy the seed plane's
    // distance+normal test can still turn out to be better described some other
    // way once every one of its faces (not just two) is fitted at once. Falls
    // back to the minimal-sample fit (never null: the loop above only records
    // `best` when `fit` succeeded) if the larger set fails every candidate
    // outright — that can happen when the consensus set's extra faces are within
    // `tol` of the seed plane individually but their combined least-squares
    // refit drifts just past it.
    const refit = candidateFrom(topo, best.inliers, tol) ?? best.fit;
    patches.push({
      id: `r${patches.length}`, faces: best.inliers, fit: refit,
      area: best.inliers.reduce((a, t) => a + topo.faceArea[t], 0),
    });
    const claimed = new Set(best.inliers);
    pool = pool.filter((t) => !claimed.has(t));
  }

  return { patches, unassigned: pool };
}
