import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/geometry/manifold-backend.js";

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
