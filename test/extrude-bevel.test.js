// extrude({ bevel }) — the backend-shared rim bevel (rim-bevel.js, desugared in
// kernel-front.js). Manifold half; test/extrude-bevel-occt.test.js is the OCCT
// twin (separate file — the two kernels must not boot in one process).
import { beforeAll, expect, test, vi } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { resolveBevel } from "../src/framework/geometry/rim-bevel.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const SQUARE = [[0, 0], [20, 0], [20, 20], [0, 20]];
const H = 10;
// A 45° bevel of depth c removes at most perimeter*c^2/2 per rim (corner miters
// overlap, so the true removal is a bit less). Loose analytic bounds are enough
// to prove a real bevel of roughly the right size was cut.
const maxRemoval = (c) => (80 * c * c) / 2;

test("bevel removes rim material within the analytic envelope", () => {
  const plain = k.extrude({ profile: SQUARE, h: H }).volume();
  const beveled = k.extrude({ profile: SQUARE, h: H, bevel: 2 }).volume();
  const removed = plain - beveled;
  expect(removed).toBeGreaterThan(0.5 * 2 * maxRemoval(2)); // two rims
  expect(removed).toBeLessThanOrEqual(2 * maxRemoval(2) + 1e-6);
});

test("bevel: n equals bevel: { bottom: n, top: n }", () => {
  const a = k.extrude({ profile: SQUARE, h: H, bevel: 2 }).volume();
  const b = k.extrude({ profile: SQUARE, h: H, bevel: { bottom: 2, top: 2 } }).volume();
  expect(a).toBeCloseTo(b, 6);
});

test("per-rim bevels are independent and preserve the z extent", () => {
  const plain = k.extrude({ profile: SQUARE, h: H }).volume();
  const bottomOnly = k.extrude({ profile: SQUARE, h: H, bevel: { bottom: 2 } });
  const both = k.extrude({ profile: SQUARE, h: H, bevel: 2 }).volume();
  expect(bottomOnly.volume()).toBeLessThan(plain);
  expect(both).toBeLessThan(bottomOnly.volume());
  const bb = bottomOnly.boundingBox();
  expect(bb.min[2]).toBeCloseTo(0, 5);
  expect(bb.max[2]).toBeCloseTo(H, 5);
});

test("bevel: 0 is exactly the plain extrusion", () => {
  const plain = k.extrude({ profile: SQUARE, h: H }).volume();
  expect(k.extrude({ profile: SQUARE, h: H, bevel: 0 }).volume()).toBe(plain);
});

test("a bevel too deep for the profile backs off with a warning, not a failure", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // Thin 2mm-wide bar: a 3mm inset collapses it; the bevel backs off to what fits.
  const bar = [[0, 0], [40, 0], [40, 2], [0, 2]];
  const s = k.extrude({ profile: bar, h: 8, bevel: 3 });
  expect(s.volume()).toBeGreaterThan(0);
  expect(s.volume()).toBeLessThanOrEqual(40 * 2 * 8);
  expect(warn).toHaveBeenCalled();
  expect(warn.mock.calls.map((c) => c[0]).join("\n")).toMatch(/extrude bevel 3 (exceeds|has no valid offset)/);
  warn.mockRestore();
});

test("bevel rejects what it cannot express, with greppable errors", () => {
  expect(() => k.extrude({ profile: SQUARE, h: H, bevel: 1, twist: 30 }))
    .toThrow("extrude: bevel cannot combine with twist or scaleTop");
  expect(() => k.extrude({ profile: SQUARE, h: H, bevel: 6 }))
    .toThrow("extrude: bevel must fit the height");
  expect(() => k.extrude({ profile: SQUARE, h: H, bevel: { botom: 1 } }))
    .toThrow("extrude: unknown bevel option");
  expect(() => k.extrude({ profile: SQUARE, h: H, bevel: "big" }))
    .toThrow("extrude: bevel must be a number or { bottom?, top? }");
});

