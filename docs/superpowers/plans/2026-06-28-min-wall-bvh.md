# Min-Wall via Ray/Shot on a Triangle BVH — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the reserved `minWall` seam with a real, accurate measurement — ray/shot wall-thickness on a reusable triangle BVH — so `verify()`/`partforge measure` report actual min-wall numbers (as warnings) instead of "pending SDF".

**Architecture:** A reusable `bvh.js` (AABB tree over the mesh's non-indexed triangle soup; `raycast` + `closestPoint`). `min-wall.js` consumes it: cast an inward ray from each surface triangle's centroid, take the nearest hit as local thickness, report the minimum. `measure()` computes it when `opts.minWall` is set; `verify()` already routes it as a warn. The spike (recorded in the spec) proved ray/shot is exact and fast and rejected the voxel/SDF alternative.

**Tech Stack:** Plain ESM JavaScript (no TypeScript), Node 24, vitest, manifold-3d meshes.

## Global Constraints

- **Plain ESM JS, no TypeScript** — `import`/`export`, no type annotations.
- **Node 24** — run tests with the nvm prelude: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run …` (default shell Node is v16 and tests fail on it).
- **Mesh shape:** `solid.toMesh()` returns a **non-indexed triangle soup** — `{ positions, normals, triangles }` where `positions` has **9 floats per triangle** (3 verts × x,y,z), no `indices`. All new code consumes this shape.
- **`minWall` stays a warn** — it never gates `ok`. (`verify`'s metric registry already has `minWall: { kind: "warn" }`; do not change that.)
- **`measure()` default behavior unchanged:** `opts.minWall` is opt-in; with it off (incl. all 4-arg callers) `minWall` is `null` and no BVH is built.
- **These existing-test changes are INTENTIONAL** (the seam is being filled, not regressed): `test/measure.test.js` (minWall:true now returns a number), `test/verify.test.js` (the "pending SDF" message changes; healthy walls now *pass* instead of warning), `test/verify-cli.test.js` (the demo no longer emits a min-wall ⚠ because its wall is healthy).
- **Branch:** work on `sdf-minwall` (already checked out).
- **Commit trailer:** every commit message ends with
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- **Create** `src/testing/bvh.js` — `buildBVH(mesh) → { raycast, closestPoint }`. AABB tree over triangles; nearest-hit ray query + nearest-surface-point query.
- **Create** `src/testing/min-wall.js` — `minWall(mesh, opts?) → { value, location } | null`. Inward ray/shot per surface triangle, via the BVH.
- **Modify** `src/testing/measure.js` — compute `minWall` when `opts.minWall` is set (else `null`).
- **Modify** `src/testing/verify.js` — change the null-`minWall` message from "pending SDF" to "unavailable" (the computed path already works through the DSL).
- **Modify** `src/testing.js` — export `buildBVH` and `minWall` (the reusable primitives).
- **Create** `test/fixtures/thin-wall-part.js` — a part with a 0.6 mm wall (trips the min-wall warning).
- **Modify** `src/parts/demo.js` — (no behavior change needed; its wall is healthy) — only touched if a test requires it; see Task 6.
- **Modify** `docs/AUTHORING-PARTS.md` — update the "Self-verification" section: min-wall is now computed (ray/shot), still a warn.
- **Tests:** `test/bvh.test.js`, `test/min-wall.test.js` (new); update `test/measure.test.js`, `test/verify.test.js`, `test/verify-cli.test.js`.

---

### Task 1: BVH build + raycast

**Files:**
- Create: `src/testing/bvh.js`
- Test: `test/bvh.test.js`

**Interfaces:**
- Produces: `buildBVH(mesh) → { raycast, closestPoint }` (closestPoint added in Task 2). `mesh` is `{ positions }` (non-indexed soup, 9 floats/triangle). `raycast(origin, dir, opts?) → { t, tri } | null` returns the nearest forward triangle hit, where `t` is the ray parameter (distance, since `dir` is unit-length in callers) and `tri` is the triangle index. `opts`: `{ tMin=1e-6, tMax=Infinity, skipTri }`. Returns `null` on no hit.

- [ ] **Step 1: Write the failing test**

```js
// test/bvh.test.js
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
  const first = bvh.raycast([5, 10, -3], [0, 0, 1]);
  const second = bvh.raycast([5, 10, -3], [0, 0, 1], { skipTri: first.tri });
  expect(second.t).toBeCloseTo(8, 5);               // z=5 face
});

