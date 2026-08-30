// Cross-backend agreement for k.vector2d. It lowers to k.shape2d, which both
// backends implement, and the regions are curve-native — so the extruded bbox
// must match the Manifold figure to within meshing tolerance.
// OCCT-booting: this file must contain NO Manifold boot (AGENTS.md).
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing.js";
import part from "../src/parts/emblem.js";

let k;
beforeAll(async () => { k = await bootOcctKernel({ vectors: part.vectors }); });

test("the emblem extrudes to the same bbox on OCCT as on Manifold", () => {
  const { min, max } = k.vector2d("emblem", { width: 40 }).extrude({ h: 2 }).boundingBox();
  expect(max[0] - min[0]).toBeCloseTo(40, 1);
  expect(max[1] - min[1]).toBeCloseTo(30, 1);
  expect(max[2] - min[2]).toBeCloseTo(2, 3);
});