// ---- regions, holes, curves, Shape2D --------------------------------------

// 20×20 square with an 8×8 hole. The hole's rim flares OUTWARD (the opening is
// larger at the face), so a hole bevel removes additional material.
const HOLE = [[6, 6], [14, 6], [14, 14], [6, 14]];

test("a region hole gets a flared bevel: more material removed than outer-only", () => {
  const plain = k.extrude({ profile: { outer: SQUARE, holes: [HOLE] }, h: H }).volume();
  const beveled = k.extrude({ profile: { outer: SQUARE, holes: [HOLE] }, h: H, bevel: 1.5 });
  const removed = plain - beveled.volume();
  // Outer rim (perimeter 80) + hole rim (perimeter 32), both rims, c=1.5.
  const cap = 2 * ((80 + 32) * 1.5 * 1.5) / 2;
  expect(removed).toBeGreaterThan(0.4 * cap);
  expect(removed).toBeLessThanOrEqual(cap + 1e-6);
  const bb = beveled.boundingBox();
  expect(bb.min[2]).toBeCloseTo(0, 5);
  expect(bb.max[2]).toBeCloseTo(H, 5);
});

test("hole winding does not matter (CW holes normalize)", () => {
  const cwHole = [...HOLE].reverse();
  const a = k.extrude({ profile: { outer: SQUARE, holes: [HOLE] }, h: H, bevel: 1.5 }).volume();
  const b = k.extrude({ profile: { outer: SQUARE, holes: [cwHole] }, h: H, bevel: 1.5 }).volume();
  expect(a).toBeCloseTo(b, 6);
});

// Circle of radius 10 as an arc contour — materialized at the fixed LOD.
const CIRCLE = { start: [10, 0], segments: [{ via: [0, 10], to: [-10, 0] }, { via: [0, -10], to: [10, 0] }] };

test("an arc-contour profile bevels (materialized at the fixed LOD)", () => {
  const plain = k.extrude({ profile: CIRCLE, h: H }).volume();
  const beveled = k.extrude({ profile: CIRCLE, h: H, bevel: 2 }).volume();
  const removed = plain - beveled;
  const cap = 2 * (2 * Math.PI * 10 * 2 * 2) / 2;
  expect(removed).toBeGreaterThan(0.5 * cap);
  expect(removed).toBeLessThanOrEqual(cap);
});

test("a Shape2D profile bevels via its own materialization", () => {
  const shape = k.shape2d(CIRCLE);
  const plain = k.extrude({ profile: shape, h: H }).volume();
  const beveled = k.extrude({ profile: shape, h: H, bevel: 2 }).volume();
  const removed = plain - beveled;
  const cap = 2 * (2 * Math.PI * 10 * 2 * 2) / 2;
  expect(removed).toBeGreaterThan(0.5 * cap);
  expect(removed).toBeLessThanOrEqual(cap);
});

test("a multi-region Shape2D bevels every region", () => {
  const two = k.shape2d(SQUARE).union(SQUARE.map(([x, y]) => [x + 40, y]));
  const one = k.extrude({ profile: SQUARE, h: H, bevel: 2 }).volume();
  expect(k.extrude({ profile: two, h: H, bevel: 2 }).volume()).toBeCloseTo(2 * one, 1);
});

test("resolveBevel normalizes and validates without a kernel", () => {
  expect(resolveBevel(2, 10)).toEqual({ bottom: 2, top: 2 });
  expect(resolveBevel({ top: 1 }, 10)).toEqual({ bottom: 0, top: 1 });
  expect(() => resolveBevel({ bottom: 5, top: 5 }, 10)).toThrow("must fit the height");
  expect(() => resolveBevel(-1, 10)).toThrow("finite numbers >= 0");
});

test("an unknown extrude option still gets the did-you-mean error (bevel joined the key list)", () => {
  expect(() => k.extrude({ profile: SQUARE, h: H, bevle: 1 })).toThrow(/did you mean bevel/);
});
