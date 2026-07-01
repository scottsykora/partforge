# Feature Labels with Hover Inspection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authors name build-step solids with `.label("Drainage hole")`; the viewer shows a cursor-following tooltip + surface highlight on hover, and click-pick Selections carry the same feature names.

**Architecture:** Per-triangle feature IDs flow from the geometry backends (Manifold via `runOriginalID` provenance; OCCT via mesh-time face classification against labeled-solid snapshots) through the worker mesh payload into the viewer's geometry `userData`. A shared raycast module resolves pointer events to `{subPart, triIndex, feature}` for both the new hover-labeler and the existing click-picker.

**Tech Stack:** three.js, manifold-3d WASM, replicad/OCCT WASM, vitest (+happy-dom for DOM tests), Playwright smoke check.

**Spec:** `docs/superpowers/specs/2026-07-01-feature-labels-design.md`

## Global Constraints

- **Node 24 required** — run `nvm use` before any npm/vitest/CLI command, or geometry tests fail confusingly.
- Work happens in a **new git worktree** branched from `refactor/simplify-framework` HEAD (create via superpowers:using-git-worktrees; branch name `feature/hover-labels`). All `cd` in commands below means the worktree root.
- Units are millimetres throughout.
- Part modules stay DOM-free and side-effect-free; `build` stays a pure function of `(k, p, d)`.
- **OCCT and Manifold must never boot in the same test file** (vitest isolates per file; use `bootManifoldKernel()` / `bootOcctKernel()` from `src/testing.js`).
- replicad (OCCT) transforms **consume their operand** — never reuse a shape after transforming it; `.clone()` first.
- Manifold WASM objects must be tracked via the backend's `T()` helper or they leak the WASM heap.
- Run the full suite (`npx vitest run`) before each commit; commit per task.

## Payload contract (used by Tasks 1–8)

`Solid.toMesh()` (both backends) MAY add two fields when the solid has labels:

- `featureIds: Uint16Array` — one entry **per triangle**, in triangle order. `0` = unlabeled; value `v > 0` refers to `features[v - 1]`.
- `features: string[]` — de-duplicated label strings. Two solids labeled with the **same string merge into one feature** (intentional: lets authors label patterned features, e.g. four holes all labeled `"Mounting holes"`).

Both fields are absent (undefined) when the build used no labels — every consumer must tolerate that.

> **Spec deviation (flagged for review):** the spec said duplicate labels warn + last-wins. During planning this changed to *same label string = same merged feature* because it's strictly more useful (patterned features) and the "duplicate" case is indistinguishable from intentional grouping at the kernel level. `docs/AUTHORING-PARTS.md` documents the merge semantics (Task 9).

---

### Task 1: Manifold backend — `.label()` + per-triangle feature IDs

**Files:**
- Modify: `src/framework/geometry/manifold-backend.js`
- Modify: `src/framework/geometry/kernel.js` (`SOLID_OPS` list + typedef)
- Modify: `src/framework/geometry/occt-backend.js` (temporary no-op stub — see step 3f)
- Test: `test/feature-labels.test.js` (create)

**Interfaces:**
- Produces: `Solid.label(name: string) => Solid` on the Manifold backend; `toMesh()` returns the payload-contract fields. Later tasks rely on exactly `featureIds` (Uint16Array, per-tri, 1-based into `features`) and `features` (string[]).

> **Contract note:** `kernel.js` exports op lists (`SOLID_OPS` etc.) that parity tests enforce on BOTH backends (`test/kernel-contract.test.js` for Manifold, `test/occt-backend.test.js` for OCCT) — a backend must expose *exactly* the documented ops. Adding `label` to `SOLID_OPS` therefore requires both backends to expose it in the same commit; OCCT gets a stub here (step 3f) that Task 4 replaces with real attribution.

- [ ] **Step 1: Write the failing tests**

Create `test/feature-labels.test.js`:

```js
// Manifold-side feature labels: .label() marks a solid; after booleans, toMesh()
// attributes each surviving triangle of that solid's surface to the label.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

test("unlabeled build produces no feature fields", () => {
  const m = k.box([0, 0, 0], [4, 4, 4]).toMesh();
  expect(m.featureIds).toBeUndefined();
  expect(m.features).toBeUndefined();
});

test("label() attributes a cut tool's surviving surface", () => {
  const s = k.box([0, 0, 0], [10, 10, 10])
    .cut(k.cylinder(2, 2, 12).at([5, 5, -1]).label("Bore"));
  const m = s.toMesh();
  expect(m.features).toEqual(["Bore"]);
  expect(m.featureIds).toBeInstanceOf(Uint16Array);
  expect(m.featureIds.length).toBe(m.triangles);
  const boreTris = [];
  m.featureIds.forEach((v, t) => { if (v === 1) boreTris.push(t); });
  expect(boreTris.length).toBeGreaterThan(0);
  // every bore triangle's vertices lie on the r=2 cylinder around (5,5)
  for (const t of boreTris) {
    for (let v = 0; v < 3; v++) {
      const x = m.positions[t * 9 + v * 3] - 5, y = m.positions[t * 9 + v * 3 + 1] - 5;
      expect(Math.hypot(x, y)).toBeCloseTo(2, 1);
    }
  }
  // and unlabeled triangles (the box faces) exist too
  expect(m.featureIds.some((v) => v === 0)).toBe(true);
});

test("labels survive transforms applied after label()", () => {
  const tool = k.cylinder(2, 2, 12).label("Bore").at([5, 5, -1]); // label BEFORE at()
  const m = k.box([0, 0, 0], [10, 10, 10]).cut(tool).toMesh();
  expect(m.features).toEqual(["Bore"]);
  expect(m.featureIds.some((v) => v === 1)).toBe(true);
});

test("same label string merges into one feature (patterned features)", () => {
  const holes = [
    k.cylinder(1, 1, 12).at([3, 3, -1]).label("Mounting holes"),
    k.cylinder(1, 1, 12).at([7, 7, -1]).label("Mounting holes"),
  ];
  const m = k.box([0, 0, 0], [10, 10, 10]).cutAll(holes).toMesh();
  expect(m.features).toEqual(["Mounting holes"]);
});

test("two distinct labels produce two feature entries", () => {
  const m = k.box([0, 0, 0], [10, 10, 10])
    .cut(k.cylinder(1, 1, 12).at([3, 3, -1]).label("Bore A"))
    .cut(k.cylinder(1, 1, 12).at([7, 7, -1]).label("Bore B"))
    .toMesh();
  expect([...m.features].sort()).toEqual(["Bore A", "Bore B"]);
  const ids = new Set(m.featureIds.filter((v) => v > 0));
  expect(ids.size).toBe(2);
});
```

Also add to the existing `test/probe.test.js`:

```js
test("label() chains on the probe kernel and does not force OCCT", () => {
  const part = {
    defaults: { a: 5 },
    parts: { p: { views: ["v"], build: (k, p) => k.box([0, 0, 0], [p.a, p.a, p.a]).label("Body") } },
    views: { v: {} },
  };
  expect(detectBackend(part)).toBe("manifold");
});
```

