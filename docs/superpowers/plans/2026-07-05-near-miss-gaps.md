# Near-Miss Gap Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** detect sub-parts separated by a small unintended gap (`nearMisses` in `measure`, `assemblyGaps` helper) and let parts gate touching/clearance intent via `verify.expect._view.contacts` / `.clearance` — closing the near-miss blind spot from issue #29.

**Architecture:** an exact dual-BVH mesh-to-mesh distance query (`bvh.distanceTo`) feeds a two-layer gap check (`meshGaps` core + `assemblyGaps` wrapper in `src/testing/gaps.js`). `measure` reports `gaps` (all pairs) and `nearMisses` (0 < d < 0.5 mm, minus overlapping pairs); `verify` adds pair-wise `contact`/`clearance` gate checks and `nearMiss` warnings following the #32 structured-diagnostics contract. Spec: `docs/superpowers/specs/2026-07-05-near-miss-gaps-design.md`.

**Tech Stack:** plain ESM, vitest, Manifold + OCCT WASM kernels (mesh-based — no kernel booleans needed).

## Global Constraints

- **Node 24 required**: run `nvm use` in the repo root before any `npm`/`npx` command (shell default Node is too old; tests fail confusingly otherwise).
- Repo: `/Users/scottsykora/Documents/Docs/pixite/code/Robot KB/partforge`, branch `near-miss-gaps`.
- All source is browser-and-worker-safe plain ESM — no Node built-ins in `src/testing/` geometry code.
- `docs/ERROR-PATTERNS.md` `##` headings are reserved for pattern entries (linted by `test/error-patterns.test.js`); IDs are permanent once committed.
- OCCT and Manifold must never boot in the same test file.
- Contact epsilon: `CONTACT_EPS = 1e-3` (mm) — a measured pair distance ≤ 1 µm counts as touching. Default near-miss threshold: `0.5` (mm). Defined once in `src/testing/gaps.js`.
- Pair identity is order-insensitive; the canonical pair key is the two names sorted and joined with `×` (the house pair separator, already used by the CLI's `a×b` output).

---

### Task 1: `bvh.distanceTo` — exact mesh-to-mesh distance

**Files:**
- Modify: `src/testing/bvh.js`
- Test: `test/bvh.test.js`

**Interfaces:**
- Consumes: existing `buildBVH(mesh)`, `closestOnTri`, `rayTri`, node shape `{ min, max, tris? | left/right }`.
- Produces: `buildBVH(mesh)` return gains `distanceTo(otherBvh) → { distance, at:[x,y,z]|null, pointA, pointB }` and `_root` (internal). `distance` is the exact minimum surface-to-surface distance (0 when touching/intersecting); `at` is the midpoint of the closest points.

- [ ] **Step 1: Write the failing tests** — append to `test/bvh.test.js`:

```js
// ── distanceTo (mesh-to-mesh) ──────────────────────────────────────────────────────────────
const translated = (mesh, [dx, dy, dz]) =>
  ({ ...mesh, positions: Array.from(mesh.positions).map((v, i) => v + [dx, dy, dz][i % 3]) });

test("distanceTo: parallel faces 0.2 apart → 0.2, at between the faces", () => {
  const a = buildBVH(boxMesh(10, 20, 5));
  const b = buildBVH(translated(boxMesh(10, 20, 5), [10.2, 0, 0]));
  const r = a.distanceTo(b);
  expect(r.distance).toBeCloseTo(0.2, 6);
  expect(r.at[0]).toBeCloseTo(10.1, 6);
});

test("distanceTo: diagonal corner-to-corner separation is exact", () => {
  const a = buildBVH(boxMesh(10, 20, 5));
  const b = buildBVH(translated(boxMesh(8, 6, 4), [13, 22, 6])); // gaps x:3 y:2 z:1
  const r = a.distanceTo(b);
  expect(r.distance).toBeCloseTo(Math.sqrt(14), 6);
  expect(r.at[0]).toBeCloseTo(11.5, 6);  // midpoint of (10,20,5)–(13,22,6)
  expect(r.at[1]).toBeCloseTo(21, 6);
  expect(r.at[2]).toBeCloseTo(5.5, 6);
});

test("distanceTo: crossed-edge configuration is exact (edge–edge closest)", () => {
  const a = buildBVH({ positions: [-5, 0, 0, 5, 0, 0, 0, 0.01, 0] });   // edge along x at z=0
  const b = buildBVH({ positions: [0, -5, 1, 0, 5, 1, 0.01, 0, 1] });   // edge along y at z=1
  expect(a.distanceTo(b).distance).toBeCloseTo(1, 6);
});

test("distanceTo: touching faces read 0", () => {
  const a = buildBVH(boxMesh(10, 20, 5));
  const b = buildBVH(translated(boxMesh(10, 20, 5), [10, 0, 0]));
  expect(a.distanceTo(b).distance).toBe(0);
});

test("distanceTo: interpenetrating boxes read 0", () => {
  const a = buildBVH(boxMesh(10, 20, 5));
  const b = buildBVH(translated(boxMesh(10, 20, 5), [9, 0, 0]));
  expect(a.distanceTo(b).distance).toBe(0);
});

test("distanceTo: a triangle piercing another's interior reads 0", () => {
  // no vertex-face or edge-edge feature pair is near — only the piercing test sees it
  const a = buildBVH({ positions: [-10, -10, 0, 10, -10, 0, 0, 10, 0] });
  const b = buildBVH({ positions: [0, 0, -1, 0.5, 0, 1, -0.5, 0, 1] });
  expect(a.distanceTo(b).distance).toBe(0);
});

test("distanceTo is symmetric", () => {
  const a = buildBVH(boxMesh(10, 20, 5));
  const b = buildBVH(translated(boxMesh(8, 6, 4), [13, 22, 6]));
  expect(b.distanceTo(a).distance).toBeCloseTo(a.distanceTo(b).distance, 9);
});

test("distanceTo works across indexed and soup meshes", () => {
  const a = buildBVH(indexedBoxMesh(10, 20, 5));
  const b = buildBVH(translated(boxMesh(10, 20, 5), [10.2, 0, 0]));
  expect(a.distanceTo(b).distance).toBeCloseTo(0.2, 6);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/bvh.test.js`
Expected: FAIL — `a.distanceTo is not a function` (8 new failures, all pre-existing tests pass).

- [ ] **Step 3: Implement** — in `src/testing/bvh.js`:

3a. Update the file header comment (line 4-5) to mention the third query: "nearest ray hit (raycast), nearest surface point (closestPoint), and exact mesh-to-mesh distance (distanceTo)".

3b. Add module-level helpers after `distSqBox` (~line 105):

```js
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
// the existing rayTri, since feature distances alone would miss it.
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
```

(`rayTri` returns `Infinity` for parallel/grazing edges — the feature distances then own the coplanar cases. `rayTri`'s `t` is in units of the unnormalized edge direction, so `0 < t <= 1` means the segment itself pierces.)

3c. Inside `buildBVH`, add `distanceTo` next to `closestPoint` and expose the root:

```js
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
```

(Replace the existing `return { raycast, closestPoint };`. `_root` is internal to `src/testing` — not documented API. Also delete the now-stale "No production consumer yet" comment above `closestPoint`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/bvh.test.js`
Expected: PASS (all, including the 8 new).

- [ ] **Step 5: Commit**

```bash
git add src/testing/bvh.js test/bvh.test.js
git commit -m "feat: exact dual-BVH mesh-to-mesh distance (bvh.distanceTo)"
```

---

### Task 2: `src/testing/gaps.js` — `meshGaps` + `assemblyGaps` + fixture

**Files:**
- Create: `src/testing/gaps.js`
- Create: `test/fixtures/gap-part.js`
- Modify: `src/testing.js` (exports)
- Test: `test/gaps.test.js` (create)

**Interfaces:**
- Consumes: `buildView(kernel, part, view, params)` → `[{ name, solid, mesh }]`; `buildBVH(mesh).distanceTo(other)` from Task 1.
- Produces:
  - `CONTACT_EPS = 1e-3` (exported const, mm).
  - `meshGaps(built) → [{ a, b, distance, at }]` — every sub-part pair (view order, `a` before `b`), raw distances (0 = contact/overlap); pairs involving an empty mesh are skipped.
  - `assemblyGaps(kernel, part, view, params = {}, { threshold = 0.5 } = {}) → [{ a, b, distance, at }]` — only pairs with `CONTACT_EPS < distance < threshold`.
  - `test/fixtures/gap-part.js` default-exports a two-box `PartDefinition` (`left`, `right`) with `defaults: { gap: 0.2 }`, view `"v"`; boxes are 10 mm cubes separated by `gap` along x (faces at `x = 10` and `x = 10 + gap`).

- [ ] **Step 1: Write the fixture** — `test/fixtures/gap-part.js`:

```js
// Two 10 mm cubes `gap` apart along x — the near-miss test rig. gap 0.2 (default)
// = near miss; 0 = touching; negative = interpenetration; ≥0.5 = clear.
export default {
  meta: { title: "GapRig", units: "mm" },
  defaults: { gap: 0.2 },
  parts: {
    left:  { views: ["v"], build: (k) => k.box([0, 0, 0], [10, 10, 10]) },
    right: { views: ["v"], build: (k, p) => k.box([10 + p.gap, 0, 0], [20 + p.gap, 10, 10]) },
  },
  views: { v: { label: "V" } },
};
```

- [ ] **Step 2: Write the failing tests** — `test/gaps.test.js`:

```js
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel, buildView, assemblyGaps, meshGaps } from "../src/testing.js";
import gapPart from "./fixtures/gap-part.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

test("assemblyGaps reports the 0.2mm near miss with a sensible location", () => {
  const gaps = assemblyGaps(k, gapPart, "v"); // defaults: gap 0.2
  expect(gaps).toHaveLength(1);
  expect(gaps[0].a).toBe("left");
  expect(gaps[0].b).toBe("right");
  expect(gaps[0].distance).toBeCloseTo(0.2, 5);
  expect(gaps[0].at[0]).toBeCloseTo(10.1, 4);       // between the facing faces
  expect(gaps[0].at[1]).toBeGreaterThanOrEqual(0);  // on the shared face footprint
  expect(gaps[0].at[1]).toBeLessThanOrEqual(10);
});

test("a 5mm separation is not a near miss", () => {
  expect(assemblyGaps(k, gapPart, "v", { gap: 5 })).toEqual([]);
});

test("touching (gap 0) is contact, not a near miss", () => {
  expect(assemblyGaps(k, gapPart, "v", { gap: 0 })).toEqual([]);
});

test("interpenetration is not a near miss (the overlap check owns it)", () => {
  expect(assemblyGaps(k, gapPart, "v", { gap: -1 })).toEqual([]);
});

test("threshold is configurable", () => {
  expect(assemblyGaps(k, gapPart, "v", { gap: 0.7 })).toEqual([]); // ≥ default 0.5
  expect(assemblyGaps(k, gapPart, "v", { gap: 0.7 }, { threshold: 1 })).toHaveLength(1);
});

test("meshGaps returns raw distances for every pair (no threshold)", () => {
  const built = buildView(k, gapPart, "v", { gap: 3 });
  const gaps = meshGaps(built);
  expect(gaps).toHaveLength(1);
  expect(gaps[0].distance).toBeCloseTo(3, 5);
  k.cleanup?.();
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/gaps.test.js`
Expected: FAIL — `assemblyGaps`/`meshGaps` not exported from `../src/testing.js`.

- [ ] **Step 4: Implement** — `src/testing/gaps.js`:

```js
import { buildView } from "./build.js";
import { buildBVH } from "./bvh.js";

// A measured pair distance at or below this (mm) counts as touching — absorbs
// posing float error while staying far below any real print clearance.
export const CONTACT_EPS = 1e-3;

// Minimum surface-to-surface distance for every sub-part pair of pre-built posed
// meshes ([{ name, mesh }] — buildView output). Distance 0 = touching or
// interpenetrating surfaces; callers filter. Pairs involving an empty mesh are
// skipped (the watertight gate owns that failure). Pure mesh math — both backends.
//   → [{ a, b, distance, at: [x,y,z] }]
export function meshGaps(built) {
  const bvhs = built
    .filter(({ mesh }) => mesh.positions.length > 0)
    .map(({ name, mesh }) => ({ name, bvh: buildBVH(mesh) }));
  const out = [];
  for (let i = 0; i < bvhs.length; i++) {
    for (let j = i + 1; j < bvhs.length; j++) {
      const { distance, at } = bvhs[i].bvh.distanceTo(bvhs[j].bvh);
      out.push({ a: bvhs[i].name, b: bvhs[j].name, distance, at });
    }
  }
  return out;
}

// Near-miss check for an assembled view — the complement of assemblyOverlaps:
// sub-part pairs that *almost* touch (0 < distance < threshold mm) in the display
// pose. Same posing path as assemblyOverlaps; no kernel booleans, so it runs on
// Manifold and OCCT alike.
//   → [{ a, b, distance, at }] (empty = no near misses)
export function assemblyGaps(kernel, part, view, params = {}, { threshold = 0.5 } = {}) {
  const gaps = meshGaps(buildView(kernel, part, view, params));
  kernel.cleanup?.(); // free the per-check WASM objects (meshes are JS-owned copies)
  return gaps.filter((g) => g.distance > CONTACT_EPS && g.distance < threshold);
}
```

And in `src/testing.js`, after the `assemblyOverlaps` export line:

```js
export { assemblyGaps, meshGaps } from "./testing/gaps.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/gaps.test.js`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/testing/gaps.js src/testing.js test/gaps.test.js test/fixtures/gap-part.js
git commit -m "feat: assemblyGaps/meshGaps near-miss check (mesh-based, both backends)"
```

---

### Task 3: `measure` reports `gaps` + `nearMisses`; CLI prints them

**Files:**
- Modify: `src/testing/measure.js`
- Modify: `bin/cli.js` (`printMeasure`)
- Test: `test/measure.test.js`, `test/cli.test.js`

**Interfaces:**
- Consumes: `meshGaps(built)`, `CONTACT_EPS` from Task 2.
- Produces: the `measure` report gains `gaps` (all pairs, raw) and `nearMisses` (`CONTACT_EPS < d < opts.gapThreshold ?? 0.5`, excluding name-pairs present in `overlaps`). `measure.ok` is **unchanged**. CLI prints a `near-misses:` line after `overlaps:` in the same pair format.

- [ ] **Step 1: Write the failing tests** — append to `test/measure.test.js`:

```js
import gapPart from "./fixtures/gap-part.js";

test("measure reports the near-miss pair with distance and location", () => {
  const r = measure(k, gapPart, "v");                     // gap 0.2
  expect(r.nearMisses).toHaveLength(1);
  expect(r.nearMisses[0]).toMatchObject({ a: "left", b: "right" });
  expect(r.nearMisses[0].distance).toBeCloseTo(0.2, 5);
  expect(r.nearMisses[0].at[0]).toBeCloseTo(10.1, 4);
  expect(r.gaps).toHaveLength(1);                          // raw pair table
  expect(r.ok).toBe(true);                                 // near misses never gate measure.ok
});

test("separated and touching pairs produce no near-miss noise", () => {
  expect(measure(k, gapPart, "v", { gap: 5 }).nearMisses).toEqual([]);
  expect(measure(k, gapPart, "v", { gap: 0 }).nearMisses).toEqual([]);
});

test("an overlapping pair is in overlaps, not nearMisses", () => {
  const r = measure(k, gapPart, "v", { gap: -1 });
  expect(r.overlaps).toHaveLength(1);
  expect(r.nearMisses).toEqual([]);
  expect(r.ok).toBe(false);                                // the existing overlap gate
});

test("single-sub-part views report empty gaps and nearMisses", () => {
  const r = measure(k, boxPart, "v");
  expect(r.gaps).toEqual([]);
  expect(r.nearMisses).toEqual([]);
});

test("gapThreshold is configurable", () => {
  expect(measure(k, gapPart, "v", { gap: 0.7 }).nearMisses).toEqual([]);
  expect(measure(k, gapPart, "v", { gap: 0.7 }, { gapThreshold: 1 }).nearMisses).toHaveLength(1);
});
```

And append to `test/cli.test.js`:

```js
test("CLI measure prints near-misses (report-only — exit stays 0)", () => {
  const out = run(["measure", "test/fixtures/gap-part.js"]);
  expect(out).toMatch(/near-misses: left×right \(0\.20mm at \[/);
});

test("CLI measure prints 'near-misses: none' on a clean part", () => {
  const out = run(["measure", "src/parts/demo.js"]);
  expect(out).toMatch(/near-misses: none/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/measure.test.js test/cli.test.js`
Expected: FAIL — `nearMisses`/`gaps` undefined; CLI output lacks the line. Pre-existing tests still pass.

- [ ] **Step 3: Implement** — `src/testing/measure.js`:

Add the import:

```js
import { meshGaps, CONTACT_EPS } from "./gaps.js";
```

Update the report-shape comment (`→ { part, view, subparts[], aggregate, overlaps[], ok }` becomes `→ { part, view, subparts[], aggregate, overlaps[], gaps[], nearMisses[], ok }`) and note that near misses are reported, never folded into `ok`.

After the `subparts` map (meshes are JS-owned copies, safe to use any time) and after the `overlaps` computation, add:

```js
  // Pair surface distances from the meshes already built — no kernel dependency,
  // so this reads on OCCT too. nearMisses = the issue-#29 signal: pairs that
  // *almost* touch; overlapping pairs are excluded by name (a fully-contained
  // sub-part has surface distance > 0 but is the overlap gate's business).
  const gaps = built.length > 1 ? meshGaps(built) : [];
  const pairKey = (a, b) => [a, b].sort().join("×");
  const overlapping = new Set(overlaps.map((o) => pairKey(o.a, o.b)));
  const gapThreshold = opts.gapThreshold ?? 0.5;
  const nearMisses = gaps.filter(
    (g) => g.distance > CONTACT_EPS && g.distance < gapThreshold && !overlapping.has(pairKey(g.a, g.b)),
  );
```

(Place the `gaps` computation line before `kernel.cleanup?.()`; the filter can follow it.) Add `gaps` and `nearMisses` to the returned object after `overlaps`. `ok` unchanged.

In `bin/cli.js` `printMeasure`, after the `overlaps:` line:

```js
  console.log(`  near-misses: ${r.nearMisses.length
    ? r.nearMisses.map((g) => `${g.a}×${g.b} (${g.distance.toFixed(2)}mm at [${g.at.map((n) => n.toFixed(1)).join(", ")}])`).join(", ")
    : "none"}`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/measure.test.js test/cli.test.js test/gaps.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/testing/measure.js bin/cli.js test/measure.test.js test/cli.test.js
git commit -m "feat: measure reports gaps + nearMisses; CLI near-misses line"
```

---

### Task 4: verify gates — `contacts`, `clearance`, near-miss warnings

**Files:**
- Modify: `src/testing/verify.js`
- Test: `test/verify.test.js`

**Interfaces:**
- Consumes: `facts.gaps` / `facts.nearMisses` / `facts.overlaps` from Task 3; `parseAssertion`/`evaluateAssertion`; `normalizeExpectation`; `CONTACT_EPS` from Task 2.
- Produces: `verify.expect._view` accepts `contacts: [[a, b], …]` and `clearance: { "a×b": <expr | {expr,hint}> }`. Check objects: `{ scope: "view", subpart: "a×b", metric: "contact" | "clearance" | "nearMiss", kind, expr, actual, status, pass, message }` + `hint`/`pattern: "near-miss-gap"`/`location` on non-pass, per the #32 contract. Undeclared `facts.nearMisses` pairs → `kind: "warn"` checks. Unknown sub-part names and malformed pair keys throw.

- [ ] **Step 1: Write the failing tests** — append to `test/verify.test.js` (the `evaluateCase` section uses synthetic facts — no kernel):

```js
const twoBoxFacts = (over = {}) => ({
  subparts: [
    { name: "left", holes: 0, volume: 1000, surfaceArea: 600, triangleCount: 12, bbox: [10, 10, 10], watertight: true, minWall: null },
    { name: "right", holes: 0, volume: 1000, surfaceArea: 600, triangleCount: 12, bbox: [10, 10, 10], watertight: true, minWall: null },
  ],
  aggregate: { bbox: [20.2, 10, 10], volume: 2000 },
  overlaps: [],
  gaps: [{ a: "left", b: "right", distance: 0.2, at: [10.1, 5, 5] }],
  nearMisses: [{ a: "left", b: "right", distance: 0.2, at: [10.1, 5, 5] }],
  ...over,
});
const pairCheck = (checks, metric) => checks.find((c) => c.metric === metric);

test("an undeclared near miss is a warning with location, hint, and pattern", () => {
  const checks = evaluateCase(twoBoxFacts(), { profile: null, expect: {} });
  const w = pairCheck(checks, "nearMiss");
  expect(w.kind).toBe("warn");
  expect(w.status).toBe("warn");
  expect(w.subpart).toBe("left×right");
  expect(w.actual).toBeCloseTo(0.2, 6);
  expect(w.location).toEqual([10.1, 5, 5]);
  expect(w.hint).toMatch(/contacts|clearance/);
  expect(w.pattern).toBe("near-miss-gap");
});

test("declaring the pair in contacts turns the near miss into a gate failure (and silences the warning)", () => {
  const checks = evaluateCase(twoBoxFacts(), { profile: null, expect: { _view: { contacts: [["left", "right"]] } } });
  const c = pairCheck(checks, "contact");
  expect(c.kind).toBe("gate");
  expect(c.status).toBe("fail");
  expect(c.actual).toBeCloseTo(0.2, 6);
  expect(c.location).toEqual([10.1, 5, 5]);
  expect(c.hint).toBeTruthy();
  expect(pairCheck(checks, "nearMiss")).toBeUndefined();
});

test("contacts passes on a touching pair, in either name order", () => {
  const facts = twoBoxFacts({ gaps: [{ a: "left", b: "right", distance: 0, at: [10, 5, 5] }], nearMisses: [] });
  const checks = evaluateCase(facts, { profile: null, expect: { _view: { contacts: [["right", "left"]] } } });
  expect(pairCheck(checks, "contact").status).toBe("pass");
});

test("contacts passes on an overlapping pair (interpenetration is contact)", () => {
  const facts = twoBoxFacts({
    overlaps: [{ a: "left", b: "right", volume: 50, location: [10, 5, 5] }],
    gaps: [{ a: "left", b: "right", distance: 0.4, at: [10, 5, 5] }],  // contained-ish reading
    nearMisses: [],
  });
  const checks = evaluateCase(facts, { profile: null, expect: { _view: { contacts: [["left", "right"]] } } });
  expect(pairCheck(checks, "contact").status).toBe("pass");
});

test("clearance gates the measured pair distance with the assertion DSL", () => {
  const fail = evaluateCase(twoBoxFacts(), { profile: null, expect: { _view: { clearance: { "left×right": ">=0.3" } } } });
  expect(pairCheck(fail, "clearance").status).toBe("fail");
  expect(pairCheck(fail, "clearance").location).toEqual([10.1, 5, 5]);
  expect(pairCheck(fail, "nearMiss")).toBeUndefined();     // declared → no warning
  const ok = evaluateCase(twoBoxFacts({ gaps: [{ a: "left", b: "right", distance: 5, at: [12.5, 5, 5] }], nearMisses: [] }),
    { profile: null, expect: { _view: { clearance: { "left×right": ">=0.3" } } } });
  expect(pairCheck(ok, "clearance").status).toBe("pass");
});

test("clearance accepts { expr, hint } and surfaces the part-authored hint", () => {
  const checks = evaluateCase(twoBoxFacts(), { profile: null,
    expect: { _view: { clearance: { "left×right": { expr: ">=0.3", hint: "grow `gap`" } } } } });
  expect(pairCheck(checks, "clearance").hint).toBe("grow `gap`");
});

test("unknown sub-part names and malformed pair keys throw", () => {
  expect(() => evaluateCase(twoBoxFacts(), { profile: null, expect: { _view: { contacts: [["left", "wing"]] } } })).toThrow(/wing/);
  expect(() => evaluateCase(twoBoxFacts(), { profile: null, expect: { _view: { clearance: { "left+right": ">=0.3" } } } })).toThrow(/a×b/);
});

test("contact/clearance skip when facts carry no gap table (legacy facts)", () => {
  const facts = twoBoxFacts({ gaps: undefined, nearMisses: undefined });
  const checks = evaluateCase(facts, { profile: null,
    expect: { _view: { contacts: [["left", "right"]], clearance: { "left×right": ">=0.3" } } } });
  expect(pairCheck(checks, "contact").status).toBe("skip");
  expect(pairCheck(checks, "clearance").status).toBe("skip");
});
```

And the end-to-end block (kernel section of the same file, which already boots Manifold):

```js
import gapPart from "./fixtures/gap-part.js";

test("end-to-end: contacts gate fails on the real 0.2mm gap part", () => {
  const part = { ...gapPart, verify: { expect: { _view: { contacts: [["left", "right"]] } } } };
  const v = verify(k, part);
  expect(v.ok).toBe(false);
  const c = v.failures.find((f) => f.metric === "contact");
  expect(c.actual).toBeCloseTo(0.2, 4);
  expect(c.location[0]).toBeCloseTo(10.1, 3);
  expect(c.pattern).toBe("near-miss-gap");
});

test("end-to-end: undeclared near miss is a warning; verify still ok", () => {
  const v = verify(k, { ...gapPart, verify: { expect: {} } });
  expect(v.ok).toBe(true);
  expect(v.warnings.some((w) => w.metric === "nearMiss")).toBe(true);
});

test("end-to-end: declared clearance passes a separated pair", () => {
  const part = { ...gapPart, defaults: { gap: 5 }, verify: { expect: { _view: { clearance: { "left×right": ">=0.3" } } } } };
  const v = verify(k, part);
  expect(v.ok).toBe(true);
  expect(v.warnings.filter((w) => w.metric === "nearMiss")).toEqual([]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/verify.test.js`
Expected: FAIL — `unknown view metric "contacts"` thrown by the generic loop (this is the current behavior the task changes).

- [ ] **Step 3: Implement** — `src/testing/verify.js`:

Add the import:

```js
import { CONTACT_EPS } from "./gaps.js";
```

Add after `normalizeExpectation` (module level):

```js
const pairKey = (a, b) => [a, b].sort().join("×");

const PAIR_HINTS = {
  contact: "the pair should touch but doesn't — grow the joining feature or move the mating datum so the faces meet",
  clearance: "the pair's free-fit gap is out of the declared range — adjust the mating dimensions or the declared clearance",
  nearMiss: "sub-parts nearly touch here — if they should meet, declare the pair in verify.expect._view.contacts and close the gap; if a free fit is intended, declare it under clearance",
};

// Pair-wise view checks: `contacts` (must touch), `clearance` (assertion DSL vs
// the measured pair distance), and warnings for undeclared near misses. These are
// per-pair, so they live outside the scalar VIEW_METRICS registry but emit the
// same structured check objects.
function pairGapChecks(facts, { contacts, clearance }) {
  const checks = [];
  const declared = new Set();
  const names = new Set(facts.subparts.map((s) => s.name));
  const requireNames = (a, b, what) => {
    for (const n of [a, b]) if (!names.has(n)) throw new Error(`${what}: unknown sub-part "${n}" (view has: ${[...names].join(", ")})`);
  };
  const gapFor = (a, b) => facts.gaps?.find((g) => pairKey(g.a, g.b) === pairKey(a, b));

  for (const [a, b] of contacts ?? []) {
    requireNames(a, b, "contacts");
    declared.add(pairKey(a, b));
    const base = { scope: "view", subpart: `${a}×${b}`, metric: "contact", kind: "gate", expr: "touching" };
    const g = gapFor(a, b);
    if (!g) { checks.push({ ...base, actual: null, status: "skip", pass: null, message: "unavailable" }); continue; }
    const overlapping = (facts.overlaps ?? []).some((o) => pairKey(o.a, o.b) === pairKey(a, b));
    if (overlapping || g.distance <= CONTACT_EPS) {
      checks.push({ ...base, actual: g.distance, status: "pass", pass: true, message: overlapping ? "in contact (overlapping)" : "in contact" });
    } else {
      checks.push({ ...base, actual: g.distance, status: "fail", pass: false,
        message: `${g.distance.toFixed(3)}mm apart, expected touching`,
        hint: PAIR_HINTS.contact, pattern: "near-miss-gap", location: g.at });
    }
  }

  for (const [key, spec] of Object.entries(clearance ?? {})) {
    const names2 = key.split("×").map((s) => s.trim());
    if (names2.length !== 2 || !names2[0] || !names2[1]) throw new Error(`clearance: pair key must be "a×b", got "${key}"`);
    const [a, b] = names2;
    requireNames(a, b, "clearance");
    declared.add(pairKey(a, b));
    const { expr, hint: partHint } = normalizeExpectation(spec);
    const base = { scope: "view", subpart: `${a}×${b}`, metric: "clearance", kind: "gate", expr: String(expr) };
    const g = gapFor(a, b);
    if (!g) { checks.push({ ...base, actual: null, status: "skip", pass: null, message: "unavailable" }); continue; }
    const { pass, message } = evaluateAssertion(parseAssertion(expr), g.distance);
    const out = { ...base, actual: g.distance, status: pass ? "pass" : "fail", pass, message };
    if (!pass) { out.hint = partHint ?? PAIR_HINTS.clearance; out.pattern = "near-miss-gap"; out.location = g.at; }
    checks.push(out);
  }

  for (const g of facts.nearMisses ?? []) {
    if (declared.has(pairKey(g.a, g.b))) continue;
    checks.push({ scope: "view", subpart: `${g.a}×${g.b}`, metric: "nearMiss", kind: "warn",
      expr: "intent undeclared", actual: g.distance, status: "warn", pass: false,
      message: `${g.distance.toFixed(3)}mm gap`, hint: PAIR_HINTS.nearMiss,
      pattern: "near-miss-gap", location: g.at });
  }
  return checks;
}
```

In `evaluateCase`, pull the pair keys out of `_view` before the generic loop (they aren't scalar metrics) and append the pair checks:

```js
export function evaluateCase(facts, { profile, expect }) {
  const checks = [];
  const { contacts, clearance, ...viewScalarExp } = expect?._view ?? {};
  const viewExp = {
    ...(profile?.bed ? { bbox: `<=[${profile.bed.join(",")}]` } : {}),
    ...viewScalarExp,
  };
  for (const [metric, expr] of Object.entries(viewExp)) checks.push(check("view", null, metric, expr, VIEW_METRICS, facts));
  checks.push(...pairGapChecks(facts, { contacts, clearance }));
  // …subpart loop unchanged…
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/verify.test.js test/verify-cases.test.js test/verify-cli.test.js`
Expected: PASS (new + all pre-existing verify tests; `verify-cli`/`verify-cases` prove no regression from the `_view` destructuring).

- [ ] **Step 5: Commit**

```bash
git add src/testing/verify.js test/verify.test.js
git commit -m "feat: contacts/clearance gates + near-miss warnings in verify"
```

---

### Task 5: OCCT coverage

**Files:**
- Modify: `test/measure-occt.test.js`

**Interfaces:**
- Consumes: `measure` (Task 3), `test/fixtures/gap-part.js` (Task 2). Match the file's existing OCCT boot pattern (`bootOcctKernel()` in `beforeAll`) — do NOT boot Manifold in this file.

- [ ] **Step 1: Write the failing test** — append to `test/measure-occt.test.js`, reusing its existing kernel variable (check the file: it already boots OCCT in `beforeAll`; reuse that binding and its timeout conventions):

```js
import gapPart from "./fixtures/gap-part.js";

test("gaps/nearMisses populate on OCCT (mesh-based, no Solid.intersect)", () => {
  const r = measure(k, gapPart, "v");
  expect(r.overlaps).toEqual([]);                    // intersect unavailable → skipped
  expect(r.nearMisses).toHaveLength(1);
  expect(r.nearMisses[0].distance).toBeCloseTo(0.2, 3);
  expect(r.nearMisses[0].at[0]).toBeCloseTo(10.1, 2);
});
```

(If the file's kernel variable or `measure` import is named differently, follow the file's names. If `measure` isn't already imported there, add the import used by its siblings.)

- [ ] **Step 2: Run to verify current behavior**

Run: `npx vitest run test/measure-occt.test.js`
Expected: PASS immediately if Tasks 2–3 are complete (the mesh path is backend-agnostic) — that's fine; this test is regression insurance, not a red-first gate. If it FAILS, the OCCT mesh form broke an assumption (fix in `meshGaps`/`bvh.js`, not the test).

- [ ] **Step 3: Commit**

```bash
git add test/measure-occt.test.js
git commit -m "test: near-miss gaps read on the OCCT backend"
```

---

### Task 6: Documentation — AUTHORING-PARTS.md + ERROR-PATTERNS.md

**Files:**
- Modify: `docs/AUTHORING-PARTS.md`
- Modify: `docs/ERROR-PATTERNS.md`
- Test: `npx vitest run test/error-patterns.test.js` (lints the pattern entry)

- [ ] **Step 1: ERROR-PATTERNS.md** — add to the **Core framework** section (after `minwall-sliver-triangles`, keeping entry shape exactly: Symptom/Cause/Fix list lines):

```markdown
## near-miss-gap

- **Symptom:** A `⚠ … nearMiss` warning or `✗ … contact` failure from `verify` reporting sub-parts `N mm apart, expected touching`, or a `near-misses:` line in `measure` output for parts that look joined in the preview.
- **Cause:** Two sub-parts that should meet don't quite — a boss shorter than the gap it must bridge, a mis-placed mating datum in `derive()`, or a union that silently missed. Renders and volume/bbox checks cannot see sub-mm joint gaps; this check exists precisely for them.
- **Fix:** If the pair should touch, grow the joining feature or fix the datum math so the faces meet, then declare the pair in `verify.expect._view.contacts`; if a free fit is intended, declare it under `clearance`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Self-verification (the `verify` block)".
```

- [ ] **Step 2: Run the lint test**

Run: `npx vitest run test/error-patterns.test.js`
Expected: PASS.

- [ ] **Step 3: AUTHORING-PARTS.md** — four edits:

3a. In the `measure` report paragraph (§ "Measuring & rendering", the paragraph starting "`measure` prints a report:"), extend the sentence listing what it reports: after "plus an assembly overlap check" add ", and a **near-miss** check — sub-part pairs whose surfaces come closer than 0.5 mm without touching (`near-misses:` in the output; reported for judgment, never an exit-code gate by itself)".

3b. In "### The diagnostics contract (for agents)": in the `location` bullet, after the `overlaps` parenthetical, add: "and the pair checks `contact` / `clearance` / `nearMiss` (the midpoint between the pair's closest surface points)". After the paragraph on subpart facts / overlap entries, add: "Pair-distance facts are `gaps` (every sub-part pair: `{ a, b, distance, at }`, distance 0 = touching or overlapping) and `nearMisses` (the pairs with an unintended-looking gap under 0.5 mm)."

3c. In "## Self-verification (the `verify` block)": extend the example's `_view` line to

```js
    _view:  { overlaps: 0,
              contacts:  [["drum", "flange"]],       // these pairs must touch
              clearance: { "lid×body": ">=0.3" } },  // intended free fits
```

and update the `_view` assertions list sentence to "…and `_view` assertions `bbox`, `volume`, `overlaps`, plus the pair-wise `contacts` / `clearance` below."

3d. After the "**Gates vs. warnings:**" paragraph, add a subsection:

```markdown
**Contacts & clearance (near-miss gaps).** Volume, bbox, and render checks all miss
sub-parts that *almost* touch — a flange floating 0.3 mm off its drum body passes
every one of them. `measure` therefore reports `nearMisses` (pairs with a
surface-to-surface gap under 0.5 mm), and `_view` accepts two pair-wise gates:

- `contacts: [["drum", "flange"]]` — each listed pair must touch. The gate fails
  with the measured gap and the closest-point location when the surfaces don't
  meet. Interpenetration counts as contact — the separate `overlaps` gate owns
  *excessive* interpenetration.
- `clearance: { "lid×body": ">=0.3" }` — an intended free fit. Keys are `"a×b"`
  (order doesn't matter); values take the same assertion DSL as any metric (and
  the `{ expr, hint }` form), evaluated against the pair's minimum surface
  distance in mm.

Any pair *not* declared either way that sits closer than 0.5 mm becomes a
**warning** — the "did you mean these to touch?" signal. Declare the pair to
silence it. Distances are measured mesh-to-mesh (exact triangle distance, so it
works on both backends with no kernel booleans); contact tolerates ~1 µm, so a
tessellation-limited curved contact (e.g. equal-radius cylinder-in-bore built with
different facet counts) may read a few hundredths of a millimetre — prefer a tight
`clearance` bound like `"<=0.05"` over `contacts` for those.
```

- [ ] **Step 4: Re-read the two edited docs sections for coherence** (no duplicated sentences, examples parse), then commit:

```bash
git add docs/AUTHORING-PARTS.md docs/ERROR-PATTERNS.md
git commit -m "docs: contacts/clearance gates and near-miss reporting"
```

---

### Task 7: Full verification

- [ ] **Step 1: Full suite**

Run: `nvm use && npm test`
Expected: all files pass (including the untouched selection/pick/render suites).

- [ ] **Step 2: CLI smoke on real parts (acceptance: no near-miss noise)**

```bash
npx partforge measure src/parts/demo.js
npx partforge measure src/parts/planter.js
npx partforge measure src/parts/filleted-box.js
npx partforge measure test/fixtures/gap-part.js
```

Expected: the three real parts print `near-misses: none` and exit 0 (planter's verify block still passes); `gap-part` prints `near-misses: left×right (0.20mm at […])` and exits 0.

- [ ] **Step 3: Commit anything outstanding, then hand off to the finishing skill** (code review → PR referencing issue #29).
