// Efficient RANSAC (Schnabel/Wahl/Klein 2007) over the faces region growing could
// not claim. Growth is connectivity-driven and therefore blind to a surface split
// into disjoint islands by a feature crossing it — a plane interrupted by a boss,
// a wall broken by a slot. RANSAC is consensus-driven and does not care whether its
// inliers touch, so the two are complementary rather than redundant.
//
// DETERMINISM IS A HARD REQUIREMENT, not a nicety. Oracle output feeds a
// content-hash memo (spec §4.1) and the framework's purity rule forbids Math.random
// outright, so candidate sampling is built from the mesh's own topology and
// quantized normals instead of drawing randomly. Same input (same faces, in the
// same order — see `ransacPatches`'s own header note on that), same patches,
// every run, in every process.
//
// Pure leaf. See spec §2.3.
import { fitPlane, fitCylinder, fitCone, fitSphere, fitTorus, deviationOf } from "./fit.js";
import { facePoints } from "./segment.js";

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

// Quantization for "same normal direction, bucket together" — deliberately the
// same 1/24 grid `segment.js`'s own `seedOrder` uses for the identical purpose
// (grouping faces by Gauss-map direction), not a fresh constant invented here.
const NORMAL_BUCKET_SCALE = 24;
// Within one normal bucket, exhaustively pair only the first this-many members.
// A genuinely single real surface only needs ONE pair from its bucket to
// bootstrap (consensus then scans the WHOLE pool, not just the bucket, so it
// recovers every matching face regardless of which pair started it) — this cap
// only bounds the rarer case of one bucket holding several DIFFERENT parallel
// planes (same normal, different offset), where exhaustive intra-bucket
// pairing is what guarantees at least one same-offset pair is tried.
const BUCKET_PAIR_CAP = 24;
// Hard ceiling on total candidate pairs handed to the round below, applied
// AFTER generating the topological and normal-bucket pairs (see
// `candidatePairs`) — a cap on how much work gets EVALUATED, never a switch to
// a different, lossier way of choosing which pairs to generate. A prior
// version of this file used a coprime-stride walk as a fallback once the pool
// exceeded a budget, and that walk could — provably, not just theoretically —
// skip every same-facet pair a plane hypothesis needs (see `candidatePairs`'s
// own comment for the measured cylinder-wall regression this caused). The
// fix is not a bigger or smarter stride, it is to make the GENERATION itself
// structurally incapable of missing those pairs, and only THEN bound the
// total.
const PAIR_BUDGET = 65536;

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
// given, the same reason candidate generation below is built from the mesh's
// own topology and quantized normals rather than anything data-adaptive.
const GRAD_H = 1e-4;
function fitNormalAt(fit, point) {
  // Plane fast path: `deviationOf`'s plane branch is `dot(normal, point) -
  // offset`, exactly linear, so its gradient is `normal` EVERYWHERE, not just
  // near the surface — this isn't an approximation for the plane case, it's
  // the same answer the finite difference below converges to, without six
  // extra `deviationOf` calls per face checked. Consensus in this file only
  // ever calls this with a plane fit (`planeHypothesis` never hands back
  // anything else), so this is the path actually taken; the general
  // finite-difference fallback stays for `opts`/future callers that might
  // pass a converged non-plane fit through the same check.
  if (fit.type === "plane") return fit.normal;
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
// mesh — measured directly against all 60 cross-quad pairs of `boxMesh`'s 12
// triangles (the 66 total pairs of 12 triangles, less the 6 same-quad pairs):
// every one of those 60 fits a cylinder AND a sphere to machine precision. A
// distance-only consensus test can't tell that coincidence apart from a real
// surface. A real surface's own faces have flat
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

// Every candidate pair worth trying a plane hypothesis on, deterministically
// ordered. A plane needs matching normal direction (two faces from unrelated
// directions never fit one to any close tolerance — see `planeHypothesis`'s
// own comment), so the pairs that can EVER succeed are already a narrow,
// structured subset of all C(n,2) — this generates exactly that subset from
// two cheap, complementary sources instead of guessing at it with a stride:
//
// 1. TOPOLOGICAL NEIGHBOURS (`topo.faceEdges`): O(3n), and — this is the part
//    a coprime-stride walk got wrong — GUARANTEED to include the diagonal
//    pair of any single real flat facet still whole in the pool (a box quad's
//    own two triangles, a cylinder wall segment's own two triangles: they
//    share an edge by construction). A prior version of this file fell back
//    to a stride walk once the pool exceeded a budget, and that walk could
//    (measured directly: a 100-segment cylinder's 200 wall triangles, handed
//    to `ransacPatches` with no adjacency hint, at that budget) skip EVERY
//    one of the wall's 100 same-facet diagonal pairs, recovering only the two
//    caps and leaving the entire wall — exactly half the mesh — unassigned,
//    silently, with no error. Topological adjacency has no such blind spot:
//    it doesn't sample a subset hoping to land on the right pairs, it reads
//    the one relationship (shared edge) a real facet's own two triangles
//    always have, for every face in the pool, unconditionally.
// 2. NORMAL BUCKETS (see `NORMAL_BUCKET_SCALE`): reaches a face with NO
//    topological neighbour left in the pool at all — a genuinely isolated
//    sliver, or one half of a plane a crossing feature disconnected from its
//    other half — by pairing it with whatever ELSE in the pool shares its
//    (quantized) normal direction, the one thing any two pieces of the same
//    real flat surface are guaranteed to share. Bounded per bucket (see
//    `BUCKET_PAIR_CAP`) rather than fully exhaustive, because a bucket that
//    holds one real, already-topologically-connected surface already got its
//    bootstrap pair from source 1 above — this only needs to guarantee
//    covering pairs ACROSS disconnected pieces, which is cheap by
//    construction (few faces per genuine disconnected remainder).
//
// `PAIR_BUDGET` truncates the COMBINED result as a hard cap on total pairs
// evaluated, applied last and only as a cap — never as a reason to swap in a
// worse generator (see `PAIR_BUDGET`'s own comment).
function candidatePairs(topo, pool) {
  const seen = new Set();
  const pairs = [];
  const push = (a, b) => {
    if (a === b) return;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push(a < b ? [a, b] : [b, a]);
  };

  const inPool = new Set(pool);
  for (const t of pool) {
    for (const ei of topo.faceEdges[t]) {
      const e = topo.edges[ei];
      if (e.triB < 0) continue;
      const nb = e.triA === t ? e.triB : e.triA;
      if (inPool.has(nb)) push(t, nb);
    }
  }

  const buckets = new Map();
  for (const t of pool) {
    const n = faceNormalOf(topo, t);
    const key = `${Math.round(n[0]*NORMAL_BUCKET_SCALE)},${Math.round(n[1]*NORMAL_BUCKET_SCALE)},${Math.round(n[2]*NORMAL_BUCKET_SCALE)}`;
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, bucket = []);
    bucket.push(t);
  }
  for (const bucket of buckets.values()) {
    const m = Math.min(bucket.length, BUCKET_PAIR_CAP);
    for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) push(bucket[i], bucket[j]);
  }

  return pairs.length > PAIR_BUDGET ? pairs.slice(0, PAIR_BUDGET) : pairs;
}

