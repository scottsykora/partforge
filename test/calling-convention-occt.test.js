// test/calling-convention-occt.test.js
// OCCT twin of calling-convention.test.js: options form ≡ positional form on the
// B-rep backend, including the natively-implemented fillet/chamfer/shell.
// (replicad consumes operands — every comparison builds fresh solids.)
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

test("factory ops: options form ≡ positional form (volumes)", () => {
  expect(k.cylinder({ d: 8, h: 10 }).volume()).toBeCloseTo(k.cylinder(4, 4, 10).volume(), 4);
  expect(k.box({ min: [0, 0, 0], max: [2, 4, 6] }).volume()).toBeCloseTo(k.box([0, 0, 0], [2, 4, 6]).volume(), 4);
  const TRI = [[0, 0], [10, 0], [0, 10]];
  expect(k.extrude({ profile: TRI, h: 5 }).volume()).toBeCloseTo(k.extrude(TRI, 5).volume(), 4);
});

test("box({size}) placement on OCCT matches the convention", () => {
  const b = k.box({ size: [4, 6, 10] }).boundingBox();
  expect(b.min[2]).toBeCloseTo(0, 4);
  expect(b.center[0]).toBeCloseTo(0, 4);
  expect(b.center[1]).toBeCloseTo(0, 4);
});

test("fillet/chamfer options form ≡ positional form", () => {
  const a = k.box([0, 0, 0], [10, 10, 10]).fillet({ r: 2, edges: { dir: "Z" } }).volume();
  const b = k.box([0, 0, 0], [10, 10, 10]).fillet(2, { dir: "Z" }).volume();
  expect(a).toBeCloseTo(b, 4);
  const c = k.box([0, 0, 0], [10, 10, 10]).chamfer({ d: 1, edges: { inPlane: "XY", at: 0 } }).volume();
  const d = k.box([0, 0, 0], [10, 10, 10]).chamfer(1, { inPlane: "XY", at: 0 }).volume();
  expect(c).toBeCloseTo(d, 4);
});

test("fillet options-form validation errors", () => {
  expect(() => k.box([0, 0, 0], [1, 1, 1]).fillet({ edges: { dir: "Z" } })).toThrow("fillet: r is required");
  expect(() => k.box([0, 0, 0], [1, 1, 1]).fillet({ radius: 2 })).toThrow('fillet: unknown option "radius" — did you mean r?');
});
