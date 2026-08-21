// Mesh faces -> primitive patches. The classic reverse-engineering segmentation,
// implemented rather than invented (spec "Prior art"): seed in normal space, grow
// on the dual graph under a primitive predicate, refit as the region grows, repeat
// to stability.
//
// Why BOTH seeding and growing, when either alone half-works: Gauss-map bucketing
// alone cannot separate two parallel planes at different offsets, and it shreds a
// tessellated cylinder into one bucket per facet. Region growing alone has no idea
// where to start and picks up whatever its arbitrary seed happened to touch. Seeds
// give growth a well-conditioned starting hypothesis; growth gives seeds their
// spatial coherence. This is the same structure Efficient RANSAC and VSA arrive at
// from different directions.
//
// The patches this produces are CANDIDATES, not truth (spec §2.8) — accept.js
// decides what is real. So a slightly over-eager grow here is recoverable, and the
// tolerances lean permissive on purpose.
//
// Pure leaf. See spec §2.3.
import { fitPlane, fitCylinder, fitCone, fitSphere, fitTorus, deviationOf } from "./fit.js";
import { ransacPatches } from "./ransac.js";

// Fit acceptance band, as a fraction of the mesh's bbox diagonal. A CAD
// tessellation's chord error is bounded and small; this sits an order of magnitude
// above it so faceting never breaks a surface apart, and well below any real
// feature size so two genuinely different surfaces never merge.
const FIT_TOL_FRAC = 3e-4;
// Reserved dial, not currently load-bearing: every seed is a single triangle,
// three points always define SOME plane exactly (rms/maxDev = 0), so `bestFit`
// (with MIN_PTS.plane = 3) can only fail on a seed whose points are so close to
// collinear that fit.js's own rank guard rejects it as degenerate — everything
// else clears `faces.length < MIN_PATCH_FACES` at its default of 1 trivially.
// Left in place (rather than deleted) as the one knob a future revision would
// raise to also discard small-but-valid patches as noise; it does nothing at 1.
const MIN_PATCH_FACES = 1;
const REFIT_ROUNDS = 3;

// Fold-angle ceiling for a growth candidate's shared edge, in radians (30°).
// This is what keeps growth from ever crossing a genuine surface boundary, and
// it has to be checked BEFORE the adaptive tolerance below is allowed to widen
// anything: unlike a chord-error tolerance, a dihedral angle is SCALE-INVARIANT
// under retessellation — a cylinder wall's own internal facet-to-facet fold is
// 2π/segs and shrinks toward zero as the mesh gets finer, while a genuine
// cylinder-to-cap edge stays at 90° no matter how fine the mesh gets. Gating on
// this first is what makes it safe to widen tolerance adaptively next: without
// this gate, the adaptive term below would inflate the tolerance most at
// exactly the sharp edges it must never cross (a large dihedral would imply a
// large permitted deviation, backwards from what's needed). `topology.js`
// already computes signed dihedrals per edge, so this check costs nothing extra.
const SMOOTH_DIHEDRAL_MAX = Math.PI / 6;

// Scales the adaptive tolerance below. Calibrated, not guessed: measured the
// ACTUAL worst-vertex deviation of a wall facet's true first neighbour against
// `w * dihedral` (see `leverArm`) across cylinderMesh(4, 10, N) for N = 16..240
// and found the two track each other almost exactly (ratio 0.99-1.00 at every
// N tried) — `w * dihedral` IS the chord sagitta this predicate needs to admit,
// not merely proportional to it. 1.5 keeps a real margin above that measured
// 1:1 correspondence without weakening the dihedral gate above, which is what
// actually protects genuinely different surfaces from merging.
const FACET_K = 1.5;

