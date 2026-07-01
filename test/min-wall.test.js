import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { minWall } from "../src/testing/min-wall.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// Hand-written INDEXED box [0,0,0]..[10,20,5]: 8 unique verts (24 floats), 12 triangles (36 ints).
// The thinnest dimension is 5 (z), so minWall should read ~5.
function indexedBoxMesh(sx, sy, sz) {
  const positions = [
    0, 0, 0,   sx, 0, 0,   sx, sy, 0,   0, sy, 0,
    0, 0, sz,  sx, 0, sz,  sx, sy, sz,  0, sy, sz,
  ];
  const indices = new Uint32Array([
    0,2,1, 0,3,2,   // -Z face
    4,5,6, 4,6,7,   // +Z face
    0,1,5, 0,5,4,   // -Y face
    1,2,6, 1,6,5,   // +X face
    2,3,7, 2,7,6,   // +Y face
    3,0,4, 3,4,7,   // -X face
  ]);
  return { positions, indices };
}

test("INDEXED box [10x20x5] — minWall reads ~5 (thinnest dimension)", () => {
  const mesh = indexedBoxMesh(10, 20, 5);
  const result = minWall(mesh);
  expect(result).not.toBeNull();
  expect(result.value).toBeCloseTo(5, 1);
});

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
