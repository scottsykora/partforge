import { expect, test } from "vitest";
import { meshVolume, bboxSize } from "../src/testing/mesh.js";

// Unit cube: 8 vertices, 12 triangles (outward normals)
const positions = [0,0,0, 1,0,0, 1,1,0, 0,1,0, 0,0,1, 1,0,1, 1,1,1, 0,1,1];
const indices   = [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 1,2,6, 1,6,5, 2,3,7, 2,7,6, 3,0,4, 3,4,7];

test("meshVolume of a unit cube is 1", () => {
  expect(meshVolume(positions, indices)).toBeCloseTo(1, 10);
});

test("bboxSize of a unit cube is [1,1,1]", () => {
  const [w, h, d] = bboxSize(positions);
  expect(w).toBeCloseTo(1, 10);
  expect(h).toBeCloseTo(1, 10);
  expect(d).toBeCloseTo(1, 10);
});
