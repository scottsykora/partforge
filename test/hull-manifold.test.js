import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { circleProfile } from "../src/framework/geometry/polygon.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const SQ = (x0, y0, s) => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];

test("hull of two separated squares → their convex wrap (area)", () => {
  // squares [0..10]² and [20..30]×[0..10]; convex hull is the 30×10 trapezoid/rect band = 300
  const shape = k.hull([SQ(0, 0, 10), SQ(20, 0, 10)]);
  expect(shape.area()).toBeCloseTo(300, 3);
  expect(shape.toRegions()).toHaveLength(1); // convex → one region
});

test("hull of one circle ≈ the circle (faceted)", () => {
  const shape = k.hull([circleProfile(10)]);
  expect(shape.area()).toBeGreaterThan(300);   // πr²≈314, faceted slightly under
  expect(shape.area()).toBeLessThan(314.16);
});

test("hullChain of three circles in a row → one connected region larger than a single pair", () => {
  const c = (x) => circleProfile(4, [x, 0]);
  const chain = k.hullChain([c(0), c(20), c(40)]);
  expect(chain.toRegions()).toHaveLength(1);                 // connected
  const pair = k.hull([c(0), c(20)]);
  expect(chain.area()).toBeGreaterThan(pair.area());          // the second sweep adds area
});

test("hullChain requires ≥2 inputs; hull rejects degenerate input", () => {
  expect(() => k.hullChain([circleProfile(4)])).toThrow(/2/);
  expect(() => k.hull([])).toThrow(/hull/);
  expect(() => k.hull([[[0, 0], [1, 1]]])).toThrow(/hull/);   // 2 points → degenerate
});
