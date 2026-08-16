// Morphological whole-solid rounding on the mesh backend: close-then-open with
// a ball — dilate(+r), erode(2r), dilate(+r) via Manifold's native Minkowski
// sum/difference. Rounds EVERY edge (convex and concave) at radius ≈ r and
// consumes features smaller than the ball (walls < 2r melt, holes < 2r seal) —
// that is the op's contract, not a defect (docs/roundall-design.md).
//
// simplify() between steps is mandatory, not an optimization: the naive
// Minkowski (hull-of-triangle-pairs) emits sliver-degenerate meshes whose
// complexity compounds through the chain — the design spike measured 106s and
// 761k broken-topology triangles without it vs 2.4s and 340 clean triangles
// with it, on the same torture case. asOriginal() first, because simplify()
// will not collapse triangles across run (originalID) boundaries and the
// Minkowski output is stitched from many.
//
// This op must NEVER throw KernelCapabilityError / NEEDS_OCCT: the mesh
// backend is roundAll's reference implementation — rerouting to OCCT would
// trade a correct result for a skip (occt-roundall.js can only skip where
// morphology exceeds what B-rep offsets support).
//
// INVARIANT — both balls share ONE segment count. Minkowski support functions
// add, so the chain displaces a face with normal n by 2·h_r(n) − h_2r(n), where
// h is the ball's support. Manifold spheres built with equal `segs` are similar
// (the 2r ball is the r ball scaled by two), so h_2r = 2·h_r and the term is
// exactly zero in EVERY direction — the input's planar faces return to their
// original planes. Give the two balls different segment counts and the term is
// only zero where a vertex happens to line up: axis-aligned boxes still look
// right while off-axis faces drift (measured 0.07mm at preview, r=2). The count
// is sized from the erosion ball (2r), the larger of the two, so the coarser of
// the two facetings still meets the tier's sagitta tolerance.

// Sphere tessellation from the facet sagitta r·(1 − cos(π/segs)): pick the
// fewest segments that keep it under the quality tier's tolerance.
const SAGITTA_TOL = { preview: 0.05, print: 0.01 }; // mm
export function roundAllSegs(r, quality) {
  const tol = SAGITTA_TOL[quality] ?? SAGITTA_TOL.preview;
  if (!(r > tol)) return 12;
  return Math.min(64, Math.max(12, Math.ceil(Math.PI / Math.acos(1 - tol / r))));
}

export function meshRoundAll(wasm, m, r, quality) {
  if (!Number.isFinite(r) || r <= 0) throw new Error("roundAll: r must be a finite number > 0 (r = 0 is handled as the identity by the caller)");
  const segs = roundAllSegs(2 * r, quality); // ONE count for BOTH balls — see the invariant above
  // Simplify tolerance: max(r/100, 0.01) mm, but never enough to collapse the
  // rim ring of a rounded edge into the next ring up. That ring sits
  // r·(1 − cos(2π/segs)) above the face plane, and it is what holds a planar
  // face at its exact position; collapsing it shaves the face inward (print
  // tier, r = 2: segs 45 puts the ring 0.0195 mm up, and a flat 0.02 tolerance
  // pulled every face of a box in by 0.034 mm). Half that spacing keeps margin.
  const tol = Math.min(Math.max(r / 100, 0.01), 0.5 * r * (1 - Math.cos((2 * Math.PI) / segs)));
  const step = (input, sphere, op) => {
    const raw = op === "sum" ? input.minkowskiSum(sphere) : input.minkowskiDifference(sphere);
    let orig;
    try {
      orig = raw.asOriginal();
    } finally {
      raw.delete?.();
    }
    try {
      return orig.simplify(tol);
    } finally {
      orig.delete?.();
    }
  };
  const sphR = wasm.Manifold.sphere(r, segs);
  const sph2R = wasm.Manifold.sphere(2 * r, segs);
  try {
    const a = step(m, sphR, "sum");          // dilate: rounds convex, seals holes < 2r
    let b;
    try {
      b = step(a, sph2R, "diff");        // erode 2r: melts walls < 2r
    } finally {
      a.delete?.();
    }
    try {
      return step(b, sphR, "sum");          // dilate back: final radius ≈ r everywhere
    } finally {
      b.delete?.();
    }
  } finally {
    sphR.delete?.();
    sph2R.delete?.();
  }
}
