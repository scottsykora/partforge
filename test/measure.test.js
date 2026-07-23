import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { measure } from "../src/testing/measure.js";
import gapPart from "./fixtures/gap-part.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const boxPart = {
  meta: { title: "Box", units: "mm" },
  defaults: {},
  parts: { block: { views: ["v"], build: (kk) => kk.box({ min: [0, 0, 0], max: [10, 20, 5] }) } },
  views: { v: { label: "V" } },
};
const tubePart = {
  meta: { title: "Tube", units: "mm" },
  defaults: {},
  parts: { tube: { views: ["v"], build: (kk) => kk.cylinder({ r: 10, h: 20 }).cut(kk.cylinder({ r: 4, h: 30 }).translate([0, 0, -5])) } },
  views: { v: { label: "V" } },
};

test("measure reports box facts: genus 0, watertight, volume ~1000, bbox ~[10,20,5]", () => {
  const r = measure(k, boxPart, "v");
  expect(r.subparts).toHaveLength(1);
  const s = r.subparts[0];
  expect(s.holes).toBe(0);
  expect(s.watertight).toBe(true);
  expect(s.volume).toBeCloseTo(1000, 0);
  expect(s.bbox[0]).toBeCloseTo(10, 1);
  expect(s.bbox[1]).toBeCloseTo(20, 1);
  expect(s.bbox[2]).toBeCloseTo(5, 1);
  expect(s.surfaceArea).toBeGreaterThan(0);
  expect(s.triangleCount).toBeGreaterThan(0);
  expect(r.overlaps).toEqual([]);
  expect(r.ok).toBe(true);
});

test("measure reports a through-bore tube as genus 1", () => {
  expect(measure(k, tubePart, "v").subparts[0].holes).toBe(1);
});

test("measure aggregate volume equals the single sub-part volume", () => {
  const r = measure(k, boxPart, "v");
  expect(r.aggregate.volume).toBeCloseTo(r.subparts[0].volume, 5);
});

test("measure defaults to the first declared view", () => {
  expect(measure(k, boxPart).view).toBe("v");
});

test("minWall is null unless opts.minWall is set, then it is the measured thickness", () => {
  expect(measure(k, boxPart, "v").subparts[0].minWall).toBe(null);                 // off by default
  const w = measure(k, boxPart, "v", {}, { minWall: true }).subparts[0].minWall;   // boxPart is 10x20x5
  expect(w).toBeCloseTo(5, 1);                                                      // thinnest dimension
});

test("measure reports the near-miss pair with distance and location", () => {
  const r = measure(k, gapPart, "v");                     // gap 0.2
  expect(r.nearMisses).toHaveLength(1);
  expect(r.nearMisses[0]).toMatchObject({ a: "left", b: "right" });
  expect(r.nearMisses[0].distance).toBeCloseTo(0.2, 5);
  expect(r.nearMisses[0].at[0]).toBeCloseTo(10.1, 4);
  expect(r.gaps).toHaveLength(1);                          // raw pair table
  expect(r.ok).toBe(true);                                 // near misses never gate measure.ok
});

test("separated and touching pairs produce no near-miss noise", () => {
  expect(measure(k, gapPart, "v", { gap: 5 }).nearMisses).toEqual([]);
  expect(measure(k, gapPart, "v", { gap: 0 }).nearMisses).toEqual([]);
});

test("an overlapping pair is in overlaps, not nearMisses", () => {
  const r = measure(k, gapPart, "v", { gap: -1 });
  expect(r.overlaps).toHaveLength(1);
  expect(r.nearMisses).toEqual([]);
  expect(r.ok).toBe(false);                                // the existing overlap gate
});

test("single-sub-part views report empty gaps and nearMisses", () => {
  const r = measure(k, boxPart, "v");
  expect(r.gaps).toEqual([]);
  expect(r.nearMisses).toEqual([]);
});

test("gapThreshold is configurable", () => {
  expect(measure(k, gapPart, "v", { gap: 0.7 }).nearMisses).toEqual([]);
  expect(measure(k, gapPart, "v", { gap: 0.7 }, { gapThreshold: 1 }).nearMisses).toHaveLength(1);
});

// Deliberately UNEQUAL volumes so the aggregate CoM test distinguishes a
// volume-weighted mean from a plain average of the sub-part centroids.
const twoBoxPart = {
  meta: { title: "TwoBox", units: "mm" }, defaults: {},
  parts: {
    a: { views: ["v"], build: (kk) => kk.box({ min: [0, 0, 0], max: [10, 10, 10] }) },        // vol 1000, com [5,5,5]
    b: { views: ["v"], build: (kk) => kk.box({ min: [30, 0, 0], max: [50, 20, 20] }) },        // vol 8000, com [40,10,10]
  },
  views: { v: { label: "V" } },
};

test("measure reports per-sub-part bounds {min,max}", () => {
  const s = measure(k, boxPart, "v").subparts[0];         // boxPart is [0,0,0]..[10,20,5]
  expect(s.bounds.min[0]).toBeCloseTo(0, 3);
  expect(s.bounds.min[1]).toBeCloseTo(0, 3);
  expect(s.bounds.min[2]).toBeCloseTo(0, 3);
  expect(s.bounds.max[0]).toBeCloseTo(10, 3);
  expect(s.bounds.max[1]).toBeCloseTo(20, 3);
  expect(s.bounds.max[2]).toBeCloseTo(5, 3);
});

test("measure reports per-sub-part centerOfMass", () => {
  const s = measure(k, boxPart, "v").subparts[0];
  expect(s.centerOfMass[0]).toBeCloseTo(5, 2);
  expect(s.centerOfMass[1]).toBeCloseTo(10, 2);
  expect(s.centerOfMass[2]).toBeCloseTo(2.5, 2);
});

test("aggregate bounds spans all sub-parts and centerOfMass is volume-weighted", () => {
  const r = measure(k, twoBoxPart, "v");
  expect(r.aggregate.bounds.min[0]).toBeCloseTo(0, 3);
  expect(r.aggregate.bounds.max[0]).toBeCloseTo(50, 3);
  // (1000·[5,5,5] + 8000·[40,10,10]) / 9000 ≈ [36.11, 9.44, 9.44] — a plain
  // average would give [22.5, 7.5, 7.5], so this catches a dropped volume weight.
  expect(r.aggregate.centerOfMass[0]).toBeCloseTo(36.11, 1);
  expect(r.aggregate.centerOfMass[1]).toBeCloseTo(9.44, 1);
  expect(r.aggregate.centerOfMass[2]).toBeCloseTo(9.44, 1);
});
