import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { circleProfile } from "../src/framework/geometry/polygon.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

const SQ = (x0, y0, s) => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];

test("hull of two separated squares → convex wrap, area 300", () => {
  const shape = k.hull([SQ(0, 0, 10), SQ(20, 0, 10)]);
  expect(shape.area()).toBeCloseTo(300, 1);
  expect(shape.toRegions()).toHaveLength(1);
});

test("hullChain of three circles → one connected region, extrudes to a positive volume", () => {
  const c = (x) => circleProfile(4, [x, 0]);
  const chain = k.hullChain([c(0), c(20), c(40)]);
  expect(chain.toRegions()).toHaveLength(1);
  expect(k.extrude({ profile: chain, h: 2 }).volume()).toBeGreaterThan(0);
});

test("hullChain requires ≥2 inputs", () => {
  expect(() => k.hullChain([circleProfile(4)])).toThrow(/2/);
});
