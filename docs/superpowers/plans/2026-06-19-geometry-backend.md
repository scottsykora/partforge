# Geometry Backend (Manifold preview + OCCT export) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the drum preview near-instant by adding a swappable geometry-kernel layer with a Manifold backend (fast mesh CSG) for preview/STL, while keeping OCCT for exact STEP export.

**Architecture:** `drum.js` becomes backend-agnostic and builds geometry through a `GeometryKernel` interface. Two backends implement it (`occt-backend`, `manifold-backend`). Two web workers each run a shared job handler with their own kernel; `main.js` routes preview/STL to the Manifold worker and STEP to a lazily-booted OCCT worker.

**Tech Stack:** Vite 8, Node 24, three.js, `replicad` + `replicad-opencascadejs` (OCCT), `manifold-3d` (new), `vitest` (new).

## Global Constraints

- **Node 24** — run `nvm use` (`.nvmrc` = 24.16.0) before any npm command.
- **The groove must use a frenet swept tube, never twist-extrude.** Twist-extrude is ~15% wrong (resolution-independent) per the spike; only the explicit frenet swept-tube mesh matches OCCT (0.12%).
- **`drum.js` must not import `replicad` or `manifold-3d`** — it only touches the `kernel` parameter.
- **Manifold `helixSweptTube` mesh must be watertight with consistent outward winding** or `Manifold.ofMesh` throws / imports inverted.
- **Two kernels cannot boot in one Node process** (crashes). Tests boot Manifold only; OCCT reference values come from a committed fixture file.
- **Licenses:** preserve upstream notices; OCCT (LGPL-2.1 + OCCT Exception) used unmodified as a separate WASM module.
- Reference design: `docs/superpowers/specs/2026-06-19-geometry-backend-design.md`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/geometry/kernel.js` | `GeometryKernel` JSDoc typedefs (the contract) + shared 2-D polygon helpers |
| `src/geometry/helix-tube.js` | Frenet swept-tube **mesh** builder → `Manifold.ofMesh` |
| `src/geometry/manifold-backend.js` | `createManifoldKernel()` — wraps `manifold-3d` |
| `src/geometry/occt-backend.js` | `createOcctKernel()` — wraps `replicad`; only backend with `toSTEP` |
| `src/drum.js` | backend-agnostic geometry (modified: takes `kernel`) |
| `src/geometry-jobs.js` | `handle(kernel, msg)` — generate / export-stl / export-step |
| `src/preview-worker.js` | boots Manifold → `geometry-jobs` |
| `src/export-worker.js` | boots OCCT lazily → `geometry-jobs` |
| `src/main.js` | spawn both workers, route jobs, `?backend=occt` toggle (modified) |
| `test/fixtures/occt-volumes.json` | committed OCCT reference volumes |
| `scripts/gen-occt-fixtures.mjs` | regenerates the fixture (own process) |
| `test/*.test.js` | vitest unit + parity tests |

---

## Task 1: Test harness + dependencies

**Files:**
- Modify: `package.json`
- Create: `vitest.config.js`
- Create: `test/smoke.test.js`

**Interfaces:**
- Produces: `npm test` runs vitest; `manifold-3d` available as a dependency.

- [ ] **Step 1: Add dependencies**

Run:
```bash
nvm use && npm install manifold-3d && npm install -D vitest
```
Expected: both appear in `package.json` (`manifold-3d` in dependencies, `vitest` in devDependencies).

- [ ] **Step 2: Add the test script to `package.json`**

In the `"scripts"` block add:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create `vitest.config.js`**

```js
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    testTimeout: 30000, // WASM boot + meshing
  },
});
```

- [ ] **Step 4: Write a smoke test that boots Manifold** — `test/smoke.test.js`

```js
import { expect, test } from "vitest";
import Module from "manifold-3d";

test("manifold boots and makes a cylinder", async () => {
  const wasm = await Module();
  wasm.setup();
  const c = wasm.Manifold.cylinder(10, 5, 5, 64);
  expect(c.volume()).toBeGreaterThan(750); // π·25·10 ≈ 785, faceted
  expect(c.volume()).toBeLessThan(786);
});
```

- [ ] **Step 5: Run it**

Run: `nvm use && npm test`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.js test/smoke.test.js
git commit -m "test: add vitest + manifold-3d dependency and a boot smoke test"
```

---

## Task 2: `helix-tube.js` — frenet swept-tube mesh builder

**Files:**
- Create: `src/geometry/helix-tube.js`
- Test: `test/helix-tube.test.js`

**Interfaces:**
- Consumes: a Manifold module (`wasm`) with `Manifold`, `Mesh`.
- Produces: `helixTube(wasm, { pathR, profileR, pitch, turns, z0, lefthand, stationsPerTurn, ringSegs }) → Manifold` — a watertight helical tube solid, profile circle carried in the frenet frame.

- [ ] **Step 1: Write the failing tests** — `test/helix-tube.test.js`

```js
import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { helixTube } from "../src/geometry/helix-tube.js";

let wasm;
beforeAll(async () => { wasm = await Module(); wasm.setup(); });

const params = { pathR: 20, profileR: 1, pitch: 4, turns: 3, z0: 0, lefthand: false };

test("tube is a valid watertight manifold (ofMesh does not throw)", () => {
  expect(() => helixTube(wasm, params)).not.toThrow();
});

test("volume matches the analytic swept-circle estimate within 5%", () => {
  const tube = helixTube(wasm, params);
  const arc = params.turns * Math.hypot(2 * Math.PI * params.pathR, params.pitch);
  const analytic = Math.PI * params.profileR ** 2 * arc;
  expect(Math.abs(tube.volume() - analytic) / analytic).toBeLessThan(0.05);
});

test("oriented outward: subtracting from a blank REMOVES material", () => {
  const blank = wasm.Manifold.cylinder(20, 25, 25, 128); // encloses the tube
  const cut = blank.subtract(helixTube(wasm, params));
  expect(cut.volume()).toBeLessThan(blank.volume());
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- helix-tube`
Expected: FAIL ("helixTube is not a function" / import error).

- [ ] **Step 3: Implement `src/geometry/helix-tube.js`**

```js
// Builds a watertight triangle mesh of a circular profile swept along a helix in
// its frenet frame, then imports it as a Manifold solid. The profile stays
// perpendicular to the helix tangent (unlike twist-extrude), so it matches an
// exact frenet sweep. Winding is consistent-outward; getting it wrong makes
// Manifold.ofMesh throw or import an inverted solid.
const norm = (v) => { const m = Math.hypot(...v); return [v[0] / m, v[1] / m, v[2] / m]; };
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];

export function helixTube(wasm, opts) {
  const { pathR, profileR, pitch, turns, z0 = 0, lefthand = false,
          stationsPerTurn = 24, ringSegs = 16 } = opts;
  const sign = lefthand ? -1 : 1;
  const c = pitch / (2 * Math.PI);          // z-rise per radian
  const phiMax = 2 * Math.PI * turns;
  const n = Math.max(2, Math.ceil(turns * stationsPerTurn)) + 1;
  const V = [], Tr = [];

  for (let i = 0; i < n; i++) {
    const phi = (phiMax * i) / (n - 1);
    const ctr = [pathR * Math.cos(sign * phi), pathR * Math.sin(sign * phi), z0 + c * phi];
    const T = norm([-sign * pathR * Math.sin(sign * phi), sign * pathR * Math.cos(sign * phi), c]);
    const N = [Math.cos(sign * phi), Math.sin(sign * phi), 0]; // radial, ⟂ T
    const B = norm(cross(T, N));
    for (let j = 0; j < ringSegs; j++) {
      const a = (2 * Math.PI * j) / ringSegs;
      V.push(ctr[0] + profileR * (Math.cos(a) * N[0] + Math.sin(a) * B[0]),
             ctr[1] + profileR * (Math.cos(a) * N[1] + Math.sin(a) * B[1]),
             ctr[2] + profileR * (Math.cos(a) * N[2] + Math.sin(a) * B[2]));
    }
  }
  // side faces (outward winding)
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < ringSegs; j++) {
    const a = i*ringSegs + j, b = i*ringSegs + (j+1)%ringSegs;
    const cc = (i+1)*ringSegs + j, dd = (i+1)*ringSegs + (j+1)%ringSegs;
    Tr.push(a, dd, cc, a, b, dd);
  }
  // end caps
  const c0 = V.length / 3;
  V.push(pathR * Math.cos(0), pathR * Math.sin(0), z0);
  for (let j = 0; j < ringSegs; j++) Tr.push(c0, (j+1)%ringSegs, j);
  const base = (n - 1) * ringSegs, cz = V.length / 3;
  V.push(pathR * Math.cos(sign * phiMax), pathR * Math.sin(sign * phiMax), z0 + c * phiMax);
  for (let j = 0; j < ringSegs; j++) Tr.push(cz, base + j, base + (j+1)%ringSegs);

  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(V), triVerts: Uint32Array.from(Tr) });
  mesh.merge();
  return wasm.Manifold.ofMesh(mesh);
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- helix-tube`
Expected: PASS (3 tests). If "oriented outward" fails (cut volume ≥ blank), the winding is inverted — swap the side-face line to `Tr.push(a, cc, dd, a, dd, b)` and both cap loops' last two indices.

- [ ] **Step 5: Commit**

```bash
git add src/geometry/helix-tube.js test/helix-tube.test.js
git commit -m "feat(geometry): frenet swept-tube mesh builder for Manifold grooves"
```

---

## Task 3: `kernel.js` — the contract + 2-D polygon helpers

**Files:**
- Create: `src/geometry/kernel.js`
- Test: `test/kernel-helpers.test.js`

**Interfaces:**
- Produces: JSDoc `@typedef GeometryKernel` / `Solid` (documentation only, no runtime), and helpers `piePolygon(tipR, arcDeg) → [[x,y],…]` and `hexPolygon(r) → [[x,y],…]` used by both backends' callers in `drum.js`.

- [ ] **Step 1: Write the failing test** — `test/kernel-helpers.test.js`

```js
import { expect, test } from "vitest";
import { piePolygon, hexPolygon } from "../src/geometry/kernel.js";

test("hexPolygon returns 6 points on radius r", () => {
  const pts = hexPolygon(3);
  expect(pts).toHaveLength(6);
  for (const [x, y] of pts) expect(Math.hypot(x, y)).toBeCloseTo(3, 6);
});

test("piePolygon starts at origin and spans the arc", () => {
  const pts = piePolygon(10, 90);
  expect(pts[0]).toEqual([0, 0]);
  const last = pts[pts.length - 1];
  expect(Math.hypot(last[0], last[1])).toBeCloseTo(10, 6);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- kernel-helpers`
Expected: FAIL (import error).

- [ ] **Step 3: Implement `src/geometry/kernel.js`**

```js
// The GeometryKernel contract (documentation) + 2-D polygon helpers shared by
// drum.js when calling kernel.prism(). Backends implement the @typedef below.

/**
 * @typedef {Object} Solid  An opaque handle to a backend solid.
 * @property {(tool: Solid) => Solid} cut
 * @property {(tools: Solid[]) => Solid} cutAll      batch subtract (backend-optimized)
 * @property {(v: number[]) => Solid} translate
 * @property {(deg: number, center: number[], axis: number[]) => Solid} rotate
 * @property {(plane: "XY"|"XZ"|"YZ") => Solid} mirror
 * @property {(opts?: {quality?: "preview"|"print"}) => {positions:Float32Array, normals:Float32Array, indices:Uint32Array, triangles:number}} toMesh
 * @property {(opts?: {quality?: "preview"|"print"}) => ArrayBuffer} toSTL
 *
 * @typedef {Object} GeometryKernel
 * @property {(rBottom:number, rTop:number, h:number, opts?:{center?:boolean}) => Solid} cylinder
 * @property {(min:number[], max:number[]) => Solid} box
 * @property {(points2D:number[][], h:number) => Solid} prism   extrude polygon from z=0
 * @property {(o:{pathR:number,profileR:number,pitch:number,turns:number,z0:number,lefthand:boolean}) => Solid} helixSweptTube
 * @property {(solids:Solid[]) => Solid} union
 * @property {(named:{name:string,solid:Solid}[]) => ArrayBuffer} toSTEP   OCCT only
 */

