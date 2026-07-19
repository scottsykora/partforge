# 2-D booleans — `Shape2D` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 2-D boolean composition to partforge via a `Shape2D` value — union/cut/intersect on profiles that feed `extrude`/`revolve` directly, exact on OCCT and faceted at mesh LOD on Manifold.

**Architecture:** `Shape2D` is a 2-D analogue of `Solid`, wrapping each backend's native 2-D shape (`CrossSection` on Manifold, replicad `Drawing` on OCCT) and mapping to their native booleans (`CrossSection.add/subtract/intersect`; Drawing `fuse/cut/intersect`). It reuses `Solid`'s content-hash cache (`h(...)` + `createSolidCache`) on Manifold and the plain-wrap/clone pattern on OCCT — matching each backend's existing asymmetry. Zero new runtime dependency.

**Tech Stack:** plain ESM JS, vitest, Manifold (`CrossSection`, WASM) + replicad/OCCT (`Drawing`, WASM), Node 24.

## Global Constraints

- **Node 24** — run `source ~/.nvm/nvm.sh && nvm use` before any `npm`/`npx vitest`; confirm `node -v` shows v24.x. If the sandbox lacks it, implement + report "needs controller verification" (never fake results).
- **Units are millimetres.**
- **`build`/helpers pure** — no `Math.random`, clock, module-level mutable state (content-hash memoization).
- **DOM-free / side-effect-free** geometry modules (load in worker + main + Node).
- **OCCT and Manifold must not boot in the same process** — OCCT tests in their own file (`bootOcctKernel`), Manifold in theirs (`bootManifoldKernel`).
- **Manifold WASM objects have no GC** — every `CrossSection` created must be `T()`-tracked and disposed via the cache's `dispose`, exactly like solids.
- **replicad booleans consume their operands** — a reused `Drawing` must `.clone()` first.
- **Kernel-contract lints** (`test/kernel-contract.test.js`): every public op on the kernel must be in `KERNEL_OPS`/`KERNEL_OPTIONAL_OPS`; every public method on a `Solid` in `SOLID_OPS`/`SOLID_OPTIONAL_OPS`; every listed op named in `docs/KERNEL-CONTRACT.md`; every `polygon.js` export named (backticked) in `KERNEL-CONTRACT.md`. Any task that adds a public op/method MUST update these lists + doc in the same task, or its own test run fails.
- **Version bump additive** — do NOT change `CONTRACT_VERSION` (currently `1`).
- **Do NOT touch** untracked `embed-test.html` / `src/app-embed-test.js`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

## Hash convention (used across tasks)

`Shape2D` hashes mirror `Solid`, folding operands by their own `_hash`:
```
k.shape2d(profile)  → h("shape2d", profile, segs)   // Manifold; OCCT omits segs
a.union(b)          → h("union2d",     a._hash, b._hash)
a.cut(b)            → h("cut2d",       a._hash, b._hash)
a.cutAll(ts)        → h("cutAll2d",    a._hash, ts.map(t => t._hash))
a.intersect(b)      → h("intersect2d", a._hash, b._hash)
```

---

### Task 1: 3-D `Solid.union(other)` method + call-site migration

Align the 3-D boolean surface to the 2-D method shape: add a binary `Solid.union(other)` method on both backends, list + document it, migrate simple binary call sites. `k.union([array])` is retained for n-ary/dynamic use.

**Files:**
- Modify: `src/framework/geometry/manifold-backend.js` (add `union` to `wrap()`)
- Modify: `src/framework/geometry/occt-backend.js` (add `union` to `wrap()`)
- Modify: `src/framework/geometry/kernel.js` (`SOLID_OPS` += `"union"`; typedef `@property`)
- Modify: `docs/KERNEL-CONTRACT.md` (name `union` as a Solid method)
- Modify: `src/parts/demo.js` (migrate binary `k.union([...])`)
- Test: `test/manifold-backend.test.js`, `test/occt-backend.test.js`

**Interfaces:**
- Produces: `Solid.union(other: Solid) => Solid` on both backends; same geometry & hash as `k.union([this, other])`.

- [ ] **Step 1: Write the failing tests**

Add to `test/manifold-backend.test.js`:
```js
test("Solid.union(other) equals k.union([a, b])", () => {
  const a = k.box({ min: [0, 0, 0], max: [10, 10, 10] });
  const b = k.box({ min: [5, 5, 0], max: [15, 15, 10] });
  const viaMethod = k.box({ min: [0, 0, 0], max: [10, 10, 10] }).union(k.box({ min: [5, 5, 0], max: [15, 15, 10] }));
  expect(viaMethod.volume()).toBeCloseTo(k.union([a, b]).volume(), 6);
});
```
Add to `test/occt-backend.test.js`:
```js
test("Solid.union(other) fuses like k.union([a, b])", () => {
  const mk = () => k.box({ min: [0, 0, 0], max: [10, 10, 10] });
  const mk2 = () => k.box({ min: [5, 5, 0], max: [15, 15, 10] });
  expect(mk().union(mk2()).volume()).toBeCloseTo(k.union([mk(), mk2()]).volume(), 3);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/manifold-backend.test.js test/occt-backend.test.js -t "union(other)"`
Expected: FAIL — `s.union is not a function`.

- [ ] **Step 3: Add `union` to both backends' `wrap()`**

