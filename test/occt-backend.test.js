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
