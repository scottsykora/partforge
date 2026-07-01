import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { measure } from "../src/testing/measure.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const boxPart = {
  meta: { title: "Box", units: "mm" },
  defaults: {},
  parts: { block: { views: ["v"], build: (kk) => kk.box([0, 0, 0], [10, 20, 5]) } },
  views: { v: { label: "V" } },
};
const tubePart = {
  meta: { title: "Tube", units: "mm" },
  defaults: {},
  parts: { tube: { views: ["v"], build: (kk) => kk.cylinder(10, 10, 20).cut(kk.cylinder(4, 4, 30).translate([0, 0, -5])) } },
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
