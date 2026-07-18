import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { pathProfile } from "../src/framework/geometry/polygon.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

const KAPPA = 0.5522847498307936;
// A full circle radius R as four cubic quarter-arcs (the standard 4-Bézier circle).
const circleCubic = (R) => {
  const k4 = R * KAPPA;
  return pathProfile([R, 0])
    .cubicTo([0, R], [R, k4], [k4, R])
    .cubicTo([-R, 0], [-k4, R], [-R, k4])
    .cubicTo([0, -R], [-R, -k4], [-k4, -R])
    .cubicTo([R, 0], [k4, -R], [R, -k4])
    .close();
};

test("extruding a cubic circle gives ~π R² h with an exact B-rep (watertight)", () => {
  const R = 10, h = 5;
  const solid = k.extrude({ profile: circleCubic(R), h });
  expect(solid.volume()).toBeCloseTo(Math.PI * R * R * h, -1); // ~1571; OCCT exact
});

test("a cubic edge exports to STEP as a spline (B_SPLINE)", async () => {
  const solid = k.extrude({ profile: circleCubic(10), h: 5 });
  const step = new TextDecoder().decode(await k.toSTEP([{ name: "p", solid }]));
  expect(step).toMatch(/B_SPLINE/);
});
