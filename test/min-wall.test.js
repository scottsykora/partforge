import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { minWall } from "../src/testing/min-wall.js";
import { buildBVH } from "../src/testing/bvh.js";

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

const tube = (rOut, rIn, h) => k.cylinder({ r: rOut, h }).cut(k.cylinder({ r: rIn, h: h + 4 }).translate([0, 0, -2]));

test("tube with a 1.0 mm wall reads ~1.0", () => {
  expect(minWall(tube(6, 5, 20).toMesh()).value).toBeCloseTo(1.0, 1);
});
test("plate with a 1.2 mm wall reads ~1.2", () => {
  expect(minWall(k.box({ min: [0, 0, 0], max: [30, 30, 1.2] }).toMesh()).value).toBeCloseTo(1.2, 1);
});
test("thin tube with a 0.6 mm wall reads ~0.6", () => {
  expect(minWall(tube(6, 5.4, 20).toMesh()).value).toBeCloseTo(0.6, 1);
});
test("a solid block reads its thinnest dimension (~5)", () => {
  expect(minWall(k.box({ min: [0, 0, 0], max: [10, 20, 5] }).toMesh()).value).toBeCloseTo(5, 1);
});
test("reports the location of the thin spot", () => {
  const r = minWall(tube(6, 5, 20).toMesh());
  expect(Array.isArray(r.location)).toBe(true);
  expect(r.location).toHaveLength(3);
});
test("an empty mesh returns null (no reliable reading)", () => {
  expect(minWall({ positions: [] })).toBeNull();
});

// ── sampling above the triangle budget ─────────────────────────────────────────
// A row of `n` separate closed boxes as one non-indexed soup (the 12 triangles of
// indexedBoxMesh above, outward-wound, box b at x = 10b). Every box is 5×5×5
// except the LAST `thin` of them, which are 5×5×0.4 — so the thinnest wall in the
// mesh lives entirely in the tail of the triangle list, where a naive "sample the
// first k triangles" would never look.
const BOX_TRIS = [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 1,2,6, 1,6,5, 2,3,7, 2,7,6, 3,0,4, 3,4,7];
function boxRow(n, thin) {
  const pos = [];
  for (let b = 0; b < n; b++) {
    const x0 = b * 10, sz = b >= n - thin ? 0.4 : 5;
    const v = [[x0,0,0],[x0+5,0,0],[x0+5,5,0],[x0,5,0],[x0,0,sz],[x0+5,0,sz],[x0+5,5,sz],[x0,5,sz]];
    for (const i of BOX_TRIS) pos.push(...v[i]);
  }
  return { positions: pos };
}

test("below the budget every triangle is cast and the result says it was exact", () => {
  const r = minWall(indexedBoxMesh(10, 20, 5));
  expect(r.sampled).toBe(false);
  expect(r.sampledTriangles).toBe(12);
  expect(r.totalTriangles).toBe(12);
});

test("above the budget the sample spreads over the whole mesh and still finds the thin wall", () => {
  const mesh = boxRow(40, 3);                          // 480 triangles; the thin boxes are the last 3
  expect(minWall(mesh).value).toBeCloseTo(0.4, 3);     // exact reading, for reference
  const r = minWall(mesh, { maxSamples: 100 });        // a contiguous first 100 covers boxes 0-8: all 5 thick
  expect(r.sampled).toBe(true);
  expect(r.sampledTriangles).toBe(100);
  expect(r.totalTriangles).toBe(480);
  expect(r.value).toBeCloseTo(0.4, 3);
});

test("sampling is deterministic — the same mesh always reads the same wall", () => {
  const mesh = boxRow(40, 3);
  const a = minWall(mesh, { maxSamples: 100 }), b = minWall(mesh, { maxSamples: 100 });
  expect(a.value).toBe(b.value);
  expect(a.location).toEqual(b.location);
});

test("the default budget leaves an ordinary part exact", () => {
  const r = minWall(tube(6, 5, 20).toMesh());          // a few thousand triangles
  expect(r.totalTriangles).toBeLessThan(50000);
  expect(r.sampled).toBe(false);
});

test("minWall casts through a caller-supplied BVH instead of building its own", () => {
  const mesh = indexedBoxMesh(10, 20, 5);
  const bvh = buildBVH(mesh);
  expect(minWall(mesh, { bvh }).value).toBeCloseTo(5, 1);
  // The supplied index is the one that answered: an index over a DIFFERENT mesh
  // gives that mesh's reading, so nothing rebuilt behind our back.
  const thin = buildBVH(indexedBoxMesh(10, 20, 0.4));
  expect(minWall(indexedBoxMesh(10, 20, 0.4), { bvh: thin }).value).toBeCloseTo(0.4, 2);
  expect(minWall(mesh).value).toBeCloseTo(5, 1);       // and builds its own without one
});

test("a mesh whose rays all miss keeps the sampling accounting (not a bare null)", () => {
  // A lone triangle: the single ray leaves it and hits nothing, so there is no
  // reading — but "we cast 1 of 1 and found nothing" is not "nobody measured".
  const r = minWall({ positions: [0, 0, 0, 10, 0, 0, 0, 10, 0] });
  expect(r).not.toBeNull();
  expect(r.value).toBeNull();
  expect(r.location).toBeNull();
  expect(r.sampled).toBe(false);
  expect(r.sampledTriangles).toBe(1);
  expect(r.totalTriangles).toBe(1);
});

test("a SAMPLED run that finds no wall says how much it looked at", () => {
  // 40 open triangles, sampled 10 at a time: no closed volume, so every ray misses.
  const pos = [];
  for (let i = 0; i < 40; i++) pos.push(i * 20, 0, 0, i * 20 + 10, 0, 0, i * 20, 10, 0);
  const r = minWall({ positions: pos }, { maxSamples: 10 });
  expect(r.value).toBeNull();
  expect(r.sampled).toBe(true);
  expect(r.sampledTriangles).toBe(10);
  expect(r.totalTriangles).toBe(40);
});
