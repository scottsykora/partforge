import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { measure } from "../src/testing/measure.js";
import thin from "./fixtures/thin-wall-part.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

test("measure reports minWallAt alongside the minWall value", () => {
  const r = measure(k, thin, "v", {}, { minWall: true });
  const ring = r.subparts.find((s) => s.name === "ring");
  expect(ring.minWall).toBeGreaterThan(0.4);   // the fixture's 0.6 mm wall
  expect(ring.minWall).toBeLessThan(0.8);
  expect(ring.minWallAt).toHaveLength(3);
  const radius = Math.hypot(ring.minWallAt[0], ring.minWallAt[1]);
  expect(radius).toBeGreaterThan(3);            // sample sits on the tube wall…
  expect(radius).toBeLessThan(4.5);             // …not in the bore or outside
});

test("minWallAt is null when min-wall measurement is off", () => {
  const r = measure(k, thin, "v", {}, {});
  expect(r.subparts[0].minWall).toBeNull();
  expect(r.subparts[0].minWallAt).toBeNull();
});

const overlapping = {
  meta: { title: "Overlap", units: "mm" },
  defaults: {},
  parts: {
    a: { views: ["v"], build: (k) => k.box([0, 0, 0], [10, 10, 10]) },
    b: { views: ["v"], build: (k) => k.box([8, 0, 0], [18, 10, 10]) },
  },
  views: { v: { label: "V" } },
};

test("overlap entries carry the intersection-region center", () => {
  const r = measure(k, overlapping, "v");
  expect(r.ok).toBe(false);
  expect(r.overlaps).toHaveLength(1);
  const o = r.overlaps[0];
  expect(o.volume).toBeCloseTo(200, 0);      // the 2×10×10 mm shared slab
  expect(o.location[0]).toBeCloseTo(9, 1);   // slab center x (8..10)
  expect(o.location[1]).toBeCloseTo(5, 1);
  expect(o.location[2]).toBeCloseTo(5, 1);
});