// `FACET_K * leverArm * |dihedral|` has NO ceiling: leverArm grows with facet
// size without limit, so a large, coarsely-tessellated flat face (exactly the
// shape a CAD exporter emits for a big plane — ONE quad) gets an arbitrarily
// loose effective tolerance at a FIXED fold angle. Measured directly: two flat
// quads hinged at 10°-29° merge into a single mis-typed "cylinder" patch at
// every facet width from 5 to 100mm, a regression this dihedral+adaptive
// design introduced (verified absent on the pre-adaptive code). The dihedral
// gate alone can't catch this — 10-29° is exactly the range it's SUPPOSED to
// let through for real curvature.
//
// The physical distinction: on a genuinely tessellated curve, `leverArm /
// dihedral` (the IMPLIED RADIUS of curvature — see `impliedRadius`) is close
// to CONSTANT and density-independent: every internal edge implies close to
// the same radius, because that's what "the same curved surface, sampled at
// different densities" means. On a flat-to-flat fold, that same ratio is
// UNBOUNDED (a fixed design angle over an arbitrarily large facet), and
// crucially there is only ONE such edge — a real polygon corner borders
// exactly one other face along it, alone, with no repetition. A genuinely
// curved patch, by contrast, always has at least one MORE internal edge with
// a closely matching implied radius and sign nearby (the facet on the
// curve's other side), because the curvature that produced this edge's fold
// didn't stop existing one facet later.
//
// So the adaptive allowance is granted only when the candidate edge's fold
// has a WITNESS: another edge of the same sign and comparable IMPLIED RADIUS,
// either already confirmed inside the growing patch, or discovered in the
// very same growth pass (see `established`/`sameFamily` in `segment`). A lone
// fold, however permissive the raw sagitta arithmetic would allow, never
// gets one.
//
// Comparing on implied radius rather than on raw dihedral matters, not just
// as a style choice: measured directly on a flat plane tangent (G1-smooth) to
// a cylinder wall, sharing one edge with it — the FIRST-order tangent
// transition edge has EXACTLY HALF the dihedral of the wall's own internal
// wall-to-wall edges (1.875° vs 3.75° at N=96; 0.9626° vs 1.925° at N=187 —
// consistently a factor of 2, at every density tried, so this is a general
// property of a tangent boundary, not a fixture artifact), while its
// `leverArm` is IDENTICAL to the internal edge's. Raw-dihedral matching
// would treat "half the internal step" as plausibly the same family (well
// within a loose ratio bound) and merge the flat plane into the cylinder
// through a small leaked chunk — reproduced directly before this fix.
// Implied radius makes the gap explicit and large: the tangent edge's
// leverArm/dihedral comes out at ~2x the wall's own true radius (~8mm vs the
// fixture's actual r=4mm) at every density tried, a robust, structural
// distinction (a G1-tangent boundary is HALF a facet-step removed from the
// curve's own interior sampling, definitionally) rather than a coincidence
// of one test case.
//
// `MATCH_RATIO` sits between that measured 1x (genuine internal consistency)
// and 2x (the tangent-boundary artifact) gap: loose enough that a uniformly
// tessellated surface's implied radius (identical edge to edge on every
// fixture measured) clears it with margin, tight enough that the 2x tangent
// artifact does not.
const MATCH_RATIO = 1.5;

// The radius of curvature this edge's fold IMPLIES, if it were one facet's
// worth of sampling a circular arc: `leverArm` (the chord's perpendicular
// throw) over the fold angle, since for small angles the two are related by
// `leverArm ≈ R * dihedral`. Meaningless (and never called) for a flat
// (dihedral = 0) edge.
const impliedRadius = (leverArm, dihedral) => leverArm / Math.abs(dihedral);

// Same sign (same convexity direction) and within a MATCH_RATIO factor of
// each other in IMPLIED RADIUS — the corroboration test `established`/
// `pending` signatures call to decide whether a candidate edge's fold is "the
// same curvature sampled again" rather than an unrelated coincidence (a
// design corner, or a tangent boundary onto a DIFFERENT surface — see the
// comment on MATCH_RATIO for why implied radius, not raw dihedral, is what
// gets compared).
function sameFamily(sigA, sigB) {
  if (sigA.sign !== sigB.sign) return false;
  const ratio = sigA.R / sigB.R;
  return ratio >= 1 / MATCH_RATIO && ratio <= MATCH_RATIO;
}

