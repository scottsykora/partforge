// Oracle: the deleted Manifold/Clipper2 offset route, reconstructed test-locally
// against the raw manifold-3d WASM (not the framework's manifold-backend.js, which
// no longer has an offset route at all — Shape2D.offset runs the native engine on
// BOTH backends now). This is the safety net for the native contour-offset engine:
// it exists to FIND divergence from Clipper2, not to be green.
//
// Compares round + sharp + chamfer. Chamfer maps to Clipper2's Round join with
// circularSegments=4 (NOT this file's SEGS=64) — the exact mapping the deleted
// manifold-backend.js used for chamfer, since a true 45-degree bevel is a 4-segment
// "round" arc collapsed to its chord. That mapping matches native to float precision
// at interior angles >= 90 degrees (the deleted backend's own comment: "the two agree
// to float precision for convex corners with interior angle >= 90deg"); at ACUTE
// (<90deg) corners Clipper2's 2-facet approximation genuinely diverges from native's
// true bevel (see KERNEL-CONTRACT / manifold-backend history) — but no corpus case
// below has an acute corner (square/L-shape/circle are all >=90deg), so that
// divergence is real but currently UNEXERCISED. A future acute-cornered corpus
// addition must account for this before enabling chamfer on it.
//
// Manifold must NOT boot in the same process as OCCT (see offset-oracle-occt.test.js) —
// this file boots only manifold-3d, and the two are separate vitest files (vitest
// isolates per file) so that invariant holds automatically.
import { beforeAll, describe, expect, test } from "vitest";
import Module from "manifold-3d";
import { offsetRegions } from "../src/framework/geometry/contour-offset.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea, pointInRing } from "../src/framework/geometry/shape2d-regions.js";

const SEGS = 64;
const rings = (regions) => regions.flatMap((rg) =>
  [tessellateContour(rg.outer, SEGS), ...rg.holes.map((h) => tessellateContour(h, SEGS))]);
const totalArea = (rs) => rs.reduce((a, r) => a + ringArea(r), 0);
// one-directional sampled boundary distance: max over a's points of min distance to b's segments
function boundaryDist(a, b) {
  const segDist = (p, q1, q2) => {
    const dx = q2[0] - q1[0], dy = q2[1] - q1[1];
    const L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - q1[0]) * dx + (p[1] - q1[1]) * dy) / L2));
    return Math.hypot(p[0] - (q1[0] + t * dx), p[1] - (q1[1] + t * dy));
  };
  let worst = 0;
  for (const ring of a) for (const p of ring) {
    let best = Infinity;
    for (const r2 of b) for (let i = 0; i < r2.length; i++)
      best = Math.min(best, segDist(p, r2[i], r2[(i + 1) % r2.length]));
    worst = Math.max(worst, best);
  }
  return worst;
}
const hausdorff = (a, b) => Math.max(boundaryDist(a, b), boundaryDist(b, a));

// Corpus: name, regions (contour IR), deltas to test. Polygonal + curved cases.
const sq = (s) => ({ outer: { start: [0, 0], segments: [{ to: [s, 0] }, { to: [s, s] }, { to: [0, s] }, { to: [0, 0] }] }, holes: [] });
const circ = (r) => ({ outer: { start: [r, 0], segments: [{ via: [0, r], to: [-r, 0] }, { via: [0, -r], to: [r, 0] }] }, holes: [] });
const Lsh = { outer: { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 10] }, { to: [5, 10] }, { to: [5, 5] }, { to: [0, 5] }, { to: [0, 0] }] }, holes: [] };
const CORPUS = [
  { name: "square", regions: [sq(10)], deltas: [1, -1, 2.5], curved: false },
  { name: "circle", regions: [circ(5)], deltas: [1, -2], curved: true },
  { name: "L-shape", regions: [Lsh], deltas: [1, -1.5], curved: false },
  { name: "square+hole", regions: [{ ...sq(10), holes: [{ start: [4, 4], segments: [{ to: [4, 6] }, { to: [6, 6] }, { to: [6, 4] }, { to: [4, 4] }] }] }], deltas: [0.5, -0.5], curved: false },
];
const AREA_RTOL = 0.005;                       // 0.5 %
const HAUS_TOL = (curved) => (curved ? 2e-2 : 5e-3);  // curved: absorb the oracle's own faceting

let CrossSection;
beforeAll(async () => {
  const wasm = await Module();
  wasm.setup();
  CrossSection = wasm.CrossSection;
});

