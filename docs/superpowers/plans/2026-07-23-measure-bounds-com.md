# measure() position facts + center of mass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose per-sub-part and aggregate `bounds:{min,max}` + `centerOfMass` from `measure()`, add a `meshCentroid` utility, and add `centerOfMass`/`boundsMin`/`boundsMax` componentwise-vector gate metrics to the verify/expect DSL.

**Architecture:** Three additive units — `mesh.js` gains the centroid math, `measure.js` returns the new facts, `verify.js` registers three new metrics (reusing the existing `bbox` vector machinery). Nothing existing changes. Docs + a version bump land last.

**Tech Stack:** Node 24.16.0 (`.nvmrc`), Vitest (`npm test` → `vitest run`), partforge's Manifold + OCCT testing kernels.

## Global Constraints

- Base branch: `measure-bounds-com` off `origin/main` (partforge 0.23.0); ships as **0.24.0**.
- Node 24: run `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use` before any npm command.
- **Purely additive.** No existing fact, metric, DSL expression, `ok` computation, or test may change behavior. Existing `bbox` (size) stays; `bounds` is the new positional companion.
- Backend-agnostic: `centerOfMass` comes from the mesh integral (works on Manifold soup *and* OCCT indexed meshes), like `bbox`/`surfaceArea`/`bounds`.
- Vitest conventions (see `test/measure.test.js`): boot a kernel in `beforeAll`, define parts inline, assert with `toBeCloseTo`.

---

## Task 1: `meshCentroid` utility

**Files:**
- Modify: `src/testing/mesh.js`
- Test: `test/mesh-centroid.test.js` (create)

**Interfaces:**
- Produces: `meshCentroid(positions, indices?) => [x,y,z] | null` — volume-weighted centroid (uniform-density center of mass) of a triangle mesh; `null` when the mesh encloses ≈ no volume.

- [ ] **Step 1: Write the failing test**

Create `test/mesh-centroid.test.js`:

```js
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel, buildView } from "../src/testing.js";
import { meshCentroid } from "../src/testing/mesh.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// A box from [0,0,0] to [10,20,5]; its centroid is the geometric center.
const boxPart = (min, max) => ({
  meta: { title: "Box", units: "mm" }, defaults: {},
  parts: { block: { views: ["v"], build: (kk) => kk.box({ min, max }) } },
  views: { v: { label: "V" } },
});

test("centroid of an origin box is its center", () => {
  const mesh = buildView(k, boxPart([0, 0, 0], [10, 20, 5]), "v")[0].mesh;
  const c = meshCentroid(mesh.positions, mesh.indices);
  expect(c[0]).toBeCloseTo(5, 3);
  expect(c[1]).toBeCloseTo(10, 3);
  expect(c[2]).toBeCloseTo(2.5, 3);
});

test("centroid tracks a translated box", () => {
  const mesh = buildView(k, boxPart([100, 0, 0], [110, 20, 5]), "v")[0].mesh;
  const c = meshCentroid(mesh.positions, mesh.indices);
  expect(c[0]).toBeCloseTo(105, 3);
  expect(c[1]).toBeCloseTo(10, 3);
  expect(c[2]).toBeCloseTo(2.5, 3);
});

test("degenerate / zero-volume meshes return null", () => {
  expect(meshCentroid([], undefined)).toBe(null);
  // two coplanar triangles (a flat square in z=0) enclose no volume
  const flat = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0];
  expect(meshCentroid(flat, undefined)).toBe(null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- --run test/mesh-centroid.test.js`
Expected: FAIL — `meshCentroid` is not exported.

- [ ] **Step 3: Implement `meshCentroid` in `src/testing/mesh.js`**