// The corroboration signature for one nonzero-dihedral edge: its convexity
// sign and its implied radius. Built once, wherever an edge is about to enter
// `established` or `pending`, rather than re-derived ad hoc at each compare.
const familySignature = (edge, arm) => ({ sign: Math.sign(edge.dihedral), R: impliedRadius(arm, edge.dihedral) });

// All five candidates over the same trial set, in ascending order of degrees of
// freedom. Two different policies read this list for two different purposes
// below (`bestFit` vs `growthFit`) — see the comment on `growthFit` for why one
// list needs two different consumers rather than one.
function candidateFits(pts, normals) {
  return [fitPlane(pts), fitCylinder(pts, normals), fitCone(pts, normals), fitSphere(pts), fitTorus(pts, normals)];
}

// FINAL classification, once a patch has stopped growing: the FIRST candidate
// (ascending DOF) that fits within tolerance, never the best-scoring one. A plane
// is a degenerate cylinder of infinite radius and a cylinder is a degenerate cone
// of zero angle, so "best RMS" would routinely dress a flat face as a huge-radius
// cylinder and produce a technically-accurate, semantically-useless report.
function bestFit(pts, normals, tol) {
  for (const f of candidateFits(pts, normals)) if (f && f.maxDev <= tol) return f;
  return null;
}

// GROWTH driver: of the candidates within tolerance, the one with the SMALLEST
// residual — deliberately NOT `bestFit`'s ascending-DOF policy, and this is not
// a stylistic difference, it is the difference between a segmenter that finds
// cylinders and one that cannot. Every smooth surface is locally flat: a patch
// of only a few facets sits well inside a tangent plane's chord tolerance no
// matter what it will turn out to be, so `bestFit` calls it a plane the moment
// it is asked, before there is enough of the patch gathered to tell a genuine
// flat from the first few facets of a cylinder. If THAT verdict is what drives
// growth (candidates tested against it via `faceDeviation`), the region cannot
// escape it: every newly admitted face must itself pass the same plane test, so
// the accumulated set can never carry enough curvature to invalidate its own
// classification — growth halts exactly at the tangent plane's tolerance
// boundary, one facet short of ever trying the cylinder that was available the
// whole time (verified empirically during this task: a tessellated cylinder
// wall seeded and refit under `bestFit` converges to a stable ~3-facet "plane"
// and then permanently stops growing, regardless of tessellation fineness,
// because the growth test and the classification test were the same policy).
// A true surface's residual falls toward zero as its patch grows (more of a
// real cylinder is still exactly a cylinder), while an increasingly strained
// plane's residual grows with it — the two curves cross well before the
// plane's tolerance is exhausted, so picking the smaller one lets growth adopt
// the cylinder as soon as there is enough data to prefer it, and keep going.
// `bestFit` still gets the final say (see below): once growth has converged,
// re-running its ascending-DOF policy on the finished point set is what stops
// a genuinely flat patch (whose non-plane candidates fail outright on
// degenerate normals, or the same trap risk elsewhere) from being reported as
// whatever curved thing this driver preferred mid-growth.
function growthFit(pts, normals, tol) {
  let best = null;
  for (const f of candidateFits(pts, normals)) {
    if (f && f.maxDev <= tol && (!best || f.maxDev < best.maxDev)) best = f;
  }
  return best;
}

const faceNormalOf = (topo, t) => [topo.faceNormal[3*t], topo.faceNormal[3*t+1], topo.faceNormal[3*t+2]];

// All three vertices of a face, so a fit sees the real surface rather than a cloud
// of centroids — a cylinder fitted from centroids alone comes out systematically
// under-radius by the sagitta of one facet.
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

// Worst distance from a face's three vertices to a fitted primitive. The growth
// predicate (ruling R19): cheap, allocation-light, and it reuses the ONE definition of
// point-to-primitive distance that fit.js owns, so growth and RANSAC can never disagree
// about what "within tolerance" means.
function faceDeviation(topo, t, fit) {
  let worst = 0;
  for (let k = 0; k < 3; k++) {
    const v = topo.tris[3*t + k] * 3;
    const d = Math.abs(deviationOf(fit, [topo.verts[v], topo.verts[v+1], topo.verts[v+2]]));
    if (d > worst) worst = d;
  }
  return worst;
}

