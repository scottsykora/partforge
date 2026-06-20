import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/geometry/manifold-backend.js";
import { bboxSize } from "./helpers.js";

let k;
beforeAll(async () => { const wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" }); });

test("cylinder minus a concentric bore removes volume", () => {
  const drum = k.cylinder(10, 10, 20).cut(k.cylinder(4, 4, 30).translate([0, 0, -5]));
  const m = drum.toMesh();
  expect(m.triangles).toBeGreaterThan(0);
});

test("cutAll batch-subtracts every tool", () => {
  const base = k.cylinder(10, 10, 10);
  const holes = [k.cylinder(1, 1, 12).translate([5, 0, -1]), k.cylinder(1, 1, 12).translate([-5, 0, -1])];
  const out = base.cutAll(holes).toMesh();
  expect(out.triangles).toBeGreaterThan(0);
});

test("toSTEP throws (unsupported)", () => {
  expect(() => k.toSTEP([])).toThrow(/not supported/i);
});

test("Solid.rotate swaps X/Y extents for a 90° Z-axis rotation", () => {
  // Tall thin box: X-extent=2, Y-extent=10, Z-extent=30
  const box = k.box([0, 0, 0], [2, 10, 30]);
  const rotated = box.rotate(90, [0, 0, 0], [0, 0, 1]);
  const rm = rotated.toMesh();
  expect(rm.triangles).toBeGreaterThan(0);
  const [rx, ry, rz] = bboxSize(rm.positions);
  // After 90° Z-rotation: original X-extent (2) becomes Y; original Y-extent (10) becomes X
  expect(rx).toBeCloseTo(10, 1);
  expect(ry).toBeCloseTo(2, 1);
  expect(rz).toBeCloseTo(30, 1);
});
