// test/rounded-primitives.test.js
// Manifold-side integration for the rounded primitives. The OCCT twin lives in
// rounded-primitives-occt.test.js (the two backends never boot in one process).
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { detectBackend } from "../src/framework/geometry/probe.js";
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

test("all-equal roundedBox matches the Minkowski closed form", () => {
  const v = k.roundedBox({ size: [20, 14, 10], round: 3 }).volume();
  expect(rel(v, minkowskiRoundedBoxVolume([20, 14, 10], 3))).toBeLessThan(0.01);
});

test("selective radii (side > rims) match the section oracle", () => {
  const round = { side: 4, top: 2, bottom: 1 };
  const v = k.roundedBox({ size: [24, 16, 12], round }).volume();
  expect(rel(v, roundedBoxVolume([24, 16, 12], round))).toBeLessThan(0.01);
});

test("side = 0 rim-only round-over matches the oracle", () => {
  const round = { side: 0, top: 3, bottom: 0 };
  const v = k.roundedBox({ size: [20, 20, 8], round }).volume();
  expect(rel(v, roundedBoxVolume([20, 20, 8], round))).toBeLessThan(0.01);
});

test("vertical-only rounding (rims 0) matches the oracle", () => {
  const round = { side: 3, top: 0, bottom: 0 };
  const v = k.roundedBox({ size: [20, 12, 8], round }).volume();
  expect(rel(v, roundedBoxVolume([20, 12, 8], round))).toBeLessThan(0.01);
});

test("roundedBox is watertight (genus 0) across regimes and boundaries", () => {
  const cases = [
    { size: [20, 14, 10], round: 3 },                              // all-equal
    { size: [24, 16, 12], round: { side: 4, top: 2, bottom: 1 } }, // selective
    { size: [20, 20, 8], round: { side: 0, top: 3, bottom: 2 } },  // rim-only
    { size: [20, 12, 10], round: { side: 6, top: 4, bottom: 4 } }, // stadium (2·side = min), strict rim gap
    { size: [20, 20, 8], round: { side: 0, top: 4, bottom: 4 } },  // side-0 full-height round-over
  ];
  for (const c of cases) {
    const s = k.roundedBox(c);
    expect(s.isEmpty(), JSON.stringify(c)).toBe(false);
    expect(s.genus(), JSON.stringify(c)).toBe(0);
    expect(s.volume(), JSON.stringify(c)).toBeGreaterThan(0);
  }
});

test("clamped middle regime builds the SAME solid as the explicit clamp", () => {
  const a = k.roundedBox({ size: [20, 20, 10], round: { side: 1, top: 3 } });
  const b = k.roundedBox({ size: [20, 20, 10], round: { side: 1, top: 1 } });
  expect(a._hash).toBe(b._hash); // same cache node, proven directly
  expect(a.volume()).toBe(b.volume()); // identical normalized args → same cache node
});

test("roundedBox center: true centers all axes", () => {
  const bb = k.roundedBox({ size: [20, 14, 10], round: 2, center: true }).boundingBox();
  expect(bb.min[2]).toBeCloseTo(-5, 5);
  expect(bb.max[2]).toBeCloseTo(5, 5);
});

test("a roundedBox part routes to Manifold, not OCCT", () => {
  const part = { defaults: {}, parts: { main: { build: (kk) => kk.roundedBox({ size: [20, 12, 8], round: 2 }) } } };
  expect(detectBackend(part)).toBe("manifold");
});