const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];

// Neighbour faces across non-boundary edges, paired with the edge itself (its
// signed dihedral and endpoints) rather than bare face ids — the growth
// predicate below needs both to gate on fold sharpness and to size its
// tolerance to the actual local facet geometry, not a global constant.
function neighbourEdges(topo, t) {
  const out = [];
  for (const ei of topo.faceEdges[t]) {
    const e = topo.edges[ei];
    if (e.triB < 0) continue;
    out.push({ face: e.triA === t ? e.triB : e.triA, edge: e });
  }
  return out;
}

// The local facet "width" a chord-error tolerance needs to scale with: NOT the
// shared edge's own length (on this mesh family that edge commonly runs ALONG
// the surface's straight axis — e.g. a cylinder wall's wall-to-wall edge is
// vertical, its full length the part's height, entirely unrelated to how far
// apart the facets are AROUND the curve) but the LEVER ARM the fold actually
// pivots on: the perpendicular distance from the shared edge's line out to the
// candidate face's farthest vertex. A dihedral fold of angle θ about that line
// displaces a point at lever arm L by approximately L·θ for small θ — exactly
// the chord sagitta this predicate needs to admit, confirmed by measuring this
// quantity against the real worst-vertex deviation across N = 16..240 on
// cylinderMesh (see FACET_K) rather than assumed.
function leverArm(topo, edge, nbFace) {
  const v0 = [topo.verts[3*edge.v0], topo.verts[3*edge.v0+1], topo.verts[3*edge.v0+2]];
  const v1 = [topo.verts[3*edge.v1], topo.verts[3*edge.v1+1], topo.verts[3*edge.v1+2]];
  const dir = sub(v1, v0);
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (len === 0) return 0;
  const u = [dir[0]/len, dir[1]/len, dir[2]/len];
  let worst = 0;
  for (let k = 0; k < 3; k++) {
    const v = topo.tris[3*nbFace + k] * 3;
    const perp = cross(sub([topo.verts[v], topo.verts[v+1], topo.verts[v+2]], v0), u);
    const dist = Math.hypot(perp[0], perp[1], perp[2]);
    if (dist > worst) worst = dist;
  }
  return worst;
}

// Classifies one growth candidate against the standing fit. Returns
// `{ verdict, leverArm }`. `tol` alone is NOT a safe unconditional pass for a
// NONZERO-dihedral edge, even though it always was for the pre-adaptive
// design: `tol` is a fraction of the WHOLE MESH's bbox diagonal, so one large
// feature anywhere in the same part (a big flat face, say) inflates it for
// every OTHER feature too — measured directly, a coarse flat plane merely
// 50mm across was enough to inflate `tol` past the true, small deviation of a
// genuine flat-to-cylinder transition edge, letting it through with no
// dihedral or corroboration check ever firing. So only a genuinely FLAT
// continuation (`edge.convexity === "flat"` — the two triangles of one
// tessellated quad, or any edge a real curve's own sampling makes coplanar)
// is unconditionally safe ("accept", no corroboration: there is no fold to
// be wrong about).
//
// This MUST be `topology.js`'s own `convexity` band (`|dihedral| <
// FLAT_EPS`), never an exact `dihedral === 0` check: a genuinely coplanar
// pair of triangles only comes out bit-exact zero when the mesh happens to
// be axis-aligned, which is a property of the FIXTURE, not of the geometry.
// Rotate the very same mesh by an arbitrary angle and the identical
// coplanar diagonal computes to something like `-9.4e-17` — a real zero
// with the wrong bit pattern from accumulated floating-point rounding in
// the cross/dot/atan2 chain `topology.js` derives it through. An exact
// equality test sends that edge down the "pending" path instead, where its
// own numerically-noisy implied radius has nothing to corroborate against
// (it is the ONLY internal edge a single seed triangle has), and growth
// never gets past one triangle — verified directly: every mesh in this
// module's own test fixtures is axis-aligned, which is exactly why this
// shipped working and rotating ANY of them (a cylinder, a box, a washer,
// at every density tried) collapsed growth entirely.
//
// Every other edge within the smoothness ceiling — whether it clears the
// plain `tol` or only the facet-scaled adaptive allowance — is "pending":
// admissible only with a witness (see `sameFamily`/`familySignature` and
// the growth loop in `segment`), because a nonzero fold is exactly the
// case a witness-less allowance can quietly get wrong. `leverArm` is
// reported whenever the edge clears the dihedral gate so the caller can
// build a corroboration signature without recomputing it.
function classifyCandidate(topo, edge, nb, fit, tol) {
  if (Math.abs(edge.dihedral) > SMOOTH_DIHEDRAL_MAX) return { verdict: "reject" };
  const dev = faceDeviation(topo, nb, fit);
  if (edge.convexity === "flat") return { verdict: dev <= tol ? "accept" : "reject" };
  const arm = leverArm(topo, edge, nb);
  const adaptive = FACET_K * arm * Math.abs(edge.dihedral);
  return { verdict: dev <= Math.max(tol, adaptive) ? "pending" : "reject", leverArm: arm };
}