Append to `src/testing/mesh.js` (mirrors `meshVolume`'s signed-tetrahedron loop):

```js
// Volume-weighted centroid (uniform-density center of mass) of a triangle mesh,
// via the same signed-tetrahedron decomposition as meshVolume. `indices` is
// optional: omit for a flat soup (3 verts/triangle). Returns [x,y,z], or null when
// the mesh encloses ~no volume (open/degenerate), where a centroid is undefined.
// Signed V (not abs) is used so the winding sign cancels in C/V.
export function meshCentroid(positions, indices) {
  const n = indices ? indices.length : positions.length / 3;
  let V = 0, cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i += 3) {
    const a = (indices ? indices[i] : i) * 3, b = (indices ? indices[i + 1] : i + 1) * 3, c = (indices ? indices[i + 2] : i + 2) * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const dx = positions[c], dy = positions[c + 1], dz = positions[c + 2];
    // signed volume of tetra (origin, a, b, c) = a · (b × c) / 6
    const v = (ax * (by * dz - bz * dy) - ay * (bx * dz - bz * dx) + az * (bx * dy - by * dx)) / 6;
    V += v;
    // tetra centroid = (0 + a + b + c) / 4, weighted by its signed volume
    cx += v * (ax + bx + dx) / 4;
    cy += v * (ay + by + dy) / 4;
    cz += v * (az + bz + dz) / 4;
  }
  if (Math.abs(V) < 1e-9) return null;
  return [cx / V, cy / V, cz / V];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --run test/mesh-centroid.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/testing/mesh.js test/mesh-centroid.test.js
git commit -m "feat(testing): meshCentroid — volume-weighted mesh center of mass"
```

---

## Task 2: Expose `bounds` + `centerOfMass` facts in `measure()`

**Files:**
- Modify: `src/testing/measure.js`
- Test: `test/measure.test.js` (extend), `test/measure-occt.test.js` (extend)

**Interfaces:**
- Consumes: `meshCentroid` (Task 1).
- Produces: each `subparts[i]` gains `bounds: {min:[x,y,z], max:[x,y,z]}` and `centerOfMass: [x,y,z]|null`; `aggregate` gains `bounds: {min,max}` and `centerOfMass: [x,y,z]|null` (volume-weighted).

- [ ] **Step 1: Write the failing test** — append to `test/measure.test.js` (no new imports needed — `measure` and `boxPart` are already in that file):

```js
const twoBoxPart = {
  meta: { title: "TwoBox", units: "mm" }, defaults: {},
  parts: {
    a: { views: ["v"], build: (kk) => kk.box({ min: [0, 0, 0], max: [10, 10, 10] }) },        // vol 1000, com [5,5,5]
    b: { views: ["v"], build: (kk) => kk.box({ min: [30, 0, 0], max: [40, 10, 10] }) },        // vol 1000, com [35,5,5]
  },
  views: { v: { label: "V" } },
};

test("measure reports per-sub-part bounds {min,max}", () => {
  const s = measure(k, boxPart, "v").subparts[0];         // boxPart is [0,0,0]..[10,20,5]
  expect(s.bounds.min[0]).toBeCloseTo(0, 3);
  expect(s.bounds.min[1]).toBeCloseTo(0, 3);
  expect(s.bounds.min[2]).toBeCloseTo(0, 3);
  expect(s.bounds.max[0]).toBeCloseTo(10, 3);
  expect(s.bounds.max[1]).toBeCloseTo(20, 3);
  expect(s.bounds.max[2]).toBeCloseTo(5, 3);
});

test("measure reports per-sub-part centerOfMass", () => {
  const s = measure(k, boxPart, "v").subparts[0];
  expect(s.centerOfMass[0]).toBeCloseTo(5, 2);
  expect(s.centerOfMass[1]).toBeCloseTo(10, 2);
  expect(s.centerOfMass[2]).toBeCloseTo(2.5, 2);
});

test("aggregate bounds spans all sub-parts and centerOfMass is volume-weighted", () => {
  const r = measure(k, twoBoxPart, "v");
  expect(r.aggregate.bounds.min[0]).toBeCloseTo(0, 3);
  expect(r.aggregate.bounds.max[0]).toBeCloseTo(40, 3);
  // equal volumes at x=5 and x=35 → aggregate com x = 20
  expect(r.aggregate.centerOfMass[0]).toBeCloseTo(20, 1);
  expect(r.aggregate.centerOfMass[1]).toBeCloseTo(5, 1);
  expect(r.aggregate.centerOfMass[2]).toBeCloseTo(5, 1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- --run test/measure.test.js`
Expected: FAIL — `s.bounds`/`s.centerOfMass`/`aggregate.bounds` undefined.

- [ ] **Step 3: Implement in `src/testing/measure.js`**

Add the import (top of file, alongside `bounds, meshArea`):

```js
import { bounds, meshArea, meshCentroid } from "./mesh.js";
```

In the `subparts.map(...)` return object, add `bounds` and `centerOfMass` (after `bbox`):

```js
    return {
      name,
      bbox: size(b),
      bounds: { min: b.min, max: b.max },
      centerOfMass: meshCentroid(mesh.positions, mesh.indices),
      volume: solid.volume(),
      surfaceArea: meshArea(mesh.positions, mesh.indices),
      triangleCount: mesh.triangles,
      watertight: typeof solid.isEmpty === "function" ? !solid.isEmpty() : null,
      holes: typeof solid.genus === "function" ? solid.genus() : null,
      minWall: mw?.value ?? null,
      minWallAt: mw?.location ?? null,
    };
```

Extend the `aggregate` object (add `bounds` + a volume-weighted `centerOfMass`). Replace the `const aggregate = {...}` block:

```js
  const ub = subparts.length ? unionBounds(subBounds) : { min: [0, 0, 0], max: [0, 0, 0] };
  const weighted = subparts.filter((s) => s.centerOfMass !== null);
  const totalVol = weighted.reduce((a, s) => a + s.volume, 0);
  const aggCom = weighted.length && Math.abs(totalVol) > 1e-9
    ? [0, 1, 2].map((i) => weighted.reduce((a, s) => a + s.volume * s.centerOfMass[i], 0) / totalVol)
    : null;
  const aggregate = {
    bbox: size(ub),
    bounds: { min: ub.min, max: ub.max },
    centerOfMass: aggCom,
    volume: subparts.reduce((a, s) => a + s.volume, 0),
    surfaceArea: subparts.reduce((a, s) => a + s.surfaceArea, 0),
    triangleCount: subparts.reduce((a, s) => a + s.triangleCount, 0),
  };
```

(Note: `unionBounds` is already defined at the top of the file; this replaces the previous inline `size(unionBounds(subBounds))` while preserving the empty-view `[0,0,0]` bbox.)

- [ ] **Step 4: Run the Manifold test to verify it passes**

Run: `npm test -- --run test/measure.test.js`
Expected: PASS.

- [ ] **Step 5: Add an OCCT parity test** — append to `test/measure-occt.test.js` (match that file's existing kernel/import style; it boots the OCCT kernel). Use the same `boxPart` shape that file already measures:

```js
test("OCCT: measure reports bounds and centerOfMass", () => {
  const s = measure(k, boxPart, "v").subparts[0];   // reuse that file's boxPart (a [0,0,0]-based box)
  expect(Array.isArray(s.bounds.min)).toBe(true);
  expect(Array.isArray(s.bounds.max)).toBe(true);
  expect(s.centerOfMass).toHaveLength(3);
  // centroid lies inside the bounds on every axis
  for (let i = 0; i < 3; i++) {
    expect(s.centerOfMass[i]).toBeGreaterThanOrEqual(s.bounds.min[i] - 1e-6);
    expect(s.centerOfMass[i]).toBeLessThanOrEqual(s.bounds.max[i] + 1e-6);
  }
});
```

If `test/measure-occt.test.js`'s box isn't named `boxPart` or is placed differently, adapt the reference to that file's actual fixture — the assertions (bounds are 3-arrays; centroid is a 3-vector inside the bounds) hold for any solid box.

- [ ] **Step 6: Run both measure suites + commit**

Run: `npm test -- --run test/measure.test.js test/measure-occt.test.js`
Expected: PASS.

```bash
git add src/testing/measure.js test/measure.test.js test/measure-occt.test.js
git commit -m "feat(measure): expose per-sub-part & aggregate bounds{min,max} + centerOfMass"
```

---

## Task 3: verify/expect DSL metrics

**Files:**
- Modify: `src/testing/verify.js`
- Test: `test/verify-position-metrics.test.js` (create)

**Interfaces:**
- Consumes: the new facts (Task 2).
- Produces: `centerOfMass`, `boundsMin`, `boundsMax` gate metrics on both `SUBPART_METRICS` and `VIEW_METRICS`, accepting the existing `">=[x,y,z]"` / `"<=[x,y,z]"` (`*`-skip) vector form; a `null` extract yields a `skip` check (existing `check()` behavior).

- [ ] **Step 1: Write the failing test**

Create `test/verify-position-metrics.test.js`:

```js
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { measure } from "../src/testing/measure.js";
import { evaluateCase } from "../src/testing/verify.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const boxPart = {   // [0,0,0]..[10,20,5]; com [5,10,2.5]
  meta: { title: "Box", units: "mm" }, defaults: {},
  parts: { block: { views: ["v"], build: (kk) => kk.box({ min: [0, 0, 0], max: [10, 20, 5] }) } },
  views: { v: { label: "V" } },
};
const run = (expect_) => evaluateCase(measure(k, boxPart, "v"), { expect: expect_, subPartNames: ["block"] });
const find = (checks, metric) => checks.find((c) => c.metric === metric);

test("centerOfMass vector assertion passes and fails componentwise", () => {
  expect(find(run({ block: { centerOfMass: "<=[*,*,3]" } }), "centerOfMass").status).toBe("pass");   // 2.5 <= 3
  expect(find(run({ block: { centerOfMass: "<=[*,*,2]" } }), "centerOfMass").status).toBe("fail");   // 2.5 > 2
});

test("boundsMin / boundsMax vector assertions", () => {
  expect(find(run({ block: { boundsMin: ">=[0,0,0]" } }), "boundsMin").status).toBe("pass");
  expect(find(run({ block: { boundsMax: "<=[10,20,5]" } }), "boundsMax").status).toBe("pass");
  expect(find(run({ block: { boundsMax: "<=[9,*,*]" } }), "boundsMax").status).toBe("fail");          // max x is 10
});

test("view (aggregate) centerOfMass metric works", () => {
  expect(find(run({ _view: { centerOfMass: "<=[*,*,3]" } }), "centerOfMass").status).toBe("pass");
});

test("a null centerOfMass skips rather than fails", () => {
  const facts = { subparts: [{ name: "block", centerOfMass: null, bounds: { min: [0, 0, 0], max: [1, 1, 1] } }],
    aggregate: { centerOfMass: null, bounds: { min: [0, 0, 0], max: [1, 1, 1] } }, overlaps: [], gaps: [], nearMisses: [] };
  const checks = evaluateCase(facts, { expect: { block: { centerOfMass: "<=[*,*,3]" } }, subPartNames: ["block"] });
  expect(find(checks, "centerOfMass").status).toBe("skip");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- --run test/verify-position-metrics.test.js`
Expected: FAIL — `unknown subpart metric "centerOfMass"` (thrown by `check()`), or wrong status.

- [ ] **Step 3: Implement in `src/testing/verify.js`**

Add three entries to `SUBPART_METRICS` (after `bbox`, before `minWall`):

```js
  centerOfMass: { kind: "gate", extract: (s) => s.centerOfMass,
    hint: "center of mass is outside the expected region — mass is distributed differently than intended; check feature placement or a mis-scaled sub-part" },
  boundsMin: { kind: "gate", extract: (s) => s.bounds?.min,
    hint: "the low corner is out of range — the part is positioned or oriented differently than expected" },
  boundsMax: { kind: "gate", extract: (s) => s.bounds?.max,
    hint: "the high corner is out of range — the part is positioned or oriented differently than expected" },
```

Add the aggregate-scoped versions to `VIEW_METRICS`:

```js
  centerOfMass: { kind: "gate", extract: (r) => r.aggregate.centerOfMass,
    hint: "the assembly's center of mass is outside the expected region — a sub-part is mis-placed or mis-scaled" },
  boundsMin: { kind: "gate", extract: (r) => r.aggregate.bounds?.min,
    hint: "the assembly's low corner is out of range — check placement or orientation" },
  boundsMax: { kind: "gate", extract: (r) => r.aggregate.bounds?.max,
    hint: "the assembly's high corner is out of range — check placement or orientation" },
```

No other change: `parseAssertion`/`evaluateAssertion` already handle the `vle`/`vge` vector form, and `check()` already returns `skip` when `extract` yields `null`/`undefined`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --run test/verify-position-metrics.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/testing/verify.js test/verify-position-metrics.test.js
git commit -m "feat(verify): centerOfMass/boundsMin/boundsMax componentwise-vector metrics"
```

---

## Task 4: Docs + version bump

**Files:**
- Modify: `docs/AUTHORING-PARTS.md`
- Modify: `docs/KERNEL-CONTRACT.md` (only if it enumerates measure facts — grep first)
- Modify: `package.json`

- [ ] **Step 1: Document the new facts + metrics**

In `docs/AUTHORING-PARTS.md`, find the `verify`-block section that enumerates the measured facts (grep for `triangleCount` and `minWall`). Wherever the per-sub-part facts are listed (e.g. "…`bbox`, `watertight`, `minWall`…"), add:

> `bounds` (per-sub-part and aggregate axis-aligned `{min,max}` corner positions — where the geometry sits, vs `bbox` which is only its size) and `centerOfMass` (`[x,y,z]`, the volume-weighted centroid; `null` for a degenerate/zero-volume sub-part).

Wherever the assertion metrics are listed, add `centerOfMass`, `boundsMin`, `boundsMax` as componentwise-vector gates using the same `"<=[x,y,z]"` / `">=[x,y,z]"` (`*`-skip) form as `bbox`, with this worked example:

```js
verify: { expect: {
  stand: { boundsMin: ">=[0,0,0]", centerOfMass: "<=[*,*,25]" },   // sits in +octant, mass kept low
  _view: { boundsMax: "<=[220,220,250]" },                          // whole assembly fits the bed
} }
```

- [ ] **Step 2: KERNEL-CONTRACT.md (conditional)**

Run: `grep -n "triangleCount\|surfaceArea\|measure(" docs/KERNEL-CONTRACT.md`
If it lists the measure facts, add `bounds` and `centerOfMass` to that list in the same style. If it doesn't mention them, make no change.

- [ ] **Step 3: Bump the version**

In `package.json`, change `"version": "0.23.0"` to `"version": "0.24.0"`.
(If partforge's release convention is a separate `chore: release` commit, the maintainer can move this — but the feature must publish as 0.24.0 for partforge-cloud to consume it.)

- [ ] **Step 4: Full suite + build green**

Run:
```bash
npm test
npm run build
```
Expected: all tests pass; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add docs/AUTHORING-PARTS.md docs/KERNEL-CONTRACT.md package.json
git commit -m "docs: document bounds/centerOfMass facts + metrics; bump to 0.24.0"
```

---

## Self-review

- **Spec coverage:** facts (§1) → Task 2; `meshCentroid` (§2) → Task 1; DSL metrics (§3) → Task 3; edge cases (null CoM skip, aggregate weighting, empty view) → Tasks 1–3 tests; docs + version (§Docs, §Versioning) → Task 4; testing (§Testing) → each task's tests + measure-occt parity.
- **Placeholder scan:** none — every code step shows complete code; the one conditional (KERNEL-CONTRACT.md) is a grep-gated real decision, not a TODO.
- **Type consistency:** `meshCentroid(positions, indices) → [x,y,z]|null` is produced in Task 1 and consumed identically in Task 2 (`meshCentroid(mesh.positions, mesh.indices)`); `s.bounds.{min,max}` and `s.centerOfMass` set in Task 2 are read by the exact same paths in Task 3's `extract` functions; `r.aggregate.bounds`/`r.aggregate.centerOfMass` consistent between Task 2 and Task 3.

## Execution Handoff

Two execution options — subagent-driven (recommended) or inline.
