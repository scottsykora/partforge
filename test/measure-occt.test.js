import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { measure } from "../src/testing/measure.js";
import part from "../src/parts/filleted-box.js";
import gapPart from "./fixtures/gap-part.js";

let k;
const boxPart = {
  meta: { title: "OcctBox", backend: "occt" }, defaults: {}, views: { v: { label: "V" } },
  parts: { a: { views: ["v"], build: (kk) => kk.box({ min: [0, 0, 0], max: [10, 10, 10] }) } },
};
beforeAll(async () => { k = await bootOcctKernel(); });

test("measure works on an OCCT part: volume present, topology null, no crash", () => {
  const r = measure(k, boxPart, "v");
  const s = r.subparts[0];
  expect(s.volume).toBeCloseTo(1000, 0);
  expect(s.bbox[0]).toBeCloseTo(10, 1);
  expect(s.triangleCount).toBeGreaterThan(0);
  // surfaceArea must be a real number from the INDEXED OCCT mesh (a 10mm cube = 600mm²),
  // not NaN — meshArea must honor mesh.indices, not assume a non-indexed soup.
  expect(Number.isFinite(s.surfaceArea)).toBe(true);
  expect(s.surfaceArea).toBeCloseTo(600, 0);
  expect(s.watertight).toBeNull();
  expect(s.holes).toBeNull();
  expect(r.overlaps).toEqual([]);
  expect(r.ok).toBe(true);
});

test("measure on OCCT filleted-box with minWall:true returns plausible minWall ≥ 5mm (not a fabricated sub-mm value)", () => {
  // filleted-box defaults: w:40 d:30 h:16 fillet:3 bore:8 (all material, no thin walls).
  // The OCCT mesh is INDEXED. On current (unfixed) code minWall fabricates a value like
  // ~0.017 by mixing unrelated vertices — a clear correctness failure.
  // After the fix, the real thinnest wall is the bore wall: bore radius=4mm, nearest
  // box edge = min(40/2, 30/2) - 4 = 15-4 = 11mm. Even conservatively, minWall must be ≥ 5.
  const r = measure(k, part, "box", {}, { minWall: true });
  const s = r.subparts[0];
  expect(Number.isFinite(s.minWall)).toBe(true);
  expect(s.minWall).toBeGreaterThanOrEqual(5);
});

test("gaps/nearMisses populate on OCCT (mesh-based, no Solid.intersect)", () => {
  const r = measure(k, gapPart, "v");
  expect(r.overlaps).toEqual([]);                    // intersect unavailable → skipped
  expect(r.nearMisses).toHaveLength(1);
  expect(r.nearMisses[0].distance).toBeCloseTo(0.2, 3);
  expect(r.nearMisses[0].at[0]).toBeCloseTo(10.1, 2);
});