// Seed order: bucket faces by quantized normal on the Gauss sphere, then visit the
// buckets largest-area-first. Big flat regions get claimed while the fit is
// best-conditioned, and the fiddly transition strips (fillets, chamfers) are left
// for last instead of being grown into by accident.
function seedOrder(topo) {
  const buckets = new Map();
  for (let t = 0; t < topo.faceArea.length; t++) {
    if (topo.faceArea[t] <= 0) continue;
    const n = faceNormalOf(topo, t);
    const key = `${Math.round(n[0]*24)},${Math.round(n[1]*24)},${Math.round(n[2]*24)}`;
    if (!buckets.has(key)) buckets.set(key, { area: 0, faces: [] });
    const b = buckets.get(key);
    b.area += topo.faceArea[t];
    b.faces.push(t);
  }
  return [...buckets.values()].sort((a, b) => b.area - a.area).flatMap((b) => b.faces);
}

export function segment(topo, opts = {}) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < topo.verts.length; i += 3) for (let a = 0; a < 3; a++) {
    if (topo.verts[i+a] < lo[a]) lo[a] = topo.verts[i+a];
    if (topo.verts[i+a] > hi[a]) hi[a] = topo.verts[i+a];
  }
  const tol = opts.tol ?? Math.hypot(hi[0]-lo[0], hi[1]-lo[1], hi[2]-lo[2]) * FIT_TOL_FRAC;

  const owner = new Int32Array(topo.faceArea.length).fill(-1);
  const patches = [];

  for (const seed of seedOrder(topo)) {
    if (owner[seed] >= 0) continue;
    let faces = [seed];
    owner[seed] = patches.length;
    let fit = growthFit(...Object.values(facePoints(topo, faces)), tol);
    if (!fit) { owner[seed] = -1; continue; }

    // Corroboration signatures (sign + implied radius, see `familySignature`)
    // for the nonzero-dihedral edges this patch has already grown across,
    // carried across REFIT_ROUNDS (not reset per round) so a later, coarser
    // round can corroborate against curvature evidence an earlier round already
    // established — see `sameFamily` / `classifyCandidate` for why a "pending"
    // (adaptive-only) candidate needs a witness here before it can be admitted.
    const established = [];

    // Grow, refit, grow again. Refitting matters: a patch seeded on one facet of a
    // cylinder starts out fitted as a PLANE, and only once it has grown across a few
    // facets does the cylinder fit become the better description. Without the refit
    // rounds the whole wall would come out as a fan of tiny planes.
    for (let round = 0; round < REFIT_ROUNDS; round++) {
      // Candidates are tested against the CURRENT fit's parameters, not by re-fitting
      // the whole trial set (controller ruling R19). Re-fitting per candidate would call
      // growthFit/bestFit — and therefore fitTorus, the most expensive fit at ~3-17ms —
      // on every REJECTED neighbour, which is most of them: a trial set spanning two
      // surfaces fits nothing, so it falls through every cheaper fit first. That is
      // thousands of full fits per part. A deviation check against the standing fit is
      // the standard region-growing formulation, is orders of magnitude cheaper, and is
      // correctness-neutral because the refit below re-converges the patch each round.
      let grew = false;
      // Fixed-point loop: a pass may admit some faces outright (flat `tol`) and
      // shelve others as "pending" (adaptive-only, awaiting a witness). Promoting
      // a pending candidate can itself supply the witness a DIFFERENT pending
      // candidate was waiting on (or open up brand-new neighbours), so the whole
      // scan repeats until a full pass changes nothing.
      let changed = true;
      while (changed) {
        changed = false;
        const queue = [...faces];
        const pending = [];
        const pendingOwned = new Set();
        while (queue.length) {
          for (const { face: nb, edge } of neighbourEdges(topo, queue.pop())) {
            if (owner[nb] >= 0 || topo.faceArea[nb] <= 0 || pendingOwned.has(nb)) continue;
            const { verdict, leverArm: arm } = classifyCandidate(topo, edge, nb, fit, tol);
            if (verdict === "reject") continue;
            if (verdict === "accept") {
              faces.push(nb); owner[nb] = patches.length; queue.push(nb);
              grew = true; changed = true;
              if (edge.convexity !== "flat") established.push(familySignature(edge, arm));
              continue;
            }
            pending.push({ nb, edge, leverArm: arm }); pendingOwned.add(nb);   // verdict === "pending"
          }
        }
        for (const p of pending) {
          if (owner[p.nb] >= 0) continue;   // claimed by another pending promotion this pass
          const sig = familySignature(p.edge, p.leverArm);
          const witnessed = established.some((s) => sameFamily(s, sig)) ||
            pending.some((q) => q !== p && sameFamily(familySignature(q.edge, q.leverArm), sig));
          if (!witnessed) continue;
          faces.push(p.nb); owner[p.nb] = patches.length;
          established.push(sig);
          grew = true; changed = true;
        }
      }
      if (!grew) break;
      const { pts, normals } = facePoints(topo, faces);
      // growthFit, not bestFit, drives the NEXT round's growth test — see the
      // comment on growthFit for why using the ascending-DOF classification here
      // would permanently trap a curved patch under its own youngest plane fit.
      fit = growthFit(pts, normals, tol) ?? fit;
    }

    if (faces.length < MIN_PATCH_FACES) { for (const t of faces) owner[t] = -1; continue; }
    // The growth loop's `fit` was chosen to keep growth moving, not to name the
    // surface; re-run the ascending-DOF classification on the now-converged point
    // set for the type actually reported, so a genuinely flat patch that
    // growthFit happened to grow under a curved fit (its normals are degenerate
    // for every non-plane candidate, so this risk is chiefly theoretical, but the
    // final call belongs to `bestFit`'s stricter policy regardless) is still
    // reported as what it is.
    const { pts, normals } = facePoints(topo, faces);
    const finalFit = bestFit(pts, normals, tol) ?? fit;
    patches.push({
      id: `q${patches.length}`, faces, fit: finalFit,
      area: faces.reduce((a, t) => a + topo.faceArea[t], 0),
    });
  }

  const unassigned = [];
  for (let t = 0; t < owner.length; t++) if (owner[t] < 0 && topo.faceArea[t] > 0) unassigned.push(t);

  // Region growing is connectivity-bound; RANSAC is not. Anything growth could not
  // claim gets one consensus pass before it is declared residual, so a surface split
  // into islands by a crossing feature is recovered rather than reported as a hole in
  // the description. `opts.ransac === false` skips it — used by ransac.js's own tests
  // and by the budget path in accept.js.
  if (opts.ransac !== false && unassigned.length) {
    const mop = ransacPatches(topo, unassigned, tol);
    patches.push(...mop.patches);
    return { patches, unassigned: mop.unassigned };
  }
  return { patches, unassigned };
}
