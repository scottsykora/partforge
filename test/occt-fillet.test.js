import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

test("volume() returns the solid volume", () => {
  expect(k.box([0, 0, 0], [10, 10, 10]).volume()).toBeCloseTo(1000, 0);
});

test("fillet removes a little volume and still meshes", () => {
  const sharp = k.box([0, 0, 0], [20, 20, 20]).volume();          // 8000
  const filleted = k.box([0, 0, 0], [20, 20, 20]).fillet(2, { dir: "Z" });
  const v = filleted.volume();
  expect(v).toBeLessThan(sharp);
  expect(v).toBeGreaterThan(7000);                                // only 4 edges rounded
  expect(filleted.toMesh().triangles).toBeGreaterThan(0);
});

test("selecting all edges removes more than selecting only vertical edges", () => {
  const vertical = k.box([0, 0, 0], [20, 20, 20]).fillet(2, { dir: "Z" }).volume();
  const all = k.box([0, 0, 0], [20, 20, 20]).fillet(2).volume();
  expect(all).toBeLessThan(vertical);
});

test("chamfer removes volume", () => {
  expect(k.box([0, 0, 0], [20, 20, 20]).chamfer(2).volume()).toBeLessThan(8000);
});

test("toIndexedMesh returns positions and indices", () => {
  const m = k.box([0, 0, 0], [5, 5, 5]).toIndexedMesh();
  expect(m.positions.length).toBeGreaterThan(0);
  expect(m.indices.length).toBeGreaterThan(0);
});

test("an out-of-range fillet is skipped, not fatal — the shape survives", () => {
  // radius far larger than the box → OCCT fails/empties; safeOp keeps the original
  // box instead of letting the part vanish.
  const v = k.box([0, 0, 0], [10, 10, 10]).fillet(50).volume();
  expect(v).toBeCloseTo(1000, 0); // unchanged box volume — fillet skipped, not vanished
});

test("an out-of-range chamfer is reduced to the largest valid value, not fatal", () => {
  // chamfer 50 can't apply to a 10mm cube; the backend searches down to the largest
  // chamfer that still yields a closed solid and applies that, rather than vanishing.
  const v = k.box([0, 0, 0], [10, 10, 10]).chamfer(50).volume();
  expect(v).toBeGreaterThan(0);     // shape survives
  expect(v).toBeLessThan(1000);     // a reduced chamfer was actually applied
});

test("chamfer validates the result: an oversize request is reduced to the largest valid, not skipped or broken", () => {
  // After a vertical fillet the bottom corners are short arcs, so a 20mm chamfer can't
  // apply at full size. The backend searches down to the largest distance that still
  // yields a closed solid and applies THAT (a real chamfer), rather than vanishing.
  const filleted = k.box([0, 0, 0], [40, 30, 16]).fillet(3, { dir: "Z" }).volume();
  const huge = k.box([0, 0, 0], [40, 30, 16]).fillet(3, { dir: "Z" }).chamfer(20, { inPlane: "XY", at: 0 });
  expect(huge.volume()).toBeGreaterThan(0);        // not vanished
  expect(huge.volume()).toBeLessThan(filleted);    // a chamfer was actually applied
  expect(huge.toMesh().triangles).toBeGreaterThan(0);
});

test("a chamfer that fits is applied at the requested value", () => {
  const filleted = k.box([0, 0, 0], [40, 30, 16]).fillet(3, { dir: "Z" }).volume();
  const v = k.box([0, 0, 0], [40, 30, 16]).fillet(3, { dir: "Z" }).chamfer(2, { inPlane: "XY", at: 0 }).volume();
  expect(v).toBeGreaterThan(0);
  expect(v).toBeLessThan(filleted);                // 2mm is in range → applied
});
