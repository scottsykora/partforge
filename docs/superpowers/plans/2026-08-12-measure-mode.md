# Measurement Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ruler toggle in the viewbar that overlays live engineering-drawing
dimensions on the 3D viewer: always-on overall dims, per-feature dims on hover,
click-to-pin dims that survive regenerates, and dimension→control linking that
focuses the driving slider.

**Architecture:** Screen-space SVG overlay above the canvas + pure dimension
engines. Pure leaves (`feature-dims`, `dim-layout`, `pins`, `param-link`) are
DOM-free and three-free; `measure-mode.js` orchestrates raycast → spec →
layout → SVG; `measure-controls.js` is viewbar chrome mirroring
cutaway-controls. One shared feature-highlight helper is extracted from
hover.js.

**Tech Stack:** three.js (raycast/projection only), SVG DOM, vitest
(`happy-dom` for DOM suites), plain ESM.

**Spec:** `docs/superpowers/specs/2026-08-12-measure-mode-design.md`

## Global Constraints

- **Node 24**: run `nvm use` before anything (`.nvmrc`); default shell Node is too old.
- Plain ESM source; no build step; no new dependencies.
- Units are **millimetres**, displayed at 0.01 precision: `v.toFixed(2)`.
- `src/framework/measure/feature-dims.js`, `dim-layout.js`, `pins.js`,
  `param-link.js` must import **nothing** from three.js or the DOM (pure typed
  arrays / plain data). The other measure files are main-thread DOM modules and
  must never be imported from the worker graph (`test/worker-layering.test.js`).
- DOM test files start with `// @vitest-environment happy-dom`.
- Commit after every task; test commands are `npx vitest run <file>` and the
  full suite `npm test`.
- Never run `npm publish` or tag; the version bump lands in the PR (Task 13).
- All CSS colors/fonts derive from existing `--pf-*` tokens (`tokens.css`);
  new component tokens are named `--pf-dim-*` and live in `app.css`.

---

### Task 1: `feature-dims.js` — pure dimension engine

**Files:**
- Create: `src/framework/measure/feature-dims.js`
- Test: `test/framework/measure/feature-dims.test.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `classifyFeature(mesh, featureId) -> Spec|null` where
    `mesh = { positions: Float32Array, indices?: Uint32Array, featureIds: Int|Uint Array per-triangle }`.
    `Spec = { kind: "plane"|"cylinder"|"bbox", values, anchors }` (see code).
  - `bboxSpec(min, max) -> { kind: "bbox", values: {w,d,h}, anchors: {min,max} }`
  - `unionBounds(list) -> {min,max}` (list of `{min,max}`)
  - `fmtMm(v) -> string` (`toFixed(2)`)

- [ ] **Step 1: Write the failing tests**

`test/framework/measure/feature-dims.test.js`:

```js
// Pure dimension engine: triangle subsets -> plane / cylinder / bbox specs.
import { expect, test } from "vitest";
import { classifyFeature, bboxSpec, unionBounds, fmtMm } from "../../../src/framework/measure/feature-dims.js";

// Non-indexed unit square in the XY plane (normal +Z), feature 1.
function square({ w = 1, h = 1, z = 0 } = {}) {
  const positions = new Float32Array([
    0, 0, z,  w, 0, z,  w, h, z,
    0, 0, z,  w, h, z,  0, h, z,
  ]);
  return { positions, featureIds: new Uint16Array([1, 1]) };
}

// Open tube (no caps): radius r, height along +Z, `seg` segments over `arc` radians.
function tube({ r = 4, height = 10, seg = 24, arc = Math.PI * 2, id = 1 } = {}) {
  const pos = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (arc * i) / seg, a1 = (arc * (i + 1)) / seg;
    const p0 = [r * Math.cos(a0), r * Math.sin(a0)], p1 = [r * Math.cos(a1), r * Math.sin(a1)];
    pos.push(p0[0], p0[1], 0, p1[0], p1[1], 0, p1[0], p1[1], height);
    pos.push(p0[0], p0[1], 0, p1[0], p1[1], height, p0[0], p0[1], height);
  }
  const positions = new Float32Array(pos);
  return { positions, featureIds: new Uint16Array(positions.length / 9).fill(id) };
}

test("planar axis-snapped face -> plane spec with global-axis extents", () => {
  const spec = classifyFeature(square({ w: 24, h: 12.5 }), 1);
  expect(spec.kind).toBe("plane");
  expect(spec.values).toEqual({ width: 24, height: 12.5 });
  // normal +Z -> basis (X, Y); width anchors run along X at the vMin edge
  expect(spec.anchors.width.a[1]).toBeCloseTo(0);
  expect(spec.anchors.width.b[0]).toBeCloseTo(24);
  expect(spec.anchors.normal).toEqual([0, 0, 1]);
});

