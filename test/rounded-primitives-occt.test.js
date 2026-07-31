// test/rounded-primitives-occt.test.js
// OCCT twin of rounded-primitives.test.js. B-rep volumes are exact, so the
// tolerance is the oracle's quadrature error, not a facet tolerance.
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import {
  roundedCylinderVolume, torusVolume, roundedBoxVolume, minkowskiRoundedBoxVolume,
} from "./fixtures/rounded-oracles.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

const rel = (actual, exact) => Math.abs(actual - exact) / exact;

test("roundedCylinder volume is B-rep exact against the oracle", () => {
  const v = k.roundedCylinder({ r: 8, h: 20, round: { top: 3, bottom: 1.5 } }).volume();
  expect(rel(v, roundedCylinderVolume(8, 20, { top: 3, bottom: 1.5 }))).toBeLessThan(1e-4);
});

test("capsule boundary is exact (a sphere)", () => {
  const v = k.roundedCylinder({ r: 5, h: 10, round: 5 }).volume();
  expect(rel(v, (4 / 3) * Math.PI * 125)).toBeLessThan(1e-6);
});

test("torus volume is B-rep exact", () => {
  const v = k.torus({ rMajor: 10, rMinor: 3 }).volume();
  expect(rel(v, torusVolume(10, 3))).toBeLessThan(1e-6);
});

test("validation errors are backend-identical (shared normalizer)", () => {
  expect(() => k.torus({ rMajor: 3, rMinor: 5 })).toThrow("torus: requires 0 < rMinor < rMajor");
  expect(() => k.roundedCylinder({ r: 8, h: 4, round: { top: 3, bottom: 2 } }))
    .toThrow("roundedCylinder: round.top + round.bottom must be ≤ h");
});

test("STEP export carries real curved surfaces (no faceting)", async () => {
  const torusStep = new TextDecoder().decode(
    await k.toSTEP([{ name: "t", solid: k.torus({ rMajor: 10, rMinor: 3 }) }]));
  expect(torusStep).toMatch(/TOROIDAL_SURFACE/);
  const cylStep = new TextDecoder().decode(
    await k.toSTEP([{ name: "c", solid: k.roundedCylinder({ r: 8, h: 20, round: 2 }) }]));
  expect(cylStep).toMatch(/TOROIDAL_SURFACE/); // the rim round-over is a torus band
});

test("all-equal roundedBox is B-rep exact against the Minkowski form", () => {
  const v = k.roundedBox({ size: [20, 14, 10], round: 3 }).volume();
  expect(rel(v, minkowskiRoundedBoxVolume([20, 14, 10], 3))).toBeLessThan(1e-6);
});

test("selective radii (side > rims) are B-rep exact against the oracle", () => {
  const round = { side: 4, top: 2, bottom: 1 };
  const v = k.roundedBox({ size: [24, 16, 12], round }).volume();
  expect(rel(v, roundedBoxVolume([24, 16, 12], round))).toBeLessThan(1e-4);
});

test("side = 0 wedge-cut round-over is B-rep exact against the oracle", () => {
  const round = { side: 0, top: 3, bottom: 2 };
  const v = k.roundedBox({ size: [20, 20, 8], round }).volume();
  expect(rel(v, roundedBoxVolume([20, 20, 8], round))).toBeLessThan(1e-4);
});

test("roundedBox STEP export carries spherical corner patches (all-equal)", async () => {
  const step = new TextDecoder().decode(
    await k.toSTEP([{ name: "b", solid: k.roundedBox({ size: [20, 14, 10], round: 3 }) }]));
  expect(step).toMatch(/SPHERICAL_SURFACE/);
});
