import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

test("cylinder minus a bore meshes to a solid", () => {
  const drum = k.cylinder(10, 10, 20).cut(k.cylinder(4, 4, 30).translate([0, 0, -5]));
  expect(drum.toMesh({ quality: "preview" }).triangles).toBeGreaterThan(0);
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
