import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { assemblyOverlaps } from "../src/framework/assembly.js";
import planterPart from "../src/parts/planter.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

test("cylinder minus a bore meshes to a solid", () => {
  const drum = k.cylinder(10, 10, 20).cut(k.cylinder(4, 4, 30).translate([0, 0, -5]));
  expect(drum.toMesh({ quality: "preview" }).triangles).toBeGreaterThan(0);
});

test("intersect keeps only the overlapping volume of two solids", () => {
  // STEP export always builds on OCCT, so OCCT must implement every boolean a part may
  // use — including intersect (e.g. the planter clips its cavity with .intersect(box)).
  const a = k.box([0, 0, 0], [10, 10, 10]);
  const b = k.box([5, 5, 5], [15, 15, 15]);
  expect(a.intersect(b).volume()).toBeCloseTo(125, 0); // the 5×5×5 overlap
});

test("intersect of disjoint solids is empty (volume 0) without throwing", () => {
  // assemblyOverlaps depends on this on OCCT: a non-overlapping pair must yield 0, not throw.
  const a = k.box([0, 0, 0], [10, 10, 10]);
  const b = k.box([50, 50, 50], [60, 60, 60]); // far apart
  expect(a.intersect(b).volume()).toBeCloseTo(0, 5);
});

test("assemblyOverlaps runs on OCCT — clean for disjoint parts, flags a real overlap", () => {
  // Adding intersect to OCCT flips measure.js's canIntersect gate, so this overlap path now
  // runs on the OCCT kernel for the first time. Guard that it behaves: no throw on disjoint.
  const mk = (bx) => ({ defaults: {}, views: { v: {} }, parts: {
    a: { views: ["v"], build: (kk) => kk.box([0, 0, 0], [10, 10, 10]) },
    b: { views: ["v"], build: (kk) => kk.box([bx, 0, 0], [bx + 10, 10, 10]) },
  } });
  expect(assemblyOverlaps(k, mk(20), "v", {})).toEqual([]);   // disjoint → no overlaps
  const hit = assemblyOverlaps(k, mk(5), "v", {});            // 5-unit overlap on X
  expect(hit).toHaveLength(1);
  expect(hit[0].volume).toBeCloseTo(500, 0);                  // 5×10×10
});

test("a Manifold-routed part (planter) exports STEP via OCCT — every part gets all 3 formats", async () => {
  // Mirrors the export-step path in jobs.js: build the part fresh on OCCT, then toSTEP.
  // Regression: the planter uses .intersect(), which OCCT lacked, so STEP silently failed.
  const p = { ...planterPart.defaults };
  const d = planterPart.derive(p);
  const solid = planterPart.parts.planter.build(k, p, d);
  const step = await k.toSTEP([{ name: "planter", solid }]);
  expect(step.byteLength).toBeGreaterThan(1000);
  expect(new TextDecoder().decode(step.slice(0, 13))).toBe("ISO-10303-21;"); // STEP header
});

test("clone() lets the original survive a consuming transform", () => {
  const a = k.box([0, 0, 0], [10, 10, 10]);
  const moved = a.clone().translate([20, 0, 0]); // consumes the clone, not `a`
  expect(a.volume()).toBeCloseTo(1000, 0);        // original still usable
  expect(moved.volume()).toBeCloseTo(1000, 0);
});

test("boundingBox reports size/center of a box (query does not consume)", () => {
  const b = k.box([0, 0, 0], [10, 20, 30]);
  const bb = b.boundingBox();
  expect(bb.size[0]).toBeCloseTo(10, 3);
  expect(bb.size[1]).toBeCloseTo(20, 3);
  expect(bb.size[2]).toBeCloseTo(30, 3);
  expect(bb.center[0]).toBeCloseTo(5, 3);
  expect(b.volume()).toBeCloseTo(6000, 0); // still usable after the query
});

test("sphere volume is ~4/3 pi r^3", () => {
  const r = 10;
  expect(k.sphere(r).volume()).toBeCloseTo((4 / 3) * Math.PI * r ** 3, -1);
});

test("revolve of a rectangular profile equals a cylinder volume", () => {
  const rect = [[0, 0], [10, 0], [10, 20], [0, 20]];
  expect(k.revolve(rect).volume()).toBeCloseTo(Math.PI * 10 ** 2 * 20, -2);
});

test("revolve rejects a negative radius", () => {
  expect(() => k.revolve([[-1, 0], [10, 0], [10, 20]])).toThrow(/radius must be/);
});

const SQ = [[-5, -5], [5, -5], [5, 5], [-5, 5]];

test("prism scaleTop<1 tapers — less volume than straight", () => {
  const straight = k.prism(SQ, 10).volume();
  const taper = k.prism(SQ, 10, { scaleTop: 0.5 }).volume();
  expect(taper).toBeLessThan(straight);
  expect(taper).toBeGreaterThan(0);
});

test("prism twist meshes to a positive-volume solid", () => {
  const tw = k.prism(SQ, 20, { twist: 90 });
  expect(tw.toMesh().triangles).toBeGreaterThan(0);
  expect(tw.volume()).toBeGreaterThan(0);
});

test("scale(2) multiplies volume ~8x", () => {
  const v1 = k.box([0, 0, 0], [2, 3, 4]).volume();
  const v2 = k.box([0, 0, 0], [2, 3, 4]).scale(2).volume();
  expect(v2).toBeCloseTo(v1 * 8, 0);
});

test("scale rejects factor <= 0", () => {
  expect(() => k.box([0, 0, 0], [1, 1, 1]).scale(0)).toThrow(/factor must be/);
});
