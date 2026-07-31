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

test("revolve: a Shape2D profile crossing the axis (negative radius) throws", () => {
  expect(() => k.revolve({ profile: k.shape2d([[-1, 0], [5, 0], [5, 3], [-1, 3]]) }))
    .toThrow("revolve: profile radius must be ≥ 0");
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

test("stadium boundary (2·side = min(w,d)) is B-rep exact", () => {
  const round = { side: 6, top: 4, bottom: 4 };
  const v = k.roundedBox({ size: [20, 12, 10], round }).volume();
  expect(rel(v, roundedBoxVolume([20, 12, 10], round))).toBeLessThan(1e-4);
});

test("side = 0 full-height round-over (top + bottom = h) is B-rep exact", () => {
  const round = { side: 0, top: 4, bottom: 4 };
  const v = k.roundedBox({ size: [20, 20, 8], round }).volume();
  expect(rel(v, roundedBoxVolume([20, 20, 8], round))).toBeLessThan(1e-4);
});

test("roundedBox center: true centers Z on OCCT", () => {
  const bb = k.roundedBox({ size: [20, 14, 10], round: 2, center: true }).boundingBox();
  expect(bb.min[2]).toBeCloseTo(-5, 4);
  expect(bb.max[2]).toBeCloseTo(5, 4);
});

test("stadium rim == side: OCCT never ships fillet output that adds material", () => {
  // OCCT's fillet produces invalid geometry at this exact boundary (rim == side
  // on a stadium profile); the monotonicity gate must skip it loudly rather
  // than export it. The un-filleted stadium prism is the volume ceiling.
  const base = 20 * 12 * 10 - (4 - Math.PI) * 36 * 10; // stadium prism, side 6
  for (const round of [{ side: 6, top: 6 }, { side: 6, top: 6, bottom: 3 }]) {
    const v = k.roundedBox({ size: [20, 12, 10], round }).volume();
    expect(v, JSON.stringify(round)).toBeLessThanOrEqual(base + 1e-6);
  }
});

test("OCCT: round: 0 degenerates to the plain box, and side-only rounding matches the oracle", () => {
  const v = k.roundedBox({ size: [20, 12, 8], round: { side: 3, top: 0, bottom: 0 } }).volume();
  expect(rel(v, roundedBoxVolume([20, 12, 8], { side: 3, top: 0, bottom: 0 }))).toBeLessThan(1e-4);
});

test("OCCT: side = 0 wedge round-over with center: true centers Z", () => {
  const bb = k.roundedBox({ size: [20, 20, 8], round: { side: 0, top: 3, bottom: 2 }, center: true }).boundingBox();
  expect(bb.min[2]).toBeCloseTo(-4, 4);
  expect(bb.max[2]).toBeCloseTo(4, 4);
});