In `src/framework/geometry/manifold-backend.js`, inside `wrap()`, next to `cut`/`intersect`, add (hash matches `k.union([a,b])`'s `h("union", [a._hash,b._hash])`):
```js
    union: (t) => cached(h("union", [hash, t._hash]), () => unionRaw([m, t._m])),
```

In `src/framework/geometry/occt-backend.js`, inside `wrap()`, next to `cut`/`intersect`, add:
```js
    union: (t) => wrap(shape.fuse(t._s), [...cloneLabels(labels), ...cloneLabels(t._labels ?? [])]),
```

- [ ] **Step 4: List + document the new method**

In `src/framework/geometry/kernel.js`, add `"union"` to `SOLID_OPS` (after `"intersect"`):
```js
export const SOLID_OPS = [
  "cut", "cutAll", "intersect", "union", "clone", "label", "boundingBox", "volume",
  ...
```
And add a typedef `@property` next to `intersect`:
```js
 * @property {(other: Solid) => Solid} union         boolean union with one other solid (n-ary: k.union([...]))
```
In `docs/KERNEL-CONTRACT.md`, wherever `intersect` is named as a Solid method, add `union` beside it (a Solid method that unions with one other solid; the `k.union([...])` kernel op remains for n-ary).

- [ ] **Step 5: Migrate binary call sites**

In `src/parts/demo.js:52`, change:
```js
        if (p.flange_d > 0) s = k.union([s, k.cylinder({ d: p.flange_d, h: p.flange_h })]);
```
to:
```js
        if (p.flange_d > 0) s = s.union(k.cylinder({ d: p.flange_d, h: p.flange_h }));
```
Leave `k.union(copies)` / `k.union(fixed)` dynamic-array sites in `test/patterns.test.js` and the binary `test/manifold-cache.test.js` sites AS-IS (the cache test specifically exercises the array form; do not migrate it).

- [ ] **Step 6: Run the suite + lints**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/manifold-backend.test.js test/occt-backend.test.js test/kernel-contract.test.js`
Expected: PASS (union method works both backends; SOLID_OPS lint accepts `union`).

- [ ] **Step 7: Commit**
```bash
git add src/framework/geometry/manifold-backend.js src/framework/geometry/occt-backend.js src/framework/geometry/kernel.js docs/KERNEL-CONTRACT.md src/parts/demo.js test/manifold-backend.test.js test/occt-backend.test.js
git commit -m "feat: Solid.union(other) method aligns 3-D booleans to the 2-D shape

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Pure region helpers — assemble + SVG-path discretize

The pure, WASM-free helpers `Shape2D.toRegions()` needs: assemble a flat set of point-rings into `[{outer, holes}]` by winding + nesting, and discretize an SVG path string into a point-ring (reusing F1's `sampleBezier`/`sampleArc`). No kernel boot — fully unit-testable.

**Files:**
- Create: `src/framework/geometry/shape2d-regions.js`
- Test: `test/shape2d-regions.test.js`

**Interfaces:**
- Produces:
  - `assembleRegions(rings: number[][][]): {outer:number[][], holes:number[][][]}[]` — group CCW outers with the CW holes nested inside them (even-odd nesting by point-in-polygon).
  - `svgPathToRings(d: string, segs: number): number[][][]` — parse `M`/`L`/`C`/`Z` (and `A` if present) into one ring per subpath; cubics via `sampleBezier`, arcs via `sampleArc`.
  - `regionsArea(regions): number` — net area of assembled regions (Σ|outer| − Σ|holes|); used by OCCT `Shape2D.area()`.

- [ ] **Step 1: Write the failing tests**

Create `test/shape2d-regions.test.js`:
```js
import { expect, test } from "vitest";
import { assembleRegions, svgPathToRings, regionsArea } from "../src/framework/geometry/shape2d-regions.js";

const area = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const [x1,y1]=p[i],[x2,y2]=p[(i+1)%p.length]; a += x1*y2 - x2*y1; } return a/2; };

test("assembleRegions nests a CW hole inside its CCW outer", () => {
  const outer = [[0,0],[10,0],[10,10],[0,10]];                 // CCW, area +100
  const hole  = [[3,3],[3,7],[7,7],[7,3]];                     // CW,  area -16
  const regions = assembleRegions([outer, hole]);
  expect(regions).toHaveLength(1);
  expect(area(regions[0].outer)).toBeCloseTo(100, 6);
  expect(regions[0].holes).toHaveLength(1);
  expect(Math.abs(area(regions[0].holes[0]))).toBeCloseTo(16, 6);
});

test("assembleRegions returns two disjoint outers as two regions", () => {
  const a = [[0,0],[5,0],[5,5],[0,5]], b = [[20,20],[25,20],[25,25],[20,25]];
  expect(assembleRegions([a, b])).toHaveLength(2);
});

test("svgPathToRings parses M/L into a polygon ring", () => {
  const rings = svgPathToRings("M0,0 L10,0 L10,10 L0,10 Z", 32);
  expect(rings).toHaveLength(1);
  expect(Math.abs(area(rings[0]))).toBeCloseTo(100, 6);
});

test("svgPathToRings samples a cubic C command via sampleBezier", () => {
  // one quarter-circle-ish cubic; ring should have many points, not 2
  const rings = svgPathToRings("M10,0 C10,5.52 5.52,10 0,10", 32);
  expect(rings[0].length).toBeGreaterThan(4);
  expect(rings[0][rings[0].length - 1][0]).toBeCloseTo(0, 6);
  expect(rings[0][rings[0].length - 1][1]).toBeCloseTo(10, 6);
});

test("regionsArea = Σ|outer| − Σ|holes|", () => {
  const outer = [[0,0],[10,0],[10,10],[0,10]], hole = [[3,3],[3,7],[7,7],[7,3]];
  expect(regionsArea(assembleRegions([outer, hole]))).toBeCloseTo(100 - 16, 6);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/shape2d-regions.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers**

Create `src/framework/geometry/shape2d-regions.js`:
```js
// Pure (WASM-free) helpers for materializing a 2-D boolean result into region
// arrays. assembleRegions groups a flat set of point-rings into {outer,holes}
// regions by winding + point-in-polygon nesting. svgPathToRings discretizes a
// replicad Drawing's SVG path (from toSVGPathD) into rings, reusing F1's
// sampleBezier / sampleArc so an OCCT-materialized curve facets like Manifold.
import { sampleBezier, sampleArc } from "./profile.js";

const ringArea = (p) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; a += x1 * y2 - x2 * y1; }
  return a / 2;
};

