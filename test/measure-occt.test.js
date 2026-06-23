import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { measure } from "../src/testing/measure.js";

let k;
const part = {
  meta: { title: "OcctBox", backend: "occt" }, defaults: {}, views: { v: { label: "V" } },
  parts: { a: { views: ["v"], build: (kk) => kk.box([0, 0, 0], [10, 10, 10]) } },
};
beforeAll(async () => { k = await bootOcctKernel(); });

test("measure works on an OCCT part: volume present, topology null, no crash", () => {
  const r = measure(k, part, "v");
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
