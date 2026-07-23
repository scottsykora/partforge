import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel, buildView } from "../src/testing.js";
import { meshCentroid } from "../src/testing/mesh.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// A box from [0,0,0] to [10,20,5]; its centroid is the geometric center.
const boxPart = (min, max) => ({
  meta: { title: "Box", units: "mm" }, defaults: {},
  parts: { block: { views: ["v"], build: (kk) => kk.box({ min, max }) } },
  views: { v: { label: "V" } },
});

test("centroid of an origin box is its center", () => {
  const mesh = buildView(k, boxPart([0, 0, 0], [10, 20, 5]), "v")[0].mesh;
  const c = meshCentroid(mesh.positions, mesh.indices);
  expect(c[0]).toBeCloseTo(5, 3);
  expect(c[1]).toBeCloseTo(10, 3);
  expect(c[2]).toBeCloseTo(2.5, 3);
});

test("centroid tracks a translated box", () => {
  const mesh = buildView(k, boxPart([100, 0, 0], [110, 20, 5]), "v")[0].mesh;
  const c = meshCentroid(mesh.positions, mesh.indices);
  expect(c[0]).toBeCloseTo(105, 3);
  expect(c[1]).toBeCloseTo(10, 3);
  expect(c[2]).toBeCloseTo(2.5, 3);
});

test("degenerate / zero-volume meshes return null", () => {
  expect(meshCentroid([], undefined)).toBe(null);
  // two coplanar triangles (a flat square in z=0) enclose no volume
  const flat = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0];
  expect(meshCentroid(flat, undefined)).toBe(null);
});
