import { expect, test } from "vitest";
import { buildBVH } from "../src/testing/bvh.js";

// a unit-ish box [0,0,0]..[10,20,5] as a non-indexed triangle soup (12 tris)
function boxMesh(sx, sy, sz) {
  const v = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]];
  const quads = [[0,1,2,3],[7,6,5,4],[0,4,5,1],[1,5,6,2],[2,6,7,3],[3,7,4,0]];
  const pos = [];
  for (const [a,b,c,d] of quads) { for (const i of [a,b,c, a,c,d]) pos.push(...v[i]); }
  return { positions: pos };
}

test("raycast hits the near face and returns its distance", () => {
  const bvh = buildBVH(boxMesh(10, 20, 5));
  const hit = bvh.raycast([5, 10, -3], [0, 0, 1]); // from below, up through z
  expect(hit).not.toBeNull();
  expect(hit.t).toBeCloseTo(3, 5);                  // z=0 face is 3 away
});

test("raycast returns the NEAREST hit, not a far one", () => {
  const bvh = buildBVH(boxMesh(10, 20, 5));
  const hit = bvh.raycast([5, 10, -3], [0, 0, 1]);
  expect(hit.t).toBeCloseTo(3, 5);                  // not 8 (the z=5 face)
});

test("skipTri ignores the source triangle (nearest becomes the far face)", () => {
  const bvh = buildBVH(boxMesh(10, 20, 5));
  const first = bvh.raycast([4.9, 10, -3], [0, 0, 1]);
  const second = bvh.raycast([4.9, 10, -3], [0, 0, 1], { skipTri: first.tri });
  expect(second.t).toBeCloseTo(8, 5);               // z=5 face
});

test("a ray that misses returns null", () => {
  const bvh = buildBVH(boxMesh(10, 20, 5));
  expect(bvh.raycast([100, 100, -3], [0, 0, 1])).toBeNull();
});
