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

// Fit acceptance band, as a fraction of the mesh's bbox diagonal. A CAD
// tessellation's chord error is bounded and small; this sits an order of magnitude
// above it so faceting never breaks a surface apart, and well below any real
// feature size so two genuinely different surfaces never merge.
const FIT_TOL_FRAC = 3e-4;
const MIN_PATCH_FACES = 1;
const REFIT_ROUNDS = 3;

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

// Neighbour faces across non-boundary edges.
function neighbours(topo, t) {
  const out = [];
  for (const ei of topo.faceEdges[t]) {
    const e = topo.edges[ei];
    if (e.triB < 0) continue;
    out.push(e.triA === t ? e.triB : e.triA);
  }
  return out;
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
      const queue = [...faces];
      let grew = false;
      while (queue.length) {
        for (const nb of neighbours(topo, queue.pop())) {
          if (owner[nb] >= 0 || topo.faceArea[nb] <= 0) continue;
          if (faceDeviation(topo, nb, fit) > tol) continue;   // see helper below
          faces.push(nb); owner[nb] = patches.length; queue.push(nb); grew = true;
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
  return { patches, unassigned };
}
