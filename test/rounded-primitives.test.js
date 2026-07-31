// test/rounded-primitives.test.js
// Manifold-side integration for the rounded primitives. The OCCT twin lives in
// rounded-primitives-occt.test.js (the two backends never boot in one process).
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import {
  roundedCylinderVolume, torusVolume, roundedBoxVolume, minkowskiRoundedBoxVolume,
} from "./fixtures/rounded-oracles.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const rel = (actual, exact) => Math.abs(actual - exact) / exact;

test("oracle self-check: quadrature agrees with the Minkowski anchor", () => {
  expect(rel(roundedBoxVolume([20, 14, 10], { side: 3, top: 3, bottom: 3 }),
    minkowskiRoundedBoxVolume([20, 14, 10], 3))).toBeLessThan(1e-5);
});

test("roundedCylinder volume matches the lathe oracle", () => {
  const v = k.roundedCylinder({ r: 8, h: 20, round: { top: 3, bottom: 1.5 } }).volume();
  expect(rel(v, roundedCylinderVolume(8, 20, { top: 3, bottom: 1.5 }))).toBeLessThan(0.01);
});

test("capsule boundary (round = r, top + bottom = h) builds watertight — a sphere", () => {
  const s = k.roundedCylinder({ r: 5, h: 10, round: 5 });
  expect(s.isEmpty()).toBe(false);
  expect(s.genus()).toBe(0);
  expect(rel(s.volume(), (4 / 3) * Math.PI * 125)).toBeLessThan(0.01);
});

test("round: 0 degenerates to the plain cylinder", () => {
  const v = k.roundedCylinder({ r: 6, h: 9, round: 0 }).volume();
  expect(rel(v, k.cylinder({ r: 6, h: 9 }).volume())).toBeLessThan(0.005);
});

test("roundedCylinder center: true centers Z", () => {
  const bb = k.roundedCylinder({ r: 5, h: 12, round: 2, center: true }).boundingBox();
  expect(bb.min[2]).toBeCloseTo(-6, 5);
  expect(bb.max[2]).toBeCloseTo(6, 5);
});

test("torus: genus 1, volume 2π²·R·r²", () => {
  const s = k.torus({ rMajor: 10, rMinor: 3 });
  expect(s.genus()).toBe(1);
  expect(s.isEmpty()).toBe(false);
  expect(rel(s.volume(), torusVolume(10, 3))).toBeLessThan(0.01);
});

test("torus bounding box spans z ∈ [−rMinor, rMinor]", () => {
  const bb = k.torus({ rMajor: 10, rMinor: 3 }).boundingBox();
  expect(bb.min[2]).toBeCloseTo(-3, 3);
  expect(bb.max[2]).toBeCloseTo(3, 3);
  expect(bb.max[0]).toBeCloseTo(13, 2);
});
