import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { pathProfile, circleProfile } from "../src/framework/geometry/polygon.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const KAPPA = 0.5522847498307936;
const circleCubic = (R) => {
  const k4 = R * KAPPA;
  return pathProfile([R, 0])
    .cubicTo([0, R], [R, k4], [k4, R])
    .cubicTo([-R, 0], [-k4, R], [-R, k4])
    .cubicTo([0, -R], [-R, -k4], [-k4, -R])
    .cubicTo([R, 0], [k4, -R], [R, -k4])
    .close();
};

test("extruding a cubic circle yields ~π R² h and a watertight (genus 0) solid", () => {
  const R = 10, h = 5;
  const solid = k.extrude({ profile: circleCubic(R), h });
  expect(solid.volume()).toBeCloseTo(Math.PI * R * R * h, -2); // faceted → looser tol
  expect(solid.genus()).toBe(0);
});

test("cubic circle and circleProfile extrude to matching volumes (LOD parity)", () => {
  const R = 10, h = 5;
  const cubicVol = k.extrude({ profile: circleCubic(R), h }).volume();
  const arcVol = k.extrude({ profile: circleProfile(R), h }).volume();
  // Both facet the same circle at mesh LOD; adaptive vs fixed segs differ slightly.
  expect(Math.abs(cubicVol - arcVol) / arcVol).toBeLessThan(0.02); // within 2%
});