test("indexed planar face classifies identically", () => {
  const positions = new Float32Array([0, 0, 0, 4, 0, 0, 4, 3, 0, 0, 3, 0]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const spec = classifyFeature({ positions, indices, featureIds: new Uint16Array([1, 1]) }, 1);
  expect(spec.kind).toBe("plane");
  expect(spec.values).toEqual({ width: 4, height: 3 });
});

test("full tube -> cylinder spec with diameter and depth", () => {
  const spec = classifyFeature(tube({ r: 4, height: 10 }), 1);
  expect(spec.kind).toBe("cylinder");
  expect(spec.values.diameter).toBeCloseTo(8, 1);
  expect(spec.values.depth).toBeCloseTo(10, 5);
  expect(spec.values.partial).toBe(false);
  // axis is ±Z
  expect(Math.abs(spec.anchors.axis[2])).toBeCloseTo(1, 5);
});

test("120° arc -> partial cylinder (R notation)", () => {
  const spec = classifyFeature(tube({ arc: (2 * Math.PI) / 3 }), 1);
  expect(spec.kind).toBe("cylinder");
  expect(spec.values.partial).toBe(true);
});

test("irregular soup falls back to bbox", () => {
  const positions = new Float32Array([
    0, 0, 0, 3, 0, 1, 0, 2, 2,
    0, 0, 0, 0, 2, 2, 1, 1, 3,
  ]);
  const spec = classifyFeature({ positions, featureIds: new Uint16Array([1, 1]) }, 1);
  expect(spec.kind).toBe("bbox");
  expect(spec.values).toEqual({ w: 3, d: 2, h: 3 });
});

test("unknown feature id -> null", () => {
  expect(classifyFeature(square(), 9)).toBeNull();
});

test("bboxSpec + unionBounds + fmtMm", () => {
  const u = unionBounds([
    { min: [0, 0, 0], max: [1, 1, 1] },
    { min: [-2, 0, 0], max: [0, 5, 0.5] },
  ]);
  expect(u).toEqual({ min: [-2, 0, 0], max: [1, 5, 1] });
  expect(bboxSpec(u.min, u.max).values).toEqual({ w: 3, d: 5, h: 1 });
  expect(fmtMm(8)).toBe("8.00");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/measure/feature-dims.test.js`
Expected: FAIL — cannot resolve `feature-dims.js`.

- [ ] **Step 3: Implement**

`src/framework/measure/feature-dims.js`:

```js
// PURE dimension engine for measurement mode: a feature's triangle subset ->
// a MeasureSpec (plane / cylinder / bbox). No three.js, no DOM, no kernel —
// plain typed arrays, same discipline as oracle/mesh.js. Handles both indexed
// (OCCT) and non-indexed (Manifold) payloads.
//
// Spec shapes (anchors are 3D points in the delivered geometry's own frame —
// the orchestrator projects them through mesh.matrixWorld, which is what makes
// dims ride the pose fast path and animations):
//   plane    { kind, values: {width, height},            anchors: {width:{a,b}, height:{a,b}, normal} }
//   cylinder { kind, values: {diameter, depth, partial}, anchors: {center, axis, top, bottom} }
//   bbox     { kind, values: {w, d, h},                  anchors: {min, max} }

const COS_3DEG = 0.99863;      // same axis-snap threshold as selection/resolve.js
const PLANAR_COS = 0.999999;   // ~1.4e-3 rad: all normals agree -> planar
const AXIS_DOT_MAX = 0.05;     // wall normals ⊥ axis within ~3°
const RADIUS_TOL = 0.02;       // radial residual: 2% of radius
const FULL_ARC_DEG = 300;      // coverage below this reads R, not ⌀

const q2 = (x) => { const r = Math.round(x * 100) / 100; return r === 0 ? 0 : r; };
export const fmtMm = (v) => v.toFixed(2);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

// Iterate the triangles of one feature: yields [a, b, c] vertex triples.
function* featureTris({ positions, indices, featureIds }, featureId) {
  const vert = indices
    ? (t, v) => { const i = indices[t * 3 + v] * 3; return [positions[i], positions[i + 1], positions[i + 2]]; }
    : (t, v) => { const i = (t * 3 + v) * 3; return [positions[i], positions[i + 1], positions[i + 2]]; };
  for (let t = 0; t < featureIds.length; t++) {
    if (featureIds[t] !== featureId) continue;
    yield [vert(t, 0), vert(t, 1), vert(t, 2)];
  }
}

export function unionBounds(list) {
  return list.reduce(
    (acc, b) => ({
      min: acc.min.map((v, i) => Math.min(v, b.min[i])),
      max: acc.max.map((v, i) => Math.max(v, b.max[i])),
    }),
    { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
  );
}

export function bboxSpec(min, max) {
  return {
    kind: "bbox",
    values: { w: q2(max[0] - min[0]), d: q2(max[1] - min[1]), h: q2(max[2] - min[2]) },
    anchors: { min: [...min], max: [...max] },
  };
}

function vertexBounds(tris) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const tri of tris) for (const p of tri) for (let i = 0; i < 3; i++) {
    if (p[i] < min[i]) min[i] = p[i];
    if (p[i] > max[i]) max[i] = p[i];
  }
  return { min, max };
}

// Axis-snap a unit normal (COS_3DEG idiom from selection/resolve.js).
function snapAxis(n) {
  let ai = 0;
  if (Math.abs(n[1]) > Math.abs(n[ai])) ai = 1;
  if (Math.abs(n[2]) > Math.abs(n[ai])) ai = 2;
  if (Math.abs(n[ai]) < COS_3DEG) return null;
  const axis = [0, 0, 0];
  axis[ai] = n[ai] > 0 ? 1 : -1;
  return axis;
}

function planeSpec(tris, normals) {
  // area-weighted mean normal
  let acc = [0, 0, 0];
  for (const { n, area } of normals) acc = add(acc, scale(n, area));
  const mean = norm(acc);
  for (const { n } of normals) if (dot(n, mean) < PLANAR_COS) return null;

  // Basis: axis-snapped normal -> the other two GLOBAL axes (a box face reads
  // W×H, not a PCA-tilted pair). Otherwise: dominant in-plane edge direction.
  const snapped = snapAxis(mean);
  let u, v;
  if (snapped) {
    const ai = snapped.findIndex((c) => c !== 0);
    u = [0, 0, 0]; u[(ai + 1) % 3] = 1;
    v = [0, 0, 0]; v[(ai + 2) % 3] = 1;
  } else {
    let best = null, bestLen = -1;
    for (const [a, b, c] of tris) {
      for (const e of [sub(b, a), sub(c, b), sub(a, c)]) {
        const l = Math.hypot(e[0], e[1], e[2]);
        if (l > bestLen) { bestLen = l; best = e; }
      }
    }
    u = norm(sub(best, scale(mean, dot(best, mean)))); // project into plane
    v = norm(cross(mean, u));
  }

  const c0 = tris[0][0];
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const tri of tris) for (const p of tri) {
    const d = sub(p, c0);
    const uu = dot(d, u), vv = dot(d, v);
    if (uu < uMin) uMin = uu; if (uu > uMax) uMax = uu;
    if (vv < vMin) vMin = vv; if (vv > vMax) vMax = vv;
  }
  const corner = (uu, vv) => add(c0, add(scale(u, uu), scale(v, vv)));
  return {
    kind: "plane",
    values: { width: q2(uMax - uMin), height: q2(vMax - vMin) },
    anchors: {
      width: { a: corner(uMin, vMin), b: corner(uMax, vMin) },
      height: { a: corner(uMax, vMin), b: corner(uMax, vMax) },
      normal: snapped ?? mean.map(q2),
    },
  };
}

function cylinderSpec(tris, normals) {
  // Axis estimate: side-wall normals of a cylinder lie in the plane ⊥ axis,
  // so any two well-separated wall normals cross to ±axis. Pick the pair with
  // the smallest |dot|; refine nothing — validation below does the accepting.
  let n0 = normals[0].n, nk = null, bestAbs = Infinity;
  for (const { n } of normals) {
    const d = Math.abs(dot(n0, n));
    if (d < bestAbs) { bestAbs = d; nk = n; }
  }
  if (!nk) return null;
  const axis = norm(cross(n0, nk));
  if (axis[0] === 0 && axis[1] === 0 && axis[2] === 0) return null;

  // Wall triangles only (a labeled boss's end caps attribute to the same
  // feature — their normals are along the axis; exclude them from the fit).
  const wallVerts = [];
  for (let t = 0; t < tris.length; t++) {
    if (Math.abs(dot(normals[t].n, axis)) > AXIS_DOT_MAX) continue;
    wallVerts.push(...tris[t]);
  }
  if (wallVerts.length < 9) return null; // fewer than 3 wall triangles: not a cylinder

  // Axis point: centroid of wall vertices. Radius: mean distance to axis line.
  let c = [0, 0, 0];
  for (const p of wallVerts) c = add(c, p);
  c = scale(c, 1 / wallVerts.length);
  const radial = (p) => { const d = sub(p, c); return sub(d, scale(axis, dot(d, axis))); };
  let rSum = 0;
  const rs = wallVerts.map((p) => { const r = Math.hypot(...radial(p)); rSum += r; return r; });
  const r = rSum / rs.length;
  if (r <= 0) return null;
  for (const ri of rs) if (Math.abs(ri - r) > Math.max(RADIUS_TOL * r, 1e-6)) return null;

  // Depth from ALL feature vertices (caps included) along the axis.
  let tMin = Infinity, tMax = -Infinity;
  for (const tri of tris) for (const p of tri) {
    const t = dot(sub(p, c), axis);
    if (t < tMin) tMin = t; if (t > tMax) tMax = t;
  }

  // Angular coverage of wall vertices -> ⌀ vs R notation.
  const u = norm(radial(wallVerts[0]));
  const v = cross(axis, u);
  const angles = wallVerts
    .map((p) => { const rd = radial(p); return Math.atan2(dot(rd, v), dot(rd, u)); })
    .sort((a, b) => a - b);
  let maxGap = 2 * Math.PI + angles[0] - angles[angles.length - 1];
  for (let i = 1; i < angles.length; i++) maxGap = Math.max(maxGap, angles[i] - angles[i - 1]);
  const coverageDeg = 360 - (maxGap * 180) / Math.PI;

  const snapped = snapAxis(axis);
  const ax = snapped ?? axis.map(q2);
  return {
    kind: "cylinder",
    values: { diameter: q2(2 * r), depth: q2(tMax - tMin), partial: coverageDeg < FULL_ARC_DEG },
    anchors: {
      center: add(c, scale(axis, (tMin + tMax) / 2)).map(q2),
      axis: ax,
      bottom: add(c, scale(axis, tMin)).map(q2),
      top: add(c, scale(axis, tMax)).map(q2),
    },
  };
}

export function classifyFeature(mesh, featureId) {
  const tris = [...featureTris(mesh, featureId)];
  if (tris.length === 0) return null;
  const normals = tris.map(([a, b, c]) => {
    const n = cross(sub(b, a), sub(c, a));
    const area = Math.hypot(n[0], n[1], n[2]) / 2;
    return { n: norm(n), area };
  });
  const plane = planeSpec(tris, normals);
  if (plane) return plane;
  const cyl = cylinderSpec(tris, normals);
  if (cyl) return cyl;
  const { min, max } = vertexBounds(tris);
  return bboxSpec(min, max);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/framework/measure/feature-dims.test.js`
Expected: PASS (all 7).

- [ ] **Step 5: Run the worker-layering test** (feature-dims is pure and must
stay importable anywhere):

Run: `npx vitest run test/worker-layering.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/framework/measure/feature-dims.js test/framework/measure/feature-dims.test.js
git commit -m "Add pure feature-dims engine for measurement mode"
```

---

### Task 2: `param-link.js` + `pins.js` — pure stores

**Files:**
- Create: `src/framework/measure/param-link.js`
- Create: `src/framework/measure/pins.js`
- Test: `test/framework/measure/param-link.test.js`
- Test: `test/framework/measure/pins.test.js`

**Interfaces:**
- Consumes: nothing (pure). The orchestrator computes the sub-part's read keys
  itself (Task 6) with `subPartReadKeys` — `linkParam` takes the resolved list
  so it stays trivially pure.
- Produces:
  - `linkParam(keys: string[], params: object, values: object) -> string|null`
  - `createPinStore() -> { toggle(view, key), has(view, key), list(view), clear(view), count(view) }`
    where `key = { subPart, featureLabel: string|null, occurrence: number }`.
  - `occurrenceOf(features: string[], featureId: number) -> number`

- [ ] **Step 1: Write the failing tests**

`test/framework/measure/param-link.test.js`:

```js
// Heuristic dimension->param linking: read-keys ∩ value match, unique or null.
import { expect, test } from "vitest";
import { linkParam } from "../../../src/framework/measure/param-link.js";

const params = { bore_d: 8, height: 30, wall: 2.5, slots: 4 };

test("unique value match links", () => {
  expect(linkParam(["bore_d", "wall"], params, { diameter: 8, depth: 12 })).toBe("bore_d");
});

test("radius-style param matches a measured diameter at value/2", () => {
  expect(linkParam(["wall"], { wall: 4 }, { diameter: 8 })).toBe("wall");
});

test("ambiguous match -> null (never guess)", () => {
  expect(linkParam(["a", "b"], { a: 8, b: 8 }, { diameter: 8 })).toBeNull();
});

test("no candidates or no match -> null", () => {
  expect(linkParam([], params, { diameter: 8 })).toBeNull();
  expect(linkParam(["height"], params, { diameter: 8.2 })).toBeNull();
});

test("matches within the 0.01 quantum only", () => {
  expect(linkParam(["wall"], { wall: 2.5 }, { width: 2.504 })).toBe("wall");
  expect(linkParam(["wall"], { wall: 2.5 }, { width: 2.52 })).toBeNull();
});

test("non-numeric params and the partial flag are ignored", () => {
  expect(linkParam(["style"], { style: "hex" }, { diameter: 8, partial: false })).toBeNull();
});
```

`test/framework/measure/pins.test.js`:

```js
// Pin store: per-view, keyed (subPart, featureLabel, occurrence), toggle semantics.
import { expect, test } from "vitest";
import { createPinStore, occurrenceOf } from "../../../src/framework/measure/pins.js";

const key = (subPart, featureLabel = null, occurrence = 0) => ({ subPart, featureLabel, occurrence });

test("toggle adds then removes", () => {
  const pins = createPinStore();
  expect(pins.toggle("main", key("body", "bore"))).toBe(true);
  expect(pins.has("main", key("body", "bore"))).toBe(true);
  expect(pins.count("main")).toBe(1);
  expect(pins.toggle("main", key("body", "bore"))).toBe(false);
  expect(pins.count("main")).toBe(0);
});

test("pins are per-view", () => {
  const pins = createPinStore();
  pins.toggle("main", key("body", "bore"));
  expect(pins.count("exploded")).toBe(0);
  expect(pins.list("main")).toEqual([key("body", "bore")]);
});

test("null label (sub-part bbox pin) and occurrence disambiguate", () => {
  const pins = createPinStore();
  pins.toggle("main", key("body"));
  pins.toggle("main", key("body", "hole", 0));
  pins.toggle("main", key("body", "hole", 1));
  expect(pins.count("main")).toBe(3);
  pins.clear("main");
  expect(pins.count("main")).toBe(0);
});

test("occurrenceOf counts same-label features before this id", () => {
  // features table: id N is features[N-1]
  expect(occurrenceOf(["hole", "hole", "slot", "hole"], 1)).toBe(0);
  expect(occurrenceOf(["hole", "hole", "slot", "hole"], 2)).toBe(1);
  expect(occurrenceOf(["hole", "hole", "slot", "hole"], 4)).toBe(2);
  expect(occurrenceOf(["hole", "slot"], 2)).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/measure/param-link.test.js test/framework/measure/pins.test.js`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

`src/framework/measure/param-link.js`:

```js
// PURE heuristic linking a measured dimension to the schema param driving it.
// Candidates come from the sub-part's read keys (param-deps.subPartReadKeys,
// resolved by the caller); a candidate links when its current value matches a
// measured value within the display quantum (0.01), or at value*2 for
// radius-style params against measured diameters. Unique match or nothing —
// never guess between two.
const QUANTUM = 0.005; // half the 0.01 display quantum: |a-b| < 0.005 rounds equal

export function linkParam(keys, params, values) {
  const measured = Object.entries(values)
    .filter(([k, v]) => typeof v === "number" && k !== "partial")
    .map(([, v]) => v);
  const matches = new Set();
  for (const key of keys) {
    const pv = params[key];
    if (typeof pv !== "number") continue;
    for (const mv of measured) {
      if (Math.abs(pv - mv) < QUANTUM) { matches.add(key); break; }
      if ("diameter" in values && Math.abs(pv * 2 - values.diameter) < QUANTUM * 2) { matches.add(key); break; }
    }
  }
  return matches.size === 1 ? [...matches][0] : null;
}
```

`src/framework/measure/pins.js`:

```js
// PURE pin store for measurement mode. Pins are PER-VIEW and keyed on stable
// identity — (subPart, featureLabel|null, occurrence) — not on geometry, so a
// regenerate re-resolves them by label (dormant when the label is gone, revived
// when it returns). `occurrence` disambiguates duplicate labels: it counts
// same-label features earlier in the features table.
const keyString = ({ subPart, featureLabel, occurrence }) =>
  `${subPart} ${featureLabel ?? "bbox"} ${occurrence ?? 0}`;

export function occurrenceOf(features, featureId) {
  const label = features[featureId - 1];
  let n = 0;
  for (let i = 0; i < featureId - 1; i++) if (features[i] === label) n++;
  return n;
}

export function createPinStore() {
  const byView = new Map(); // view -> Map(keyString -> key)
  const viewMap = (view) => {
    let m = byView.get(view);
    if (!m) { m = new Map(); byView.set(view, m); }
    return m;
  };
  return {
    // -> true when the pin was added, false when it was removed
    toggle(view, key) {
      const m = viewMap(view), ks = keyString(key);
      if (m.has(ks)) { m.delete(ks); return false; }
      m.set(ks, { ...key, occurrence: key.occurrence ?? 0 });
      return true;
    },
    has: (view, key) => viewMap(view).has(keyString(key)),
    list: (view) => [...viewMap(view).values()],
    clear: (view) => { viewMap(view).clear(); },
    count: (view) => viewMap(view).size,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/framework/measure/param-link.test.js test/framework/measure/pins.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/measure/param-link.js src/framework/measure/pins.js \
  test/framework/measure/param-link.test.js test/framework/measure/pins.test.js
git commit -m "Add pure param-link and pin store for measurement mode"
```

---

### Task 3: `dim-layout.js` — screen-space layout engine

**Files:**
- Create: `src/framework/measure/dim-layout.js`
- Test: `test/framework/measure/dim-layout.test.js`

**Interfaces:**
- Consumes: Specs from Task 1.
- Produces:
  - `layout(items, viewport, prev) -> { lines, arrows, labels, choices }`
    - `items`: `[{ id, tier: "static"|"hover"|"pinned", spec, project, paramName?, pinned? }]`
      where `project(point3) -> { x, y, behind }` (pixels).
    - `viewport`: `{ width, height }`.
    - `prev`: the previous return value or `null` (hysteresis).
    - `lines`: `[{ x1, y1, x2, y2, kind: "ext"|"dim"|"leader", tier }]`
    - `arrows`: `[{ x, y, angle, tier }]` (angle radians, arrow points along it)
    - `labels`: `[{ id, text, x, y, w, h, tier, kind: "chip"|"offscreen", paramName, pinned }]`
      (x,y = label box top-left)
  - Layout constants exported for the overlay/tests:
    `EXT_GAP = 4`, `EXT_OVERSHOOT = 3`, `ARROW = 7`, `DIM_OFFSET = 18`,
    `CHAR_W = 7`, `LABEL_H = 16`, `LABEL_PAD = 5`.

- [ ] **Step 1: Write the failing tests**

`test/framework/measure/dim-layout.test.js`:

```js
// Layout engine against a fake orthographic projector: silhouette-edge
// selection, primitive anatomy, collision nudging, hysteresis, offscreen chips.
import { expect, test } from "vitest";
import { layout, DIM_OFFSET, LABEL_H } from "../../../src/framework/measure/dim-layout.js";
import { bboxSpec } from "../../../src/framework/measure/feature-dims.js";

// Top-down ortho: X -> right, Y -> up (screen y flipped), Z ignored.
const ortho = (p) => ({ x: 200 + p[0], y: 200 - p[1], behind: false });
const vp = { width: 400, height: 400 };
const item = (over = {}) => ({
  id: "a", tier: "static", spec: bboxSpec([-50, -30, 0], [50, 30, 10]), project: ortho, ...over,
});

test("bbox produces three linear dims with ext+dim lines and a label each", () => {
  const out = layout([item()], vp, null);
  const dimLines = out.lines.filter((l) => l.kind === "dim");
  const extLines = out.lines.filter((l) => l.kind === "ext");
  expect(dimLines.length).toBe(3);          // W, D, H
  expect(extLines.length).toBe(6);          // two per dim
  expect(out.arrows.length).toBe(6);
  expect(out.labels.map((l) => l.text).sort()).toEqual(["100.00", "20.00", "60.00"]);
});

test("silhouette rule: the W dim uses an outboard edge, offset outward", () => {
  const out = layout([item()], vp, null);
  const w = out.labels.find((l) => l.text === "100.00");
  // outboard for the X-extent under top-down ortho = above or below the model
  const modelTop = 200 - 30, modelBottom = 200 + 30;
  expect(w.y + LABEL_H < modelTop || w.y > modelBottom).toBe(true);
});

test("hysteresis: same input with prev keeps the same choices", () => {
  const first = layout([item()], vp, null);
  const second = layout([item()], vp, first);
  expect(second.choices).toEqual(first.choices);
  expect(second.labels).toEqual(first.labels);
});

test("plane spec produces two linear dims", () => {
  const spec = {
    kind: "plane", values: { width: 24, height: 12 },
    anchors: {
      width: { a: [0, 0, 0], b: [24, 0, 0] },
      height: { a: [24, 0, 0], b: [24, 12, 0] },
      normal: [0, 0, 1],
    },
  };
  const out = layout([item({ spec, tier: "hover" })], vp, null);
  expect(out.lines.filter((l) => l.kind === "dim").length).toBe(2);
  expect(out.labels.map((l) => l.text).sort()).toEqual(["12.00", "24.00"]);
});

test("cylinder produces a leader with drafting notation + a depth dim", () => {
  const spec = {
    kind: "cylinder", values: { diameter: 8, depth: 10, partial: false },
    anchors: { center: [0, 0, 5], axis: [0, 0, 1], bottom: [0, 0, 0], top: [0, 0, 10] },
  };
  const out = layout([item({ spec, tier: "hover" })], vp, null);
  expect(out.lines.some((l) => l.kind === "leader")).toBe(true);
  expect(out.labels.some((l) => l.text.startsWith("⌀"))).toBe(true); // ⌀8.00
  const partial = { ...spec, values: { ...spec.values, partial: true } };
  const out2 = layout([item({ spec: partial, tier: "hover" })], vp, null);
  expect(out2.labels.some((l) => l.text.startsWith("R"))).toBe(true);   // R4.00
});

test("labels never overlap after the collision pass", () => {
  const items = [0, 1, 2, 3].map((i) => ({
    id: `p${i}`, tier: "pinned", project: ortho,
    spec: {
      kind: "cylinder", values: { diameter: 4 + i * 0.01, depth: 2, partial: false },
      anchors: { center: [0, 0, 0], axis: [0, 0, 1], bottom: [0, 0, 0], top: [0, 0, 2] },
    },
  }));
  const out = layout(items, vp, null);
  const rects = out.labels.map((l) => l);
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j];
    const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    expect(overlap).toBe(false);
  }
});

test("fully offscreen pinned item collapses to an edge chip; others drop", () => {
  const far = (p) => ({ x: p[0] + 5000, y: p[1] + 5000, behind: false });
  const pinned = layout([item({ project: far, tier: "pinned", pinned: true })], vp, null);
  expect(pinned.labels.length).toBe(1);
  expect(pinned.labels[0].kind).toBe("offscreen");
  const chip = pinned.labels[0];
  expect(chip.x + chip.w).toBeLessThanOrEqual(vp.width);
  expect(chip.y + chip.h).toBeLessThanOrEqual(vp.height);
  const hover = layout([item({ project: far, tier: "hover" })], vp, null);
  expect(hover.labels.length).toBe(0);
});

test("behind-camera anchors drop their primitives cleanly", () => {
  const behind = (p) => ({ x: 200 + p[0], y: 200 - p[1], behind: true });
  const out = layout([item({ project: behind })], vp, null);
  expect(out.lines.length).toBe(0);
  expect(out.labels.length).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/framework/measure/dim-layout.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`src/framework/measure/dim-layout.js`:

```js
// PURE screen-space layout for measurement mode: specs + a projector ->
// engineering-drawing primitives (extension lines with true gap/overshoot,
// dimension lines with arrowheads, bent leaders, label boxes). Deterministic
// greedy collision pass; hysteresis via the previous frame's choices so dims
// stay planted during orbit. All coordinates in CSS pixels.
import { fmtMm } from "./feature-dims.js";

export const EXT_GAP = 4;        // drafting gap between geometry and extension line
export const EXT_OVERSHOOT = 3;  // extension line runs past the dimension line
export const ARROW = 7;          // arrowhead length
export const DIM_OFFSET = 18;    // dimension line offset from the geometry
export const CHAR_W = 7;         // label width estimate per character (mono)
export const LABEL_H = 16;
export const LABEL_PAD = 5;
const HYSTERESIS = 0.85;         // keep the previous choice unless beaten by >15%
const EDGE_MARGIN = 8;           // offscreen chips hug the viewport inside this
const MAX_NUDGE = 8;

const labelBox = (text, paramName) => {
  const chars = text.length + (paramName ? paramName.length + 3 : 0);
  return { w: chars * CHAR_W + LABEL_PAD * 2, h: LABEL_H };
};

// One linear dimension between projected points a and b, offset along unit o.
function linearDim(out, { id, a, b, o, text, tier, paramName, pinned }) {
  const off = (p, k) => ({ x: p.x + o.x * k, y: p.y + o.y * k });
  const dimA = off(a, DIM_OFFSET), dimB = off(b, DIM_OFFSET);
  for (const [p, dp] of [[a, dimA], [b, dimB]]) {
    out.lines.push({
      x1: p.x + o.x * EXT_GAP, y1: p.y + o.y * EXT_GAP,
      x2: dp.x + o.x * EXT_OVERSHOOT, y2: dp.y + o.y * EXT_OVERSHOOT,
      kind: "ext", tier,
    });
  }
  out.lines.push({ x1: dimA.x, y1: dimA.y, x2: dimB.x, y2: dimB.y, kind: "dim", tier });
  const ang = Math.atan2(dimB.y - dimA.y, dimB.x - dimA.x);
  out.arrows.push({ x: dimA.x, y: dimA.y, angle: ang + Math.PI, tier });
  out.arrows.push({ x: dimB.x, y: dimB.y, angle: ang, tier });
  const box = labelBox(text, paramName);
  const mid = { x: (dimA.x + dimB.x) / 2, y: (dimA.y + dimB.y) / 2 };
  out.labels.push({
    id, text, tier, kind: "chip", paramName: paramName ?? null, pinned: !!pinned,
    x: mid.x - box.w / 2 + o.x * (box.h / 2 + 2),
    y: mid.y - box.h / 2 + o.y * (box.h / 2 + 2),
    ...box,
    // slide dir for the collision pass: along the dimension line
    _slide: { x: Math.cos(ang), y: Math.sin(ang) },
  });
}

const onScreen = (p, vp) => !p.behind
  && p.x >= 0 && p.x <= vp.width && p.y >= 0 && p.y <= vp.height;

// The 8 corners of a min/max box.
const boxCorners = (min, max) => [
  [min[0], min[1], min[2]], [max[0], min[1], min[2]], [min[0], max[1], min[2]], [max[0], max[1], min[2]],
  [min[0], min[1], max[2]], [max[0], min[1], max[2]], [min[0], max[1], max[2]], [max[0], max[1], max[2]],
];
// Corner-index pairs of the 4 box edges parallel to each axis.
const AXIS_EDGES = [
  [[0, 1], [2, 3], [4, 5], [6, 7]], // X
  [[0, 2], [1, 3], [4, 6], [5, 7]], // Y
  [[0, 4], [1, 5], [2, 6], [3, 7]], // Z
];

function bboxItem(out, item, vp, prevChoice, choices) {
  const { spec, project } = item;
  const corners = boxCorners(spec.anchors.min, spec.anchors.max).map(project);
  if (corners.some((c) => c.behind)) return;
  const cx = corners.reduce((s, c) => s + c.x, 0) / 8;
  const cy = corners.reduce((s, c) => s + c.y, 0) / 8;
  const texts = [fmtMm(spec.values.w), fmtMm(spec.values.d), fmtMm(spec.values.h)];
  const chosen = [];
  for (let axis = 0; axis < 3; axis++) {
    if (spec.values[["w", "d", "h"][axis]] === 0) { chosen.push(-1); continue; }
    // Silhouette rule: the edge whose midpoint sits furthest from the projected
    // center never crosses the model. Hysteresis: keep the previous edge unless
    // the best beats it by >15%.
    let bestIdx = 0, bestScore = -1;
    const scores = AXIS_EDGES[axis].map(([i, j]) => {
      const mx = (corners[i].x + corners[j].x) / 2, my = (corners[i].y + corners[j].y) / 2;
      return Math.hypot(mx - cx, my - cy);
    });
    scores.forEach((s, i) => { if (s > bestScore) { bestScore = s; bestIdx = i; } });
    const prevIdx = prevChoice?.[axis];
    const idx = prevIdx != null && prevIdx >= 0 && scores[prevIdx] >= HYSTERESIS * bestScore
      ? prevIdx : bestIdx;
    chosen.push(idx);
    const [i, j] = AXIS_EDGES[axis][idx];
    const a = corners[i], b = corners[j];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const oLen = Math.hypot(mx - cx, my - cy) || 1;
    const o = { x: (mx - cx) / oLen, y: (my - cy) / oLen };
    linearDim(out, { id: `${item.id}:${axis}`, a, b, o, text: texts[axis],
      tier: item.tier, paramName: item.paramName, pinned: item.pinned });
  }
  choices[item.id] = chosen;
}

function planeItem(out, item) {
  const { spec, project } = item;
  const dims = [
    { key: "width", pair: spec.anchors.width },
    { key: "height", pair: spec.anchors.height },
  ];
  const pts = dims.flatMap((d) => [project(d.pair.a), project(d.pair.b)]);
  if (pts.some((p) => p.behind)) return;
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  for (const d of dims) {
    const a = project(d.pair.a), b = project(d.pair.b);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    // outward = perpendicular to the dim direction, pointing away from center
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    let o = { x: -Math.sin(ang), y: Math.cos(ang) };
    if (o.x * (mx - cx) + o.y * (my - cy) < 0) o = { x: -o.x, y: -o.y };
    linearDim(out, { id: `${item.id}:${d.key}`, a, b, o, text: fmtMm(spec.values[d.key]),
      tier: item.tier, paramName: item.paramName, pinned: item.pinned });
  }
}

function cylinderItem(out, item, vp, prevChoice, choices) {
  const { spec, project } = item;
  const center = project(spec.anchors.center);
  if (center.behind) return;
  const text = spec.values.partial
    ? `R${fmtMm(spec.values.diameter / 2)}` : `⌀${fmtMm(spec.values.diameter)}`;
  // leader quadrant: away from the viewport center; hysteresis keeps it planted
  const quads = [{ x: 1, y: -1 }, { x: -1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];
  const away = { x: center.x - vp.width / 2, y: center.y - vp.height / 2 };
  const scores = quads.map((q) => q.x * away.x + q.y * away.y);
  let bestIdx = 0;
  scores.forEach((s, i) => { if (s > scores[bestIdx]) bestIdx = i; });
  const prevIdx = prevChoice?.[0];
  const idx = prevIdx != null && scores[prevIdx] >= HYSTERESIS * scores[bestIdx] ? prevIdx : bestIdx;
  choices[item.id] = [idx];
  const q = quads[idx];
  const L = 34; // leader run
  const elbow = { x: center.x + q.x * L, y: center.y + q.y * L * 0.6 };
  const box = labelBox(text, item.paramName);
  const labelX = q.x > 0 ? elbow.x + 8 : elbow.x - 8 - box.w;
  out.lines.push({ x1: elbow.x, y1: elbow.y, x2: center.x, y2: center.y, kind: "leader", tier: item.tier });
  out.lines.push({ x1: elbow.x, y1: elbow.y, x2: q.x > 0 ? labelX : labelX + box.w, y2: elbow.y, kind: "leader", tier: item.tier });
  out.arrows.push({ x: center.x, y: center.y, angle: Math.atan2(center.y - elbow.y, center.x - elbow.x), tier: item.tier });
  out.labels.push({
    id: `${item.id}:dia`, text, tier: item.tier, kind: "chip",
    paramName: item.paramName ?? null, pinned: !!item.pinned,
    x: labelX, y: elbow.y - box.h / 2, ...box,
    _slide: { x: 0, y: q.y },
  });
  // depth as a linear dim along the axis (skip degenerate depths)
  if (spec.values.depth > 0.01) {
    const a = project(spec.anchors.bottom), b = project(spec.anchors.top);
    if (!a.behind && !b.behind) {
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      let o = { x: -Math.sin(ang), y: Math.cos(ang) };
      if (o.x * q.x + o.y * q.y < 0) o = { x: -o.x, y: -o.y }; // same side as the leader
      linearDim(out, { id: `${item.id}:depth`, a, b, o, text: fmtMm(spec.values.depth),
        tier: item.tier, pinned: item.pinned });
    }
  }
}

// Representative projected points of a spec, for the offscreen test.
function specPoints(spec, project) {
  if (spec.kind === "bbox") return boxCorners(spec.anchors.min, spec.anchors.max).map(project);
  if (spec.kind === "plane") {
    return [spec.anchors.width.a, spec.anchors.width.b, spec.anchors.height.b].map(project);
  }
  return [spec.anchors.center, spec.anchors.bottom, spec.anchors.top].map(project);
}

export function layout(items, viewport, prev) {
  const out = { lines: [], arrows: [], labels: [], choices: {} };
  // hover first so it claims its natural spot; pinned, then static yield to it
  const order = { hover: 0, pinned: 1, static: 2 };
  const sorted = [...items].sort((a, b) => (order[a.tier] ?? 3) - (order[b.tier] ?? 3));
  for (const item of sorted) {
    const pts = specPoints(item.spec, item.project);
    if (pts.every((p) => !onScreen(p, viewport))) {
      if (!item.pinned) continue;
      // Pinned-but-offscreen: one edge chip pointing at the anchor, clamped in.
      const p = pts[0];
      if (p.behind) continue;
      const text = item.spec.kind === "cylinder"
        ? `⌀${fmtMm(item.spec.values.diameter)}`
        : fmtMm(Object.values(item.spec.values).find((v) => typeof v === "number") ?? 0);
      const box = labelBox(text, item.paramName);
      out.labels.push({
        id: item.id, text, tier: item.tier, kind: "offscreen",
        paramName: item.paramName ?? null, pinned: true,
        x: Math.min(Math.max(p.x, EDGE_MARGIN), viewport.width - box.w - EDGE_MARGIN),
        y: Math.min(Math.max(p.y, EDGE_MARGIN), viewport.height - box.h - EDGE_MARGIN),
        ...box, _slide: { x: 0, y: 1 },
      });
      continue;
    }
    const prevChoice = prev?.choices?.[item.id];
    if (item.spec.kind === "bbox") bboxItem(out, item, viewport, prevChoice, out.choices);
    else if (item.spec.kind === "plane") planeItem(out, item);
    else if (item.spec.kind === "cylinder") cylinderItem(out, item, viewport, prevChoice, out.choices);
  }
  // Deterministic greedy collision pass: nudge along the label's slide dir.
  const placed = [];
  for (const l of out.labels) {
    const slide = l._slide ?? { x: 0, y: 1 };
    let tries = 0;
    const hits = () => placed.some((p) =>
      l.x < p.x + p.w && p.x < l.x + l.w && l.y < p.y + p.h && p.y < l.y + l.h);
    while (hits() && tries < MAX_NUDGE) {
      l.x += slide.x * (LABEL_H + 2);
      l.y += slide.y * (LABEL_H + 2);
      tries++;
    }
    placed.push(l);
    delete l._slide;
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/framework/measure/dim-layout.test.js`
Expected: PASS. If the collision test fails, check the slide-dir handling —
identical leaders must stack, not sit on each other.

- [ ] **Step 5: Commit**

```bash
git add src/framework/measure/dim-layout.js test/framework/measure/dim-layout.test.js
git commit -m "Add pure screen-space dimension layout engine"
```

---

### Task 4: extract `feature-highlight.js` from hover.js + `setSuppressed`

**Files:**
- Create: `src/framework/selection/feature-highlight.js`
- Modify: `src/framework/selection/hover.js`
- Modify: `src/framework/selection/index.js`
- Test: `test/framework/measure/feature-highlight.test.js`
- Existing tests must stay green: `test/selection-hover.test.js`

**Interfaces:**
- Produces:
  - `createFeatureHighlight(viewer) -> { show(hit), clear(), dispose() }` —
    the overlay mesh + per-sub-part subset cache currently inline in hover.js.
    `show(hit)` takes the `raycastViewer` hit shape; highlights the feature's
    triangle subset when `hit.feature` is set, else the whole sub-part mesh.
  - `attachHoverLabels(...)` return gains `setSuppressed(on: boolean)`; while
    suppressed, hover shows nothing (same behavior as its existing
    cutaway-handle suppression, OR'd with it).

- [ ] **Step 1: Write the failing test**

`test/framework/measure/feature-highlight.test.js`:

```js
// @vitest-environment happy-dom
// Shared feature-highlight helper: overlay mesh parenting, subset caching, disposal.
import { expect, test, vi } from "vitest";
import * as THREE from "three";
import { createFeatureHighlight } from "../../../src/framework/selection/feature-highlight.js";

function meshWithFeatures() {
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0,   // tri 0 -> feature 1
    0, 0, 0, 1, 1, 0, 0, 1, 0,   // tri 1 -> feature 2
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.userData.featureIds = new Uint16Array([1, 2]);
  geo.userData.features = ["top", "side"];
  return new THREE.Mesh(geo);
}

const viewer = () => ({ registerCutawayMaterial: vi.fn(() => vi.fn()) });

test("show(feature hit) parents a one-triangle overlay to the hit mesh", () => {
  const mesh = meshWithFeatures();
  const hl = createFeatureHighlight(viewer());
  hl.show({ mesh, subPart: "body", feature: { id: 1, label: "top" } });
  const overlay = mesh.children[0];
  expect(overlay.visible).toBe(true);
  expect(overlay.geometry.getAttribute("position").count).toBe(3);
  hl.clear();
  expect(overlay.visible).toBe(false);
  hl.dispose();
});

test("subset cache reuses geometry per (geometry, featureId)", () => {
  const mesh = meshWithFeatures();
  const hl = createFeatureHighlight(viewer());
  hl.show({ mesh, subPart: "body", feature: { id: 1, label: "top" } });
  const g1 = mesh.children[0].geometry;
  hl.show({ mesh, subPart: "body", feature: { id: 2, label: "side" } });
  hl.show({ mesh, subPart: "body", feature: { id: 1, label: "top" } });
  expect(mesh.children[0].geometry).toBe(g1);
  hl.dispose();
});

test("show without feature highlights the whole mesh geometry", () => {
  const mesh = meshWithFeatures();
  const hl = createFeatureHighlight(viewer());
  hl.show({ mesh, subPart: "body", feature: null });
  expect(mesh.children[0].geometry).toBe(mesh.geometry);
  hl.dispose();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/framework/measure/feature-highlight.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the extraction**

`src/framework/selection/feature-highlight.js` — move `featureSubset`, the
material/overlay/subset-cache block, and `showHighlight`/`clearHighlight` out
of hover.js verbatim (keep the comments):

```js
// Shared surface-highlight helper: an overlay mesh tinting one feature's
// triangle subset (or a whole sub-part). Extracted from hover.js so the hover
// tooltip and measurement mode share one implementation and one subset cache.
import * as THREE from "three";
import { CUTAWAY_OVERLAY_RENDER_ORDER } from "../cutaway-render.js";

const HIGHLIGHT = 0x4da3ff;

// Extract the subset of a geometry belonging to one feature id. Handles both
// non-indexed (Manifold) and indexed (OCCT) payloads.
function featureSubset(geometry, featureId) {
  const { featureIds } = geometry.userData;
  const pos = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const vertAt = index ? (t, v) => index.getX(t * 3 + v) : (t, v) => t * 3 + v;
  let count = 0;
  for (let t = 0; t < featureIds.length; t++) if (featureIds[t] === featureId) count++;
  const out = new Float32Array(count * 9);
  let o = 0;
  for (let t = 0; t < featureIds.length; t++) {
    if (featureIds[t] !== featureId) continue;
    for (let v = 0; v < 3; v++) {
      const i = vertAt(t, v);
      out[o++] = pos.getX(i); out[o++] = pos.getY(i); out[o++] = pos.getZ(i);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(out, 3));
  return g;
}

export function createFeatureHighlight(viewer) {
  const material = new THREE.MeshBasicMaterial({
    color: HIGHLIGHT, transparent: true, opacity: 0.35,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const unregisterCutaway = viewer.registerCutawayMaterial?.(material) ?? (() => {});
  let emptyOverlayGeometry = new THREE.BufferGeometry();
  const overlay = new THREE.Mesh(emptyOverlayGeometry, material);
  overlay.visible = false;
  overlay.renderOrder = CUTAWAY_OVERLAY_RENDER_ORDER;
  let overlayParent = null;
  // Subset cache per sub-part: rebuilt when the sub-part's geometry object
  // changes (i.e. after a regenerate) — keyed on the geometry instance.
  const subsets = new Map(); // subPart -> { geo, byId: Map(featureId -> BufferGeometry) }

  function mount(geometry, mesh) {
    emptyOverlayGeometry?.dispose();
    emptyOverlayGeometry = null;
    overlay.geometry = geometry;
    // Parent to the sub-part mesh, not the scene: the overlay geometry is a
    // subset of the mesh's own (delivered-frame) vertices, so it must inherit
    // whatever fast-path pose viewer.setSubPose has written onto that mesh.
    if (overlayParent !== mesh) {
      mesh.add(overlay);
      overlayParent = mesh;
    }
    overlay.visible = true;
  }

  return {
    show(hit) {
      if (!hit.feature) { mount(hit.mesh.geometry, hit.mesh); return; }
      const cached = subsets.get(hit.subPart);
      let byId = cached?.geo === hit.mesh.geometry ? cached.byId : null;
      if (!byId) {
        for (const g of cached?.byId.values() ?? []) g.dispose();
        byId = new Map();
        subsets.set(hit.subPart, { geo: hit.mesh.geometry, byId });
      }
      let g = byId.get(hit.feature.id);
      if (!g) { g = featureSubset(hit.mesh.geometry, hit.feature.id); byId.set(hit.feature.id, g); }
      mount(g, hit.mesh);
    },
    clear() { overlay.visible = false; },
    dispose() {
      overlay.visible = false;
      overlayParent?.remove(overlay);
      for (const { byId } of subsets.values()) for (const g of byId.values()) g.dispose();
      subsets.clear();
      emptyOverlayGeometry?.dispose();
      unregisterCutaway();
      material.dispose();
    },
  };
}
```

Then in `hover.js`:
- Delete `featureSubset`, the material/overlay/subsets block, `showHighlight`,
  `clearHighlight`, and their cleanup steps; import and create
  `createFeatureHighlight(viewer)` instead; `show()` calls `highlight.show(hit)`,
  `hide()` calls `highlight.clear()`, `detach()` calls `highlight.dispose()`
  (keep `runCleanupSteps` for the listener teardown).
- Add external suppression:

```js
  let externallySuppressed = false;
  // in onMove and the scheduled callback, replace `suppressed` checks with
  // `(suppressed || externallySuppressed)`
  // in the returned object:
  setSuppressed(on) {
    externallySuppressed = !!on;
    if (externallySuppressed) { invalidatePendingWork(); hide(); }
  },
```

- Re-export from `selection/index.js`:

```js
export { createFeatureHighlight } from "./feature-highlight.js";
```

- [ ] **Step 4: Run the new and existing hover tests**

Run: `npx vitest run test/framework/measure/feature-highlight.test.js test/selection-hover.test.js`
Expected: PASS — the extraction must not change hover behavior.

- [ ] **Step 5: Commit**

```bash
git add src/framework/selection/feature-highlight.js src/framework/selection/hover.js \
  src/framework/selection/index.js test/framework/measure/feature-highlight.test.js
git commit -m "Extract shared feature-highlight helper; add hover suppression hook"
```

---

### Task 5: `dim-overlay.js` — SVG renderer + CSS

**Files:**
- Create: `src/framework/measure/dim-overlay.js`
- Modify: `src/framework/app.css` (append the measure block)
- Test: `test/framework/measure/dim-overlay.test.js`

**Interfaces:**
- Consumes: layout primitives from Task 3.
- Produces:
  - `createDimOverlay(container, { onChipClick } = {}) -> { render(prims, viewport), clear(), setVisible(on), element, dispose() }`
    - `onChipClick(labelId)` fires on chip click or Enter/Space.
    - `element` is the `<svg>` (measure-mode serializes it for capture).

- [ ] **Step 1: Write the failing test**

`test/framework/measure/dim-overlay.test.js`:

```js
// @vitest-environment happy-dom
// SVG overlay renderer: primitive -> element mapping, chip interactivity, teardown.
import { expect, test, vi } from "vitest";
import { createDimOverlay } from "../../../src/framework/measure/dim-overlay.js";

const prims = {
  lines: [
    { x1: 0, y1: 0, x2: 10, y2: 0, kind: "ext", tier: "static" },
    { x1: 0, y1: 5, x2: 10, y2: 5, kind: "dim", tier: "static" },
  ],
  arrows: [{ x: 10, y: 5, angle: 0, tier: "static" }],
  labels: [
    { id: "a:0", text: "24.00", x: 2, y: 8, w: 40, h: 16, tier: "static", kind: "chip", paramName: null, pinned: false },
    { id: "b:dia", text: "⌀8.00", x: 60, y: 8, w: 60, h: 16, tier: "pinned", kind: "chip", paramName: "bore_d", pinned: true },
  ],
};
const vp = { width: 200, height: 100 };

test("renders lines, arrows and labels with tier/kind classes", () => {
  const host = document.createElement("div");
  const overlay = createDimOverlay(host);
  overlay.render(prims, vp);
  const svg = overlay.element;
  expect(svg.getAttribute("viewBox")).toBe("0 0 200 100");
  expect(svg.querySelectorAll("line.pf-dim-ext").length).toBe(1);
  expect(svg.querySelectorAll("line.pf-dim-line").length).toBe(1);
  expect(svg.querySelectorAll("path.pf-dim-arrow").length).toBe(1);
  expect(svg.querySelectorAll("g.pf-dim-chip").length).toBe(2);
  expect(svg.querySelector('g[data-dim-id="b:dia"]').classList.contains("linked")).toBe(true);
  overlay.dispose();
  expect(host.querySelector("svg")).toBeNull();
});

test("linked chip carries the param name and is a keyboard button", () => {
  const host = document.createElement("div");
  const onChipClick = vi.fn();
  const overlay = createDimOverlay(host, { onChipClick });
  overlay.render(prims, vp);
  const chip = overlay.element.querySelector('g[data-dim-id="b:dia"]');
  expect(chip.getAttribute("role")).toBe("button");
  expect(chip.getAttribute("tabindex")).toBe("0");
  expect(chip.textContent).toContain("bore_d");
  chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(onChipClick).toHaveBeenCalledWith("b:dia");
  chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(onChipClick).toHaveBeenCalledTimes(2);
  overlay.dispose();
});

test("re-render replaces content; clear empties; setVisible toggles hidden", () => {
  const host = document.createElement("div");
  const overlay = createDimOverlay(host);
  overlay.render(prims, vp);
  overlay.render({ lines: [], arrows: [], labels: [prims.labels[0]] }, vp);
  expect(overlay.element.querySelectorAll("g.pf-dim-chip").length).toBe(1);
  overlay.clear();
  expect(overlay.element.querySelectorAll("*").length).toBe(0);
  overlay.setVisible(false);
  expect(overlay.element.hasAttribute("hidden")).toBe(true);
  overlay.dispose();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/framework/measure/dim-overlay.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/framework/measure/dim-overlay.js`:

```js
// Thin SVG renderer for measurement mode: layout primitives -> a full-viewport
// <svg> above the canvas. All appearance comes from CSS classes (app.css) so
// the theme system applies; only geometry attributes are written here. The
// svg is pointer-transparent except label chips, which are the pin/reveal
// hit targets (role=button, keyboard-activatable).
import { ARROW, LABEL_PAD } from "./dim-layout.js";

const NS = "http://www.w3.org/2000/svg";
const LINE_CLASS = { ext: "pf-dim-ext", dim: "pf-dim-line", leader: "pf-dim-leader" };

function svgEl(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export function createDimOverlay(container, { onChipClick } = {}) {
  const svg = svgEl("svg", { class: "pf-dim-overlay", "aria-hidden": "false" });
  container.appendChild(svg);

  // One delegated listener pair instead of per-chip listeners (chips are
  // rebuilt every render).
  const chipOf = (ev) => ev.target.closest?.("g.pf-dim-chip");
  const onClick = (ev) => {
    const chip = chipOf(ev);
    if (chip) onChipClick?.(chip.dataset.dimId);
  };
  const onKeydown = (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const chip = chipOf(ev);
    if (!chip) return;
    ev.preventDefault();
    onChipClick?.(chip.dataset.dimId);
  };
  svg.addEventListener("click", onClick);
  svg.addEventListener("keydown", onKeydown);

  function render({ lines, arrows, labels }, viewport) {
    svg.setAttribute("viewBox", `0 0 ${viewport.width} ${viewport.height}`);
    const next = [];
    for (const l of lines) {
      next.push(svgEl("line", {
        x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2,
        class: `${LINE_CLASS[l.kind]} tier-${l.tier}`,
      }));
    }
    for (const a of arrows) {
      // filled triangle pointing along `angle`
      const s = Math.sin(a.angle), c = Math.cos(a.angle);
      const p = (dx, dy) => `${a.x + dx * c - dy * s},${a.y + dx * s + dy * c}`;
      next.push(svgEl("path", {
        d: `M ${p(0, 0)} L ${p(-ARROW, ARROW / 2.6)} L ${p(-ARROW, -ARROW / 2.6)} Z`,
        class: `pf-dim-arrow tier-${a.tier}`,
      }));
    }
    for (const l of labels) {
      const linked = !!l.paramName;
      const g = svgEl("g", {
        class: `pf-dim-chip tier-${l.tier} kind-${l.kind}`
          + (linked ? " linked" : "") + (l.pinned ? " pinned" : ""),
        "data-dim-id": l.id,
        role: "button", tabindex: "0",
        "aria-label": linked ? `${l.text}, linked to ${l.paramName}` : l.text,
      });
      g.appendChild(svgEl("rect", {
        x: l.x, y: l.y, width: l.w, height: l.h, rx: 4, class: "pf-dim-chip-bg",
      }));
      const text = svgEl("text", {
        x: l.x + LABEL_PAD, y: l.y + l.h / 2, class: "pf-dim-text",
        "dominant-baseline": "central",
      });
      text.textContent = l.text;
      g.appendChild(text);
      if (linked) {
        const param = svgEl("text", {
          x: l.x + l.w - LABEL_PAD, y: l.y + l.h / 2, class: "pf-dim-param",
          "dominant-baseline": "central", "text-anchor": "end",
        });
        param.textContent = l.paramName;
        g.appendChild(param);
      }
      next.push(g);
    }
    svg.replaceChildren(...next);
  }

  return {
    render,
    clear: () => svg.replaceChildren(),
    setVisible: (on) => { if (on) svg.removeAttribute("hidden"); else svg.setAttribute("hidden", ""); },
    element: svg,
    dispose() {
      svg.removeEventListener("click", onClick);
      svg.removeEventListener("keydown", onKeydown);
      svg.remove();
    },
  };
}
```

Append to `src/framework/app.css` (after the cutaway block; derive everything
from existing tokens):

```css
/* ---- measurement mode -----------------------------------------------------
   The dimension overlay is an SVG layer above the canvas, below the floating
   chrome (viewbar z:15). A drawing, not a HUD: hairlines, drafting arrowheads,
   mono numerals. Tiers: static (always-on bbox) is muted; hover/pinned are
   full-strength; param-linked chips are the one loud thing — a mini control
   pill that visually IS the slider it summons. */
.pf-stage { --pf-dim-ink: var(--pf-muted-2); --pf-dim-ink-strong: var(--pf-text-2); }
.pf-dim-overlay {
  position: absolute; inset: 0; z-index: 10;
  width: 100%; height: 100%;
  pointer-events: none;
  font-family: var(--pf-mono); font-size: 11px; letter-spacing: 0.02em;
  animation: pf-dim-in 140ms ease-out;
}
@keyframes pf-dim-in { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .pf-dim-overlay { animation: none; } }
.pf-dim-ext, .pf-dim-line, .pf-dim-leader {
  stroke: var(--pf-dim-ink); stroke-width: 1; fill: none;
}
.pf-dim-arrow { fill: var(--pf-dim-ink); }
.tier-hover.pf-dim-ext, .tier-hover.pf-dim-line, .tier-hover.pf-dim-leader,
.tier-pinned.pf-dim-ext, .tier-pinned.pf-dim-line, .tier-pinned.pf-dim-leader {
  stroke: var(--pf-dim-ink-strong);
}
.tier-hover.pf-dim-arrow, .tier-pinned.pf-dim-arrow { fill: var(--pf-dim-ink-strong); }
.pf-dim-chip { pointer-events: auto; cursor: pointer; }
.pf-dim-chip-bg { fill: transparent; }
.pf-dim-text {
  fill: var(--pf-dim-ink); paint-order: stroke;
  stroke: var(--pf-bg); stroke-width: 3; stroke-linejoin: round;
}
.tier-hover .pf-dim-text, .tier-pinned .pf-dim-text { fill: var(--pf-dim-ink-strong); }
.pf-dim-param { fill: var(--pf-accent); font-size: 10px; }
/* linked chips read as a mini control pill — the rail living in the drawing */
.pf-dim-chip.linked .pf-dim-chip-bg {
  fill: var(--pf-surface); stroke: var(--pf-accent); stroke-width: 1;
}
.pf-dim-chip.linked:hover .pf-dim-chip-bg { fill: var(--pf-accent-soft); }
.pf-dim-chip.kind-offscreen .pf-dim-chip-bg {
  fill: var(--pf-surface); stroke: var(--pf-border); stroke-width: 1;
}
.pf-dim-chip:focus-visible { outline: none; }
.pf-dim-chip:focus-visible .pf-dim-chip-bg { stroke: var(--pf-accent); stroke-width: 2; }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/framework/measure/dim-overlay.test.js test/tokens.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/measure/dim-overlay.js src/framework/app.css \
  test/framework/measure/dim-overlay.test.js
git commit -m "Add SVG dimension overlay renderer and measure-mode styles"
```

---

### Task 6: `measure-mode.js` — orchestrator

**Files:**
- Create: `src/framework/measure/measure-mode.js`
- Test: `test/framework/measure/measure-mode.test.js`

**Interfaces:**
- Consumes: `classifyFeature`/`bboxSpec`/`unionBounds` (Task 1), `linkParam`
  (Task 2), `createPinStore`/`occurrenceOf` (Task 2), `layout` (Task 3),
  `createFeatureHighlight` (Task 4), `createDimOverlay` (Task 5),
  `raycastViewer`/`featureAt` (existing), `subPartReadKeys`/`RELEVANT_ALL`
  (existing `param-deps.js`).
- Produces:
  `createMeasureMode(viewer, { part, getContext, revealParam, schedule? }) ->`
  `{ setEnabled(on), isEnabled(), clearPins(), pinCount(), onPinsChange(cb),`
  `  getOverlaySvg(), detach() }`
  - `getContext() -> { view, params }` (mount's existing helper shape).
  - `revealParam(key) -> void` (late-bound thunk; may be a no-op).
  - `onPinsChange(cb)` fires after any pin add/remove/clear (controls chrome
    syncs the Clear button off it); returns an unsubscribe.
  - `getOverlaySvg() -> SVGElement|null` (null when disabled).

- [ ] **Step 1: Write the failing test**

`test/framework/measure/measure-mode.test.js`:

```js
// @vitest-environment happy-dom
// Orchestrator against a minimal real-three fake viewer: enable -> always-on
// dims; hover -> feature dims; click -> pin + param reveal; regen re-anchor.
import { expect, test, vi } from "vitest";
import * as THREE from "three";
import { createMeasureMode } from "../../../src/framework/measure/measure-mode.js";

// A 20×10 plate: one sub-part, one labeled planar feature covering both
// triangles of its top face at z=2. Non-indexed, feature ids per triangle.
function plateMesh() {
  const positions = new Float32Array([
    0, 0, 2, 20, 0, 2, 20, 10, 2,
    0, 0, 2, 20, 10, 2, 0, 10, 2,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.userData.featureIds = new Uint16Array([1, 1]);
  geo.userData.features = ["top face"];
  return new THREE.Mesh(geo);
}

function fakeViewer(mesh) {
  const dom = document.createElement("div");
  const stage = document.createElement("div");
  stage.appendChild(dom);
  dom.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(10, 5, 40); // over the plate center, looking down -Z
  camera.lookAt(10, 5, 2);
  camera.updateMatrixWorld(true);
  mesh.name = "plate";
  mesh.updateMatrixWorld(true);
  const frameCbs = new Set();
  return {
    domElement: dom,
    stageElement: stage,
    camera,
    _subMeshes: { plate: mesh },
    onFrame: (cb) => { frameCbs.add(cb); return () => frameCbs.delete(cb); },
    registerCutawayMaterial: () => () => {},
    frame: () => { for (const cb of [...frameCbs]) cb(16); },
  };
}

const part = {
  parts: { plate: { label: "Plate", build: () => {} } },
  views: { main: { parts: ["plate"] } },
};
const pointerOpts = { bubbles: true, clientX: 50, clientY: 50, pointerId: 1 };

function setup() {
  const mesh = plateMesh();
  const viewer = fakeViewer(mesh);
  const revealParam = vi.fn();
  const mode = createMeasureMode(viewer, {
    part,
    getContext: () => ({ view: "main", params: { plate_w: 20, wall: 3 } }),
    revealParam,
    schedule: (cb) => cb(), // synchronous for tests
  });
  return { mesh, viewer, mode, revealParam };
}

test("enable renders always-on overall dims; disable hides but keeps state", () => {
  const { viewer, mode } = setup();
  mode.setEnabled(true);
  const svg = mode.getOverlaySvg();
  expect(svg).not.toBeNull();
  const texts = [...svg.querySelectorAll("text")].map((t) => t.textContent);
  expect(texts).toContain("20.00"); // plate W
  expect(texts).toContain("10.00"); // plate D
  mode.setEnabled(false);
  expect(mode.getOverlaySvg()).toBeNull();
  mode.detach();
});

test("hover shows the feature's dims with a param link", () => {
  const { viewer, mode } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  const texts = [...mode.getOverlaySvg().querySelectorAll("text")].map((t) => t.textContent);
  expect(texts).toContain("20.00");
  expect(texts).toContain("plate_w"); // linked: unique read-key value match
  mode.detach();
});

test("click pins; pin survives a geometry swap; clearPins notifies", () => {
  const { mesh, viewer, mode } = setup();
  const onPins = vi.fn();
  mode.onPinsChange(onPins);
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
  viewer.domElement.dispatchEvent(new PointerEvent("pointerup", pointerOpts));
  viewer.domElement.dispatchEvent(new MouseEvent("click", pointerOpts));
  expect(mode.pinCount()).toBe(1);
  expect(onPins).toHaveBeenCalled();
  // simulate a regenerate: same labels, new geometry instance
  const fresh = plateMesh();
  viewer._subMeshes.plate.geometry = fresh.geometry;
  viewer.frame(); // dirty check picks up the new geometry
  expect(mode.pinCount()).toBe(1);
  const texts = [...mode.getOverlaySvg().querySelectorAll("text")].map((t) => t.textContent);
  expect(texts).toContain("20.00"); // pinned dim re-anchored and re-rendered
  mode.clearPins();
  expect(mode.pinCount()).toBe(0);
  mode.detach();
});

test("clicking a linked hovered dim reveals the param", () => {
  const { viewer, mode, revealParam } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  viewer.domElement.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
  viewer.domElement.dispatchEvent(new PointerEvent("pointerup", pointerOpts));
  viewer.domElement.dispatchEvent(new MouseEvent("click", pointerOpts));
  expect(revealParam).toHaveBeenCalledWith("plate_w");
  mode.detach();
});

test("drag does not pin", () => {
  const { viewer, mode } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", { ...pointerOpts, clientX: 80 }));
  viewer.domElement.dispatchEvent(new PointerEvent("pointerup", { ...pointerOpts, clientX: 80 }));
  viewer.domElement.dispatchEvent(new MouseEvent("click", { ...pointerOpts, clientX: 80 }));
  expect(mode.pinCount()).toBe(0);
  mode.detach();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/framework/measure/measure-mode.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/framework/measure/measure-mode.js`:

```js
// Measurement-mode orchestrator: the one measure module that touches both
// three.js and the DOM. Owns mode state and drives the pipeline
//   raycast hit -> feature-dims spec -> param-link -> dim-layout -> dim-overlay
// per frame with a dirty check (camera, mesh matrices, geometry identity), so
// dims ride orbits, the pose fast path, and animations, and re-anchor across
// regenerates. Pins live in the pure pin store, per view, and survive mode
// toggles; `Clear` (chrome) is the only thing that empties them.
import * as THREE from "three";
import { raycastViewer } from "../selection/raycast.js";
import { createFeatureHighlight } from "../selection/feature-highlight.js";
import { subPartReadKeys, RELEVANT_ALL } from "../param-deps.js";
import { classifyFeature, bboxSpec, unionBounds } from "./feature-dims.js";
import { linkParam } from "./param-link.js";
import { createPinStore, occurrenceOf } from "./pins.js";
import { layout } from "./dim-layout.js";
import { createDimOverlay } from "./dim-overlay.js";

const DRAG_THRESHOLD_SQUARED = 5 ** 2; // px of pointer travel that means "orbit"
const _v = new THREE.Vector3();

export function createMeasureMode(viewer, { part, getContext, revealParam, schedule = (cb) => requestAnimationFrame(cb) }) {
  const pins = createPinStore();
  const pinListeners = new Set();
  const notifyPins = () => { for (const cb of [...pinListeners]) cb(); };

  let enabled = false;
  let overlay = null;          // created on first enable, kept across toggles
  let highlight = null;
  let hover = null;            // { item, key } for the currently hovered spec
  let prevLayout = null;
  let detached = false;

  // ---- spec cache: (geometry instance, featureId) -> core spec -------------
  const specCache = new Map(); // geometry -> Map(featureId -> spec|null)
  function featureSpec(mesh, featureId) {
    let byId = specCache.get(mesh.geometry);
    if (!byId) { byId = new Map(); specCache.set(mesh.geometry, byId); }
    if (!byId.has(featureId)) {
      const { featureIds } = mesh.geometry.userData;
      const positions = mesh.geometry.getAttribute("position").array;
      const indices = mesh.geometry.getIndex()?.array;
      byId.set(featureId, featureIds
        ? classifyFeature({ positions, indices, featureIds }, featureId)
        : null);
    }
    return byId.get(featureId);
  }

  // ---- projection: geometry-frame point -> CSS px in the canvas ------------
  function projectorFor(mesh) {
    return (p) => {
      _v.set(p[0], p[1], p[2]);
      if (mesh) _v.applyMatrix4(mesh.matrixWorld);
      _v.project(viewer.camera);
      const rect = viewer.domElement.getBoundingClientRect();
      return {
        x: ((_v.x + 1) / 2) * rect.width,
        y: ((1 - _v.y) / 2) * rect.height,
        behind: _v.z > 1,
      };
    };
  }

  const visibleMeshes = () => Object.entries(viewer._subMeshes)
    .filter(([, m]) => m.visible && m.geometry.getAttribute("position")?.count);

  // ---- param linking (scoped like selection/resolve.js scopeParams) --------
  function readKeysFor(subPart) {
    const { view, params } = getContext();
    let reads;
    try { reads = subPartReadKeys(part, view, params); } catch { return Object.keys(getContext().params); }
    return reads === RELEVANT_ALL
      ? Object.keys(params)
      : [...(reads.get(subPart) ?? Object.keys(params))];
  }
  const linkFor = (subPart, spec) =>
    spec ? linkParam(readKeysFor(subPart), getContext().params, spec.values) : null;

  // ---- pin resolution: stable key -> a live layout item --------------------
  function resolvePin(key, index) {
    const mesh = viewer._subMeshes[key.subPart];
    if (!mesh || !mesh.visible) return null;
    if (key.featureLabel == null) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const { min, max } = mesh.geometry.boundingBox;
      return { spec: bboxSpec([min.x, min.y, min.z], [max.x, max.y, max.z]), mesh };
    }
    const { features = [], featureIds } = mesh.geometry.userData;
    if (!featureIds) return null;
    // find the (occurrence+1)-th feature id carrying this label — dormant when gone
    let seen = 0;
    for (let i = 0; i < features.length; i++) {
      if (features[i] !== key.featureLabel) continue;
      if (seen === key.occurrence) {
        const spec = featureSpec(mesh, i + 1);
        return spec ? { spec, mesh } : null;
      }
      seen++;
    }
    return null;
  }

  function buildItems() {
    const items = [];
    const meshes = visibleMeshes();
    if (meshes.length === 0) return items;
    // always-on overall bounds (posed, like viewer.frameTo)
    const boundsList = meshes.map(([, m]) => {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox.clone().applyMatrix4(m.matrix);
      return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
    });
    const u = unionBounds(boundsList);
    // overall anchors are in the shared (posed-mesh-local == parent) frame;
    // project through the first mesh's PARENT transform via a null-mesh projector
    items.push({ id: "overall", tier: "static", spec: bboxSpec(u.min, u.max), project: projectorFor(null) });
    const { view } = getContext();
    pins.list(view).forEach((key, i) => {
      const live = resolvePin(key, i);
      if (!live) return; // dormant
      const id = `pin:${key.subPart}:${key.featureLabel ?? "bbox"}:${key.occurrence}`;
      items.push({
        id, tier: "pinned", pinned: true, spec: live.spec, project: projectorFor(live.mesh),
        paramName: linkFor(key.subPart, live.spec), _key: key,
      });
    });
    if (hover) items.push(hover.item);
    return items;
  }

  function renderNow() {
    if (!enabled || !overlay) return;
    const rect = viewer.domElement.getBoundingClientRect();
    const viewport = { width: rect.width, height: rect.height };
    prevLayout = layout(buildItems(), viewport, prevLayout);
    overlay.render(prevLayout, viewport);
  }

  // ---- frame dirty check ---------------------------------------------------
  let lastSig = "";
  function frameSig() {
    const e = viewer.camera.matrixWorld.elements;
    let sig = `${e[0]},${e[5]},${e[10]},${e[12]},${e[13]},${e[14]},${viewer.camera.projectionMatrix.elements[0]}`;
    for (const [name, m] of Object.entries(viewer._subMeshes)) {
      sig += `|${name}:${m.visible ? 1 : 0}:${m.geometry.id}:${m.matrix.elements[12]},${m.matrix.elements[13]},${m.matrix.elements[14]},${m.matrix.elements[0]},${m.matrix.elements[5]}`;
    }
    return sig;
  }
  const offFrame = viewer.onFrame(() => {
    if (!enabled) return;
    const sig = frameSig();
    if (sig === lastSig) return;
    lastSig = sig;
    // geometry identity is part of the signature, so a regenerate lands here:
    // drop stale hover (its mesh geometry may be gone) and re-render
    if (hover && hover.geometry !== viewer._subMeshes[hover.subPart]?.geometry) hover = null;
    renderNow();
  });

  // ---- pointer handling (drag threshold: the click-picker idiom) -----------
  const pointerStarts = new Map();
  let dragged = false;
  let pendingMove = null;
  let moveScheduled = false;

  function hitToHover(hit) {
    let spec, key;
    if (hit.feature) {
      spec = featureSpec(hit.mesh, hit.feature.id);
      const { features } = hit.mesh.geometry.userData;
      key = { subPart: hit.subPart, featureLabel: hit.feature.label,
        occurrence: occurrenceOf(features, hit.feature.id) };
    }
    if (!spec) {
      if (!hit.mesh.geometry.boundingBox) hit.mesh.geometry.computeBoundingBox();
      const { min, max } = hit.mesh.geometry.boundingBox;
      spec = bboxSpec([min.x, min.y, min.z], [max.x, max.y, max.z]);
      key = { subPart: hit.subPart, featureLabel: null, occurrence: 0 };
    }
    return {
      key,
      geometry: hit.mesh.geometry,
      subPart: hit.subPart,
      item: {
        id: "hover", tier: "hover", spec, project: projectorFor(hit.mesh),
        paramName: linkFor(hit.subPart, spec),
      },
    };
  }

  function onMove(ev) {
    if (!enabled || ev.pointerType === "touch") return;
    const start = pointerStarts.get(ev.pointerId);
    if (start && !dragged) {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      dragged = dx * dx + dy * dy > DRAG_THRESHOLD_SQUARED;
    }
    pendingMove = { x: ev.clientX, y: ev.clientY };
    if (moveScheduled) return;
    moveScheduled = true;
    schedule(() => {
      moveScheduled = false;
      const p = pendingMove;
      pendingMove = null;
      if (!enabled || detached || !p) return;
      const hit = raycastViewer(viewer, p.x, p.y);
      if (hit) {
        hover = hitToHover(hit);
        highlight.show(hit);
      } else {
        hover = null;
        highlight.clear();
      }
      renderNow();
    });
  }
  const onDown = (ev) => {
    if (pointerStarts.size === 0) dragged = false;
    pointerStarts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  };
  const onUp = (ev) => pointerStarts.delete(ev.pointerId);
  const onCancel = (ev) => { pointerStarts.delete(ev.pointerId); if (pointerStarts.size === 0) dragged = false; };
  const onLeave = () => { hover = null; highlight?.clear(); renderNow(); };

  function togglePin(key, paramName) {
    const { view } = getContext();
    const added = pins.toggle(view, key);
    if (added && paramName) revealParam?.(paramName);
    notifyPins();
    renderNow();
  }

  function onClick(ev) {
    const wasDragged = dragged;
    pointerStarts.clear();
    dragged = false;
    if (!enabled || wasDragged) return;
    const hit = raycastViewer(viewer, ev.clientX, ev.clientY);
    if (!hit) return;
    const h = hitToHover(hit);
    togglePin(h.key, h.item.paramName);
  }

  // chip click: pinned chips carry their stable key; the hover chip pins itself
  function onChipClick(labelId) {
    if (labelId.startsWith("hover")) {
      if (hover) togglePin(hover.key, hover.item.paramName);
      return;
    }
    const pinItem = prevLayout && buildItems().find((i) => labelId.startsWith(i.id));
    if (pinItem?._key) togglePin(pinItem._key, null); // toggling off: no reveal
  }

  const dom = viewer.domElement;
  dom.addEventListener("pointermove", onMove);
  dom.addEventListener("pointerdown", onDown);
  dom.addEventListener("pointerup", onUp);
  dom.addEventListener("pointercancel", onCancel);
  dom.addEventListener("pointerleave", onLeave);
  dom.addEventListener("click", onClick);

  function setEnabled(on) {
    if (detached || on === enabled) return;
    enabled = !!on;
    if (enabled) {
      // overlay lives in the canvas's positioned ancestor (the stage)
      overlay ??= createDimOverlay(viewer.stageElement ?? dom.parentElement, { onChipClick });
      highlight ??= createFeatureHighlight(viewer);
      overlay.setVisible(true);
      lastSig = "";
      renderNow();
    } else {
      hover = null;
      highlight?.clear();
      overlay?.setVisible(false);
      overlay?.clear();
      prevLayout = null;
    }
  }

  return {
    setEnabled,
    isEnabled: () => enabled,
    clearPins() {
      pins.clear(getContext().view);
      notifyPins();
      renderNow();
    },
    pinCount: () => pins.count(getContext().view),
    onPinsChange: (cb) => { pinListeners.add(cb); return () => pinListeners.delete(cb); },
    getOverlaySvg: () => (enabled && overlay ? overlay.element : null),
    detach() {
      if (detached) return;
      detached = true;
      enabled = false;
      offFrame();
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointerup", onUp);
      dom.removeEventListener("pointercancel", onCancel);
      dom.removeEventListener("pointerleave", onLeave);
      dom.removeEventListener("click", onClick);
      highlight?.dispose();
      overlay?.dispose();
      specCache.clear();
      pinListeners.clear();
    },
  };
}
```

Note the `viewer.stageElement ?? dom.parentElement` seam — the fake viewer in
tests supplies `stageElement`; in the real app `dom.parentElement` is the
`.pf-stage` container (positioned), which is correct.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/framework/measure/measure-mode.test.js`
Expected: PASS. If the hover test misses, check the camera framing in the
fixture (the raycast must hit the plate at canvas center).

- [ ] **Step 5: Commit**

```bash
git add src/framework/measure/measure-mode.js test/framework/measure/measure-mode.test.js
git commit -m "Add measurement-mode orchestrator"
```

---

### Task 7: `measure-controls.js` chrome + cutaway `escapeGuard`

**Files:**
- Create: `src/framework/measure/measure-controls.js`
- Modify: `src/framework/cutaway-controls.js` (add `escapeGuard` option)
- Test: `test/framework/measure/measure-controls.test.js`
- Existing tests must stay green: `test/framework/cutaway-controls.test.js`

**Interfaces:**
- Consumes: the mode object from Task 6 (`setEnabled`, `isEnabled`,
  `clearPins`, `pinCount`, `onPinsChange`).
- Produces:
  - `attachMeasureControls(viewer, mode, { measure } = {}, { tooltip } = {}) -> { detach }`
    Mirrors `attachCutawayControls`: no button → no-op; `aria-pressed`;
    contextual actions (`Clear` — hidden when `pinCount() === 0` — and a
    static `mm` tag); Escape on the canvas/buttons exits the mode; full
    attribute restore on detach.
  - `attachCutawayControls(viewer, elements, { tooltip, escapeGuard })`:
    when `escapeGuard?.()` returns true, cutaway's Escape handler does
    nothing (measure claims the first Escape).

**Escape design note (refines the spec):** at-target keydown listeners ignore
the capture flag, so "capture phase + stopPropagation" cannot order two
listeners on the same element. The explicit `escapeGuard` option is the
deterministic replacement: mount passes `() => measureMode.isEnabled()`.

- [ ] **Step 1: Write the failing test**

`test/framework/measure/measure-controls.test.js`:

```js
// @vitest-environment happy-dom
// Viewbar chrome for measurement mode + the cutaway Escape-ordering contract.
import { expect, test, vi } from "vitest";
import { attachMeasureControls } from "../../../src/framework/measure/measure-controls.js";
import { attachCutawayControls } from "../../../src/framework/cutaway-controls.js";

function fakeMode(over = {}) {
  const pinCbs = new Set();
  let enabled = false;
  let pins = 0;
  return {
    setEnabled: vi.fn((on) => { enabled = on; }),
    isEnabled: () => enabled,
    clearPins: vi.fn(() => { pins = 0; for (const cb of pinCbs) cb(); }),
    pinCount: () => pins,
    onPinsChange: (cb) => { pinCbs.add(cb); return () => pinCbs.delete(cb); },
    __setPins: (n) => { pins = n; for (const cb of pinCbs) cb(); },
    ...over,
  };
}

function fixture() {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const button = document.createElement("button");
  document.body.appendChild(button);
  return { canvas, button, viewer: { domElement: canvas } };
}

test("no button -> inert no-op", () => {
  const { viewer } = fixture();
  const chrome = attachMeasureControls(viewer, fakeMode(), {});
  chrome.detach(); // must not throw
});

test("toggle wires aria-pressed and the mode", () => {
  const { viewer, button } = fixture();
  const mode = fakeMode();
  attachMeasureControls(viewer, mode, { measure: button });
  expect(button.getAttribute("aria-pressed")).toBe("false");
  button.click();
  expect(mode.setEnabled).toHaveBeenCalledWith(true);
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.classList.contains("on")).toBe(true);
});

test("Clear appears only with pins and clears them", () => {
  const { viewer, button } = fixture();
  const mode = fakeMode();
  attachMeasureControls(viewer, mode, { measure: button });
  button.click();
  const actions = document.querySelector(".pf-measure-actions");
  expect(actions.hidden).toBe(false);
  const clear = [...actions.querySelectorAll("button")].find((b) => b.textContent === "Clear");
  expect(clear.hidden).toBe(true);
  mode.__setPins(2);
  expect(clear.hidden).toBe(false);
  clear.click();
  expect(mode.clearPins).toHaveBeenCalled();
  expect(clear.hidden).toBe(true);
});

test("Escape exits the mode; cutaway skips Escape while measure is active", () => {
  const { viewer, button } = fixture();
  const cutButton = document.createElement("button");
  document.body.appendChild(cutButton);
  const mode = fakeMode();
  const cutViewer = {
    domElement: viewer.domElement,
    cutawaySupported: () => true,
    cutawayEnabled: vi.fn(() => true),
    setCutawayEnabled: vi.fn(),
    flipCutaway: vi.fn(),
    resetCutaway: vi.fn(),
  };
  attachCutawayControls(cutViewer, { cutaway: cutButton }, { escapeGuard: () => mode.isEnabled() });
  attachMeasureControls(viewer, mode, { measure: button });
  button.click(); // measure on
  viewer.domElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(mode.setEnabled).toHaveBeenLastCalledWith(false);
  expect(cutViewer.setCutawayEnabled).not.toHaveBeenCalled(); // guard held
  viewer.domElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(cutViewer.setCutawayEnabled).toHaveBeenCalledWith(false); // second Escape reaches cutaway
});

test("detach restores the host button and removes the actions row", () => {
  const { viewer, button } = fixture();
  button.setAttribute("title", "host title");
  const chrome = attachMeasureControls(viewer, fakeMode(), { measure: button });
  button.click();
  chrome.detach();
  expect(button.getAttribute("title")).toBe("host title");
  expect(button.classList.contains("on")).toBe(false);
  expect(document.querySelector(".pf-measure-actions")).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/framework/measure/measure-controls.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/framework/cutaway-controls.js` — two-line change:

```js
export function attachCutawayControls(viewer, { cutaway: button } = {}, { tooltip, escapeGuard } = {}) {
  // ... unchanged ...
  const onEscape = (event) => {
    if (event.key !== "Escape" || !viewer.cutawayEnabled()) return;
    if (escapeGuard?.()) return; // an inner lens (measure mode) claims this Escape
    event.preventDefault();
    disable();
  };
```

`src/framework/measure/measure-controls.js` — mirror cutaway-controls'
structure exactly (attribute capture/restore, tooltip binding, cleanup steps):

```js
// Viewbar chrome for measurement mode: the ruler toggle + contextual actions
// ("Clear" when pins exist, a static "mm" unit tag). A direct sibling of
// cutaway-controls.js — same no-op-without-button contract, same attribute
// restore discipline on detach. The mode object (measure-mode.js) owns all
// behavior; this file only puts it on screen.
import { attachButtonTooltips } from "../tooltip.js";

const BUTTON_ATTRIBUTES = ["type", "aria-pressed", "aria-label", "title", "disabled"];
const RULER_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.3 8.7 8.7 21.3c-.4.4-1 .4-1.4 0l-4.6-4.6c-.4-.4-.4-1 0-1.4L15.3 2.7c.4-.4 1-.4 1.4 0l4.6 4.6c.4.4.4 1 0 1.4Z"/><path d="m7.5 10.5 2 2"/><path d="m10.5 7.5 2 2"/><path d="m13.5 4.5 2 2"/><path d="m4.5 13.5 2 2"/></svg>`;

const noop = () => {};

function runCleanupSteps(steps) {
  const errors = [];
  for (const step of steps) {
    try { step(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "measure control cleanup failed");
}

function captureAttributes(element, names) {
  return new Map(names.map((name) => [name, {
    present: element.hasAttribute(name),
    value: element.getAttribute(name),
  }]));
}

function restoreAttributes(element, attributes) {
  for (const [name, { present, value }] of attributes) {
    if (present) element.setAttribute(name, value);
    else element.removeAttribute(name);
  }
}

export function attachMeasureControls(viewer, mode, { measure: button } = {}, { tooltip } = {}) {
  if (!button) return { detach: noop };

  const hostAttributes = captureAttributes(button, BUTTON_ATTRIBUTES);
  const hostHtml = button.innerHTML;
  const hostOn = button.classList.contains("on");

  button.type = "button";
  button.innerHTML = RULER_ICON;
  button.setAttribute("aria-pressed", "false");
  if (!tooltip && !button.hasAttribute("title")) button.title = "Toggle measurements";

  const actions = document.createElement("span");
  actions.className = "pf-measure-actions";
  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.textContent = "Clear";
  clearButton.title = "Remove all pinned measurements";
  clearButton.setAttribute("aria-label", "Remove all pinned measurements");
  const unitTag = document.createElement("span");
  unitTag.className = "pf-measure-unit";
  unitTag.textContent = "mm";
  actions.append(clearButton, unitTag);
  button.after(actions);

  const tooltipBinding = tooltip
    ? attachButtonTooltips(tooltip, [button, clearButton].map((element) => ({ element })))
    : null;

  function sync() {
    const on = mode.isEnabled();
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("aria-label", on ? "Hide measurements" : "Show measurements");
    button.classList.toggle("on", on);
    actions.hidden = !on;
    clearButton.hidden = mode.pinCount() === 0;
    tooltipBinding?.sync();
  }

  const onToggle = () => { mode.setEnabled(!mode.isEnabled()); sync(); };
  const onClear = () => { mode.clearPins(); sync(); };
  const onEscape = (event) => {
    if (event.key !== "Escape" || !mode.isEnabled()) return;
    event.preventDefault();
    mode.setEnabled(false);
    sync();
    tooltipBinding?.hide();
  };
  const offPins = mode.onPinsChange(sync);

  button.addEventListener("click", onToggle);
  clearButton.addEventListener("click", onClear);
  const escapeTargets = [viewer.domElement, button, clearButton];
  for (const element of escapeTargets) element.addEventListener("keydown", onEscape);
  sync();

  let detached = false;
  return {
    detach() {
      if (detached) return;
      detached = true;
      runCleanupSteps([
        offPins,
        () => button.removeEventListener("click", onToggle),
        () => clearButton.removeEventListener("click", onClear),
        ...escapeTargets.map((element) => () => element.removeEventListener("keydown", onEscape)),
        () => tooltipBinding?.detach(),
        () => actions.remove(),
        () => restoreAttributes(button, hostAttributes),
        () => { button.innerHTML = hostHtml; },
        () => button.classList.toggle("on", hostOn),
      ]);
    },
  };
}
```

Append to `src/framework/app.css`, next to the cutaway actions styles (find
`.pf-cutaway-actions` and mirror its rules for `.pf-measure-actions`, plus):

```css
.pf-measure-unit {
  font-family: var(--pf-mono); font-size: 10px; color: var(--pf-muted);
  align-self: center; padding: 0 4px; user-select: none;
}
```

- [ ] **Step 4: Run new + cutaway tests**

Run: `npx vitest run test/framework/measure/measure-controls.test.js test/framework/cutaway-controls.test.js`
Expected: PASS — the `escapeGuard` default (undefined) must not change
existing cutaway behavior.

- [ ] **Step 5: Commit**

```bash
git add src/framework/measure/measure-controls.js src/framework/cutaway-controls.js \
  src/framework/app.css test/framework/measure/measure-controls.test.js
git commit -m "Add measure-mode viewbar chrome; cutaway learns escapeGuard"
```

---

### Task 8: panel `revealParam` + flash CSS

**Files:**
- Modify: `src/framework/panel/render.js`
- Modify: `src/framework/app.css`
- Test: `test/framework/panel/reveal.test.js`

**Interfaces:**
- Produces: `buildControls(...)` return gains
  `revealParam(key) -> boolean` — opens enclosing collapsed sections/folds,
  scrolls the control into view, focuses its primary input, pulses
  `.pf-param-flash`. Returns false for unknown keys.

- [ ] **Step 1: Write the failing test**

`test/framework/panel/reveal.test.js` (look at
`test/framework/panel/` and `test/framework/controls.test.js` for the
established `buildControls` fixture shape — parameters object, params, root
div; reuse their minimal schema idiom):

```js
// @vitest-environment happy-dom
// revealParam: open the fold, focus the input, pulse the flash class.
import { expect, test } from "vitest";
import { buildControls } from "../../../src/framework/panel/render.js";

const parameters = {
  Body: {
    wall: { type: "number", label: "Wall", min: 1, max: 10 },
    advanced: {
      title: "Advanced",
      bore_d: { type: "number", label: "Bore ⌀", min: 2, max: 20 },
    },
  },
};

function setup() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const params = { wall: 3, bore_d: 8 };
  const panel = buildControls(root, parameters, params, () => {}, () => {});
  return { root, panel };
}

test("revealParam opens the enclosing fold and focuses the input", () => {
  const { root, panel } = setup();
  const fold = root.querySelector(".adv");
  expect(fold.classList.contains("hidden")).toBe(true); // folds start closed
  expect(panel.revealParam("bore_d")).toBe(true);
  expect(fold.classList.contains("hidden")).toBe(false);
  const input = document.activeElement;
  expect(fold.contains(input)).toBe(true);
});

test("revealParam pulses the flash class on the control", () => {
  const { root, panel } = setup();
  panel.revealParam("wall");
  expect(root.querySelector(".pf-param-flash")).not.toBeNull();
});

test("unknown key returns false and changes nothing", () => {
  const { panel } = setup();
  expect(panel.revealParam("nope")).toBe(false);
});
```

If `buildControls`'s parameter-schema shape differs from this guess, mirror the
shape used in `test/framework/controls.test.js` — the assertions stay the same.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/framework/panel/reveal.test.js`
Expected: FAIL — `revealParam` is not a function.

- [ ] **Step 3: Implement**

In `panel/render.js`:

1. Add alongside the other maps at the top of `buildControls`:

```js
  const keyToId = new Map();      // param key -> node id, for revealParam
```

2. In `renderNode`, right after `nodeEls.set(node.id, widget.el)` for control
leaves:

```js
    if (node.key && !keyToId.has(node.key)) keyToId.set(node.key, node.id);
```

3. Add to the returned object:

```js
    // Measurement mode's dimension->control link: open whatever encloses the
    // control, bring it on screen, hand it keyboard focus, and pulse the flash
    // so the eye lands on it. DOM-containment (not tree walking) finds the
    // enclosing disclosures, so section vs fold nesting needs no special case.
    revealParam(key) {
      const id = keyToId.get(key);
      const el = id && nodeEls.get(id);
      if (!el) return false;
      for (const [, d] of disclosures) {
        if (!d.body.contains(el) || !d.body.classList.contains("hidden")) continue;
        d.body.classList.remove("hidden");
        d.button.setAttribute("aria-expanded", "true");
        d.el.classList.remove("collapsed");
      }
      el.scrollIntoView?.({ block: "center" });
      el.querySelector("input, select, textarea, .seg button")?.focus({ preventScroll: true });
      el.classList.remove("pf-param-flash");
      void el.offsetWidth; // restart the animation on repeat reveals
      el.classList.add("pf-param-flash");
      el.addEventListener("animationend", () => el.classList.remove("pf-param-flash"), { once: true });
      return true;
    },
```

4. Append to `src/framework/app.css`:

```css
/* dimension->control reveal: a decaying accent pulse that hands off to the
   focused control's own focus ring */
.pf-param-flash { animation: pf-param-flash 900ms ease-out; }
@keyframes pf-param-flash {
  0% { box-shadow: 0 0 0 3px color-mix(in oklab, var(--pf-accent) 70%, transparent); }
  100% { box-shadow: 0 0 0 3px transparent; }
}
@media (prefers-reduced-motion: reduce) { .pf-param-flash { animation: none; } }
```

- [ ] **Step 4: Run new + existing panel/controls tests**

Run: `npx vitest run test/framework/panel/reveal.test.js test/framework/controls.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/panel/render.js src/framework/app.css test/framework/panel/reveal.test.js
git commit -m "Panel learns revealParam for dimension->control linking"
```

---

### Task 9: mount wiring + hover suppression + example pages

**Files:**
- Modify: `src/framework/mount.js`
- Modify: every example page that has a `#cutaway` button (`demo.html`,
  `planter.html`, `filleted-box.html`, `bracket.html`, `faceted-vase.html`,
  `hull-sweep.html`, `nameplate.html`, `hinged-box.html`, `screw.html`,
  `text-smoke.html`, `embed-test.html` if it has a viewbar)
- Modify: `src/framework/index.js` (export the measure modules if index.js
  exports the other chrome attachers — mirror whatever it does for
  `attachCutawayControls`)

**Interfaces:**
- Consumes: everything above.
- Produces: a working end-to-end feature in the dev apps.

- [ ] **Step 1: Wire mount.js**

In the element resolution block, add to `chrome`:

```js
      measure: elements.chrome?.measure ?? byId("measure"),
```

After the tooltip creation and BEFORE `attachCutawayControls` (the cutaway
call needs the mode for its guard), replacing the current hover line:

```js
    // Measurement mode: overlay + pins + dimension->control reveal. The panel
    // is built later in this function, so revealParam is a late-bound thunk.
    let panelRef = null;
    const measureMode = createMeasureMode(viewer, {
      part,
      getContext: () => ({ view: view(), params }),
      revealParam: (key) => panelRef?.revealParam(key),
    });
    cleanup.defer(() => measureMode.detach());
    const measureChrome = attachMeasureControls(viewer, measureMode, {
      measure: els.chrome.measure,
    }, { tooltip });
    cleanup.defer(() => measureChrome.detach());
```

Pass the guard to cutaway:

```js
    const cutawayChrome = attachCutawayControls(viewer, {
      cutaway: els.chrome.cutaway,
    }, { tooltip, escapeGuard: () => measureMode.isEnabled() });
```

Wire hover suppression via a mode-change signal. First, a small addition to
Task 6's `measure-mode.js`: keep a `modeListeners` set, fire it at the end of
`setEnabled`, and expose `onModeChange(cb)` returning an unsubscribe
(identical shape to `onPinsChange`). Then in mount, after the existing hover
attach:

```js
    const offMeasureHover = measureMode.onModeChange(() =>
      hover.setSuppressed(measureMode.isEnabled()));
    cleanup.defer(offMeasureHover);
```

Also add the matching one-line test in
`test/framework/measure/measure-mode.test.js`:

```js
test("onModeChange fires on enable and disable", () => {
  const { mode } = setup();
  const cb = vi.fn();
  mode.onModeChange(cb);
  mode.setEnabled(true);
  mode.setEnabled(false);
  expect(cb).toHaveBeenCalledTimes(2);
});
```

`getContext` note: mount already defines a `getContext` for pickers that
includes `derived`; it is defined AFTER this point in the function body. Use
the inline `() => ({ view: view(), params })` closure shown above (both
`view` and `params` are `const`/`let` declared before it runs — check
ordering; `view` is defined with the tabs, so place the measure block after
`createViewTabs`, still before `attachCutawayControls` is fine because the
cutaway attach also currently sits before the tabs — **move the cutaway +
measure attach block to just after `const params = { ...part.defaults }`**,
keeping their relative order; nothing between depended on `cutawayChrome`
except the tab-change handler, which is a closure and unaffected).

Where the panel is built (`const panel = buildControls(...)`, ~line 526), add:

```js
    panelRef = panel;
```

- [ ] **Step 2: Add the viewbar button to the example pages**

In each page's viewbar, before the cutaway button:

```html
        <button id="measure" title="Measurements" aria-label="Toggle measurements">⟺</button>
```

(The glyph is a placeholder the chrome replaces with the ruler SVG on attach.)

```bash
for f in demo.html planter.html filleted-box.html bracket.html faceted-vase.html \
         hull-sweep.html nameplate.html hinged-box.html screw.html text-smoke.html; do
  grep -q 'id="measure"' "$f" || \
  perl -0pi -e 's{(\s*)(<button id="cutaway")}{$1<button id="measure" title="Measurements" aria-label="Toggle measurements">\x{27FA}</button>$1$2}' "$f"
done
grep -l 'id="measure"' *.html
```

Check `embed-test.html` by hand — add the button only if it has a viewbar
with a cutaway button.

- [ ] **Step 3: Add mount imports**

```js
import { createMeasureMode } from "./measure/measure-mode.js";
import { attachMeasureControls } from "./measure/measure-controls.js";
```

Check `src/framework/index.js`: if it re-exports `attachCutawayControls`,
re-export the two measure entry points the same way.

- [ ] **Step 4: Run the full suite + the browser smoke check**

```bash
npm test
npm run check
```

Expected: PASS. `mount.test.js` exercises mount wiring — if it fails on the
reordered attach block, the failure names the assumption; keep the cutaway
attach semantics identical (same arguments plus `escapeGuard`).

- [ ] **Step 5: Manual verification in the dev server**

Run: `npm run dev`, open `/planter.html` (rich labeled part), then:
- click the ruler → overall W×D×H dims appear, engineering-style;
- hover the pot wall → feature dims + highlight, no plain hover tooltip;
- click a linked dim → it pins, the rail slider flashes and takes focus,
  arrow keys change the param, the pinned dim updates live;
- Escape exits measure (cutaway untouched if it was on);
- toggle mode off/on → pins return.

- [ ] **Step 6: Commit**

```bash
git add src/framework/mount.js src/framework/index.js *.html
git commit -m "Wire measurement mode into mount and the example apps"
```

---

### Task 10: `capture-overlay.js` — dimensioned captures

**Files:**
- Create: `src/framework/measure/capture-overlay.js`
- Test: `test/framework/measure/capture-overlay.test.js`

**Interfaces:**
- Produces:
  - `inlineOverlayStyles(svg) -> SVGElement` — a CLONE of the overlay with
    computed styles written as presentation attributes (serialized SVG has no
    stylesheet).
  - `overlaySvgString(svg, viewport) -> string` — serialized, xmlns'd, sized.
  - `compositeOverlay(frameDataUrl, svgString, { width, height }) -> Promise<string>`
    — draws the frame then the overlay onto a canvas; returns a PNG data URL.
    (Not unit-tested: happy-dom does not rasterize. The exported pure helpers
    are; the composite is exercised manually / by hosts.)

- [ ] **Step 1: Write the failing test**

`test/framework/measure/capture-overlay.test.js`:

```js
// @vitest-environment happy-dom
// Style inlining + serialization for dimensioned captures (rasterization
// itself is not testable in happy-dom).
import { expect, test } from "vitest";
import { inlineOverlayStyles, overlaySvgString } from "../../../src/framework/measure/capture-overlay.js";

function overlayFixture() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "pf-dim-overlay");
  const line = document.createElementNS(NS, "line");
  line.setAttribute("class", "pf-dim-line");
  const text = document.createElementNS(NS, "text");
  text.setAttribute("class", "pf-dim-text");
  text.textContent = "24.00";
  svg.append(line, text);
  document.body.appendChild(svg);
  return svg;
}

test("inlineOverlayStyles clones and stamps presentation attributes", () => {
  const svg = overlayFixture();
  const clone = inlineOverlayStyles(svg);
  expect(clone).not.toBe(svg);
  const line = clone.querySelector("line");
  expect(line.hasAttribute("stroke")).toBe(true);
  const text = clone.querySelector("text");
  expect(text.hasAttribute("fill")).toBe(true);
  expect(text.hasAttribute("font-family")).toBe(true);
  // the original is untouched
  expect(svg.querySelector("line").hasAttribute("stroke")).toBe(false);
});

test("overlaySvgString serializes with xmlns and explicit size", () => {
  const svg = overlayFixture();
  const s = overlaySvgString(svg, { width: 640, height: 480 });
  expect(s).toContain('xmlns="http://www.w3.org/2000/svg"');
  expect(s).toContain('width="640"');
  expect(s).toContain('height="480"');
  expect(s).toContain("24.00");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/framework/measure/capture-overlay.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/framework/measure/capture-overlay.js`:

```js
// Dimensioned captures: composite the measurement overlay onto a captured
// frame. Serialized SVG carries no stylesheet, so computed styles are inlined
// as presentation attributes first. Fonts do not travel into rasterized SVG
// either — composited captures fall back through the --pf-mono stack
// (ui-monospace instead of Geist Mono); embedding a WOFF subset is the
// upgrade path if that grates.
const STYLE_PROPS = [
  "stroke", "stroke-width", "stroke-linejoin", "stroke-linecap", "fill",
  "opacity", "font-family", "font-size", "font-weight", "letter-spacing",
  "paint-order", "text-anchor", "dominant-baseline",
];

export function inlineOverlayStyles(svg) {
  const clone = svg.cloneNode(true);
  const walk = (orig, copy) => {
    if (orig.nodeType === 1) {
      const cs = getComputedStyle(orig);
      for (const prop of STYLE_PROPS) {
        const v = cs.getPropertyValue(prop);
        if (v && v !== "none" && v !== "normal" && v !== "auto") copy.setAttribute(prop, v);
      }
    }
    for (let i = 0; i < orig.children.length; i++) walk(orig.children[i], copy.children[i]);
  };
  walk(svg, clone);
  return clone;
}

export function overlaySvgString(svg, { width, height }) {
  const clone = inlineOverlayStyles(svg);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.removeAttribute("hidden");
  return new XMLSerializer().serializeToString(clone);
}

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error("capture-overlay: image failed to decode"));
  img.src = src;
});

// frameDataUrl: viewer.captureCurrent()'s output. svgString: overlaySvgString().
export async function compositeOverlay(frameDataUrl, svgString, { width, height }) {
  const [frame, dims] = await Promise.all([
    loadImage(frameDataUrl),
    loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`),
  ]);
  const canvas = document.createElement("canvas");
  canvas.width = frame.naturalWidth;
  canvas.height = frame.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(frame, 0, 0);
  // the overlay is laid out in CSS pixels; scale it to the frame's resolution
  ctx.drawImage(dims, 0, 0, width, height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/framework/measure/capture-overlay.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/measure/capture-overlay.js test/framework/measure/capture-overlay.test.js
git commit -m "Add overlay compositing for dimensioned captures"
```

---

### Task 11: docs

**Files:**
- Modify: `docs/AUTHORING-PARTS.md`
- Modify: `AGENTS.md` (the `src/framework/` architecture bullet)

- [ ] **Step 1: AUTHORING-PARTS.md**

Find the section documenting `Solid.label()` / feature labels (grep for
`label(`). Append:

```markdown
Labels do double duty in the viewer: the hover tooltip names the feature, and
**measurement mode** (the ruler button in the viewbar) measures it — a labeled
hole reads ⌀ + depth, a labeled face reads its extents, and a click pins that
dimension so it tracks parameter changes live. Label the features a user would
want to measure; unlabeled geometry still measures as its bounding box.
```

- [ ] **Step 2: AGENTS.md**

In the `src/framework/` bullet, after the cutaway file list, add
`measure/` with a one-line description:

```markdown
  `measure/` (the ruler-button measurement mode: pure dimension engines +
  SVG overlay; `feature-dims.js`/`dim-layout.js`/`pins.js`/`param-link.js`
  are pure leaves, `measure-mode.js` orchestrates, `measure-controls.js` is
  the viewbar chrome),
```

- [ ] **Step 3: Run the docs coherence test + full suite**

```bash
npx vitest run test/framework/docs-coherence.test.js
npm test
```

Expected: PASS. If docs-coherence flags anything about the new files, follow
its failure message — it is the authority on doc/code agreement.

- [ ] **Step 4: Commit**

```bash
git add docs/AUTHORING-PARTS.md AGENTS.md
git commit -m "Document measurement mode"
```

---

### Task 12: version bump + final verification

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump the minor version** (current: 0.53.0 — re-check before
bumping; another PR may have landed):

```bash
npm pkg get version
npm version minor --no-git-tag-version
```

- [ ] **Step 2: Full suite + smoke + lint the example parts still lint clean**

```bash
npm test
npm run check
```

Expected: PASS everywhere.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "Bump version for measurement mode"
```

---

## Self-Review (completed)

- **Spec coverage:** always-on dims (T6), hover feature dims (T1+T6),
  per-sub-part bbox (T6 `hitToHover` fallback), click-to-pin + per-view pins +
  dormancy (T2+T6), param linking + reveal (T2+T8+T9), drafting visuals +
  tokens (T5), Escape ordering (T7), hover suppression (T4+T9), capture (T10),
  docs (T11), version bump (T12). Deferred list untouched — no edge picking,
  no touch hover, no CLI renders, narrow-layout reveal is a natural no-op
  (revealParam thunk targets the rail regardless of pane state; acceptable
  v1 behavior per spec).
- **Escape mechanism deviation from spec** (capture-phase → `escapeGuard`)
  is deliberate and documented in Task 7.
- **Type consistency:** `Spec`/`items`/`labels` shapes match across T1/T3/T5/T6;
  `mode` surface matches across T6/T7/T9 (including `onModeChange` added in
  T9's correction and tested there).