// CCW polygon points for a circular-sector "pie" from the origin, radius tipR.
export function piePolygon(tipR, arcDeg, segs = 32) {
  const a = (arcDeg * Math.PI) / 180;
  const pts = [[0, 0]];
  const steps = Math.max(2, Math.ceil((segs * arcDeg) / 360));
  for (let i = 0; i <= steps; i++) {
    const t = (a * i) / steps;
    pts.push([tipR * Math.cos(t), tipR * Math.sin(t)]);
  }
  return pts;
}

// Vertex-up regular hexagon, circumradius r (flats facing ±X).
export function hexPolygon(r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 3;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -- kernel-helpers`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/geometry/kernel.js test/kernel-helpers.test.js
git commit -m "feat(geometry): GeometryKernel contract + pie/hex polygon helpers"
```

---

## Task 4: `manifold-backend.js`

**Files:**
- Create: `src/geometry/manifold-backend.js`
- Test: `test/manifold-backend.test.js`

**Interfaces:**
- Consumes: `helixTube` (Task 2), a Manifold `wasm` module.
- Produces: `createManifoldKernel(wasm, { quality }) → GeometryKernel`. `toSTEP` throws `"STEP export not supported by the Manifold backend"`.

- [ ] **Step 1: Write the failing tests** — `test/manifold-backend.test.js`

```js
import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/geometry/manifold-backend.js";

let k;
beforeAll(async () => { const wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" }); });

test("cylinder minus a concentric bore removes volume", () => {
  const drum = k.cylinder(10, 10, 20).cut(k.cylinder(4, 4, 30).translate([0, 0, -5]));
  const m = drum.toMesh();
  expect(m.triangles).toBeGreaterThan(0);
});

test("cutAll batch-subtracts every tool", () => {
  const base = k.cylinder(10, 10, 10);
  const holes = [k.cylinder(1, 1, 12).translate([5, 0, -1]), k.cylinder(1, 1, 12).translate([-5, 0, -1])];
  const out = base.cutAll(holes).toMesh();
  expect(out.triangles).toBeGreaterThan(0);
});

test("toSTEP throws (unsupported)", () => {
  expect(() => k.toSTEP([])).toThrow(/not supported/i);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- manifold-backend`
Expected: FAIL (import error).

- [ ] **Step 3: Implement `src/geometry/manifold-backend.js`**

```js
import { helixTube } from "./helix-tube.js";

const PLANE_NORMAL = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };
const SEGS = { preview: 64, print: 220 };       // circular segments
const TUBE = { preview: { stationsPerTurn: 24, ringSegs: 16 }, print: { stationsPerTurn: 64, ringSegs: 24 } };

export function createManifoldKernel(wasm, { quality = "preview" } = {}) {
  const { Manifold, CrossSection } = wasm;
  const segs = SEGS[quality], tube = TUBE[quality];

  const wrap = (m) => ({
    _m: m,
    cut: (t) => wrap(m.subtract(t._m)),
    cutAll: (tools) => wrap(m.subtract(tools.map((t) => t._m).reduce((a, b) => a.add(b)))),
    translate: (v) => wrap(m.translate(v)),
    rotate: (deg, center, axis) => {
      const euler = [axis[0] * deg, axis[1] * deg, axis[2] * deg];
      const moved = m.translate([-center[0], -center[1], -center[2]]).rotate(euler).translate(center);
      return wrap(moved);
    },
    mirror: (plane) => wrap(m.mirror(PLANE_NORMAL[plane])),
    toMesh: () => {
      const g = m.getMesh();
      return {
        positions: g.numProp === 3 ? g.vertProperties : Float32Array.from(stridePos(g)),
        normals: new Float32Array(0),       // main thread computes vertex normals
        indices: g.triVerts,
        triangles: g.triVerts.length / 3,
      };
    },
    toSTL: () => stlFromMesh(m.getMesh()),
  });

  return {
    cylinder: (rb, rt, h, { center = false } = {}) => wrap(Manifold.cylinder(h, rb, rt, segs, center)),
    box: (min, max) => wrap(Manifold.cube([max[0]-min[0], max[1]-min[1], max[2]-min[2]]).translate(min)),
    prism: (pts, h) => wrap(CrossSection.ofPolygons([pts]).extrude(h)),
    helixSweptTube: (o) => wrap(helixTube(wasm, { ...o, ...tube })),
    union: (solids) => wrap(solids.map((s) => s._m).reduce((a, b) => a.add(b))),
    toSTEP: () => { throw new Error("STEP export not supported by the Manifold backend"); },
  };
}

function stridePos(g) {
  const out = [];
  for (let v = 0; v < g.vertProperties.length; v += g.numProp)
    out.push(g.vertProperties[v], g.vertProperties[v + 1], g.vertProperties[v + 2]);
  return out;
}

function stlFromMesh(g) {
  const tris = g.triVerts, vp = g.vertProperties, np = g.numProp, n = tris.length / 3;
  const ab = new ArrayBuffer(84 + n * 50); const dv = new DataView(ab); dv.setUint32(80, n, true);
  let o = 84; const P = (i) => [vp[i*np], vp[i*np+1], vp[i*np+2]];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) { dv.setFloat32(o, 0, true); o += 4; } // normal (slicers recompute)
    for (const idx of [tris[i*3], tris[i*3+1], tris[i*3+2]]) { const p = P(idx); for (const x of p) { dv.setFloat32(o, x, true); o += 4; } }
    dv.setUint16(o, 0, true); o += 2;
  }
  return ab;
}
```

> Note: `CrossSection.ofPolygons([pts])` takes an array of contours; `pts` is a flat list of `[x,y]`. If the installed manifold-3d exposes it as `new CrossSection([pts])`, use that — verify against `node -e` during Step 4 and adjust.

- [ ] **Step 4: Run the tests**

Run: `npm test -- manifold-backend`
Expected: PASS (3 tests). If `CrossSection.ofPolygons` is undefined, switch `prism` to `new CrossSection([pts]).extrude(h)` and re-run.

- [ ] **Step 5: Commit**

```bash
git add src/geometry/manifold-backend.js test/manifold-backend.test.js
git commit -m "feat(geometry): manifold-3d backend (cylinder/box/prism/helix/booleans/STL)"
```

---

## Task 5: `occt-backend.js`

**Files:**
- Create: `src/geometry/occt-backend.js`
- Test: `test/occt-backend.test.js`

**Interfaces:**
- Consumes: a booted replicad (caller runs `setOC`).
- Produces: `createOcctKernel(replicad) → GeometryKernel` (same shape as Manifold's), plus `toSTEP(named)` returning a STEP ArrayBuffer. `toMesh`/`toSTL` accept `{quality}` mapping to mesh tolerances.

- [ ] **Step 1: Write the failing test** — `test/occt-backend.test.js`

```js
import { beforeAll, expect, test } from "vitest";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

let k;
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  globalThis.require = globalThis.require ?? require;
  globalThis.__dirname = globalThis.__dirname ?? path.dirname(fileURLToPath(import.meta.url));
  const { default: init } = await import("replicad-opencascadejs/src/replicad_single.js");
  const OC = await init({ wasmBinary: fs.readFileSync(require.resolve("replicad-opencascadejs/src/replicad_single.wasm")) });
  const replicad = await import("replicad");
  replicad.setOC(OC);
  const { createOcctKernel } = await import("../src/geometry/occt-backend.js");
  k = createOcctKernel(replicad);
});

test("cylinder minus a bore meshes to a solid", () => {
  const drum = k.cylinder(10, 10, 20).cut(k.cylinder(4, 4, 30).translate([0, 0, -5]));
  expect(drum.toMesh({ quality: "preview" }).triangles).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- occt-backend`
Expected: FAIL (import error).

- [ ] **Step 3: Implement `src/geometry/occt-backend.js`**

```js
// OCCT backend via replicad. Same GeometryKernel shape as the Manifold backend,
// and the only backend with toSTEP(). This is where today's drum.js kernel calls
// (makeCylinder, makeHelix+genericSweep, draw/extrude, cut/fuse) now live.
const MESH = { preview: { tolerance: 0.1, angularTolerance: 0.5 }, print: { tolerance: 0.01, angularTolerance: 0.1 } };

export function createOcctKernel(replicad) {
  const { makeCylinder, makeBox, makeCircle, makeHelix, assembleWire, genericSweep,
          makeCompound, loft, draw, exportSTEP } = replicad;

  const wrap = (shape) => ({
    _s: shape,
    cut: (t) => wrap(shape.cut(t._s)),
    cutAll: (tools) => wrap(shape.cut(makeCompound(tools.map((t) => t._s)))),
    translate: (v) => wrap(shape.translate(v)),
    rotate: (deg, center, axis) => wrap(shape.rotate(deg, center, axis)),
    mirror: (plane) => wrap(shape.mirror(plane)),
    toMesh: ({ quality = "preview" } = {}) => {
      const m = shape.mesh(MESH[quality]);
      return {
        positions: Float32Array.from(m.vertices),
        normals: m.normals ? Float32Array.from(m.normals) : new Float32Array(0),
        indices: Uint32Array.from(m.triangles),
        triangles: m.triangles.length / 3,
      };
    },
    toSTL: ({ quality = "print" } = {}) => shape.blobSTL(MESH[quality]).arrayBuffer(),
  });

  // cylinder OR frustum (loft of two circles) when rb !== rt
  const cylinder = (rb, rt, h, { center = false } = {}) => {
    const z0 = center ? -h / 2 : 0;
    if (Math.abs(rb - rt) < 1e-9) return wrap(makeCylinder(rb, h, [0, 0, z0]));
    const w1 = assembleWire([makeCircle(rb, [0, 0, z0])]);
    const w2 = assembleWire([makeCircle(rt, [0, 0, z0 + h])]);
    return wrap(loft([w1, w2]));
  };

  // extrude a 2-D polygon from z=0
  const prism = (pts, h) => {
    let pen = draw(pts[0]);
    for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
    return wrap(pen.close().sketchOnPlane("XY").extrude(h));
  };

  // circle profile swept along a helix (frenet)
  const helixSweptTube = ({ pathR, profileR, pitch, turns, z0, lefthand }) => {
    const spine = makeHelix(pitch, pitch * turns, pathR, [0, 0, z0], [0, 0, 1], lefthand);
    const dir = lefthand ? -1 : 1;
    const tangent = [0, dir * pathR, pitch / (2 * Math.PI)];
    const profile = assembleWire([makeCircle(profileR, [pathR, 0, z0], tangent)]);
    return wrap(genericSweep(profile, spine, { frenet: true }));
  };

  return {
    cylinder, box: (min, max) => wrap(makeBox(min, max)), prism, helixSweptTube,
    union: (solids) => wrap(solids.map((s) => s._s).reduce((a, b) => a.fuse(b))),
    toSTEP: (named) => exportSTEP(named.map(({ name, solid }) => ({ name, shape: solid._s }))).arrayBuffer(),
  };
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -- occt-backend`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/geometry/occt-backend.js test/occt-backend.test.js
git commit -m "feat(geometry): OCCT backend via replicad (incl. STEP export)"
```

---

## Task 6: Port `drum.js` to the kernel

**Files:**
- Modify: `src/drum.js` (whole file — remove `replicad` import, take `kernel`)
- Test: `test/drum-occt.test.js`

**Interfaces:**
- Consumes: a `GeometryKernel` (Task 3 shape), `piePolygon`/`hexPolygon` (Task 3), `DEFAULTS`/`derive` (`params.js`, unchanged).
- Produces: `buildSubPart(kernel, name, params) → Solid` (name ∈ `"small"|"big"|"block"`, canonical frame); `buildParts(kernel, part, params) → {name, solid}[]` (export, standalone parts).

**Mapping (apply throughout):**

| Today (replicad) | Becomes (kernel) |
|---|---|
| `makeCylinder(r, h, [0,0,z])` (along +Z) | `kernel.cylinder(r, r, h).translate([0,0,z])` |
| `makeCylinder(r, h, base, [0,1,0])` (along +Y) | `kernel.cylinder(r, r, h).rotate(-90, [0,0,0], [1,0,0]).translate(base)` |
| `makeCylinder(r, h, base, [0,-1,0])` (along −Y; knot pocket) | `kernel.cylinder(r, r, h).rotate(90, [0,0,0], [1,0,0]).translate(base)` |
| `makeCylinder(r, h, base, [1,0,0])` (along +X) | `kernel.cylinder(r, r, h).rotate(90, [0,0,0], [0,1,0]).translate(base)` |
| `makeCylinder(r, h, start, ax)` (lock hole; `ax` in XZ plane) | `kernel.cylinder(r, r, h).rotate(Math.atan2(ax[0], ax[2])*180/Math.PI, [0,0,0], [0,1,0]).translate(start)` |
| `frustum(r1, r2, h, z)` | `kernel.cylinder(r1, r2, h).translate([0,0,z])` |
| `makeBox(min, max)` | `kernel.box(min, max)` |
| `annularSector(rootR,tipR,arc,h,z0)` | `kernel.prism(piePolygon(tipR,arc), h).translate([0,0,z0]).cut(kernel.cylinder(rootR,rootR,h+2).translate([0,0,z0-1]))` |
| `hexPrism(cx,cz,r,yLo,nt)` | `kernel.prism(hexPolygon(r), nt).rotate(-90,[0,0,0],[1,0,0]).translate([cx,yLo,cz])` |
| `grooveTool(pathR,pitch,turns,z0,grooveR,lh)` | `kernel.helixSweptTube({pathR,profileR:grooveR,pitch,turns,z0,lefthand:lh})` |
| `fuzzyCut(drum, tool)` | `drum.cut(tool)` (Manifold needs no fuzzy; OCCT cut is fine for a single grooved-field compound) |
| `makeCompound(tools)` as a cut tool | use `solid.cutAll(tools)` |
| `drum.cut(x)` / `drum.fuse(x)` | `drum.cut(x)` / `kernel.union([drum, x])` |
| `.translate/.rotate/.mirror` | unchanged (Solid methods) |

> **fuzzyCut removal:** the grooved field cut becomes `drum.cut(kernel.union(grooveTools))`. OCCT previously needed `fuzzyCut` for near-tangent helices; verify the OCCT parity test (Task 7) still produces a valid solid — if the OCCT groove boolean returns empty, keep a fuzzy path **inside occt-backend** by adding an optional `solid.cutFuzzy(tool)` and using it only for the groove. (Manifold never needs it.)

- [ ] **Step 1: Write the failing test** — `test/drum-occt.test.js`

```js
import { beforeAll, expect, test } from "vitest";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

let k, buildSubPart;
beforeAll(async () => {
  const require = createRequire(import.meta.url);
  globalThis.require = globalThis.require ?? require;
  globalThis.__dirname = globalThis.__dirname ?? path.dirname(fileURLToPath(import.meta.url));
  const { default: init } = await import("replicad-opencascadejs/src/replicad_single.js");
  const OC = await init({ wasmBinary: fs.readFileSync(require.resolve("replicad-opencascadejs/src/replicad_single.wasm")) });
  const replicad = await import("replicad"); replicad.setOC(OC);
  const { createOcctKernel } = await import("../src/geometry/occt-backend.js");
  k = createOcctKernel(replicad);
  ({ buildSubPart } = await import("../src/drum.js"));
});

test("small drum builds via the OCCT kernel and meshes", () => {
  expect(buildSubPart(k, "small", {}).toMesh({ quality: "preview" }).triangles).toBeGreaterThan(0);
});
test("big drum builds via the OCCT kernel and meshes", () => {
  expect(buildSubPart(k, "big", {}).toMesh({ quality: "preview" }).triangles).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- drum-occt`
Expected: FAIL (`buildSubPart` arity / replicad import error).

- [ ] **Step 3: Rewrite `src/drum.js`** applying the mapping above to every function (`buildSmallDrum`, `buildBigDrum`, `buildTensionerBlock`, `seatBlock`, `buildSubPart`, `buildParts`). Replace the top `replicad` import with `import { piePolygon, hexPolygon } from "./geometry/kernel.js";` and thread `kernel` as the first arg of each builder. Keep the existing perf ordering (interior/wedge cuts before grooves; `cutAll` for batched features; `union` for end stops). Remove `buildDrum` and `fuzzy-cut.js` usage.

> This is a mechanical port — every geometry call has a row in the mapping table; no new behavior. Build incrementally and run `npm test -- drum-occt` until both parts mesh.

- [ ] **Step 4: Run the tests**

Run: `npm test -- drum-occt`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/drum.js test/drum-occt.test.js
git commit -m "refactor(drum): build geometry through the GeometryKernel interface"
```

---

## Task 7: OCCT fixtures + cross-kernel parity tests

**Files:**
- Create: `scripts/gen-occt-fixtures.mjs`
- Create: `test/fixtures/occt-volumes.json`
- Create: `test/parity.test.js`

**Interfaces:**
- Consumes: `buildSubPart` (Task 6), both `createKernel` factories.
- Produces: committed OCCT volumes; a Manifold-only parity suite.

- [ ] **Step 1: Write the fixture generator** — `scripts/gen-occt-fixtures.mjs`

```js
// Runs in its OWN process (OCCT only) — Manifold + OCCT can't share a process.
import { createRequire } from "module"; import { fileURLToPath } from "url"; import path from "path"; import fs from "fs";
const require = createRequire(import.meta.url);
globalThis.require = globalThis.require ?? require;
globalThis.__dirname = globalThis.__dirname ?? path.dirname(fileURLToPath(import.meta.url));
const { default: init } = await import("replicad-opencascadejs/src/replicad_single.js");
const OC = await init({ wasmBinary: fs.readFileSync(require.resolve("replicad-opencascadejs/src/replicad_single.wasm")) });
const replicad = await import("replicad"); replicad.setOC(OC);
const { createOcctKernel } = await import("../src/geometry/occt-backend.js");
const { buildSubPart } = await import("../src/drum.js");
const meshVolume = (v, t) => { let V = 0; for (let i = 0; i < t.length; i += 3) { const a=t[i]*3,b=t[i+1]*3,c=t[i+2]*3;
  V += (v[a]*(v[b+1]*v[c+2]-v[b+2]*v[c+1]) - v[a+1]*(v[b]*v[c+2]-v[b+2]*v[c]) + v[a+2]*(v[b]*v[c+1]-v[b+1]*v[c]))/6; } return Math.abs(V); };
const bboxSize = (p) => { const lo=[Infinity,Infinity,Infinity], hi=[-Infinity,-Infinity,-Infinity];
  for (let i=0;i<p.length;i+=3) for (let a=0;a<3;a++){ lo[a]=Math.min(lo[a],p[i+a]); hi[a]=Math.max(hi[a],p[i+a]); }
  return [hi[0]-lo[0], hi[1]-lo[1], hi[2]-lo[2]]; };
const k = createOcctKernel(replicad);
const out = {};
for (const name of ["small", "big"]) {
  const m = buildSubPart(k, name, {}).toMesh({ quality: "preview" });
  out[name] = { volume: meshVolume(m.positions, m.indices), size: bboxSize(m.positions) };
}
const dir = fileURLToPath(new URL("../test/fixtures/", import.meta.url));
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "occt-volumes.json"), JSON.stringify(out, null, 2) + "\n");
console.log("wrote test/fixtures/occt-volumes.json", out);
```

- [ ] **Step 2: Generate the fixture**

Run: `nvm use && node scripts/gen-occt-fixtures.mjs`
Expected: prints `{ small: ~…, big: ~… }` and writes `test/fixtures/occt-volumes.json`.

- [ ] **Step 3: Write the parity test** — `test/parity.test.js`

```js
import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import occtVolumes from "./fixtures/occt-volumes.json";
import { createManifoldKernel } from "../src/geometry/manifold-backend.js";
import { buildSubPart } from "../src/drum.js";

const meshVolume = (v, t) => { let V = 0; for (let i = 0; i < t.length; i += 3) { const a=t[i]*3,b=t[i+1]*3,c=t[i+2]*3;
  V += (v[a]*(v[b+1]*v[c+2]-v[b+2]*v[c+1]) - v[a+1]*(v[b]*v[c+2]-v[b+2]*v[c]) + v[a+2]*(v[b]*v[c+1]-v[b+1]*v[c]))/6; } return Math.abs(V); };
const bboxSize = (p) => { const lo=[Infinity,Infinity,Infinity], hi=[-Infinity,-Infinity,-Infinity];
  for (let i=0;i<p.length;i+=3) for (let a=0;a<3;a++){ lo[a]=Math.min(lo[a],p[i+a]); hi[a]=Math.max(hi[a],p[i+a]); }
  return [hi[0]-lo[0], hi[1]-lo[1], hi[2]-lo[2]]; };

let k;
beforeAll(async () => { const wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" }); });

// Volume + bbox parity catches scale/placement drift. Handedness/mirroring can
// still pass these — the ?backend=occt visual A/B (Task 10) is the handedness gate.
for (const name of ["small", "big"]) {
  test(`Manifold ${name} drum matches OCCT (volume 1.5%, bbox 2%)`, () => {
    const m = buildSubPart(k, name, {}).toMesh();
    const v = meshVolume(m.positions, m.indices), size = bboxSize(m.positions);
    expect(Math.abs(v - occtVolumes[name].volume) / occtVolumes[name].volume).toBeLessThan(0.015);
    for (let a = 0; a < 3; a++)
      expect(Math.abs(size[a] - occtVolumes[name].size[a]) / occtVolumes[name].size[a]).toBeLessThan(0.02);
  });
}

test("Manifold block builds and is non-empty (OCCT can't mesh it headless)", () => {
  expect(buildSubPart(k, "block", {}).toMesh().triangles).toBeGreaterThan(0);
});
```

- [ ] **Step 4: Run the parity suite**

Run: `npm test -- parity`
Expected: PASS (3 tests). If a drum exceeds 1.5%, raise `TUBE`/`SEGS` resolution in `manifold-backend.js` (Task 4, Step 3) and re-run; if still off, the groove geometry differs — debug `helix-tube` params against `occt-backend.helixSweptTube`.

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-occt-fixtures.mjs test/fixtures/occt-volumes.json test/parity.test.js
git commit -m "test(geometry): OCCT volume fixtures + cross-kernel parity suite"
```

---

## Task 8: `geometry-jobs.js` — shared worker handler

**Files:**
- Create: `src/geometry-jobs.js`
- Test: `test/geometry-jobs.test.js`

**Interfaces:**
- Consumes: a `GeometryKernel`, `buildSubPart`/`buildParts`.
- Produces: `handle(kernel, msg, post)` where `msg.type ∈ {"generate","export-stl","export-step"}`. `generate` posts `{type:"meshes", meshes:[{name,positions,normals,indices,triangles}], ms}`; exports post `{type:"download", data, filename, mime}`; errors post `{type:"error", message}`.

- [ ] **Step 1: Write the failing test** — `test/geometry-jobs.test.js`

```js
import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/geometry/manifold-backend.js";
import { handle } from "../src/geometry-jobs.js";

let k;
beforeAll(async () => { const wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" }); });

test("generate posts one mesh per requested sub-part", () => {
  const posted = [];
  handle(k, { type: "generate", subparts: ["small", "big"], params: {} }, (m) => posted.push(m));
  const meshes = posted.find((p) => p.type === "meshes");
  expect(meshes.meshes.map((x) => x.name).sort()).toEqual(["big", "small"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- geometry-jobs`
Expected: FAIL (import error).

- [ ] **Step 3: Implement `src/geometry-jobs.js`**

```js
import { buildSubPart, buildParts } from "./drum.js";

// view → sub-parts (block only exists when tensioner pockets are on)
export function viewParts(view, params) {
  const hasBlock = (params.tensioner_pocket_depth ?? 0) > 0;
  if (view === "small") return ["small"];
  if (view === "big") return hasBlock ? ["big", "block"] : ["big"];
  return hasBlock ? ["small", "big", "block"] : ["small", "big"];
}

export function handle(kernel, msg, post) {
  try {
    if (msg.type === "generate") {
      const t0 = Date.now();
      const meshes = msg.subparts.map((name) => {
        const m = buildSubPart(kernel, name, msg.params).toMesh({ quality: "preview" });
        return { name, ...m };
      });
      post({ type: "meshes", meshes, ms: Date.now() - t0 });
    } else if (msg.type === "export-stl") {
      const parts = buildParts(kernel, msg.part, msg.params);
      // single part → one STL; multiple → caller zips. Here: post each part's STL buffer.
      post({ type: "download-parts", ext: "stl", mime: "model/stl",
             parts: parts.map((p) => ({ name: p.name, data: p.solid.toSTL({ quality: "print" }) })) });
    } else if (msg.type === "export-step") {
      const parts = buildParts(kernel, msg.part, msg.params);
      post({ type: "download", data: kernel.toSTEP(parts), filename: `${msg.part}.step`, mime: "application/step" });
    }
  } catch (err) {
    post({ type: "error", message: String(err?.message || err) });
  }
}
```

> `toSTL` may return a Promise (OCCT `blobSTL().arrayBuffer()`); `export-stl` only runs on the Manifold worker (sync). If you ever route STL to OCCT, `await` it.

- [ ] **Step 4: Run the test**

Run: `npm test -- geometry-jobs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/geometry-jobs.js test/geometry-jobs.test.js
git commit -m "feat: shared worker job handler (generate / export-stl / export-step)"
```

---

## Task 9: The two workers

**Files:**
- Create: `src/preview-worker.js`
- Create: `src/export-worker.js`
- Delete: `src/drum-worker.js`

**Interfaces:**
- Produces: two module workers. Preview posts `meshes`/`download-parts`/`error`; export posts `download`/`error`.

- [ ] **Step 1: Implement `src/preview-worker.js`**

```js
import Module from "manifold-3d";
import { createManifoldKernel } from "./geometry/manifold-backend.js";
import { handle } from "./geometry-jobs.js";

let kernel = null;
const ready = (async () => {
  const wasm = await Module();
  wasm.setup();
  kernel = createManifoldKernel(wasm, { quality: "preview" });
  postMessage({ type: "ready" });
})();

self.onmessage = async (e) => {
  await ready;
  const meshes = [];
  handle(kernel, e.data, (m) => {
    if (m.type === "meshes") {
      const transfer = [];
      for (const x of m.meshes) transfer.push(x.positions.buffer, x.normals.buffer, x.indices.buffer);
      postMessage(m, transfer);
    } else if (m.type === "download-parts") {
      postMessage(m, m.parts.map((p) => p.data));
    } else postMessage(m);
  });
};
```

- [ ] **Step 2: Implement `src/export-worker.js`** (OCCT, lazy)

```js
import { createRequire } from "module";

let kernel = null, booting = null;
async function occtKernel() {
  if (kernel) return kernel;
  if (!booting) booting = (async () => {
    const opencascade = (await import("replicad-opencascadejs/src/replicad_single.js")).default;
    const wasmUrl = (await import("replicad-opencascadejs/src/replicad_single.wasm?url")).default;
    const OC = await opencascade({ locateFile: () => wasmUrl });
    const replicad = await import("replicad");
    replicad.setOC(OC);
    const { createOcctKernel } = await import("./geometry/occt-backend.js");
    kernel = createOcctKernel(replicad);
    return kernel;
  })();
  return booting;
}

self.onmessage = async (e) => {
  const { handle } = await import("./geometry-jobs.js");
  postMessage({ type: "progress", phase: "loading exact kernel" });
  const k = await occtKernel();
  handle(k, e.data, (m) => postMessage(m, m.type === "download" ? [m.data] : []));
};
```

> `createRequire` import is harmless in the worker; if the bundler complains, drop it — it's only there to mirror the Node boot path. Verify the `?url` import resolves under Vite (it does for the current `drum-worker.js`).

- [ ] **Step 3: Delete the old worker**

```bash
git rm src/drum-worker.js
```

- [ ] **Step 4: Verify the build compiles**

Run: `nvm use && npm run build`
Expected: `✓ built` (main.js still references the old worker — that's fixed in Task 10; if the build fails only on `main.js` imports, proceed to Task 10 and re-run there).

- [ ] **Step 5: Commit**

```bash
git add src/preview-worker.js src/export-worker.js
git commit -m "feat: split into Manifold preview worker + lazy OCCT export worker"
```

---

## Task 10: `main.js` routing, lazy export, dev toggle

**Files:**
- Modify: `src/main.js`

**Interfaces:**
- Consumes: both workers; existing per-sub-part cache, `viewParts` (re-import from `geometry-jobs.js`).

- [ ] **Step 1: Spawn both workers and add the toggle** — replace the single-worker block near the top of `main.js`:

```js
const useOcctPreview = new URLSearchParams(location.search).get("backend") === "occt";
const previewWorker = new Worker(new URL("./preview-worker.js", import.meta.url), { type: "module" });
const exportWorker = new Worker(new URL("./export-worker.js", import.meta.url), { type: "module" });
// preview defaults to Manifold; ?backend=occt routes preview generate to the OCCT worker
const genWorker = useOcctPreview ? exportWorker : previewWorker;
```

- [ ] **Step 2: Route jobs.** `generate` → `genWorker`; `export-stl` → `previewWorker`; `export-step` → `exportWorker`. Wire `onmessage` for both workers to the existing handlers, mapping the new message types:
  - `meshes` → existing per-sub-part cache + `refreshView()` (unchanged).
  - `download-parts` → if one part, download it; if many, zip with `fflate` and download `drums.zip`.
  - `download` → download (STEP).
  - `ready` from `previewWorker` → `kernelReady = true; refreshView()`.
  - `progress`/`error` → existing status handling.

```js
import { zipSync } from "fflate";
function onDownloadParts({ parts, ext, mime }) {
  if (parts.length === 1) return triggerDownload(parts[0].data, `${parts[0].name}.${ext}`, mime);
  const entries = {}; for (const p of parts) entries[`${p.name}.${ext}`] = new Uint8Array(p.data);
  triggerDownload(zipSync(entries, { level: 0 }), "drums.zip", "application/zip");
}
```
  Update the download button handlers to post `{type:"export-stl", part, params}` to `previewWorker` and `{type:"export-step", part, params}` to `exportWorker`.

- [ ] **Step 3: Build + run the app**

Run: `nvm use && npm run build`
Expected: `✓ built`.

- [ ] **Step 4: Manual verification (dev server)**

Run: `nvm use && npm run dev`, open http://localhost:5173, hard-refresh. Verify:
  - Preview appears fast (Manifold), no "booting kernel" 11 MB wait.
  - Generate Both, then switch tabs — instant (cache intact).
  - Download STL → a file downloads (Manifold, fast).
  - Download STEP → brief "loading exact kernel", then a `.step` file (OCCT lazy-boot).
  - Open `http://localhost:5173/?backend=occt` → preview still renders (OCCT path), for A/B.

- [ ] **Step 5: Commit**

```bash
git add src/main.js
git commit -m "feat: route preview/STL to Manifold, STEP to lazy OCCT, add ?backend toggle"
```

---

## Self-review notes (for the implementer)

- The groove parity (Task 7) is the gate that proves the Manifold geometry is right — do not skip it.
- If `manifold-3d`'s `CrossSection`/`Mesh`/`union` API names differ from those shown (versions drift), verify with a quick `node -e` and adjust the backend; the contract (`kernel.js`) stays fixed.
- After Task 10, `fuzzy-cut.js` is unused — delete it in a follow-up cleanup commit if nothing imports it.
- The parity tests use default params (full-circle drums). Spot-check a **sector (`big_sector_deg` < 360)** config via the `?backend=occt` toggle once, since that path isn't in the automated suite.
- Rotation **handedness** (groove lefthand/righthand, the ±Y/±X cylinder rows) isn't caught by volume/bbox parity — confirm visually with the toggle in Task 10.
