// src/testing/bvh.js
// Triangle BVH over a mesh in either Manifold non-indexed soup form (9 floats per
// triangle, no `indices`) or OCCT indexed form (`positions` = 3 floats/vertex +
// `indices` = 3 vertex-indices/triangle). A reusable spatial index: nearest ray hit
// (raycast) and nearest surface point (closestPoint, added alongside). AABB tree,
// median split on the widest centroid axis, slab ray–box test with pruning.

const LEAF = 4; // max triangles per leaf

// Triangles as [v0,v1,v2] coord triples, from either a Manifold non-indexed soup
// (positions = 9 floats/triangle, no indices) or an OCCT indexed mesh (positions =
// 3 floats/vertex + indices = 3 vertex-indices/triangle).
export function meshTriangles(mesh) {
  const { positions, indices } = mesh;
  if (indices) {
    const n = indices.length / 3, out = new Array(n);
    for (let t = 0; t < n; t++) {
      const a = indices[3 * t] * 3, b = indices[3 * t + 1] * 3, c = indices[3 * t + 2] * 3;
      out[t] = [[positions[a], positions[a + 1], positions[a + 2]],
                [positions[b], positions[b + 1], positions[b + 2]],
                [positions[c], positions[c + 1], positions[c + 2]]];
    }
    return out;
  }
  const n = positions.length / 9, out = new Array(n);
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    out[t] = [[positions[o], positions[o + 1], positions[o + 2]],
              [positions[o + 3], positions[o + 4], positions[o + 5]],
              [positions[o + 6], positions[o + 7], positions[o + 8]]];
  }
  return out;
}

function readTris(mesh) {
  const triangles = meshTriangles(mesh);
  return triangles.map(([v0, v1, v2], i) => {
    const min = [Math.min(v0[0], v1[0], v2[0]), Math.min(v0[1], v1[1], v2[1]), Math.min(v0[2], v1[2], v2[2])];
    const max = [Math.max(v0[0], v1[0], v2[0]), Math.max(v0[1], v1[1], v2[1]), Math.max(v0[2], v1[2], v2[2])];
    return { i, v0, v1, v2, min, max, c: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] };
  });
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

// nearest point on triangle to P (Ericson), returns { point, d2 }
function closestOnTri(P, tri) {
  const A = tri.v0, B = tri.v1, C = tri.v2;
  const sub = (p, q) => [p[0]-q[0], p[1]-q[1], p[2]-q[2]];
  const dot = (p, q) => p[0]*q[0] + p[1]*q[1] + p[2]*q[2];
  const add = (p, q) => [p[0]+q[0], p[1]+q[1], p[2]+q[2]];
  const mul = (p, s) => [p[0]*s, p[1]*s, p[2]*s];
  const ab = sub(B,A), ac = sub(C,A), ap = sub(P,A);
  const d1 = dot(ab,ap), d2 = dot(ac,ap);
  let Q;
  if (d1<=0&&d2<=0) Q = A;
  else { const bp = sub(P,B), d3 = dot(ab,bp), d4 = dot(ac,bp);
    if (d3>=0&&d4<=d3) Q = B;
    else { const vc = d1*d4 - d3*d2;
      if (vc<=0&&d1>=0&&d3<=0) Q = add(A, mul(ab, d1/(d1-d3)));
      else { const cp = sub(P,C), d5 = dot(ab,cp), d6 = dot(ac,cp);
        if (d6>=0&&d5<=d6) Q = C;
        else { const vb = d5*d2 - d1*d6;
          if (vb<=0&&d2>=0&&d6<=0) Q = add(A, mul(ac, d2/(d2-d6)));
          else { const va = d3*d6 - d5*d4;
            if (va<=0&&(d4-d3)>=0&&(d5-d6)>=0) Q = add(B, mul(sub(C,B), (d4-d3)/((d4-d3)+(d5-d6))));
            else { const denom = 1/(va+vb+vc); Q = add(add(A, mul(ab, vb*denom)), mul(ac, vc*denom)); } } } } } }
  const pq = sub(P, Q);
  return { point: Q, d2: dot(pq, pq) };
}

// squared distance from point to an AABB (0 inside)
function distSqBox(p, min, max) {
  let s = 0;
  for (let a = 0; a < 3; a++) { const v = p[a] < min[a] ? min[a] - p[a] : p[a] > max[a] ? p[a] - max[a] : 0; s += v * v; }
  return s;
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
  const tris = readTris(mesh);
  const root = build(tris);

  function raycast(origin, dir, { tMin = 1e-6, tMax = Infinity, skipTri = -1 } = {}) {
    const invD = [1 / dir[0], 1 / dir[1], 1 / dir[2]];
    let best = tMax, bestTri = -1;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (rayBox(origin, invD, node.min, node.max, tMin, best) === Infinity) continue;
      if (node.tris) {
        for (const tri of node.tris) {
          if (tri.i === skipTri) continue;
          const t = rayTri(origin, dir, tri, tMin);
          if (t < best) { best = t; bestTri = tri.i; }
        }
      } else { stack.push(node.left, node.right); }
    }
    return bestTri === -1 ? null : { t: best, tri: bestTri };
  }

  // No production consumer yet — pre-built + tested as the reusable primitive for the deferred clearance/min-feature gate.
  function closestPoint(p) {
    let best2 = Infinity, bestPt = null, bestTri = -1;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (distSqBox(p, node.min, node.max) > best2) continue;
      if (node.tris) {
        for (const tri of node.tris) { const r = closestOnTri(p, tri); if (r.d2 < best2) { best2 = r.d2; bestPt = r.point; bestTri = tri.i; } }
      } else {
        // visit the nearer child first for better pruning
        const dl = distSqBox(p, node.left.min, node.left.max), dr = distSqBox(p, node.right.min, node.right.max);
        if (dl < dr) { stack.push(node.right, node.left); } else { stack.push(node.left, node.right); }
      }
    }
    return { point: bestPt, dist: Math.sqrt(best2), tri: bestTri };
  }

  return { raycast, closestPoint };
}
