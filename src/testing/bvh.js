// src/testing/bvh.js
// Triangle BVH over a mesh in either Manifold non-indexed soup form (9 floats per
// triangle, no `indices`) or OCCT indexed form (`positions` = 3 floats/vertex +
// `indices` = 3 vertex-indices/triangle). A reusable spatial index: nearest ray hit
// (raycast), nearest surface point (closestPoint), and exact mesh-to-mesh distance
// (distanceTo). AABB tree, median split on the widest centroid axis, slab ray–box
// test with pruning.

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

// squared distance between two AABBs (0 when they overlap)
function boxBoxDistSq(a, b) {
  let s = 0;
  for (let ax = 0; ax < 3; ax++) {
    const v = a.min[ax] > b.max[ax] ? a.min[ax] - b.max[ax] : b.min[ax] > a.max[ax] ? b.min[ax] - a.max[ax] : 0;
    s += v * v;
  }
  return s;
}

// closest points between segments P1→Q1 and P2→Q2 (Ericson 5.1.9), → { a, b, d2 }
function closestSegSeg(P1, Q1, P2, Q2) {
  const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const d1 = sub(Q1, P1), d2v = sub(Q2, P2), r = sub(P1, P2);
  const a = dot(d1, d1), e = dot(d2v, d2v), f = dot(d2v, r);
  const EPS = 1e-12;
  let s, t;
  if (a <= EPS && e <= EPS) { s = 0; t = 0; }
  else if (a <= EPS) { s = 0; t = clamp01(f / e); }
  else {
    const c = dot(d1, r);
    if (e <= EPS) { t = 0; s = clamp01(-c / a); }
    else {
      const b = dot(d1, d2v), denom = a * e - b * b;
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  const A = [P1[0] + d1[0] * s, P1[1] + d1[1] * s, P1[2] + d1[2] * s];
  const B = [P2[0] + d2v[0] * t, P2[1] + d2v[1] * t, P2[2] + d2v[2] * t];
  const pq = sub(A, B);
  return { a: A, b: B, d2: dot(pq, pq) };
}

// exact min distance between two triangles → { d2, a, b } (a on t1, b on t2).
// Non-intersecting triangles realize their minimum at a vertex-face or edge-edge
// feature pair; a piercing edge (interior×interior crossing) is caught first with
// rayTri, since feature distances alone would miss it. rayTri's t is in units of
// the unnormalized edge direction, so 0 < t <= 1 means the segment itself pierces;
// parallel/grazing edges return Infinity and the coplanar cases fall to the
// feature distances.
function triTriDist(t1, t2) {
  const edges = (t) => [[t.v0, t.v1], [t.v1, t.v2], [t.v2, t.v0]];
  for (const [p, q] of edges(t1)) {
    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const t = rayTri(p, d, t2, 0);
    if (t <= 1) { const at = [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t]; return { d2: 0, a: at, b: at }; }
  }
  for (const [p, q] of edges(t2)) {
    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const t = rayTri(p, d, t1, 0);
    if (t <= 1) { const at = [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t]; return { d2: 0, a: at, b: at }; }
  }
  let best = { d2: Infinity, a: null, b: null };
  for (const v of [t2.v0, t2.v1, t2.v2]) {
    const r = closestOnTri(v, t1);
    if (r.d2 < best.d2) best = { d2: r.d2, a: r.point, b: v };
  }
  for (const v of [t1.v0, t1.v1, t1.v2]) {
    const r = closestOnTri(v, t2);
    if (r.d2 < best.d2) best = { d2: r.d2, a: v, b: r.point };
  }
  for (const [p1, q1] of edges(t1)) for (const [p2, q2] of edges(t2)) {
    const r = closestSegSeg(p1, q1, p2, q2);
    if (r.d2 < best.d2) best = { d2: r.d2, a: r.a, b: r.b };
  }
  return best;
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

  // Exact minimum surface-to-surface distance to another buildBVH result.
  // Dual traversal pruned by AABB–AABB distance; exact triangle–triangle
  // distance at leaf pairs; early-exits at 0 (touching/intersecting).
  function distanceTo(other) {
    const ext = (n) => (n.max[0] - n.min[0]) + (n.max[1] - n.min[1]) + (n.max[2] - n.min[2]);
    let best = { d2: Infinity, a: null, b: null };
    const stack = [[root, other._root]];
    while (stack.length && best.d2 > 0) {
      const [na, nb] = stack.pop();
      if (boxBoxDistSq(na, nb) >= best.d2) continue;
      const aLeaf = !!na.tris, bLeaf = !!nb.tris;
      if (aLeaf && bLeaf) {
        for (const ta of na.tris) for (const tb of nb.tris) {
          const r = triTriDist(ta, tb);
          if (r.d2 < best.d2) best = r;
        }
      } else if (!aLeaf && (bLeaf || ext(na) >= ext(nb))) {
        // descend the larger node; push the nearer child last so it pops first
        const dl = boxBoxDistSq(na.left, nb), dr = boxBoxDistSq(na.right, nb);
        if (dl < dr) stack.push([na.right, nb], [na.left, nb]);
        else stack.push([na.left, nb], [na.right, nb]);
      } else {
        const dl = boxBoxDistSq(na, nb.left), dr = boxBoxDistSq(na, nb.right);
        if (dl < dr) stack.push([na, nb.right], [na, nb.left]);
        else stack.push([na, nb.left], [na, nb.right]);
      }
    }
    if (best.a === null) return { distance: Infinity, at: null, pointA: null, pointB: null }; // empty mesh
    const at = [(best.a[0] + best.b[0]) / 2, (best.a[1] + best.b[1]) / 2, (best.a[2] + best.b[2]) / 2];
    return { distance: Math.sqrt(best.d2), at, pointA: best.a, pointB: best.b };
  }

  return { raycast, closestPoint, distanceTo, _root: root };
}