// [joinType, circularSegments] — chamfer rides Clipper2's Round join but with
// circularSegments=4 instead of this file's SEGS=64, matching the deleted
// manifold-backend.js's own chamfer mapping exactly (a 4-segment "round" arc IS a
// 45-degree-chord bevel, not a curve).
const JOIN = { round: ["Round", SEGS], sharp: ["Miter", SEGS], chamfer: ["Round", 4] };
for (const { name, regions, deltas, curved } of CORPUS) {
  for (const delta of deltas) for (const corners of ["round", "sharp", "chamfer"]) {
    test(`${name} delta=${delta} ${corners} matches Clipper2 within tolerance`, () => {
      const native = rings(offsetRegions(regions, delta, { corners }));
      const cs = CrossSection.ofPolygons(rings(regions), "EvenOdd");
      const [joinType, circularSegments] = JOIN[corners];
      const oracle = cs.offset(delta, joinType, 2, circularSegments).toPolygons();
      expect(Math.abs(totalArea(native) - totalArea(oracle)) / Math.abs(totalArea(oracle))).toBeLessThan(AREA_RTOL);
      expect(hausdorff(native, oracle)).toBeLessThan(HAUS_TOL(curved));
    });
  }
}

// Known divergences (parked): cases where the native engine is KNOWN to disagree
// with the true offset result, verified by independent grid computation. These are
// NOT part of the honest-agreement corpus above — asserting equality here would
// either fail (masking nothing) or force the tolerances open (masking everything
// else). Instead: characterization tests. Each asserts the native engine's CURRENT
// (defective) measured value within a loose band, with the true value and root
// cause recorded in a comment, so a regression that makes the defect WORSE breaks
// the band, and a fix that makes it correct is expected to break the band too —
// at which point the case should be deleted from here and promoted to the main
// corpus above.
describe("known divergences (parked)", () => {
  test("wide L-pocket: delta closes a 5-wide-arm pocket but native leaves a residual", () => {
    // 30x20 plate with a wide L-shaped pocket (5-unit arms, the same shape family as
    // test/contour-offset.test.js's narrow-arm (4-unit) L-pocket fixture, scaled up)
    // cut out, offset +3. Max inscribed circle in the pocket has radius 2.5 < delta 3,
    // so the pocket (hole) should fully close (0 holes remain, true area = 928.274 —
    // pure (w+2d)(h+2d) - (4-pi)d^2 rounded-rect growth of the 30x20 plate, since no
    // hole survives to subtract). Root cause: no global validity check on a raw offset
    // ring that is locally valid (simple, correctly wound) but should have vanished
    // entirely — see contour-offset.js's own comment above the (removed) Part 2 prune
    // for the history of this exact case (task-5B-report.md's round-2 section measured
    // this same shape's residual at delta+3/round as area 921.2116882454313; measured
    // here at 921.19 — the ~0.02 difference is this file's own SEGS=64 tessellation vs
    // that report's own sampling, not a behavior change).
    const plate = { start: [0, 0], segments: [{ to: [30, 0] }, { to: [30, 20] }, { to: [0, 20] }, { to: [0, 0] }] };
    // L-pocket, both arms 5 wide: vertical arm x:[10,15] y:[6,15]; horizontal arm
    // y:[6,11] x:[10,21]; reflex vertex at (15,11). CW (hole) winding.
    const pocket = { start: [10, 6], segments: [
      { to: [10, 15] }, { to: [15, 15] }, { to: [15, 11] }, { to: [21, 11] }, { to: [21, 6] }, { to: [10, 6] }] };
    const region = { outer: plate, holes: [pocket] };
    const out = offsetRegions([region], 3, { corners: "round" });
    const holeCount = out.reduce((n, rg) => n + rg.holes.length, 0);
    const area = out.reduce((a, rg) => a + Math.abs(ringArea(tessellateContour(rg.outer, SEGS)))
      - rg.holes.reduce((h, hole) => h + Math.abs(ringArea(tessellateContour(hole, SEGS))), 0), 0);
    // True: holeCount === 0, area === 928.274. Native currently leaves the hole
    // ring in place (residual, unclosed pocket; measured area ~921.19) — assert the
    // CURRENT (measured) behavior in a tight band around 921.19, NOT anchored on the
    // true 928.274, so a drift toward the true value (which would mean the defect got
    // smaller without anyone noticing/fixing it deliberately) breaks this test instead
    // of silently passing. This case has no topological backstop (unlike cases 2-3
    // below, which assert overlap/non-containment explicitly) — holeCount > 0 alone
    // doesn't pin the magnitude, so this band is doing the real characterization work.
    expect(holeCount).toBeGreaterThan(0);
    expect(area).toBeGreaterThan(921.19 - 0.5);
    expect(area).toBeLessThan(921.19 + 0.5);
  });

  test("merge: two nearby holes overlap into an invalid double-ring, not one merged hole", () => {
    // 40x20 plate with two 6x8 holes 3mm apart, delta -2 sharp. True merged area
    // is 348 (round-corner truth 352.68) once the two holes fuse into one. Native
    // instead returns TWO separate, OVERLAPPING hole rings — a topologically
    // invalid result (rings intersect, not merged). Root cause: ringsCross (used
    // by validateRawOffset) never calls segsOverlap, so a raw pair of holes whose
    // boundaries cross via collinear overlap (not a transversal crossing) passes
    // validation uncaught — see contour-offset.js ~283-287.
    const plate = { start: [0, 0], segments: [{ to: [40, 0] }, { to: [40, 20] }, { to: [0, 20] }, { to: [0, 0] }] };
    // Two 6x8 holes (CW), 3mm apart horizontally: first x in [10,16], second x in [19,25], both y in [6,14].
    const holeA = { start: [10, 6], segments: [{ to: [10, 14] }, { to: [16, 14] }, { to: [16, 6] }, { to: [10, 6] }] };
    const holeB = { start: [19, 6], segments: [{ to: [19, 14] }, { to: [25, 14] }, { to: [25, 6] }, { to: [19, 6] }] };
    const region = { outer: plate, holes: [holeA, holeB] };
    const out = offsetRegions([region], -2, { corners: "sharp" });
    const rg = out[0];
    // Pin the defect as a defect: the two grown holes overlap rather than having
    // merged into one simple ring.
    expect(rg.holes.length).toBe(2);
    const ringsOf = rg.holes.map((h) => tessellateContour(h, SEGS));
    const overlaps = (a, b) => a.some((p) => pointInRing(p, b)) || b.some((p) => pointInRing(p, a));
    expect(overlaps(ringsOf[0], ringsOf[1])).toBe(true);
    // Loose characterization band on the (topologically-invalid, so not directly
    // comparable to the true merged value) net area native currently reports.
    const area = Math.abs(ringArea(tessellateContour(rg.outer, SEGS)))
      - rg.holes.reduce((h, hole) => h + Math.abs(ringArea(tessellateContour(hole, SEGS))), 0);
    expect(area).toBeGreaterThan(300);
    expect(area).toBeLessThan(348 - 0.5);
  });

  test("breakthrough: a hole near the edge stays unclipped by the eroded outer", () => {
    // 40x20 plate with a 10x10 hole 2mm from the bottom edge, delta -2 sharp.
    // True area (hole breaks through the eroded outer's bottom edge) is 408
    // (round-corner truth 409.72). Native keeps the full grown hole, unclipped by
    // the eroded outer boundary — a topologically invalid result (hole ring not
    // contained in its outer). Root cause: validateRawOffset's hole-containment
    // check only tests ONE point (h[0]) of the hole ring against the outer — see
    // contour-offset.js ~300 (pointInRing(h[0], rg.outer)) — which is satisfied
    // even when most of the hole ring has escaped outside the eroded outer.
    const plate = { start: [0, 0], segments: [{ to: [40, 0] }, { to: [40, 20] }, { to: [0, 20] }, { to: [0, 0] }] };
    // 10x10 hole (CW), bottom edge 2mm above the plate's bottom edge (y in [2,12]).
    const hole = { start: [15, 2], segments: [{ to: [15, 12] }, { to: [25, 12] }, { to: [25, 2] }, { to: [15, 2] }] };
    const region = { outer: plate, holes: [hole] };
    const out = offsetRegions([region], -2, { corners: "sharp" });
    const rg = out[0];
    const outerRing = tessellateContour(rg.outer, SEGS);
    expect(rg.holes.length).toBe(1);
    const holeRing = tessellateContour(rg.holes[0], SEGS);
    // Pin the defect: the hole ring is NOT fully contained in the outer (it
    // breaks through what should be the eroded bottom edge).
    expect(holeRing.every((p) => pointInRing(p, outerRing))).toBe(false);
    const area = Math.abs(ringArea(outerRing)) - Math.abs(ringArea(holeRing));
    expect(area).toBeGreaterThan(300);
    expect(area).toBeLessThan(408 - 0.5);
  });

  test("clustered reflex corners: chamfer offset over-resolves a 9-gon", () => {
    // 9-gon with several clustered reflex corners, chamfer offset delta -2.79.
    // True eroded area is 2.76 (a thin sliver); native resolves to roughly 7.71 —
    // several times too much surviving area. Root cause: resolveSelfRegions
    // (paper-bridge.js) doesn't correctly untangle the self-intersections a
    // chamfer offset produces when several reflex corners sit close together —
    // see contour-offset.js's Part-1-deletion-guard comment (~193-213) for the
    // same 9-gon used as the deletion-guard's own regression repro.
    const pts = [[19.49, 10], [12.33, 11.95], [11.2, 16.81], [8.87, 11.96], [0.93, 13.3], [3.45, 7.62], [8.52, 7.44], [10.92, 4.78], [15.09, 5.73]];
    const nonagon = { start: pts[0], segments: [...pts.slice(1).map((p) => ({ to: p })), { to: pts[0] }] };
    const out = offsetRegions([{ outer: nonagon, holes: [] }], -2.79, { corners: "chamfer" });
    const area = out.reduce((a, rg) => a + Math.abs(ringArea(tessellateContour(rg.outer, SEGS))), 0);
    // True: 2.76. Native currently resolves to ~7.71 — characterize the current
    // (over-inclusive) behavior in a loose band around that measured value.
    expect(area).toBeGreaterThan(2.76 + 0.5);
    expect(area).toBeLessThan(9);
  });
});
