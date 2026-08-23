// Polygon-footprint reconstruction: a prismatic feature whose footprint is neither a
// box nor a circle must be rebuilt from its cap's own measured boundary loops, not
// its bounding box. The motivating specimens are in the third-party corpus — a sword
// bookmark whose bounding-box candidate is mostly air (rejected, volume score 0) and
// a real box whose reconstruction stalled at ~24% — but the fixtures here are exact,
// kernel-built, and orientation-swept, per this project's standing lesson: measure
// invariance across rotations, don't reason about it.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { describe as describeMesh } from "../src/framework/oracle/describe.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// An L: the simplest footprint a bounding box overshoots badly (the box candidate
// doubles the true 4800mm³ volume, scores a poor xor-gain, and loses).
const L = [[0, 0], [40, 0], [40, 10], [10, 10], [10, 30], [0, 30]];

test("an L-shaped extrusion reconstructs from its measured footprint", () => {
  const r = describeMesh(k, k.extrude({ profile: L, h: 8 }), { digest: "fp-L" });
  expect(r.error).toBeUndefined();
  expect(r.score.explainedArea).toBeGreaterThan(0.99);
  expect(r.score.explainedVolumeFraction).toBeGreaterThan(0.9);
});

test("the rotated L reconstructs the same way", () => {
  // 29° about an oblique axis — the committed angle every orientation regression in
  // this feature has used, because it is the one that has actually caught bugs.
  const axis = [1, 2, 3].map((v) => v / Math.hypot(1, 2, 3));
  const solid = k.extrude({ profile: L, h: 8 }).rotate(29, [0, 0, 0], axis);
  const r = describeMesh(k, solid, { digest: "fp-L-rot" });
  expect(r.error).toBeUndefined();
  expect(r.score.explainedVolumeFraction).toBeGreaterThan(0.9);
});

test("an annular footprint (outer loop + hole loop) reconstructs, hole included", () => {
  // A square plate with a square hole: the cap is one surface with TWO loops, and a
  // candidate built from only the outer loop would overfill the hole and score worse
  // than one honouring both.
  const outer = [[0, 0], [30, 0], [30, 30], [0, 30]];
  const hole = [[10, 10], [20, 10], [20, 20], [10, 20]];
  const r = describeMesh(k, k.extrude({ profile: { outer, holes: [hole] }, h: 6 }), { digest: "fp-annular" });
  expect(r.error).toBeUndefined();
  expect(r.score.explainedVolumeFraction).toBeGreaterThan(0.9);
});
