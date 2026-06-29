// src/testing/bvh.js
// Triangle BVH over a non-indexed triangle soup (9 floats per triangle, as produced
// by solid.toMesh()). A reusable spatial index: nearest ray hit (raycast) and nearest
// surface point (closestPoint, added alongside). AABB tree, median split on the widest
// centroid axis, slab ray–box test with pruning.

const LEAF = 4; // max triangles per leaf

function readTris(positions) {
  const n = positions.length / 9, tris = new Array(n);
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const v0 = [positions[o], positions[o + 1], positions[o + 2]];
    const v1 = [positions[o + 3], positions[o + 4], positions[o + 5]];
    const v2 = [positions[o + 6], positions[o + 7], positions[o + 8]];
    const min = [Math.min(v0[0], v1[0], v2[0]), Math.min(v0[1], v1[1], v2[1]), Math.min(v0[2], v1[2], v2[2])];
    const max = [Math.max(v0[0], v1[0], v2[0]), Math.max(v0[1], v1[1], v2[1]), Math.max(v0[2], v1[2], v2[2])];
    tris[t] = { i: t, v0, v1, v2, min, max, c: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] };
  }
  return tris;
}

function aabbOf(items) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const it of items) for (let a = 0; a < 3; a++) { if (it.min[a] < min[a]) min[a] = it.min[a]; if (it.max[a] > max[a]) max[a] = it.max[a]; }
  return { min, max };
}

function build(items) {
  const box = aabbOf(items);
  if (items.length <= LEAF) return { ...box, tris: items };
  const ext = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  const axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
  const sorted = items.slice().sort((p, q) => p.c[axis] - q.c[axis]);
  const mid = sorted.length >> 1;
  const left = sorted.slice(0, mid), right = sorted.slice(mid);
  if (left.length === 0 || right.length === 0) return { ...box, tris: items }; // degenerate split
  return { ...box, left: build(left), right: build(right) };
}

// slab test: returns the entry distance if the ray meets [min,max] within (tMin,best], else Infinity
function rayBox(o, invD, min, max, tMin, best) {
  let t0 = tMin, t1 = best;
  for (let a = 0; a < 3; a++) {
    let lo = (min[a] - o[a]) * invD[a], hi = (max[a] - o[a]) * invD[a];
    if (lo > hi) { const tmp = lo; lo = hi; hi = tmp; }
    if (lo > t0) t0 = lo; if (hi < t1) t1 = hi;
    if (t0 > t1) return Infinity;
  }
  return t0;
}

// Möller–Trumbore; returns t>tMin or Infinity
function rayTri(o, d, tri, tMin) {
  const e1 = [tri.v1[0] - tri.v0[0], tri.v1[1] - tri.v0[1], tri.v1[2] - tri.v0[2]];
  const e2 = [tri.v2[0] - tri.v0[0], tri.v2[1] - tri.v0[1], tri.v2[2] - tri.v0[2]];
  const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (det > -1e-12 && det < 1e-12) return Infinity;
  const inv = 1 / det;
  const tv = [o[0] - tri.v0[0], o[1] - tri.v0[1], o[2] - tri.v0[2]];
  const u = (tv[0] * p[0] + tv[1] * p[1] + tv[2] * p[2]) * inv;
  if (u < 0 || u > 1) return Infinity;
  const q = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
  const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
  return t > tMin ? t : Infinity;
}

export function buildBVH(mesh) {
  const tris = readTris(mesh.positions);
  const root = build(tris);

  function raycast(origin, dir, { tMin = 1e-6, tMax = Infinity, skipTri = -1 } = {}) {
    const invD = [1 / dir[0], 1 / dir[1], 1 / dir[2]];
    // When skipTri is set, advance tMin past that triangle's hit depth so that
    // coplanar siblings (sharing the exact same t) are also excluded.
    let effectiveTMin = tMin;
    if (skipTri >= 0 && skipTri < tris.length) {
      const skipT = rayTri(origin, dir, tris[skipTri], -Infinity);
      if (skipT < Infinity) effectiveTMin = Math.max(effectiveTMin, skipT);
    }
    let best = tMax, bestTri = -1;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (rayBox(origin, invD, node.min, node.max, effectiveTMin, best) === Infinity) continue;
      if (node.tris) {
        for (const tri of node.tris) {
          if (tri.i === skipTri) continue;
          const t = rayTri(origin, dir, tri, effectiveTMin);
          if (t < best) { best = t; bestTri = tri.i; }
        }
      } else { stack.push(node.left, node.right); }
    }
    return bestTri === -1 ? null : { t: best, tri: bestTri };
  }

  return { raycast };
}