export function ransacPatches(topo, faces, tol, opts = {}) {
  const minInliers = opts.minInliers ?? MIN_INLIERS;
  let pool = [...faces];
  const patches = [];

  while (pool.length >= minInliers) {
    let best = null;
    // Deterministic minimal samples: every pair `candidatePairs` generates, not
    // drawn at random (see the file header — determinism is a hard requirement,
    // not a style preference) and not a coprime-stride subset either (see
    // `candidatePairs` for why that seemed reasonable and provably was not).
    for (const sample of candidatePairs(topo, pool)) {
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
      faces: best.inliers, fit: refit,
      area: best.inliers.reduce((a, t) => a + topo.faceArea[t], 0),
    });
    const claimed = new Set(best.inliers);
    pool = pool.filter((t) => !claimed.has(t));
  }

  // Canonicalize order before numbering: the WHILE loop above discovers
  // patches in an order driven by `pool`'s own current arrangement (ties in
  // consensus size are broken by whichever candidate the pair generator
  // happened to try first), and `pool`'s arrangement starts from whatever
  // order the caller passed `faces` in. The set of faces in each patch is
  // provably order-invariant (region growing's own connectivity doesn't
  // enter into this file at all, and neither does array order — only which
  // faces satisfy a fitted plane's distance+normal test, which doesn't
  // depend on iteration order); the SEQUENCE they were discovered in is not,
  // and this file's own header claims "same input, same patches, every
  // run" — a claim that is only true if "same input" means the same SET of
  // faces, not the same order too, unless output order is made to not
  // depend on input order either. Sorting by each patch's own smallest face
  // index — a property of the mesh's topology, not of the caller's array —
  // gives a canonical order with no dependency on how `faces` happened to
  // be listed, closing that gap rather than merely documenting it.
  for (const p of patches) p.faces.sort((a, b) => a - b);
  patches.sort((a, b) => a.faces[0] - b.faces[0]);
  patches.forEach((p, i) => { p.id = `r${i}`; });

  // Same reasoning for the residual: its CONTENT (which faces went unclaimed)
  // is order-invariant, but `pool` carries whatever relative order the
  // caller's `faces` had. A plain ascending sort is the canonical form for a
  // bare list of face indices.
  pool.sort((a, b) => a - b);

  return { patches, unassigned: pool };
}