// Ray-cast point-in-polygon (even-odd). ring: [[x,y],…].
function pointInRing([px, py], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Group rings: positive-area rings are outers, negative-area are holes; nest each
// hole into the smallest-area outer that contains its first vertex.
export function assembleRegions(rings) {
  const outers = [], holes = [];
  for (const r of rings) {
    if (r.length < 3) continue;
    (ringArea(r) >= 0 ? outers : holes).push(r);
  }
  const regions = outers.map((outer) => ({ outer, holes: [] }));
  regions.sort((a, b) => Math.abs(ringArea(a.outer)) - Math.abs(ringArea(b.outer)));
  for (const hole of holes) {
    const home = regions.find((rg) => pointInRing(hole[0], rg.outer));
    if (home) home.holes.push(hole);
  }
  // largest-first for a stable, readable order
  regions.sort((a, b) => Math.abs(ringArea(b.outer)) - Math.abs(ringArea(a.outer)));
  return regions;
}

// Net area of assembled regions: Σ|outer| − Σ|holes|.
export function regionsArea(regions) {
  let a = 0;
  for (const rg of regions) {
    a += Math.abs(ringArea(rg.outer));
    for (const hole of rg.holes) a -= Math.abs(ringArea(hole));
  }
  return a;
}

// Minimal SVG-path tokenizer for the absolute commands replicad emits: M, L, C,
// A, Z (and their explicit forms). Coordinates are numbers separated by spaces
// or commas. One subpath (M…Z) → one ring; the start point is not duplicated.
export function svgPathToRings(d, segs) {
  const toks = d.match(/[MLCAZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  const rings = [];
  let ring = null, cur = null, start = null, i = 0;
  const num = () => Number(toks[i++]);
  while (i < toks.length) {
    const t = toks[i++];
    if (t === "M") { if (ring && ring.length >= 3) rings.push(ring); cur = start = [num(), num()]; ring = [cur.slice()]; }
    else if (t === "L") { cur = [num(), num()]; ring.push(cur.slice()); }
    else if (t === "C") {
      const c1 = [num(), num()], c2 = [num(), num()], end = [num(), num()];
      for (const p of sampleBezier(cur, c1, c2, end, segs)) ring.push(p);
      cur = end;
    }
    else if (t === "A") {
      // SVG elliptical arc: rx ry rot largeArc sweep x y. Treated as circular
      // (rx≈ry) via the three-point sampleArc: midpoint of the chord bulged by
      // the sagitta is a good `via`. If replicad never emits A (see Task 4), this
      // branch is dead but harmless.
      const rx = num(), ry = num(); num(); const large = num(), sweep = num(); const end = [num(), num()];
      const r = (rx + ry) / 2;
      const mx = (cur[0] + end[0]) / 2, my = (cur[1] + end[1]) / 2;
      const dx = end[0] - cur[0], dy = end[1] - cur[1], dist = Math.hypot(dx, dy) || 1e-9;
      const h2 = Math.max(0, r * r - (dist / 2) ** 2) ** 0.5;
      const sign = (large === sweep) ? 1 : -1;   // bulge side
      const via = [mx + sign * h2 * (-dy / dist), my + sign * h2 * (dx / dist)];
      for (const p of sampleArc(cur, via, end, segs)) ring.push(p);
      cur = end;
    }
    else if (t === "Z") { if (ring && ring.length >= 3) rings.push(ring); ring = null; }
  }
  if (ring && ring.length >= 3) rings.push(ring);
  return rings;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/shape2d-regions.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/framework/geometry/shape2d-regions.js test/shape2d-regions.test.js
git commit -m "feat: pure region-assembly + SVG-path discretizer for Shape2D materialization

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Manifold `Shape2D` (constructor, booleans, materialize, caching)

**Files:**
- Create: `src/framework/geometry/shape2d-sugar.js` (shared `.simple()`)
- Modify: `src/framework/geometry/manifold-backend.js` (`shape2d` op + `wrapShape2d`)
- Modify: `src/framework/geometry/kernel.js` (`KERNEL_OPS` += `"shape2d"`; new `SHAPE2D_OPS`)
- Modify: `test/kernel-contract.test.js` (lint the Shape2D public surface)
- Modify: `docs/KERNEL-CONTRACT.md` (name `shape2d` + the Shape2D methods)
- Test: `test/shape2d-manifold.test.js`

**Interfaces:**
- Produces (Manifold): `k.shape2d(profile|Shape2D) => Shape2D` with `_cs`, `_shape2d:true`, `_hash`, and methods `.union/.cut/.cutAll/.intersect(other)`, `.area()`, `.boundingBox()`, `.toRegions()`, `.simple()`.
- `SHAPE2D_OPS` (kernel.js): the public Shape2D method list, for the contract lint.

- [ ] **Step 1: Write the failing tests**

Create `test/shape2d-manifold.test.js`:
```js
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { circleProfile } from "../src/framework/geometry/polygon.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const SQ = (x0, y0, s) => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];

test("union area of two overlapping unit-spaced squares", () => {
  const s = k.shape2d(SQ(0, 0, 10)).union(SQ(5, 5, 10));   // 100 + 100 − 25 overlap
  expect(s.area()).toBeCloseTo(175, 4);
});

test("cut subtracts overlap area", () => {
  const s = k.shape2d(SQ(0, 0, 10)).cut(SQ(5, 5, 10));      // 100 − 25
  expect(s.area()).toBeCloseTo(75, 4);
});

test("intersect keeps the overlap", () => {
  const s = k.shape2d(SQ(0, 0, 10)).intersect(SQ(5, 5, 10));// 25
  expect(s.area()).toBeCloseTo(25, 4);
});

test("subtract that punches a hole extrudes to genus 1", () => {
  const plate = k.shape2d(SQ(0, 0, 20)).cut(SQ(7, 7, 6));   // hole strictly inside
  expect(k.extrude({ profile: plate, h: 3 }).genus()).toBe(1);
});

test("toRegions materializes; simple unwraps the single region", () => {
  const s = k.shape2d(SQ(0, 0, 10)).cut(SQ(7, 7, 6));       // ring with a hole → 1 region
  const regions = s.toRegions();
  expect(regions).toHaveLength(1);
  expect(s.simple().holes).toHaveLength(1);
});

test("boolean is content-hash cached (hit on repeat)", () => {
  k.beginSubPart("t");
  k.resetCacheStats();
  const one = () => k.shape2d(SQ(0, 0, 10)).cut(SQ(5, 5, 10)).area();
  one(); const before = k.cacheStats().hits; one();
  expect(k.cacheStats().hits).toBeGreaterThan(before);
  k.endSubPart();
});

test("curve operand: cut a circleProfile hole from a square", () => {
  const s = k.shape2d(SQ(-10, -10, 20)).cut(circleProfile(5));
  expect(s.area()).toBeCloseTo(400 - Math.PI * 25, 0);   // faceted → loose tol
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/shape2d-manifold.test.js`
Expected: FAIL — `k.shape2d is not a function`.

- [ ] **Step 3: Shared `.simple()` sugar**

Create `src/framework/geometry/shape2d-sugar.js`:
```js
// Backend-shared Shape2D front. Like solid-sugar for Solids, but the 2-D shared
// surface is small: .simple() unwraps a single-region materialization or throws.
// Backends attach the geometry ops (booleans, area, boundingBox, toRegions).
export function addShape2dSugar(s) {
  s.simple = () => {
    const regions = s.toRegions();
    if (regions.length !== 1) throw new Error(`Shape2D.simple: result has ${regions.length} regions, not 1 (use toRegions())`);
    return regions[0];
  };
  return s;
}
```

- [ ] **Step 4: Manifold `shape2d` + `wrapShape2d`**

In `src/framework/geometry/manifold-backend.js`:

Add the import near the top (beside the profile import):
```js
import { addShape2dSugar } from "./shape2d-sugar.js";
import { assembleRegions } from "./shape2d-regions.js";
```

Inside `createManifoldKernel`, after `wrap`/`cached` are defined, add the 2-D shape wrapper and constructor (mirrors `wrap`/`cached`; every `CrossSection` is `T()`-tracked and cache-disposed):
```js
  // 2-D cross-section value. Mirrors wrap()/cached(): booleans route through the
  // solid cache (dispose frees the CrossSection); operands fold by _hash.
  const cachedCS = (hash, computeCS) => cache.lookup(hash, () => {
    const cs = computeCS();                     // already T()-tracked
    return { value: wrapShape2d(cs, hash), pin: cs, dispose: () => cs.delete?.() };
  });
  const liftCS = (x) => (x && x._shape2d ? x : shape2d(x));
  const wrapShape2d = (cs, hash) => addShape2dSugar({
    _cs: cs,
    _shape2d: true,
    _hash: hash,
    union:     (o) => { const t = liftCS(o); return cachedCS(h("union2d", hash, t._hash), () => T(cs.add(t._cs))); },
    cut:       (o) => { const t = liftCS(o); return cachedCS(h("cut2d", hash, t._hash), () => T(cs.subtract(t._cs))); },
    cutAll:    (os) => { const ts = os.map(liftCS); return cachedCS(h("cutAll2d", hash, ts.map((t) => t._hash)),
                 () => T(ts.reduce((acc, t) => T(acc.subtract(t._cs)), cs))); },
    intersect: (o) => { const t = liftCS(o); return cachedCS(h("intersect2d", hash, t._hash), () => T(cs.intersect(t._cs))); },
    area: () => cs.area(),
    boundingBox: () => { const r = cs.bounds(); return { min: [r.min[0], r.min[1]], max: [r.max[0], r.max[1]] }; },
    toRegions: () => assembleRegions(cs.toPolygons()),
    clone: () => wrapShape2d(cs, hash),
  });
  const shape2d = (profile) => {
    if (profile && profile._shape2d) return profile;                // idempotent
    const hash = h("shape2d", profile, segs);
    return cachedCS(hash, () => {
      const { outer, holes } = tessellateProfile(profile, segs);
      return T(CrossSection.ofPolygons([outer, ...holes], "EvenOdd"));
    });
  };
```
Add `shape2d` to the returned kernel object (in the `return finishKernel({ … })` list):
```js
    shape2d,
```
**Verify against the API while implementing:** `CrossSection.bounds()` return shape — the plan assumes `{ min:[x,y], max:[x,y] }`; if replicad's `Rect` uses different field names, adapt the `boundingBox()` mapping (the test only reads `.min`/`.max`). Confirm `CrossSection.ofPolygons(polys, "EvenOdd")` and `.add/.subtract/.intersect/.area/.toPolygons` signatures against `node_modules/manifold-3d/manifold.d.ts` before finishing.

- [ ] **Step 5: List + lint the Shape2D surface**

In `src/framework/geometry/kernel.js`: add `"shape2d"` to `KERNEL_OPS` (after `"union"`), and add a new export:
```js
// Public methods every Shape2D exposes (2-D boolean value; contract-linted).
export const SHAPE2D_OPS = [
  "union", "cut", "cutAll", "intersect", "area", "boundingBox", "toRegions", "simple", "clone",
];
```
In `test/kernel-contract.test.js`, add a Shape2D public-surface lint mirroring the Solid one (import `SHAPE2D_OPS`; `k.shape2d(...)` on the booted Manifold kernel — this file already boots Manifold for the Solid checks):
```js
test("Shape2D exposes exactly the documented method surface", () => {
  const documented = new Set(SHAPE2D_OPS);
  const shape = k.shape2d([[0, 0], [10, 0], [10, 10], [0, 10]]);
  expect(publicKeys(shape).filter((key) => !documented.has(key))).toEqual([]);
});
```
(Match the file's existing `publicKeys`/boot pattern; if it doesn't already boot a Manifold kernel, add a `beforeAll(bootManifoldKernel)` consistent with the Solid check.) In `docs/KERNEL-CONTRACT.md`, name `shape2d` and each `SHAPE2D_OPS` method (the "names every contract op" lint iterates `SHAPE2D_OPS` too — extend that test's `ops` array to include `...SHAPE2D_OPS`).

- [ ] **Step 6: Run tests + lints**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/shape2d-manifold.test.js test/kernel-contract.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**
```bash
git add src/framework/geometry/shape2d-sugar.js src/framework/geometry/manifold-backend.js src/framework/geometry/kernel.js test/kernel-contract.test.js docs/KERNEL-CONTRACT.md test/shape2d-manifold.test.js
git commit -m "feat: Manifold Shape2D — 2-D booleans via CrossSection, cached + materializable

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: OCCT `Shape2D` (constructor, booleans, materialize)

Mirror Task 3 on OCCT: `Shape2D` wraps a replicad `Drawing`; booleans use `fuse/cut/intersect` with `.clone()` discipline; `.toRegions()` discretizes via Task 2's `svgPathToRings`. No cache on this backend (matches OCCT's `Solid`).

**Files:**
- Modify: `src/framework/geometry/occt-backend.js` (`shape2d` op + `wrapShape2d`)
- Test: `test/shape2d-occt.test.js`

**Interfaces:**
- Produces (OCCT): `k.shape2d(profile|Shape2D) => Shape2D` with `_drawing`, `_shape2d:true`, same method surface as Manifold (`SHAPE2D_OPS`).

- [ ] **Step 1: Verify what `toSVGPathD` emits (fixture check first)**

Before writing `toRegions`, add a temporary probe test to confirm whether replicad emits cubic `C` or elliptical-arc `A` for a curved boolean result, so the discretizer path is validated against reality (Task 2 handles both, but confirm which fires):
```js
// (temporary, remove after confirming) in test/shape2d-occt.test.js
test("probe: toSVGPaths of a circle-cut drawing", () => {
  const d = k.shape2d([[-10,-10],[10,-10],[10,10],[-10,10]]).cut(circleProfile(5));
  console.log(d._drawing.toSVGPaths());
});
```
Run it, read the emitted commands, then delete the probe. Record in the report which commands appear.

- [ ] **Step 2: Write the failing tests**

Create `test/shape2d-occt.test.js`:
```js
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { circleProfile, pathProfile } from "../src/framework/geometry/polygon.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

const SQ = (x0, y0, s) => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];
const stepText = async (solid) => new TextDecoder().decode(await k.toSTEP([{ name: "p", solid }]));

test("union/cut/intersect extrude to the expected volumes", () => {
  const h = 4;
  expect(k.extrude({ profile: k.shape2d(SQ(0,0,10)).union(SQ(5,5,10)), h }).volume()).toBeCloseTo(175 * h, -1);
  expect(k.extrude({ profile: k.shape2d(SQ(0,0,10)).cut(SQ(5,5,10)), h }).volume()).toBeCloseTo(75 * h, -1);
  expect(k.extrude({ profile: k.shape2d(SQ(0,0,10)).intersect(SQ(5,5,10)), h }).volume()).toBeCloseTo(25 * h, -1);
});

test("curve operand stays exact: cut a cubic-circle hole → STEP has a B_SPLINE", async () => {
  const KAPPA = 0.5522847498307936, R = 5, k4 = R * KAPPA;
  const circle = pathProfile([R, 0])
    .cubicTo([0, R], [R, k4], [k4, R]).cubicTo([-R, 0], [-k4, R], [-R, k4])
    .cubicTo([0, -R], [-R, -k4], [-k4, -R]).cubicTo([R, 0], [k4, -R], [R, -k4]).close();
  const plate = k.shape2d(SQ(-10, -10, 20)).cut(circle);
  const step = await stepText(k.extrude({ profile: plate, h: 3 }));
  expect(step).toMatch(/B_SPLINE/);
});

test("boundingBox and toRegions materialize", () => {
  const s = k.shape2d(SQ(0, 0, 10)).cut(SQ(7, 7, 6));
  const bb = s.boundingBox();
  expect(bb.min[0]).toBeCloseTo(0, 6); expect(bb.max[0]).toBeCloseTo(10, 6);
  const regions = s.toRegions();
  expect(regions).toHaveLength(1);
  const area = (p) => { let a=0; for (let i=0;i<p.length;i++){const [x1,y1]=p[i],[x2,y2]=p[(i+1)%p.length];a+=x1*y2-x2*y1;} return Math.abs(a/2); };
  expect(area(regions[0].outer)).toBeCloseTo(100, 4);
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/shape2d-occt.test.js`
Expected: FAIL — `k.shape2d is not a function`.

- [ ] **Step 4: OCCT `shape2d` + `wrapShape2d`**

In `src/framework/geometry/occt-backend.js`:

Add imports:
```js
import { addShape2dSugar } from "./shape2d-sugar.js";
import { assembleRegions, svgPathToRings, regionsArea } from "./shape2d-regions.js";
```

Inside `createOcctKernel`, after `contourDrawing` is defined, add (a region → Drawing via `contourDrawing` + hole-cuts, exactly like `extrude`'s region path; `.clone()` before any consuming boolean so a reused shape survives):
```js
  const SHAPE2D_SEGS = 64;   // materialization LOD for toRegions() discretization
  const drawingFromProfile = (profile) => {
    const { outer, holes } = normalizeProfile(profile);
    let region = contourDrawing(outer);
    for (const hole of holes) region = region.cut(contourDrawing(hole));
    return region;
  };
  const liftDrawing = (x) => (x && x._shape2d ? x : shape2d(x));
  const wrapShape2d = (drawing) => {
    const toRegions = () => assembleRegions(drawing.toSVGPaths().flatMap((d) => svgPathToRings(d, SHAPE2D_SEGS)));
    return addShape2dSugar({
      _drawing: drawing,
      _shape2d: true,
      union:     (o) => wrapShape2d(drawing.clone().fuse(liftDrawing(o)._drawing.clone())),
      cut:       (o) => wrapShape2d(drawing.clone().cut(liftDrawing(o)._drawing.clone())),
      cutAll:    (os) => wrapShape2d(os.map(liftDrawing).reduce((acc, t) => acc.cut(t._drawing.clone()), drawing.clone())),
      intersect: (o) => wrapShape2d(drawing.clone().intersect(liftDrawing(o)._drawing.clone())),
      area: () => regionsArea(toRegions()),                 // no native Drawing area → derive from materialized regions
      boundingBox: () => { const b = drawing.boundingBox; return { min: [b.bounds[0][0], b.bounds[0][1]], max: [b.bounds[1][0], b.bounds[1][1]] }; },
      toRegions,
      clone: () => wrapShape2d(drawing.clone()),
    });
  };
  const shape2d = (profile) => (profile && profile._shape2d ? profile : wrapShape2d(drawingFromProfile(profile)));
```
**Verify `Drawing.boundingBox` against the real replicad API while coding:** the `boundingBox()` mapping assumes `Drawing.boundingBox` (a `BoundingBox2d`) exposes `.bounds` as `[[minX,minY],[maxX,maxY]]`; if the field names differ (`.min/.max`, `.center/.width`, etc.), adapt so `.min`/`.max` are `[x,y]` — the tests read `.min[0]`/`.max[0]`. `area()` derives from `toRegions()` (no native Drawing area accessor), so it needs no API guess.

Add `shape2d` to the returned kernel object:
```js
    shape2d,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/shape2d-occt.test.js`
Expected: PASS (volumes match, STEP has `B_SPLINE`, toRegions materializes). If `toRegions` disagrees on area, revisit `svgPathToRings` against the commands recorded in Step 1.

- [ ] **Step 6: Commit**
```bash
git add src/framework/geometry/occt-backend.js test/shape2d-occt.test.js
git commit -m "feat: OCCT Shape2D — curve-preserving 2-D booleans + Drawing materialization

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `extrude` / `revolve` accept a `Shape2D`

**Files:**
- Modify: `src/framework/geometry/manifold-backend.js` (`extrude`/`revolve` Shape2D branch)
- Modify: `src/framework/geometry/occt-backend.js` (`extrude`/`revolve` Shape2D branch)
- Modify: `src/framework/geometry/op-options.js` (`revolveArgs` check: Shape2D branch)
- Test: `test/shape2d-manifold.test.js`, `test/shape2d-occt.test.js`

**Interfaces:**
- Consumes: `Shape2D` (`_shape2d`, `_cs`/`_drawing`, `_hash` on Manifold).
- Produces: `k.extrude({ profile: shape, h })` and `k.revolve({ profile: shape, degrees })` accept a `Shape2D`.

- [ ] **Step 1: Write failing tests**

Add to `test/shape2d-manifold.test.js`:
```js
test("revolve of a Shape2D lathe profile builds a sane solid", () => {
  const prof = k.shape2d([[2, 0], [6, 0], [6, 8], [2, 8]]);   // rectangle in +X (r,z)
  const v = k.revolve({ profile: prof, degrees: 360 }).volume();
  expect(v).toBeCloseTo(Math.PI * (6 * 6 - 2 * 2) * 8, -1);   // annular ring volume
});
```
Add to `test/shape2d-occt.test.js`:
```js
test("revolve of a Shape2D builds a positive-volume solid", () => {
  const prof = k.shape2d([[2, 0], [6, 0], [6, 8], [2, 8]]);
  expect(k.revolve({ profile: prof, degrees: 360 }).volume()).toBeGreaterThan(0);
});
```
(Extrude-of-Shape2D is already exercised by Task 3/4 genus/volume tests — those will pass once the extrude branch lands; they currently rely on it, so run them here too.)

- [ ] **Step 2: Run to verify the revolve tests fail**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/shape2d-manifold.test.js test/shape2d-occt.test.js -t "revolve of a Shape2D"`
Expected: FAIL — revolve doesn't handle a Shape2D (throws in `revolveArgs` check `for (const [r] of pts)`, or downstream).

- [ ] **Step 3: `revolveArgs` Shape2D branch (op-options.js)**

In `src/framework/geometry/op-options.js`, change the `revolve` check to handle a `Shape2D` (branded `_shape2d`) via its bounding box, keeping the point-array scan for the legacy form:
```js
  revolve:  { toArgs: revolveArgs, check: (pts) => {
    if (pts && pts._shape2d) {
      if (pts.boundingBox().min[0] < 0) throw new Error("revolve: profile radius must be ≥ 0");
      return;
    }
    for (const [r] of pts) if (r < 0) throw new Error("revolve: profile radius must be ≥ 0");
  } },
```
(This keeps op-options geometry-free — it only reads a brand and calls a method on the passed value.)

- [ ] **Step 4: Manifold `extrude`/`revolve` Shape2D branch**

In `src/framework/geometry/manifold-backend.js`, at the top of `extrude`, before `cached(...)`, add a Shape2D fast path (reuse the shape's cross-section; still cache by the shape's `_hash`):
```js
    extrude: (profile, height, { twist = 0, scaleTop = 1 } = {}) => {
      if (profile && profile._shape2d) {
        return cached(h("extrude", profile._hash, height, twist, scaleTop, segs), () => {
          const cs = profile._cs;
          if (twist === 0 && scaleTop === 1) return T(cs.extrude(height));
          const nDiv = Math.max(1, Math.ceil(Math.abs(twist) / 5));
          return T(cs.extrude(height, nDiv, twist, [scaleTop, scaleTop]));
        });
      }
      return cached(h("extrude", profile, height, twist, scaleTop, segs), () => {
        const { outer, holes } = tessellateProfile(profile, segs);
        const cs = T(CrossSection.ofPolygons([outer, ...holes], "EvenOdd"));
        if (twist === 0 && scaleTop === 1) return T(cs.extrude(height));
        const nDiv = Math.max(1, Math.ceil(Math.abs(twist) / 5));
        return T(cs.extrude(height, nDiv, twist, [scaleTop, scaleTop]));
      });
    },
```
And `revolve`:
```js
    revolve: (pts, { degrees = 360 } = {}) => {
      if (pts && pts._shape2d)
        return cached(h("revolve", pts._hash, degrees, segs), () => T(pts._cs.revolve(segs, degrees)));
      return cached(h("revolve", pts, degrees, segs), () => T(Manifold.revolve([pts], segs, degrees)));
    },
```

- [ ] **Step 5: OCCT `extrude`/`revolve` Shape2D branch**

In `src/framework/geometry/occt-backend.js`, at the top of `extrude`, add:
```js
  const extrude = (profile, h, { twist = 0, scaleTop = 1 } = {}) => {
    const region = profile && profile._shape2d ? profile._drawing.clone() : drawingFromProfile(profile);
    const sketch = region.sketchOnPlane("XY");
    if (twist === 0 && scaleTop === 1) return wrap(sketch.extrude(h));
    const cfg = {};
    if (twist !== 0) cfg.twistAngle = twist;
    if (scaleTop !== 1) cfg.extrusionProfile = { profile: "linear", endFactor: scaleTop };
    return wrap(sketch.extrude(h, cfg));
  };
```
(`drawingFromProfile` is the region-builder extracted in Task 4; the pre-Task-4 `extrude` inlined it — replace that inline body with the call. The existing `normalizeProfile`/`contourDrawing` path now lives in `drawingFromProfile`.) And `revolve`:
```js
  const revolve = (pts, { degrees = 360 } = {}) => {
    const region = pts && pts._shape2d ? pts._drawing.clone() : contourDrawing(pts);
    return wrap(region.sketchOnPlane("XZ").revolve([0, 0, 1], { angle: degrees }));
  };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/shape2d-manifold.test.js test/shape2d-occt.test.js`
Expected: PASS (extrude + revolve of Shape2D on both backends; earlier genus/volume tests still green).

- [ ] **Step 7: Commit**
```bash
git add src/framework/geometry/manifold-backend.js src/framework/geometry/occt-backend.js src/framework/geometry/op-options.js test/shape2d-manifold.test.js test/shape2d-occt.test.js
git commit -m "feat: extrude/revolve accept a Shape2D (both backends); revolve radius-check via bbox

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Errors, hash unit tests, parity, docs, version bump

**Files:**
- Test: `test/shape2d-regions.test.js` or a new `test/shape2d-hash.test.js` (hash + lift + validation, no WASM)
- Modify: `docs/AUTHORING-PARTS.md`, `docs/ERROR-PATTERNS.md`, `docs/KERNEL-CONTRACT.md` (parity note)
- Modify: `package.json` (+ lockfile sync)
- Test: full suite + smoke

- [ ] **Step 1: Hash + lift + validation unit tests (no WASM)**

The hash composition is testable without a kernel — `h` is pure. Add `test/shape2d-hash.test.js`:
```js
import { expect, test } from "vitest";
import { h } from "../src/framework/geometry/solid-hash.js";

test("Shape2D op hashes are operand-sensitive and stable", () => {
  const a = "aaa", b = "bbb", c = "ccc";
  expect(h("union2d", a, b)).toBe(h("union2d", a, b));       // stable
  expect(h("union2d", a, b)).not.toBe(h("union2d", a, c));   // operand-sensitive
  expect(h("cut2d", a, b)).not.toBe(h("union2d", a, b));     // op-sensitive
});
```
Add empty-shape / bad-profile behavior tests to `test/shape2d-manifold.test.js`:
```js
test("intersect of disjoint shapes is empty; simple() throws", () => {
  const s = k.shape2d([[0,0],[1,0],[1,1],[0,1]]).intersect([[10,10],[11,10],[11,11],[10,11]]);
  expect(s.area()).toBeCloseTo(0, 6);
  expect(() => s.simple()).toThrow("Shape2D.simple");
});
test("shape2d rejects an invalid profile", () => {
  expect(() => k.shape2d([[0, 0], [1, 0]])).toThrow(/≥3 points|profile/);
});
```

- [ ] **Step 2: ERROR-PATTERNS entries**

In `docs/ERROR-PATTERNS.md`, add entries for the new literals (house format — `##` kebab heading, Symptom/Cause/Fix, Symptom opening with the backtick literal):
```markdown
## shape2d-simple-not-single-region

- **Symptom:** `Shape2D.simple: result has N regions, not 1 (use toRegions())`
- **Cause:** `.simple()` was called on a boolean result that is empty or split
  into multiple disjoint regions (e.g. `intersect` of disjoint shapes, or a
  `cut` that severs a shape in two).
- **Fix:** Use `.toRegions()` to get the array, or adjust the operands so the
  result is a single connected region.
```
(Add a `revolve: profile radius must be ≥ 0` cross-reference only if not already present.)

- [ ] **Step 3: AUTHORING-PARTS + KERNEL-CONTRACT prose**

In `docs/AUTHORING-PARTS.md`, add a short "2-D booleans" subsection with a runnable example:
```js
// Keyhole plate: union a disc onto a rect, punch a slot, extrude.
const plate = k.shape2d(roundedRectPolygon(40, 24, 4))
  .union(circleProfile(8))
  .cut(slotPolygon(16, 3));
k.extrude({ profile: plate, h: 3 });
```
Note: `Shape2D` booleans are build-time (not `derive()`), curve-preserving on OCCT / faceted at mesh LOD on Manifold, and feed `extrude`/`revolve` directly. In `docs/KERNEL-CONTRACT.md`, add a sentence that 2-D booleans are a parity-relevant op (exact on OCCT, faceted on Manifold; measure-parity within tolerance).

- [ ] **Step 4: Version bump**

Edit `package.json` — bump the minor version (do NOT touch `CONTRACT_VERSION`), then sync the lockfile:
```bash
source ~/.nvm/nvm.sh && nvm use && npm install --package-lock-only
```

- [ ] **Step 5: Full suite + smoke**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run`
Expected: all green (existing + all shape2d tests + lints).
Then the app smoke check if Playwright is available: `npm run check` (or note it was not run).

- [ ] **Step 6: Commit**
```bash
git add test/shape2d-hash.test.js test/shape2d-manifold.test.js docs/AUTHORING-PARTS.md docs/ERROR-PATTERNS.md docs/KERNEL-CONTRACT.md package.json package-lock.json
git commit -m "test/docs: Shape2D hash + empty-shape guards; author docs; version bump

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- `k.shape2d` + `.union/.cut/.cutAll/.intersect` → Tasks 3 (Manifold), 4 (OCCT). ✅
- Content-hash caching (Manifold), clone discipline (OCCT) → Tasks 3, 4. ✅
- `extrude` + `revolve` accept `Shape2D`; `revolveArgs` fix → Task 5. ✅
- `.area()`/`.boundingBox()`/`.toRegions()`/`.simple()` both backends → Tasks 3, 4 (helpers: Task 2). ✅
- OCCT materialization via SVG discretize (reusing F1 samplers) → Tasks 2 + 4 (with the emitted-command verification in Task 4 Step 1). ✅
- Curve operands (OCCT exact → STEP `B_SPLINE`; Manifold faceted) → Tasks 3, 4. ✅
- 3-D `Solid.union(other)` + migration → Task 1. ✅
- Contract lints (KERNEL_OPS/SOLID_OPS/SHAPE2D_OPS + KERNEL-CONTRACT naming) → Tasks 1, 3, plus doc naming in each. ✅
- Validation/errors + ERROR-PATTERNS + parity + docs + version → Task 6. ✅

**Placeholder scan:** no logic placeholders. Three integration-surface confirmations remain, each naming exactly what to check and what the test asserts: Manifold `CrossSection.bounds()` field names (Task 3 `boundingBox()`); replicad `Drawing.boundingBox` field names (Task 4 `boundingBox()` — `area()` now derives from `regionsArea(toRegions())`, no guess); and the `toSVGPathD` command shape (C vs A), which Task 4 Step 1 makes an explicit verify-first step before the discretizer is trusted.

**Type consistency:** `_shape2d` brand, `_cs` (Manifold) / `_drawing` (OCCT), `_hash` (Manifold), and the `SHAPE2D_OPS` method names are used identically across Tasks 3–5; `boundingBox()` returns `{min:[x,y], max:[x,y]}` on both backends; hashes follow the one convention block. `liftCS`/`liftDrawing` both key off `_shape2d`.

**Out of scope (unchanged from spec):** prism+Shape2D, raw curve-contour `revolve`, variadic 2-D kernel op, sugar `.extrude`, F3.
