import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { minWall } from "../src/testing/min-wall.js";

let k;
beforeAll(async () => { const wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" }); });

const tube = (rOut, rIn, h) => k.cylinder(rOut, rOut, h).cut(k.cylinder(rIn, rIn, h + 4).translate([0, 0, -2]));

test("tube with a 1.0 mm wall reads ~1.0", () => {
  expect(minWall(tube(6, 5, 20).toMesh()).value).toBeCloseTo(1.0, 1);
});
test("plate with a 1.2 mm wall reads ~1.2", () => {
  expect(minWall(k.box([0, 0, 0], [30, 30, 1.2]).toMesh()).value).toBeCloseTo(1.2, 1);
});
test("thin tube with a 0.6 mm wall reads ~0.6", () => {
  expect(minWall(tube(6, 5.4, 20).toMesh()).value).toBeCloseTo(0.6, 1);
});
test("a solid block reads its thinnest dimension (~5)", () => {
  expect(minWall(k.box([0, 0, 0], [10, 20, 5]).toMesh()).value).toBeCloseTo(5, 1);
});
test("reports the location of the thin spot", () => {
  const r = minWall(tube(6, 5, 20).toMesh());
  expect(Array.isArray(r.location)).toBe(true);
  expect(r.location).toHaveLength(3);
});
test("an empty mesh returns null (no reliable reading)", () => {
  expect(minWall({ positions: [] })).toBeNull();
});
