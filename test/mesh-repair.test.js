import { expect, test } from "vitest";
import { signedVolume, ensureOutward, openEdgeCount } from "../src/framework/geometry/mesh-repair.js";

// A hand-built axis-aligned cube [0,e]^3, indexed (8 verts, 12 tris), wound CCW-outward
// (each triangle's normal, via (v1-v0)x(v2-v0), points away from the cube). Mirrors the
// boxMesh-style fixtures used elsewhere in test/ (e.g. test/bvh.test.js) but keeps its own
// local copy per the task brief (test/helpers/cube-soup.js is a later task's shared helper).
const EDGE = 10;
function cubeVerts(e) {
  return [
    [0, 0, 0], [e, 0, 0], [e, e, 0], [0, e, 0], // 0-3: bottom
    [0, 0, e], [e, 0, e], [e, e, e], [0, e, e], // 4-7: top
  ];
}
// Outward-CCW winding, two triangles per face.
const CUBE_TRIS = [
  0, 2, 1,  0, 3, 2, // bottom (-z)
  4, 5, 6,  4, 6, 7, // top (+z)
  0, 1, 5,  0, 5, 4, // front (-y)
  3, 7, 6,  3, 6, 2, // back (+y)
  0, 4, 7,  0, 7, 3, // left (-x)
  1, 2, 6,  1, 6, 5, // right (+x)
];

function flatPositions(verts) {
  return verts.flat();
}

// Flatten an indexed mesh into an unindexed triangle soup (each triangle gets its own 3
// fresh vertex entries, positionally identical to shared ones but not sharing array slots).
function toSoup(verts, tris) {
  const soup = [];
  for (let t = 0; t < tris.length; t++) soup.push(...verts[tris[t]]);
  return soup;
}

test("signedVolume of an outward-wound cube is approximately +edge^3", () => {
  const positions = flatPositions(cubeVerts(EDGE));
  expect(signedVolume(positions, CUBE_TRIS)).toBeCloseTo(EDGE ** 3, 5);
});

test("signedVolume goes negative when every triangle is reversed (inward-facing)", () => {
  const positions = flatPositions(cubeVerts(EDGE));
  const reversed = CUBE_TRIS.slice();
  for (let t = 0; t < reversed.length; t += 3) {
    const tmp = reversed[t + 1]; reversed[t + 1] = reversed[t + 2]; reversed[t + 2] = tmp;
  }
  expect(signedVolume(positions, reversed)).toBeCloseTo(-(EDGE ** 3), 5);
});

test("ensureOutward flips an inward-facing mesh back to positive volume", () => {
  const positions = flatPositions(cubeVerts(EDGE));
  const reversed = CUBE_TRIS.slice();
  for (let t = 0; t < reversed.length; t += 3) {
    const tmp = reversed[t + 1]; reversed[t + 1] = reversed[t + 2]; reversed[t + 2] = tmp;
  }
  expect(signedVolume(positions, reversed)).toBeLessThan(0);
  ensureOutward(positions, reversed);
  expect(signedVolume(positions, reversed)).toBeCloseTo(EDGE ** 3, 5);
});

test("ensureOutward leaves an already-outward mesh untouched", () => {
  const positions = flatPositions(cubeVerts(EDGE));
  const tris = CUBE_TRIS.slice();
  ensureOutward(positions, tris);
  expect(tris).toEqual(CUBE_TRIS);
  expect(signedVolume(positions, tris)).toBeCloseTo(EDGE ** 3, 5);
});

test("openEdgeCount is 0 for an intact watertight cube", () => {
  const positions = flatPositions(cubeVerts(EDGE));
  expect(openEdgeCount(positions, CUBE_TRIS)).toBe(0);
});

test("openEdgeCount is 4 after deleting one face (two triangles)", () => {
  const positions = flatPositions(cubeVerts(EDGE));
  const withHole = CUBE_TRIS.slice(6); // drop the first face's two triangles (bottom)
  expect(openEdgeCount(positions, withHole)).toBe(4);
});

test("openEdgeCount is 0 for an unindexed triangle soup cube (positional weld connects it)", () => {
  const soup = toSoup(cubeVerts(EDGE), CUBE_TRIS);
  expect(soup.length).toBe(36 * 3); // 36 verts x 3 coords
  expect(openEdgeCount(soup)).toBe(0);
});