test("a ray that misses returns null", () => {
  const bvh = buildBVH(boxMesh(10, 20, 5));
  expect(bvh.raycast([100, 100, -3], [0, 0, 1])).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run test/bvh.test.js`
Expected: FAIL — `buildBVH` not defined.

- [ ] **Step 3: Write minimal implementation**

```js
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
  const root = build(readTris(mesh.positions));

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

  return { raycast };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run test/bvh.test.js`
Expected: PASS (4 raycast tests).

- [ ] **Step 5: Commit**

```bash
git add src/testing/bvh.js test/bvh.test.js
git commit -m "feat: triangle BVH with nearest-hit raycast

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: BVH closestPoint

**Files:**
- Modify: `src/testing/bvh.js`
- Test: `test/bvh.test.js`

**Interfaces:**
- Produces: `closestPoint(p) → { point:[x,y,z], dist, tri }` on the returned object — the nearest point on the mesh surface to `p`, its distance, and the triangle index. This is the reusable query a future clearance/min-feature check uses; it is part of the explicitly-chosen reusable-BVH design.

- [ ] **Step 1: Write the failing test**

```js
// append to test/bvh.test.js
test("closestPoint on a box face returns the perpendicular foot + distance", () => {
  const bvh = buildBVH(boxMesh(10, 20, 5));
  const r = bvh.closestPoint([5, 10, 9]);   // 4 above the z=5 top face
  expect(r.dist).toBeCloseTo(4, 5);
  expect(r.point[2]).toBeCloseTo(5, 5);
});

test("closestPoint matches a brute-force reference on the box", () => {
  const mesh = boxMesh(10, 20, 5);
  const bvh = buildBVH(mesh);
  const pts = [[-3, -3, -3], [5, 25, 2], [12, 10, 8], [5, 10, 2.5]];
  const brute = (p) => {
    let best = Infinity;
    for (let t = 0; t < mesh.positions.length / 9; t++) {
      const o = t * 9;
      const A = [mesh.positions[o], mesh.positions[o+1], mesh.positions[o+2]];
      const B = [mesh.positions[o+3], mesh.positions[o+4], mesh.positions[o+5]];
      const C = [mesh.positions[o+6], mesh.positions[o+7], mesh.positions[o+8]];
      best = Math.min(best, Math.sqrt(distSqPointTriRef(p, A, B, C)));
    }
    return best;
  };
  for (const p of pts) expect(bvh.closestPoint(p).dist).toBeCloseTo(brute(p), 4);
});

// reference closest-point-on-triangle (Ericson) for the brute-force check
function distSqPointTriRef(P, A, B, C) {
  const sub = (p, q) => [p[0]-q[0], p[1]-q[1], p[2]-q[2]];
  const dot = (p, q) => p[0]*q[0] + p[1]*q[1] + p[2]*q[2];
  const add = (p, q) => [p[0]+q[0], p[1]+q[1], p[2]+q[2]];
  const mul = (p, s) => [p[0]*s, p[1]*s, p[2]*s];
  const ab = sub(B,A), ac = sub(C,A), ap = sub(P,A);
  const d1 = dot(ab,ap), d2 = dot(ac,ap); if (d1<=0&&d2<=0) return dot(ap,ap);
  const bp = sub(P,B), d3 = dot(ab,bp), d4 = dot(ac,bp); if (d3>=0&&d4<=d3) return dot(bp,bp);
  const vc = d1*d4 - d3*d2; if (vc<=0&&d1>=0&&d3<=0){const v=d1/(d1-d3);const q=add(A,mul(ab,v));const pq=sub(P,q);return dot(pq,pq);}
  const cp = sub(P,C), d5 = dot(ab,cp), d6 = dot(ac,cp); if (d6>=0&&d5<=d6) return dot(cp,cp);
  const vb = d5*d2 - d1*d6; if (vb<=0&&d2>=0&&d6<=0){const w=d2/(d2-d6);const q=add(A,mul(ac,w));const pq=sub(P,q);return dot(pq,pq);}
  const va = d3*d6 - d5*d4; if (va<=0&&(d4-d3)>=0&&(d5-d6)>=0){const w=(d4-d3)/((d4-d3)+(d5-d6));const q=add(B,mul(sub(C,B),w));const pq=sub(P,q);return dot(pq,pq);}
  const denom=1/(va+vb+vc); const v=vb*denom, w=vc*denom; const q=add(add(A,mul(ab,v)),mul(ac,w)); const pq=sub(P,q); return dot(pq,pq);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run test/bvh.test.js`
Expected: FAIL — `bvh.closestPoint` is not a function.

- [ ] **Step 3: Write minimal implementation**

Add this closest-point-on-triangle helper near `rayTri` in `src/testing/bvh.js`:

```js
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
```

Then add `closestPoint` inside `buildBVH` and include it in the returned object:

```js
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
```

(Replace the previous `return { raycast };` with the `return { raycast, closestPoint };` above.)

- [ ] **Step 4: Run test to verify it passes**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run test/bvh.test.js`
Expected: PASS (raycast + closestPoint).

- [ ] **Step 5: Commit**

```bash
git add src/testing/bvh.js test/bvh.test.js
git commit -m "feat: BVH closestPoint (reusable for clearance/min-feature)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `min-wall.js` — ray/shot via the BVH

**Files:**
- Create: `src/testing/min-wall.js`
- Modify: `src/testing.js` (export `buildBVH` and `minWall`)
- Test: `test/min-wall.test.js`

**Interfaces:**
- Consumes: `buildBVH` (Tasks 1–2).
- Produces: `minWall(mesh, { maxThickness? } = {}) → { value, location } | null`. For each surface triangle: compute its outward normal and area; skip degenerate (near-zero-area) triangles; cast a ray from the centroid, nudged inward, along the reversed normal; the nearest hit distance (via `raycast`, skipping the source triangle, with `tMax = maxThickness`) is the local thickness. Return the minimum across samples with its `location` (the sampled centroid), or **`null`** if no sample yields a valid hit. `maxThickness` defaults to the mesh's bounding-box diagonal.

- [ ] **Step 1: Write the failing test**

```js
// test/min-wall.test.js
import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { minWall } from "../src/testing/min-wall.js";

let k;
beforeAll(async () => { const wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" }); });

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run test/min-wall.test.js`
Expected: FAIL — `minWall` not defined.

- [ ] **Step 3: Write minimal implementation**

```js
// src/testing/min-wall.js
// Min wall thickness by ray/shot on a triangle BVH (see the spec's spike: this beat the
// voxel/SDF approach on both accuracy and speed). For each surface triangle, cast a ray
// inward (reverse of its outward normal) from the centroid; the nearest hit is the local
// material thickness. The minimum across samples is the reported min wall.
import { buildBVH } from "./bvh.js";

export function minWall(mesh, { maxThickness } = {}) {
  const pos = mesh.positions;
  const n = pos.length / 9;
  if (n === 0) return null;

  // bbox diagonal as the default cap (a ray exiting into open air gets no hit anyway).
  if (maxThickness == null) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) { if (pos[i + a] < min[a]) min[a] = pos[i + a]; if (pos[i + a] > max[a]) max[a] = pos[i + a]; }
    maxThickness = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) + 1;
  }

  const bvh = buildBVH(mesh);
  let best = Infinity, loc = null;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const v0 = [pos[o], pos[o + 1], pos[o + 2]];
    const v1 = [pos[o + 3], pos[o + 4], pos[o + 5]];
    const v2 = [pos[o + 6], pos[o + 7], pos[o + 8]];
    const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;                       // degenerate triangle
    nx /= len; ny /= len; nz /= len;                // outward normal (manifold winding)
    const c = [(v0[0] + v1[0] + v2[0]) / 3, (v0[1] + v1[1] + v2[1]) / 3, (v0[2] + v1[2] + v2[2]) / 3];
    const dir = [-nx, -ny, -nz];                    // inward
    const origin = [c[0] + dir[0] * 1e-4, c[1] + dir[1] * 1e-4, c[2] + dir[2] * 1e-4];
    const hit = bvh.raycast(origin, dir, { tMax: maxThickness, skipTri: t });
    if (hit && hit.t < best) { best = hit.t; loc = c; }
  }
  return best === Infinity ? null : { value: best, location: loc };
}
```

Append to `src/testing.js`:

```js
export { buildBVH } from "./testing/bvh.js";
export { minWall } from "./testing/min-wall.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run test/min-wall.test.js`
Expected: PASS (all 6 fixtures, matching the spike's measured values).

- [ ] **Step 5: Commit**

```bash
git add src/testing/min-wall.js src/testing.js test/min-wall.test.js
git commit -m "feat: ray/shot min-wall thickness on the BVH + exports

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire min-wall into `measure()`

**Files:**
- Modify: `src/testing/measure.js`
- Test: `test/measure.test.js`

**Interfaces:**
- `measure(kernel, part, view, params, opts)` — when `opts.minWall` is truthy, each sub-part's `minWall` is computed from its mesh via `minWall(mesh).value` (or `null` if unreliable). With `opts.minWall` off (default, incl. 4-arg callers) it stays `null` and no BVH is built.

- [ ] **Step 1: Update the existing test (intended change)**

Replace the current min-wall test in `test/measure.test.js` (the one named "each subpart carries a minWall field (null until the SDF plan implements it)") with:

```js
test("minWall is null unless opts.minWall is set, then it is the measured thickness", () => {
  expect(measure(k, boxPart, "v").subparts[0].minWall).toBe(null);                 // off by default
  const w = measure(k, boxPart, "v", {}, { minWall: true }).subparts[0].minWall;   // boxPart is 10x20x5
  expect(w).toBeCloseTo(5, 1);                                                      // thinnest dimension
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run test/measure.test.js`
Expected: FAIL — `minWall` is still hard-coded `null`, so the `toBeCloseTo(5, 1)` assertion fails.

- [ ] **Step 3: Write minimal implementation**

In `src/testing/measure.js`, add the import at the top:

```js
import { minWall } from "./min-wall.js";
```

Replace the placeholder `minWall: null,` field (and its comment) in the per-sub-part object with:

```js
      minWall: opts.minWall ? (minWall(mesh)?.value ?? null) : null,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run test/measure.test.js`
Expected: PASS (off → null; on → ~5).

- [ ] **Step 5: Commit**

```bash
git add src/testing/measure.js test/measure.test.js
git commit -m "feat: measure() computes minWall when opts.minWall is set

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Update `verify()` message + integration tests

**Files:**
- Modify: `src/testing/verify.js`
- Test: `test/verify.test.js`

**Interfaces:**
- Behavior change: a null `minWall` (unavailable / unreliable) now reports message "min wall unavailable" instead of "min wall not yet measured (pending SDF)". The computed (non-null) path is unchanged — it already runs through the DSL evaluator and yields a `warn` status only when the assertion fails. `ok` semantics unchanged.

- [ ] **Step 1: Update the existing tests (intended changes)**

In `test/verify.test.js`:

(a) The pure test "min-wall is a warn (pending SDF), never a fail" — rename and update the message assertion (it feeds `facts.minWall: null`, so it exercises the unavailable branch):

```js
test("min-wall with no reading is a warn (unavailable), never a fail", () => {
  const checks = evaluateCase(facts, { profile: resolveProfile("fdm-pla"), expect: {} });
  const w = byKey(checks, "subpart", "minWall");
  expect(w.kind).toBe("warn");
  expect(w.status).toBe("warn");
  expect(w.message).toMatch(/unavailable/);
});
```

(b) The integration test "verify passes a sound part and reports a min-wall warning" — the tube's wall is healthy (~4 mm ≥ 1.2), so min-wall now *passes* rather than warns. Update it to assert the real measurement:

```js
test("verify passes a sound part and reports a real min-wall measurement", () => {
  const part = { ...tube(12, 10), verify: { process: "fdm-pla", expect: { tube: { holes: 1 }, _view: { overlaps: 0 } } } };
  const v = verify(k, part);
  expect(v.ok).toBe(true);
  const mw = v.cases[0].checks.find((c) => c.metric === "minWall");
  expect(mw.actual).toBeGreaterThan(1.2);   // healthy wall (~4 mm)
  expect(mw.status).toBe("pass");
});
```

(c) The demo test "the demo part ships a passing verify block" — drop the now-incorrect min-wall-warning assertion; assert the real measurement passes:

```js
test("the demo part ships a passing verify block", () => {
  const v = verify(k, demo);
  expect(v.ok).toBe(true);
  expect(v.cases.map((c) => c.name)).toEqual(["defaults", "M3", "M5"]);
  const mw = v.cases[0].checks.find((c) => c.metric === "minWall");
  expect(mw.actual).toBeGreaterThan(1.2);   // spacer wall ~2.2 mm
  expect(mw.status).toBe("pass");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run test/verify.test.js`
Expected: FAIL — the message still says "pending SDF" (test (a) fails on the regex).

- [ ] **Step 3: Write minimal implementation**

In `src/testing/verify.js`, change the `minWall` null-branch message in `check(...)`:

```js
    if (metric === "minWall") return { ...base, actual, status: "warn", pass: null, message: "min wall unavailable" };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run test/verify.test.js`
Expected: PASS (pure message test + both integration tests with real min-wall).

- [ ] **Step 5: Commit**

```bash
git add src/testing/verify.js test/verify.test.js
git commit -m "feat: verify reports real min-wall; 'unavailable' for no reading

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Thin-wall fixture + CLI tests (warning path)

**Files:**
- Create: `test/fixtures/thin-wall-part.js`
- Test: `test/verify-cli.test.js`

**Interfaces:**
- A part with a 0.6 mm wall and `process: "fdm-pla"` (minWall 1.2) → its min-wall check fails the threshold → a `⚠` warning, but `ok` stays true so `partforge measure` still exits 0. The demo (healthy wall) prints "all gates passed" with no min-wall ⚠.

- [ ] **Step 1: Update + add CLI tests (intended changes)**

In `test/verify-cli.test.js`:

(a) The existing demo test asserted a `⚠` from the (previously stubbed) min-wall. The demo's wall is healthy now, so update that test to assert the passing summary instead:

```js
test("measure --process runs verify, prints checks, exits 0 for a sound part", () => {
  const out = run(["measure", "src/parts/demo.js", "--process", "fdm-pla"]);
  expect(out).toMatch(/verify/);
  expect(out).toMatch(/all gates passed/);
});
```

(b) Add a test that the thin-wall fixture produces a min-wall warning yet still exits 0 (warnings never gate):

```js
test("a too-thin wall prints a ⚠ warning but still exits 0", () => {
  const out = run(["measure", "test/fixtures/thin-wall-part.js"]);
  expect(out).toMatch(/⚠/);
  expect(out).toMatch(/minWall/);
  expect(out).toMatch(/warning/);
});
```

Add `measure-thin-v.json` to the `afterAll` cleanup list (the fixture's part title slugs to `thin`, view `v`).

- [ ] **Step 2: Run test to verify it fails**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run test/verify-cli.test.js`
Expected: FAIL — fixture `test/fixtures/thin-wall-part.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `test/fixtures/thin-wall-part.js`:

```js
// A printable-but-too-thin part: a tube with a 0.6 mm wall. Fits the bed and has one
// bore, but its wall is under the FDM-PLA minimum (1.2 mm) — so min-wall WARNS while
// the hard gates pass and the exit code stays 0.
export default {
  meta: { title: "Thin", units: "mm" },
  defaults: {},
  parts: { ring: { views: ["v"], build: (k) => k.cylinder(4, 4, 10).cut(k.cylinder(3.4, 3.4, 14).translate([0, 0, -2])) } },
  views: { v: { label: "V" } },
  verify: { process: "fdm-pla", expect: { ring: { holes: 1 }, _view: { overlaps: 0 } } },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run test/verify-cli.test.js`
Expected: PASS (demo "all gates passed"; thin-wall ⚠ + exit 0).

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/thin-wall-part.js test/verify-cli.test.js
git commit -m "test: thin-wall fixture exercises the min-wall warning path

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Docs + spec status + full suite green

**Files:**
- Modify: `docs/AUTHORING-PARTS.md`
- Modify: `docs/superpowers/specs/2026-06-28-dfm-and-self-verify-design.md`

- [ ] **Step 1: Update the authoring docs**

In `docs/AUTHORING-PARTS.md`, "Self-verification" section, the "Gates vs. warnings" paragraph currently says min-wall is "not yet computed (it reports 'pending SDF' …)". Replace that clause so it reads that min-wall **is computed** (ray/shot wall-thickness) and remains a **warning** (reported, never fails). Keep the rest of the paragraph (Manifold-only skip on OCCT) unchanged. Use this sentence:

```markdown
**Gates vs. warnings:** exact facts are **gates** (a failure sets a non-zero exit code);
`minWall` is computed (a ray/shot wall-thickness measurement) and reported as a
**warning** — it flags walls below the profile's minimum but never fails the build.
`holes`/`watertight` are Manifold-only, so those assertions **skip** on OCCT parts
rather than fail.
```

- [ ] **Step 2: Update the spec status line**

In `docs/superpowers/specs/2026-06-28-dfm-and-self-verify-design.md`, change the status line to record this slice as implemented:

```markdown
**Status:** Approved (design). Verify engine + DSL slice implemented + merged (2026-06-28).
Min-wall slice implemented (2026-06-28): ray/shot on a reusable triangle BVH (voxel/SDF
spiked and rejected). Reusable `closestPoint` ready for a future clearance/min-feature slice.
```

- [ ] **Step 3: Run the whole suite**

Run: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use && npx vitest run`
Expected: PASS — all files, no regressions (new `bvh`/`min-wall` suites + the updated measure/verify/CLI tests).

- [ ] **Step 4: Commit**

```bash
git add docs/AUTHORING-PARTS.md docs/superpowers/specs/2026-06-28-dfm-and-self-verify-design.md
git commit -m "docs: min-wall is now computed (ray/shot on BVH); update guide + spec

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Deferred to a future slice

- **Clearance/gap gate** between sub-parts — query one sub-part's BVH `closestPoint` at another's surface vertices → min distance. The BVH and `closestPoint` are built here for exactly this.
- **Min-feature size**; **shell/offset validation**.
- **Promoting min-wall from warn to gate** after validation on real curved parts (it stays a warn in this slice by design).