(Adapt imports to the file's existing style — it already imports `detectBackend`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/feature-labels.test.js test/probe.test.js`
Expected: feature-labels tests FAIL with `label is not a function`; the probe test PASSES already (catch-all Proxy) — keep it as a regression guard.

- [ ] **Step 3: Implement `.label()` and the mesh-out attribution**

In `src/framework/geometry/manifold-backend.js`:

3a. Add a per-kernel label registry inside `createManifoldKernel`, next to `const cache = createSolidCache();`:

```js
  const featureLabels = new Map(); // originalID -> label string (grows per label(); tiny)
```

3b. In the object returned by `wrap(m, hash)`, add (near `clone:`):

```js
    // Name this solid's surface for hover/pick feature attribution. asOriginal()
    // stamps a fresh originalID that survives transforms and booleans, so every
    // surviving triangle of this surface can be traced back to the label.
    label: (name) => cached(h("label", hash, name), () => {
      const o = T(m.asOriginal());
      featureLabels.set(o.originalID(), name);
      return o;
    }),
```

Note the label participates in the content hash (`h("label", hash, name)`), so relabeling can't be served a stale cached solid. On a cache **hit** the registry entry from the first run is still present (kernel-scoped Map), so attribution keeps working.

3c. Thread the registry into mesh extraction. Change `meshOut`:

```js
  function meshOut(m, asStl) {
    const g = m.getMesh();
    const r = asStl ? stlFromMesh(g) : creasedNormals(g, Math.cos((SHARP_ANGLE * Math.PI) / 180), featureLabels);
    g.delete?.();
    return r;
  }
```

3d. In `creasedNormals(g, sharpCos, featureLabels)`, after the `triOID` loop (it already computes per-triangle original-surface ids), add the attribution pass, and extend the return:

```js
  // Per-triangle feature attribution: map each triangle's original-surface id
  // through the label registry. Same label string → same feature entry, so a
  // pattern of solids labeled alike reads as one feature.
  let featureIds = null, features = null;
  if (featureLabels?.size) {
    const indexOf = new Map(); // label string -> 1-based feature index
    features = [];
    featureIds = new Uint16Array(nTri);
    for (let t = 0; t < nTri; t++) {
      const label = featureLabels.get(triOID[t]);
      if (label === undefined) continue;
      let fi = indexOf.get(label);
      if (fi === undefined) { features.push(label); fi = features.length; indexOf.set(label, fi); }
      featureIds[t] = fi;
    }
    if (features.length === 0) { featureIds = features = null; } // labels exist in the kernel, none in THIS mesh
  }

  const out = { positions, normals, triangles: nTri, edges: Float32Array.from(edges) };
  if (featureIds) { out.featureIds = featureIds; out.features = features; }
  return out;
```

(Replace the existing single-line `return {...}` at the end of `creasedNormals`.)

3e. Add `label` to the contract in `src/framework/geometry/kernel.js` — both the data list and the typedef. In `SOLID_OPS`, add it on the `cut`/`clone` line:

```js
export const SOLID_OPS = [
  "cut", "cutAll", "intersect", "clone", "label", "boundingBox", "volume",
  ...
];
```

and in the `@typedef {Object} Solid` block, next to `clone`:

```js
 * @property {(name: string) => Solid} label   name this solid's surface for hover/pick feature attribution (survives transforms + booleans; same name on several solids merges into one feature)
```

3f. Temporary OCCT stub so the OCCT parity test (`test/occt-backend.test.js` asserts the backend exposes exactly `SOLID_OPS`) stays green until Task 4. In `src/framework/geometry/occt-backend.js`'s `wrap`, next to `clone`:

```js
    // TEMPORARY stub: satisfies the SOLID_OPS contract; real attribution (snapshot
    // registry + toMesh classification) replaces this in the feature-labels OCCT task.
    label: (_name) => wrap(shape),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/feature-labels.test.js test/probe.test.js test/manifold-backend.test.js test/manifold-cache.test.js test/kernel-contract.test.js`
Expected: ALL PASS. Then `npx vitest run test/occt-backend.test.js` (separate invocation is fine; vitest isolates per file regardless) — the OCCT parity test must PASS with the stub.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/manifold-backend.js src/framework/geometry/kernel.js src/framework/geometry/occt-backend.js test/feature-labels.test.js test/probe.test.js
git commit -m "feat(geometry): Solid.label() feature attribution on the Manifold backend"
```

---

### Task 2: Worker payload — carry featureIds/features through generate

**Files:**
- Modify: `src/framework/jobs.js` (the generate branch: `meshes.push` line + the `transfer` flatMap right below it — transferables are declared in jobs.js since the worker-protocol consolidation; worker.js needs NO change)
- Test: `test/feature-labels.test.js` (extend)

**Interfaces:**
- Consumes: `toMesh()` payload-contract fields from Task 1.
- Produces: `{type:"meshes"}` messages whose entries carry `featureIds`/`features` verbatim; `featureIds.buffer` is in the message's transfer list (zero-copy).

- [ ] **Step 1: Write the failing test**

Append to `test/feature-labels.test.js`:

```js
import { handle } from "../src/testing.js";

test("generate jobs pass featureIds/features through to the mesh payload", async () => {
  const part = {
    defaults: { bore: 4 },
    parts: {
      body: {
        views: ["v"],
        build: (k, p) => k.box([0, 0, 0], [10, 10, 10])
          .cut(k.cylinder(p.bore / 2, p.bore / 2, 12).at([5, 5, -1]).label("Bore")),
      },
    },
    views: { v: {} },
  };
  const posted = [];
  await handle(k, part, { type: "generate", subparts: ["body"], view: "v", params: {} }, (m) => posted.push(m));
  const meshes = posted.find((m) => m.type === "meshes").meshes;
  expect(meshes[0].features).toEqual(["Bore"]);
  expect(meshes[0].featureIds).toBeInstanceOf(Uint16Array);
});
```

(Merge the `import { handle }` into the existing import from `../src/testing.js`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/feature-labels.test.js -t "generate jobs pass"`
Expected: FAIL — `features` is undefined on the pushed mesh entry.

- [ ] **Step 3: Implement the pass-through**

In `src/framework/jobs.js`, the generate branch currently pushes:

```js
          meshes.push({ name, positions: m.positions, normals: m.normals, indices: m.indices, triangles: m.triangles, edges: m.edges });
```

Change to:

```js
          meshes.push({ name, positions: m.positions, normals: m.normals, indices: m.indices, triangles: m.triangles, edges: m.edges, featureIds: m.featureIds, features: m.features });
```

and a few lines below, add `featureIds` to the declared transferables:

```js
      const transfer = meshes.flatMap((m) =>
        [m.positions.buffer, m.normals?.buffer, m.indices?.buffer, m.edges?.buffer, m.featureIds?.buffer].filter(Boolean));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/feature-labels.test.js test/framework/jobs.test.js test/cache-jobs.test.js`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/jobs.js test/feature-labels.test.js
git commit -m "feat(worker): carry feature attribution through the generate mesh payload"
```

---

### Task 3: Pure OCCT attribution math — `feature-attribution.js`

**Files:**
- Create: `src/framework/geometry/feature-attribution.js`
- Test: `test/feature-attribution.test.js` (create)

**Interfaces:**
- Produces: `classifyFaceGroups(resultMesh, soups, tol?) => { featureIds, features } | {}` where
  `resultMesh = { vertices: number[], triangles: number[], faceGroups: [{start, count, faceId}] }` (replicad ShapeMesh shape) and
  `soups = [{ label: string, vertices: number[], triangles: number[] }]` (labeled snapshots, meshed by the caller).
  Pure JS — no OCCT, no three.js — so Task 4 only wires it up.

- [ ] **Step 1: Write the failing tests**

Create `test/feature-attribution.test.js`:

```js
// Pure classification math for OCCT feature labels: does a face group's sampled
// triangle centroids lie on a labeled solid's (coarsely meshed) surface?
import { expect, test } from "vitest";
import { classifyFaceGroups, pointTriDist } from "../src/framework/geometry/feature-attribution.js";

test("pointTriDist: interior projection, edge, and vertex cases", () => {
  const a = [0, 0, 0], b = [4, 0, 0], c = [0, 4, 0];
  expect(pointTriDist([1, 1, 5], a, b, c)).toBeCloseTo(5, 6);   // above interior
  expect(pointTriDist([2, -3, 0], a, b, c)).toBeCloseTo(3, 6);  // beyond edge ab
  expect(pointTriDist([-3, -4, 0], a, b, c)).toBeCloseTo(5, 6); // beyond vertex a
});

// Two unit-ish quads in the z=0 and z=10 planes as one "result mesh" with two
// face groups; one soup covering only the z=10 quad.
const quad = (z) => ({
  vertices: [0, 0, z, 10, 0, z, 10, 10, z, 0, 10, z],
  triangles: [0, 1, 2, 0, 2, 3],
});
const both = {
  vertices: [...quad(0).vertices, ...quad(10).vertices],
  triangles: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
  faceGroups: [{ start: 0, count: 2, faceId: 1 }, { start: 2, count: 2, faceId: 2 }],
};

test("classifyFaceGroups attributes only faces on the labeled surface", () => {
  const { featureIds, features } = classifyFaceGroups(both, [{ label: "Top", ...quad(10) }]);
  expect(features).toEqual(["Top"]);
  expect([...featureIds]).toEqual([0, 0, 1, 1]);
});

test("most recently applied label wins a tie", () => {
  const { featureIds, features } = classifyFaceGroups(both, [
    { label: "First", ...quad(10) },
    { label: "Second", ...quad(10) },
  ]);
  expect(features[featureIds[2] - 1]).toBe("Second");
});

test("faceGroups counted in index units (start/count *3) are auto-detected", () => {
  const indexUnits = { ...both, faceGroups: [{ start: 0, count: 6, faceId: 1 }, { start: 6, count: 6, faceId: 2 }] };
  const { featureIds } = classifyFaceGroups(indexUnits, [{ label: "Top", ...quad(10) }]);
  expect([...featureIds]).toEqual([0, 0, 1, 1]);
});

test("no faceGroups → no attribution (graceful degrade)", () => {
  const out = classifyFaceGroups({ ...both, faceGroups: undefined }, [{ label: "Top", ...quad(10) }]);
  expect(out.featureIds).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/feature-attribution.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/framework/geometry/feature-attribution.js`:

```js
// Pure classification math for OCCT feature labels. The OCCT backend meshes each
// labeled solid snapshot into a triangle soup; a face of the RESULT mesh belongs to
// a label when its sampled triangle centroids all lie on that soup's surface (a cut
// face lies exactly on its tool's surface, up to the two meshes' tolerances).
// No OCCT, no three.js — unit-testable with hand-built soups.

// Result mesh (preview) tolerance 0.1 + snapshot mesh tolerance 0.1 + slack.
const DEFAULT_TOL = 0.35; // mm — surfaces closer than this to another labeled surface can misattribute
const SAMPLES_PER_FACE = 4;

// Distance from point p to triangle (a,b,c) — the classic region-based projection.
export function pointTriDist(p, a, b, c) {
  const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return Math.hypot(...ap);                 // vertex a
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return Math.hypot(...bp);                // vertex b
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {                              // edge ab
    const t = d1 / (d1 - d3);
    return Math.hypot(...sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]));
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return Math.hypot(...cp);                // vertex c
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {                              // edge ac
    const t = d2 / (d2 - d6);
    return Math.hypot(...sub(p, [a[0] + ac[0] * t, a[1] + ac[1] * t, a[2] + ac[2] * t]));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {                    // edge bc
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const bc = sub(c, b);
    return Math.hypot(...sub(p, [b[0] + bc[0] * t, b[1] + bc[1] * t, b[2] + bc[2] * t]));
  }
  const denom = 1 / (va + vb + vc);                                  // interior
  const v = vb * denom, w = vc * denom;
  return Math.hypot(...sub(p, [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]));
}

const centroid = (V, T, t) => {
  const i = T[t * 3] * 3, j = T[t * 3 + 1] * 3, k = T[t * 3 + 2] * 3;
  return [(V[i] + V[j] + V[k]) / 3, (V[i + 1] + V[j + 1] + V[k + 1]) / 3, (V[i + 2] + V[j + 2] + V[k + 2]) / 3];
};

function distToSoup(p, soup) {
  const V = soup.vertices, T = soup.triangles;
  let best = Infinity;
  for (let t = 0; t < T.length / 3; t++) {
    const a = [V[T[t * 3] * 3], V[T[t * 3] * 3 + 1], V[T[t * 3] * 3 + 2]];
    const b = [V[T[t * 3 + 1] * 3], V[T[t * 3 + 1] * 3 + 1], V[T[t * 3 + 1] * 3 + 2]];
    const c = [V[T[t * 3 + 2] * 3], V[T[t * 3 + 2] * 3 + 1], V[T[t * 3 + 2] * 3 + 2]];
    const d = pointTriDist(p, a, b, c);
    if (d < best) best = d;
  }
  return best;
}

// resultMesh: replicad ShapeMesh {vertices, triangles, faceGroups}; soups: labeled
// snapshots meshed by the caller. Returns {} when attribution isn't possible.
export function classifyFaceGroups(resultMesh, soups, tol = DEFAULT_TOL) {
  const groups = resultMesh.faceGroups;
  const nTri = resultMesh.triangles.length / 3;
  if (!groups?.length || !soups.length) return {};

  // faceGroups start/count units differ across replicad versions: triangle counts
  // sum to nTri, index counts to nTri*3. Detect which this is.
  const total = groups.reduce((s, g) => s + g.count, 0);
  const div = total === nTri * 3 ? 3 : 1;

  const indexOf = new Map(); // label -> 1-based feature index (same-label merge)
  const features = [];
  const featureIds = new Uint16Array(nTri);

  for (const g of groups) {
    const start = g.start / div, count = g.count / div;
    // sample a few spread triangles of the face
    const picks = [];
    for (let s = 0; s < Math.min(SAMPLES_PER_FACE, count); s++) {
      picks.push(start + Math.floor((s * (count - 1)) / Math.max(1, SAMPLES_PER_FACE - 1)));
    }
    // last matching soup wins (most recently applied label)
    let winner = null;
    for (const soup of soups) {
      const onSurface = picks.every(
        (t) => distToSoup(centroid(resultMesh.vertices, resultMesh.triangles, t), soup) <= tol
      );
      if (onSurface) winner = soup.label;
    }
    if (winner == null) continue;
    let fi = indexOf.get(winner);
    if (fi === undefined) { features.push(winner); fi = features.length; indexOf.set(winner, fi); }
    for (let t = start; t < start + count; t++) featureIds[t] = fi;
  }
  return features.length ? { featureIds, features } : {};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/feature-attribution.test.js`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/feature-attribution.js test/feature-attribution.test.js
git commit -m "feat(geometry): pure face-classification math for OCCT feature labels"
```

---

### Task 4: OCCT backend — `.label()` propagation + attribution wiring

**Files:**
- Modify: `src/framework/geometry/occt-backend.js` (the `wrap` function)
- Test: `test/feature-labels-occt.test.js` (create — OCCT boots alone in its own file)

**Interfaces:**
- Consumes: `classifyFaceGroups` from Task 3.
- Produces: `.label()` on OCCT Solids; `toMesh()` returns the same payload-contract fields as Manifold. `_labels` is the wrapper-internal registry (underscore-prefixed so the probe proxy ignores it).

- [ ] **Step 1: Write the failing test**

Create `test/feature-labels-occt.test.js`:

```js
// OCCT-side feature labels. OCCT must boot alone (never with Manifold) — this
// file only imports bootOcctKernel.
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120000);

test("label() attributes a cut tool's surviving surface (OCCT)", () => {
  const s = k.box([0, 0, 0], [10, 10, 10])
    .cut(k.cylinder(2, 2, 12).at([5, 5, -1]).label("Bore"));
  const m = s.toMesh();
  expect(m.features).toEqual(["Bore"]);
  expect(m.featureIds).toBeInstanceOf(Uint16Array);
  expect(m.featureIds.length).toBe(m.triangles);
  // a bore triangle's vertices lie on the r=2 cylinder around (5,5); use indices
  // (OCCT meshes are indexed)
  const t = m.featureIds.indexOf(1);
  expect(t).toBeGreaterThanOrEqual(0);
  for (let v = 0; v < 3; v++) {
    const vi = m.indices[t * 3 + v] * 3;
    const x = m.positions[vi] - 5, y = m.positions[vi + 1] - 5;
    expect(Math.hypot(x, y)).toBeCloseTo(2, 1);
  }
  expect(m.featureIds.some((v) => v === 0)).toBe(true); // box faces unlabeled
});

test("labels survive transforms applied after label() (OCCT)", () => {
  const tool = k.cylinder(2, 2, 12).label("Bore").at([5, 5, -1]);
  const m = k.box([0, 0, 0], [10, 10, 10]).cut(tool).toMesh();
  expect(m.features).toEqual(["Bore"]);
});

test("fillet surfaces stay unlabeled but other labeled faces persist", () => {
  const s = k.box([0, 0, 0], [20, 20, 10]).fillet(2, { dir: "Z" })
    .cut(k.cylinder(3, 3, 12).at([10, 10, -1]).label("Bore"));
  const m = s.toMesh();
  expect(m.features).toEqual(["Bore"]);
});

test("unlabeled OCCT build produces no feature fields", () => {
  const m = k.box([0, 0, 0], [4, 4, 4]).toMesh();
  expect(m.featureIds).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/feature-labels-occt.test.js`
Expected: FAIL — `m.features` is undefined (Task 1's stub discards the label). (OCCT boot takes ~10-30 s — that's normal.)

- [ ] **Step 3: Implement label propagation in `wrap`**

In `src/framework/geometry/occt-backend.js`, **replace Task 1's temporary `label` stub** and change `wrap` to carry a labels list. **Every replicad transform consumes its operand**, so snapshots are cloned before transforming.

```js
  // Feature labels: each entry snapshots the labeled solid's geometry at the moment
  // the label applies; transforms move the snapshots along, booleans merge the two
  // sides' lists. At toMesh() time result faces are classified against the snapshots.
  const cloneLabels = (ls) => ls.map((l) => ({ label: l.label, snapshot: l.snapshot.clone() }));
  const mapLabels = (ls, f) => ls.map((l) => ({ label: l.label, snapshot: f(l.snapshot.clone()) }));

  const wrap = (shape, labels = []) => addSugar({
    _s: shape,
    _labels: labels,
    label: (name) => wrap(shape, [...labels, { label: name, snapshot: shape.clone() }]),
    cut: (t) => wrap(shape.cut(t._s), [...cloneLabels(labels), ...cloneLabels(t._labels ?? [])]),
    cutAll: (tools) => wrap(
      shape.cut(makeCompound(tools.map((t) => t._s))),
      [...cloneLabels(labels), ...tools.flatMap((t) => cloneLabels(t._labels ?? []))]
    ),
    intersect: (t) => wrap(shape.intersect(t._s), [...cloneLabels(labels), ...cloneLabels(t._labels ?? [])]),
    clone: () => wrap(shape.clone(), cloneLabels(labels)),
    ...
    translate: (v) => wrap(shape.translate(v), mapLabels(labels, (s) => s.translate(v))),
    rotate: (deg, center, axis) => wrap(shape.rotate(deg, center, axis), mapLabels(labels, (s) => s.rotate(deg, center, axis))),
    mirror: (plane) => wrap(shape.mirror(plane), mapLabels(labels, (s) => s.mirror(plane))),
    scale: (factor, center = [0, 0, 0]) => {
      if (!(factor > 0)) throw new Error("scale: factor must be > 0");
      return wrap(shape.scale(factor, center), mapLabels(labels, (s) => s.scale(factor, center)));
    },
    fillet: (radius, selector) => wrap(safeOp(shape, (sh) => sh.fillet(radius, toEdgeFinder(selector)), `fillet(${radius})`), cloneLabels(labels)),
    chamfer: (distance, selector) => wrap(validChamfer(shape, toEdgeFinder(selector), distance), cloneLabels(labels)),
    shell: (thickness, openFaces) => {
      if (openFaces == null) throw new Error("shell: openFaces is required (a fully closed hollow is not supported)");
      // replicad shells inward with a positive thickness in this version, keeping outer dimensions.
      return wrap(safeOp(shape, (sh) => sh.shell(thickness, toFaceFinder(openFaces)), `shell(${thickness})`), cloneLabels(labels));
    },
    ...
  });
```

(The `...` lines are the existing members — `boundingBox`, `volume`, `toSTL`, `toIndexedMesh`, etc. — unchanged except where shown. Keep the existing bodies; only the second `wrap(...)` argument is new.)

`union` (kernel-level, if present in this backend) and any other op returning `wrap(...)` of combined shapes must merge the operands' `_labels` the same way as `cut`.

3b. Wire attribution into `toMesh`:

```js
    toMesh: ({ quality = "preview" } = {}) => {
      const m = shape.mesh(MESH[quality]);
      const out = {
        positions: Float32Array.from(m.vertices),
        normals: new Float32Array(0), // let the main thread crease (matches prior look)
        indices: Uint32Array.from(m.triangles),
        triangles: m.triangles.length / 3,
      };
      if (labels.length) {
        const soups = labels.map((l) => {
          const lm = l.snapshot.clone().mesh(MESH.preview); // clone: mesh() must not disturb the kept snapshot
          return { label: l.label, vertices: lm.vertices, triangles: lm.triangles };
        });
        Object.assign(out, classifyFaceGroups(m, soups));
      }
      return out;
    },
```

Add the import at the top: `import { classifyFaceGroups } from "./feature-attribution.js";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/feature-labels-occt.test.js test/occt-backend.test.js test/occt-fillet.test.js test/solid-sugar-occt.test.js`
Expected: ALL PASS. If the bore triangles aren't attributed, print `m.faceGroups` inside the test to check the start/count units and fix the detection in Task 3 — the auto-detect covers triangle- and index-units.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/occt-backend.js test/feature-labels-occt.test.js
git commit -m "feat(geometry): Solid.label() feature attribution on the OCCT backend"
```

---

### Task 5: Viewer stores feature data; shared raycast module

**Files:**
- Modify: `src/framework/viewer.js` (`buildGeometry`)
- Create: `src/framework/selection/raycast.js`
- Modify: `src/framework/selection/pick.js` (consume raycast.js)
- Modify: `src/framework/selection/index.js` (exports)
- Test: `test/selection-raycast.test.js` (create); existing `test/selection-pick.test.js` must keep passing

**Interfaces:**
- Consumes: mesh payload fields from Task 2.
- Produces:
  - `viewer` geometries carry `userData.featureIds` / `userData.features`.
  - `raycastViewer(viewer, clientX, clientY) => null | { mesh, subPart, triIndex, pointWorld: THREE.Vector3, pointLocal: [x,y,z], normalLocal: [x,y,z], feature: { id, label } | null }` — `feature.id` is the 1-based payload id; `feature` is null for unlabeled triangles.
  - `featureAt(mesh, triIndex) => { id, label } | null` (exported for reuse).

- [ ] **Step 1: Write the failing tests**

Create `test/selection-raycast.test.js`:

```js
// @vitest-environment happy-dom
import { expect, test } from "vitest";
import * as THREE from "three";
import { raycastViewer, featureAt } from "../src/framework/selection/raycast.js";

function makeViewer() {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const geo = new THREE.BoxGeometry(4, 4, 4).toNonIndexed(); // non-indexed like Manifold payloads
  const nTri = geo.getAttribute("position").count / 3;
  geo.userData.featureIds = new Uint16Array(nTri).fill(1);
  geo.userData.features = ["Test feature"];
  const mesh = new THREE.Mesh(geo);
  mesh.name = "one";
  mesh.visible = true;
  new THREE.Group().add(mesh); // hover adds overlays to mesh.parent
  mesh.parent.updateMatrixWorld(true);
  const domElement = document.createElement("div");
  domElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  document.body.appendChild(domElement);
  return { camera, domElement, _subMeshes: { one: mesh }, flashPoint: () => {} };
}

test("raycastViewer resolves subPart, triangle, local point, and feature", () => {
  const viewer = makeViewer();
  const hit = raycastViewer(viewer, 100, 100); // dead centre → hits the box front face
  expect(hit).not.toBeNull();
  expect(hit.subPart).toBe("one");
  expect(hit.feature).toEqual({ id: 1, label: "Test feature" });
  expect(hit.pointLocal[2]).toBeCloseTo(2, 4); // front face of the 4mm box
  expect(hit.triIndex).toBeGreaterThanOrEqual(0);
});

test("raycastViewer returns null on a miss", () => {
  const viewer = makeViewer();
  expect(raycastViewer(viewer, 1, 1)).toBeNull(); // corner ray misses the box
});

test("featureAt is null when the geometry has no feature data", () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  expect(featureAt(mesh, 0)).toBeNull();
});

test("invisible meshes are not hit", () => {
  const viewer = makeViewer();
  viewer._subMeshes.one.visible = false;
  expect(raycastViewer(viewer, 100, 100)).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/selection-raycast.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

3a. Create `src/framework/selection/raycast.js` (the raycast math moves here from pick.js):

```js
// Shared raycast for the selection modules: pointer position → the sub-part mesh,
// triangle, CAD-local point/normal, and (when the mesh carries attribution) the
// feature under the pointer. Used by both the click-picker and the hover-labeler.
import * as THREE from "three";

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

// Invert the mesh's world transform (pivot rotation + per-view recentring) to recover
// shared-frame CAD coords — the same frame build() models in.
export function worldToSubPartLocal(mesh, world) {
  const v = Array.isArray(world) ? new THREE.Vector3(world[0], world[1], world[2]) : world.clone();
  mesh.worldToLocal(v);
  return [v.x, v.y, v.z];
}

// The feature carried by a mesh triangle, or null (unlabeled / no attribution data).
export function featureAt(mesh, triIndex) {
  const { featureIds, features } = mesh.geometry.userData;
  const id = featureIds?.[triIndex] ?? 0;
  return id > 0 ? { id, label: features[id - 1] } : null;
}

export function raycastViewer(viewer, clientX, clientY) {
  const rect = viewer.domElement.getBoundingClientRect();
  ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, viewer.camera);
  const meshes = Object.values(viewer._subMeshes).filter((m) => m.visible);
  const hit = raycaster.intersectObjects(meshes, false)[0];
  if (!hit) return null;
  return {
    mesh: hit.object,
    subPart: hit.object.name,
    triIndex: hit.faceIndex,
    pointWorld: hit.point,
    pointLocal: worldToSubPartLocal(hit.object, hit.point),
    // face.normal is in the geometry's local frame, which equals the CAD frame here
    // (the mesh carries no local transform; only its parents rotate/recentre).
    normalLocal: hit.face ? [hit.face.normal.x, hit.face.normal.y, hit.face.normal.z] : [0, 0, 0],
    feature: featureAt(hit.object, hit.faceIndex),
  };
}
```

3b. Rewrite `src/framework/selection/pick.js` over the shared module (it keeps its public API; `worldToSubPartLocal` is re-exported for compatibility):

```js
// Viewer adapter for click-to-select: arms a click listener, raycasts via the shared
// selection raycast, and hands a resolved Selection to onPick.
import { raycastViewer, worldToSubPartLocal } from "./raycast.js";
import { resolveSelection } from "./resolve.js";

export { worldToSubPartLocal };

export function attachPicker(viewer, { part, getContext, onPick }) {
  let active = false;

  function onClick(ev) {
    if (!active) return;
    const hit = raycastViewer(viewer, ev.clientX, ev.clientY);
    if (!hit) return;
    const selection = resolveSelection(part, getContext(), hit);
    viewer.flashPoint([hit.pointWorld.x, hit.pointWorld.y, hit.pointWorld.z]);
    onPick(selection);
  }

  viewer.domElement.addEventListener("click", onClick);
  return {
    setActive: (on) => { active = !!on; },
    detach: () => viewer.domElement.removeEventListener("click", onClick),
  };
}
```

3c. In `src/framework/viewer.js`'s `buildGeometry`, accept and store the attribution (destructure the two new fields and attach before `return out`):

```js
  function buildGeometry({ positions, normals, indices, triangles, edges, featureIds, features }) {
    ...
    out.userData.triangles = triCount;
    if (featureIds) { out.userData.featureIds = featureIds; out.userData.features = features; }
    ...
  }
```

Per-triangle order is stable through both paths: Manifold payloads are already non-indexed in triangle order, and `toCreasedNormals` (OCCT path) converts indexed → non-indexed preserving triangle order — so `featureIds[raycast faceIndex]` stays aligned. Do not reorder triangles anywhere in this function.

3d. Add to `src/framework/selection/index.js`:

```js
export { raycastViewer, featureAt } from "./raycast.js";
```

(Keep the existing `worldToSubPartLocal` export path working — it now re-exports through pick.js.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/selection-raycast.test.js test/selection-pick.test.js test/selection-index.test.js`
Expected: ALL PASS — pick.js behavior is unchanged for existing consumers.

- [ ] **Step 5: Commit**

```bash
git add src/framework/selection/raycast.js src/framework/selection/pick.js src/framework/selection/index.js src/framework/viewer.js test/selection-raycast.test.js
git commit -m "refactor(selection): shared raycast module; viewer stores feature attribution"
```

---

### Task 6: Selection core — feature in resolveSelection and formatSelection

**Files:**
- Modify: `src/framework/selection/resolve.js` (replace the dormant `hit.face` block)
- Modify: `src/framework/selection/format.js`
- Test: extend `test/selection-resolve.test.js`, `test/selection-format.test.js`

**Interfaces:**
- Consumes: `hit.feature = { id, label } | null` from Task 5's raycast.
- Produces: `selection.feature = { label: string }` (only when the hit carried one); formatted styles include the label. The old never-populated `hit.face` `{kind, axis, radius}` path is **removed** (it was dormant — grep confirms no producer).

- [ ] **Step 1: Write the failing tests**

Add to `test/selection-resolve.test.js` (match the file's existing part/ctx fixtures):

```js
test("a hit with a feature resolves to selection.feature.label", () => {
  const s = resolveSelection(part, ctx, {
    subPart: "one", pointLocal: [1, 2, 3], normalLocal: [0, 0, 1],
    feature: { id: 1, label: "Drainage hole" },
  });
  expect(s.feature).toEqual({ label: "Drainage hole" });
});

test("a hit without a feature has no selection.feature", () => {
  const s = resolveSelection(part, ctx, {
    subPart: "one", pointLocal: [1, 2, 3], normalLocal: [0, 0, 1], feature: null,
  });
  expect(s.feature).toBeUndefined();
});
```

Add to `test/selection-format.test.js`:

```js
test("token style includes the feature label", () => {
  const s = { subPart: "planter", feature: { label: "Drainage hole" }, point: [0, 0, 1.5], normal: [0, 0, -1], params: { drain: 8 } };
  expect(formatSelection(s)).toBe("@planter · Drainage hole · pt(0,0,1.5) n(-Z) · {drain:8}");
});

test("prompt style names the feature", () => {
  const s = { subPart: "planter", feature: { label: "Drainage hole" }, point: [0, 0, 1.5], normal: [0, 0, -1], params: { drain: 8 } };
  expect(formatSelection(s, { style: "prompt" }))
    .toBe("On sub-part **planter**, the user pointed at **Drainage hole**, local point (0, 0, 1.5), normal -Z, with params {drain: 8}.");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/selection-resolve.test.js test/selection-format.test.js`
Expected: new tests FAIL (feature undefined / wrong strings). Some OLD tests exercising the `hit.face` cylinder path may exist — they will be **replaced** in step 3 (that contract was dormant; the spec supersedes it).

- [ ] **Step 3: Implement**

In `src/framework/selection/resolve.js`, replace the `if (hit.face) { ... }` block at the end of `resolveSelection` with:

```js
  // Feature attribution from the mesh payload (Solid.label() in the part's build) —
  // the same name the hover tooltip shows, so user, agent, and viewer share vocabulary.
  if (hit.feature) selection.feature = { label: hit.feature.label };
```

In `src/framework/selection/format.js`:

```js
function tokenStyle(s) {
  const head = `@${s.subPart}`;
  const feat = s.feature ? ` · ${s.feature.label}` : "";
  return `${head}${feat} · pt(${s.point.join(",")}) n(${fmtNormal(s.normal)}) · {${fmtParams(s.params)}}`;
}

function promptStyle(s) {
  const params = Object.entries(s.params).map(([k, v]) => `${k}: ${v}`).join(", ");
  const feat = s.feature ? ` **${s.feature.label}**,` : "";
  return `On sub-part **${s.subPart}**, the user pointed at${feat} local point (${s.point.join(", ")}), `
    + `normal ${fmtNormal(s.normal)}, with params {${params}}.`;
}
```

Delete/rewrite any old tests asserting the `kind/axis/radius` face formats (`cyl-face r=…`) — that vocabulary is replaced by author labels.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/selection-resolve.test.js test/selection-format.test.js test/selection-pick.test.js test/pick-banner.test.js test/pick-client.test.js`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/selection/resolve.js src/framework/selection/format.js test/selection-resolve.test.js test/selection-format.test.js
git commit -m "feat(selection): Selections carry the authored feature label"
```

---

### Task 7: Hover labeler — tooltip + highlight overlay

**Files:**
- Create: `src/framework/selection/hover.js`
- Modify: `src/framework/selection/index.js` (export)
- Modify: `src/framework/app.css` (tooltip styles)
- Modify: `src/framework/mount.js` (always-on wiring)
- Test: `test/selection-hover.test.js` (create)

**Interfaces:**
- Consumes: `raycastViewer` from Task 5; `part.parts[name].label` fallback.
- Produces: `attachHoverLabels(viewer, { part, schedule? }) => { detach }`. `schedule` defaults to `requestAnimationFrame`; tests inject `(cb) => cb()` to run synchronously. Tooltip element id: `#pf-hover-tip` (class `show` when visible; children `b` = feature, `span.pf-hover-sub` = sub-part).

- [ ] **Step 1: Write the failing tests**

Create `test/selection-hover.test.js`:

```js
// @vitest-environment happy-dom
import { afterEach, expect, test } from "vitest";
import * as THREE from "three";
import { attachHoverLabels } from "../src/framework/selection/hover.js";

const part = { parts: { one: { label: "Planter", views: ["v"] } }, views: { v: {} } };
const sync = (cb) => cb(); // run raycasts synchronously in tests

function makeViewer({ featured = true } = {}) {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const geo = new THREE.BoxGeometry(4, 4, 4).toNonIndexed();
  if (featured) {
    const nTri = geo.getAttribute("position").count / 3;
    geo.userData.featureIds = new Uint16Array(nTri).fill(1);
    geo.userData.features = ["Drainage hole"];
  }
  const mesh = new THREE.Mesh(geo);
  mesh.name = "one";
  mesh.visible = true;
  const group = new THREE.Group();
  group.add(mesh);
  group.updateMatrixWorld(true);
  const domElement = document.createElement("div");
  domElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  document.body.appendChild(domElement);
  return { camera, domElement, _subMeshes: { one: mesh }, _group: group };
}

const move = (el, x, y) => el.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));

afterEach(() => { document.body.innerHTML = ""; });

test("hovering a labeled feature shows 'feature · sub-part' and a highlight overlay", () => {
  const viewer = makeViewer();
  const h = attachHoverLabels(viewer, { part, schedule: sync });
  move(viewer.domElement, 100, 100);
  const tip = document.getElementById("pf-hover-tip");
  expect(tip.classList.contains("show")).toBe(true);
  expect(tip.querySelector("b").textContent).toBe("Drainage hole");
  expect(tip.querySelector(".pf-hover-sub").textContent).toBe("Planter");
  // overlay mesh added beside the sub-mesh
  const overlay = viewer._subMeshes.one.parent.children.find((c) => c !== viewer._subMeshes.one);
  expect(overlay).toBeDefined();
  expect(overlay.visible).toBe(true);
  h.detach();
});

test("hovering unlabeled geometry shows only the sub-part label, no overlay", () => {
  const viewer = makeViewer({ featured: false });
  const h = attachHoverLabels(viewer, { part, schedule: sync });
  move(viewer.domElement, 100, 100);
  const tip = document.getElementById("pf-hover-tip");
  expect(tip.classList.contains("show")).toBe(true);
  expect(tip.querySelector("b").textContent).toBe("Planter");
  const overlay = viewer._subMeshes.one.parent.children.find((c) => c !== viewer._subMeshes.one && c.visible);
  expect(overlay).toBeUndefined();
  h.detach();
});

test("a miss hides the tooltip and overlay", () => {
  const viewer = makeViewer();
  const h = attachHoverLabels(viewer, { part, schedule: sync });
  move(viewer.domElement, 100, 100);
  move(viewer.domElement, 1, 1); // corner → miss
  expect(document.getElementById("pf-hover-tip").classList.contains("show")).toBe(false);
  h.detach();
});

test("pointerdown (orbiting) suppresses the tooltip until the next move", () => {
  const viewer = makeViewer();
  const h = attachHoverLabels(viewer, { part, schedule: sync });
  move(viewer.domElement, 100, 100);
  viewer.domElement.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  expect(document.getElementById("pf-hover-tip").classList.contains("show")).toBe(false);
  h.detach();
});

test("detach removes the tooltip element and listeners", () => {
  const viewer = makeViewer();
  const h = attachHoverLabels(viewer, { part, schedule: sync });
  h.detach();
  expect(document.getElementById("pf-hover-tip")).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/selection-hover.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `hover.js`**

Create `src/framework/selection/hover.js`:

```js
// Always-on hover inspection: a cursor-following tooltip naming the feature +
// sub-part under the pointer, and an overlay mesh highlighting the feature's
// surface. Feature names come from Solid.label() in the part's build, carried
// per-triangle in the mesh payload (geometry.userData.featureIds/features).
import * as THREE from "three";
import { raycastViewer } from "./raycast.js";

const HIGHLIGHT = 0x4da3ff;

// Extract the subset of a non-indexed geometry belonging to one feature id.
function featureSubset(geometry, featureId) {
  const { featureIds } = geometry.userData;
  const pos = geometry.getAttribute("position");
  let count = 0;
  for (let t = 0; t < featureIds.length; t++) if (featureIds[t] === featureId) count++;
  const out = new Float32Array(count * 9);
  let o = 0;
  for (let t = 0; t < featureIds.length; t++) {
    if (featureIds[t] !== featureId) continue;
    for (let v = 0; v < 3; v++) {
      out[o++] = pos.getX(t * 3 + v); out[o++] = pos.getY(t * 3 + v); out[o++] = pos.getZ(t * 3 + v);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(out, 3));
  return g;
}

export function attachHoverLabels(viewer, { part, schedule = (cb) => requestAnimationFrame(cb) }) {
  // Hover is a mouse idiom — skip entirely on touch-only devices.
  if (globalThis.matchMedia && !matchMedia("(hover: hover)").matches) return { detach: () => {} };

  const tip = document.createElement("div");
  tip.id = "pf-hover-tip";
  const feat = document.createElement("b");
  const sub = document.createElement("span");
  sub.className = "pf-hover-sub";
  tip.append(feat, sub);
  document.body.appendChild(tip);

  const material = new THREE.MeshBasicMaterial({
    color: HIGHLIGHT, transparent: true, opacity: 0.35,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const overlay = new THREE.Mesh(new THREE.BufferGeometry(), material);
  overlay.visible = false;
  overlay.renderOrder = 2;
  let overlayParent = null;
  // Subset cache per sub-part: rebuilt when the sub-part's geometry object changes
  // (i.e. after a regenerate) — keyed on the geometry instance.
  const subsets = new Map(); // subPart -> { geo, byId: Map(featureId -> BufferGeometry) }

  const subLabel = (name) => part.parts[name]?.label ?? name;

  function clearHighlight() {
    overlay.visible = false;
  }

  function hide() {
    tip.classList.remove("show");
    clearHighlight();
  }

  function show(hit, x, y) {
    if (hit.feature) {
      feat.textContent = hit.feature.label;
      sub.textContent = subLabel(hit.subPart);
      const cached = subsets.get(hit.subPart);
      let byId = cached?.geo === hit.mesh.geometry ? cached.byId : null;
      if (!byId) {
        for (const g of cached?.byId.values() ?? []) g.dispose();
        byId = new Map();
        subsets.set(hit.subPart, { geo: hit.mesh.geometry, byId });
      }
      let g = byId.get(hit.feature.id);
      if (!g) { g = featureSubset(hit.mesh.geometry, hit.feature.id); byId.set(hit.feature.id, g); }
      overlay.geometry = g;
      if (overlayParent !== hit.mesh.parent) { hit.mesh.parent.add(overlay); overlayParent = hit.mesh.parent; }
      overlay.visible = true;
    } else {
      feat.textContent = subLabel(hit.subPart);
      sub.textContent = "";
      clearHighlight();
    }
    tip.style.left = `${x + 14}px`;
    tip.style.top = `${y + 14}px`;
    tip.classList.add("show");
  }

  let pending = null; // latest pointer position; one raycast per scheduled frame
  let down = false;

  function onMove(ev) {
    if (ev.pointerType === "touch") return;
    if (down) return;
    const had = pending;
    pending = { x: ev.clientX, y: ev.clientY };
    if (had) return; // a frame is already scheduled
    schedule(() => {
      const p = pending;
      pending = null;
      if (!p || down) return;
      const hit = raycastViewer(viewer, p.x, p.y);
      if (hit) show(hit, p.x, p.y); else hide();
    });
  }
  const onDown = () => { down = true; hide(); };
  const onUp = () => { down = false; };
  const onLeave = () => hide();

  viewer.domElement.addEventListener("pointermove", onMove);
  viewer.domElement.addEventListener("pointerdown", onDown);
  viewer.domElement.addEventListener("pointerup", onUp);
  viewer.domElement.addEventListener("pointerleave", onLeave);

  return {
    detach: () => {
      viewer.domElement.removeEventListener("pointermove", onMove);
      viewer.domElement.removeEventListener("pointerdown", onDown);
      viewer.domElement.removeEventListener("pointerup", onUp);
      viewer.domElement.removeEventListener("pointerleave", onLeave);
      tip.remove();
      overlayParent?.remove(overlay);
      for (const { byId } of subsets.values()) for (const g of byId.values()) g.dispose();
      material.dispose();
    },
  };
}
```

3b. Export from `src/framework/selection/index.js`:

```js
export { attachHoverLabels } from "./hover.js";
```

3c. Styles in `src/framework/app.css` (next to the `#pf-pick-banner` block; reuse the same CSS variables it uses):

```css
/* hover feature-label tooltip (selection/hover.js) */
#pf-hover-tip {
  position: fixed; z-index: 30; pointer-events: none; display: none;
  padding: 4px 9px; border-radius: 6px; max-width: 260px;
  background: var(--panel); border: 1px solid var(--border);
  color: var(--text-strong); font-size: 12px; line-height: 1.35;
  box-shadow: 0 2px 10px rgba(0, 0, 0, .25);
}
#pf-hover-tip.show { display: block; }
#pf-hover-tip .pf-hover-sub { color: var(--muted); font-size: 11px; margin-left: 7px; }
#pf-hover-tip .pf-hover-sub:empty { display: none; }
```

(Check the variable names actually used in app.css — `--panel`/`--border`/`--muted`/`--text-strong` — and match them; the pick-banner block at app.css:209 is the reference.)

3d. Wire in `src/framework/mount.js` — import and attach right after `createViewer`:

```js
import { attachPickToggle, attachHoverLabels } from "./selection/index.js";
...
  const viewer = createViewer(container, part);
  attachHoverLabels(viewer, { part }); // always-on hover inspection (no-op on touch-only devices)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/selection-hover.test.js test/selection-index.test.js`
Expected: ALL PASS.

- [ ] **Step 5: Manual sanity check in the browser**

Run: `npm run dev`, open `http://localhost:5173/planter.html` (labels arrive in Task 8 — at this point hovering shows the sub-part fallback "Planter" everywhere, no highlight). Confirm: tooltip follows the mouse, hides while orbiting, no console errors.

- [ ] **Step 6: Commit**

```bash
git add src/framework/selection/hover.js src/framework/selection/index.js src/framework/app.css src/framework/mount.js test/selection-hover.test.js
git commit -m "feat(viewer): always-on hover tooltip + feature highlight overlay"
```

---

### Task 8: Label the example parts

**Files:**
- Modify: `src/parts/planter.js` (build only)
- Modify: `src/parts/filleted-box.js` (build only)
- Test: extend `test/feature-labels.test.js` (planter), `test/feature-labels-occt.test.js` (filleted-box)

**Interfaces:**
- Consumes: `.label()` from Tasks 1/4. No new interfaces produced — labels are data.

- [ ] **Step 1: Write the failing tests**

Append to `test/feature-labels.test.js`:

```js
import planter from "../src/parts/planter.js";
import { resolveParams, buildPosed } from "../src/framework/jobs.js";

test("planter's build exposes its authored feature names", () => {
  const { p, d } = resolveParams(planter, {});
  const m = buildPosed(k, planter, "planter", { purpose: "display", view: "planter", p, d }).toMesh();
  expect([...m.features].sort()).toEqual(["Cavity", "Drainage hole", "Faceted wall"]);
});
```

(`resolveParams`/`buildPosed` are exported from `src/framework/jobs.js`; add `viewSubParts`-style imports as needed.)

Append to `test/feature-labels-occt.test.js`:

```js
import filletedBox from "../src/parts/filleted-box.js";
import { resolveParams, buildPosed } from "../src/framework/jobs.js";

test("filleted-box labels its bore", () => {
  const { p, d } = resolveParams(filletedBox, {});
  const m = buildPosed(k, filletedBox, "body", { purpose: "display", view: "box", p, d }).toMesh();
  expect(m.features).toEqual(["Bore"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/feature-labels.test.js -t "planter"` then `npx vitest run test/feature-labels-occt.test.js -t "filleted-box"`
Expected: FAIL — `features` is undefined (no labels yet).

- [ ] **Step 3: Add the labels**

In `src/parts/planter.js`'s build, label the three build steps (geometry unchanged):

```js
      build: (k, p, d) => {
        const body = k.prism(d.outerPts, p.height, { scaleTop: p.taper, twist: p.twist }).label("Faceted wall");
        ...
        const cavity = k
          .prism(d.innerPts, p.height + 4, { scaleTop: 1 + (d.innerTaper - 1) * f, twist: p.twist * f })
          .intersect(k.box([-1e4, -1e4, p.floor], [1e4, 1e4, p.height + 10]))
          .label("Cavity");
        let s = body.cut(cavity);
        // Optional drainage hole straight through the base.
        if (p.drain > 0) s = s.cut(k.cylinder(d.drainR, d.drainR, p.floor + 4).at([0, 0, -2]).label("Drainage hole"));
        return s;
      },
```

(Keep the existing comments; only the `.label(...)` calls are added. Label the cavity AFTER the intersect so the label covers the clipped cavity, not the over-tall prism.)

In `src/parts/filleted-box.js`'s build, label the bore:

```js
        if (p.bore > 0) s = s.cut(k.cylinder(p.bore / 2, p.bore / 2, p.h + 2).at([p.w / 2, p.d / 2, -1]).label("Bore"));
```

- [ ] **Step 4: Run the full suite + verify gates**

Run: `npx vitest run`
Expected: ALL PASS — in particular `verify-cases.test.js` / `demo-part.test.js` / `filleted-box.test.js` (labels must not change geometry: same volume, same hole count).

Run: `npx partforge measure src/parts/planter.js && npx partforge measure src/parts/filleted-box.js`
Expected: both exit 0 with unchanged measurements.

- [ ] **Step 5: Visual check**

Run: `npm run dev`; on `/planter.html` hover the outer wall ("Faceted wall · Planter"), inside ("Cavity · Planter"), and the drain hole wall ("Drainage hole · Planter") — each highlights its region. On `/filleted-box.html` hover the bore ("Bore · Body") and a filleted edge (falls back to "Body"). Also confirm the pick flow speaks the same names: open `/planter.html?pick`, arm Pick, click the drain — the copied token contains `· Drainage hole ·`.

- [ ] **Step 6: Commit**

```bash
git add src/parts/planter.js src/parts/filleted-box.js test/feature-labels.test.js test/feature-labels-occt.test.js
git commit -m "feat(parts): name planter and filleted-box features with Solid.label()"
```

---

### Task 9: Documentation — authoring guide section

**Files:**
- Modify: `docs/AUTHORING-PARTS.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Add a "Naming features" section**

Place it near the build-step style section (after "Build-step style: orient → place, and batch features", around line 127 — adjust to the file's current structure). Content:

```markdown
### Naming features (`.label()`)

Give build-step solids human-readable names — the viewer's hover tooltip, the
highlight, and pick selections all use them, so you, the app user, and an agent
share the same vocabulary ("Make the Drainage hole 10 mm").

​```js
const body = k.prism(d.outerPts, p.height, { scaleTop: p.taper }).label("Faceted wall");
let s = body.cut(cavity.label("Cavity"));
if (p.drain > 0) s = s.cut(k.cylinder(d.drainR, d.drainR, p.floor + 4).at([0, 0, -2]).label("Drainage hole"));
​```

- A label names the solid's **surface** wherever it survives into the final part —
  a cutting tool's label lands on the faces it leaves behind (the hole's wall).
- Label **after** shaping compound tools (e.g. after an `intersect` clip) and
  either before or after transforms — labels ride through `at`/`rotate`/etc.
- The **same label on several solids merges into one feature** — label a pattern
  of four holes `"Mounting holes"` and they hover/highlight as one.
- Unlabeled geometry falls back to the sub-part's `label`. Faces created by
  `fillet`/`chamfer`/`shell` are new surfaces, so they use the fallback too.
- Works on both backends. On OCCT each label keeps a geometry snapshot for
  mesh-time classification — label a handful of features, not hundreds.
- Names should describe intent ("Drainage hole", not "cylinder2"); keep them
  unique per sub-part unless you want the merge behavior.
```

(Remove the zero-width characters around the inner code fence when pasting — they're only here to nest the fences.)

Also add one row to the Solid API table (near `clone`):

```markdown
| `s.label(name)` | name this solid's surface for hover/pick feature attribution; survives transforms + booleans; same name on several solids merges into one feature |
```

- [ ] **Step 2: Verify docs build nothing (docs are plain markdown) and commit**

```bash
git add docs/AUTHORING-PARTS.md
git commit -m "docs: authoring guide section for Solid.label() feature naming"
```

---

### Task 10: Smoke check + final verification

**Files:**
- Modify: `scripts/check-app.mjs`

**Interfaces:**
- Consumes: `#pf-hover-tip` contract from Task 7.

- [ ] **Step 1: Extend the smoke check with a hover assertion**

In `scripts/check-app.mjs`, after the `booted = true;` line (still inside the `try`):

```js
  // Hover inspection: move the mouse across the canvas and expect the feature
  // tooltip to appear (any hit — labeled features or the sub-part fallback).
  const box = await page.locator("#app canvas").boundingBox();
  if (box) {
    for (const [fx, fy] of [[0.5, 0.5], [0.4, 0.45], [0.6, 0.55], [0.5, 0.35]]) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
      await sleep(120);
      if (await page.locator("#pf-hover-tip.show").count()) { hovered = true; break; }
    }
  }
```

Declare `let hovered = false;` next to `let booted = false;`, include it in the report line and the exit code:

```js
console.log(`  booted: ${booted}   hovered: ${hovered}   status: ${JSON.stringify(status)}   errors: ${errors.length}`);
...
process.exit(booted && hovered ? 0 : 1);
```

(If the viewer canvas isn't inside `#app`, check the HTML — `createViewer` appends the canvas to the `#app` container.)

- [ ] **Step 2: Run the smoke checks against all three apps**

```bash
node scripts/check-app.mjs demo.html
CHECK_PORT=5180 node scripts/check-app.mjs planter.html
CHECK_PORT=5181 node scripts/check-app.mjs filleted-box.html
```

Expected: all exit 0 with `hovered: true`, `errors: 0`. (These are the same checks CI runs — `.github/workflows/ci.yml`.)

- [ ] **Step 3: Full suite + build**

```bash
npx vitest run
npm run build
```

Expected: suite green; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-app.mjs
git commit -m "test(smoke): assert the hover tooltip appears in the headless check"
```

- [ ] **Step 5: Finish the branch**

Use superpowers:finishing-a-development-branch — the work merges back to `refactor/simplify-framework` (or PRs against it), NOT directly to `main`, since it builds on that branch's refactor.
