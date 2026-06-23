# Render + Measure Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two pure-Node CLI tools in the `partforge` package — `partforge measure` and `partforge render` — so a part author (human or LLM) can verify a part headlessly: report geometric facts and produce canonical-angle PNGs.

**Architecture:** A shared `buildView` core builds a view's sub-parts in Node with the Manifold kernel and returns live solids + copied-out meshes. `measure` reads facts off those (bbox, volume, area, triangles, watertight, holes) plus the existing overlap check. `render` draws the meshes with three.js on a headless-gl context and writes PNGs. A single `partforge` bin dispatches both subcommands; the functions are also exported from `partforge/testing`.

**Tech Stack:** Node 24, Manifold (`manifold-3d`), three.js, headless-gl (`gl`), `pngjs`, Vitest.

## Global Constraints

- **Node 24** (`.nvmrc` = 24.16.0). Run `nvm use` first; the default shell Node is too old and fails. Tests: `npx vitest run`.
- **Units are millimetres**; volume may be displayed in cm³ (mm³ ÷ 1000), area in cm² (mm² ÷ 100).
- **Manifold and OCCT must never boot in the same process.** Every file here is Manifold-only. Never import the OCCT kernel.
- **Manifold WASM objects are not garbage-collected** — they are freed via the kernel's `cleanup()`. Read all exact solid facts (`volume()`, `genus()`, `isEmpty()`) BEFORE any `cleanup()`. Meshes from `toMesh()` are copied into JS-owned arrays and survive cleanup.
- **Part modules are DOM-free**; import them directly. Geometry helpers come from `partforge/geometry`, never the `partforge` main barrel (it pulls in the DOM viewer and crashes in Node).
- **Test boot pattern** (mirror existing tests): `const wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" });` inside `beforeAll`.
- **Every commit message ends with this two-line footer** (use a `git commit -F - <<'EOF' … EOF` heredoc to include it):
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1
  ```
- Work happens on the existing `render-measure-harness` branch.

---

### Task 1: headless-gl spike gate (BLOCKING — do this first)

`gl` is a native module that has historically lagged on new Node / Apple Silicon, and the target is Node 24 / macOS. Before building any render code, prove `gl` + `pngjs` install and produce real pixels on this machine. This task is a throwaway spike; only the dependency additions are committed.

**If the spike fails (gl will not build/run): STOP and escalate to the human.** The documented fallback is a pure-JS software rasterizer behind the same `render.js` interface (Task 5) — do not start that without confirming the decision.

**Files:**
- Create (throwaway, deleted before commit): `scripts/spike-gl.mjs`
- Modify: `package.json` (add `gl`, `pngjs` to `dependencies`)

- [ ] **Step 1: Install the native deps**

Run: `nvm use && npm install gl pngjs`
Expected: installs without a build error. If `gl` fails to compile on Node 24 / macOS, STOP (see escalation note above).

- [ ] **Step 2: Write the spike script**

Create `scripts/spike-gl.mjs`:

```js
// THROWAWAY spike: prove headless-gl builds and draws real pixels on this machine.
import createGL from "gl";
import { PNG } from "pngjs";
import { writeFileSync } from "node:fs";

const W = 64, H = 64;
const gl = createGL(W, H, { preserveDrawingBuffer: true });
if (!gl) { console.error("FAIL: gl context is null — headless-gl did not initialize"); process.exit(1); }

gl.clearColor(0.1, 0.1, 0.1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
const vs = gl.createShader(gl.VERTEX_SHADER);
gl.shaderSource(vs, "attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }"); gl.compileShader(vs);
const fs = gl.createShader(gl.FRAGMENT_SHADER);
gl.shaderSource(fs, "void main(){ gl_FragColor = vec4(0.6, 0.7, 0.8, 1.0); }"); gl.compileShader(fs);
const prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog); gl.useProgram(prog);
const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.7, -0.7, 0.7, -0.7, 0, 0.7]), gl.STATIC_DRAW);
const loc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
gl.drawArrays(gl.TRIANGLES, 0, 3);

const px = new Uint8Array(W * H * 4);
gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
const png = new PNG({ width: W, height: H }); png.data = Buffer.from(px);
writeFileSync("spike-gl.png", PNG.sync.write(png));

let hit = 0;
for (let i = 0; i < px.length; i += 4) if (px[i] > 120 && px[i + 2] > 180) hit++;
console.log(hit > 50 ? `OK: headless-gl rendered (${hit} triangle pixels), wrote spike-gl.png` : "FAIL: no triangle pixels drawn");
process.exit(hit > 50 ? 0 : 1);
```

- [ ] **Step 3: Run the spike**

Run: `node scripts/spike-gl.mjs`
Expected: prints `OK: headless-gl rendered (… triangle pixels) …` and exits 0. If it prints FAIL or throws, STOP and escalate.

- [ ] **Step 4: Clean up the throwaway artifacts**

Run: `rm scripts/spike-gl.mjs spike-gl.png`
Expected: only the `package.json` / `package-lock.json` dependency changes remain.

- [ ] **Step 5: Commit the dependency additions**

```bash
git add package.json package-lock.json
git commit -F - <<'EOF'
build: add gl + pngjs deps for headless rendering

Verified headless-gl builds and renders real pixels on Node 24 / macOS via a
throwaway spike (not committed).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1
EOF
```

---

### Task 2: `buildView` shared core

The single definition of "build a view's sub-parts headlessly." Mirrors the `generate` branch of `src/framework/jobs.js`, but keeps solids **live** (no `cleanup()`), so callers can read exact solid facts.

**Files:**
- Create: `src/testing/build.js`
- Test: `test/build.test.js`

**Interfaces:**
- Consumes: `viewSubParts` from `src/framework/jobs.js`; a Manifold kernel from `createManifoldKernel`.
- Produces: `buildView(kernel, part, view, params = {}) → [{ name, solid, mesh }]` where `solid` is a live Manifold `Solid` and `mesh` is `solid.toMesh()` (`{ positions, normals, triangles, edges }`). Does NOT call `kernel.cleanup()`.

- [ ] **Step 1: Write the failing test**

Create `test/build.test.js`:

```js
import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { buildView } from "../src/testing/build.js";
import part from "../src/parts/demo.js";

let k;
beforeAll(async () => { const wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" }); });

test("buildView returns one live solid + mesh for the demo spacer view", () => {
  const built = buildView(k, part, "spacer");
  expect(built).toHaveLength(1);
  expect(built[0].name).toBe("spacer");
  expect(built[0].mesh.triangles).toBeGreaterThan(0);
  // buildView must NOT cleanup — the solid is still live, so its exact volume reads
  expect(built[0].solid.volume()).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/build.test.js`
Expected: FAIL — cannot resolve `../src/testing/build.js`.

- [ ] **Step 3: Implement `buildView`**

Create `src/testing/build.js`:

```js
import { viewSubParts } from "../framework/jobs.js";

// Build every sub-part of a view in its display (assembly) pose with the given
// Manifold kernel, returning live solids + copied-out meshes. Mirrors the
// `generate` path in jobs.js, but keeps solids LIVE (does NOT call
// kernel.cleanup()) so callers can read exact solid facts (volume/genus/empty)
// before they free the kernel. Meshes are JS-owned arrays and survive cleanup.
export function buildView(kernel, part, view, params = {}) {
  const p = { ...part.defaults, ...params };
  const d = part.derive ? part.derive(p) : {};
  return viewSubParts(part, view, p).map((name) => {
    const sp = part.parts[name];
    let solid = sp.build(kernel, p, d);
    if (sp.place) solid = sp.place(solid, { view, purpose: "display", p, d });
    return { name, solid, mesh: solid.toMesh() };
  });
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/build.test.js`
Expected: PASS, output pristine.

- [ ] **Step 5: Commit**

```bash
git add src/testing/build.js test/build.test.js
git commit -F - <<'EOF'
feat(testing): buildView — headless view builder shared by measure + render

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1
EOF
```

---

### Task 3: measurement primitives (mesh helpers + Manifold facts)

Add the cheap geometry primitives `measure` needs: `bounds` and `meshArea` on the mesh helpers, and `genus`/`isEmpty` read methods on the Manifold `Solid` wrap.

**Files:**
- Modify: `src/testing/mesh.js` (add `bounds`, `meshArea`)
- Modify: `src/framework/geometry/manifold-backend.js` (add `genus`, `isEmpty` to the `wrap` object, ~line 56 after `volume`)
- Test: `test/helpers.test.js` (extend), `test/manifold-backend.test.js` (extend)

**Interfaces:**
- Produces: `bounds(positions) → { min:[x,y,z], max:[x,y,z] }`; `meshArea(positions) → number` (mm², from a non-indexed triangle soup, 9 floats per triangle). On a Manifold `Solid`: `genus() → number`, `isEmpty() → boolean`.

> Note: `genus()` and `isEmpty()` are standard `manifold-3d` methods. If the installed build names them differently, the Step-2 test failure will say so — adjust the pass-throughs to match the actual API (do not change the test's expected values).

- [ ] **Step 1: Write the failing tests**

Append to `test/helpers.test.js`:

```js
import { meshVolume, bboxSize, bounds, meshArea } from "../src/testing/mesh.js";

test("bounds of the unit cube is min [0,0,0] max [1,1,1]", () => {
  const b = bounds(positions);
  expect(b.min).toEqual([0, 0, 0]);
  expect(b.max).toEqual([1, 1, 1]);
});

test("meshArea of a unit right triangle is 0.5", () => {
  // one triangle, non-indexed: 9 floats
  expect(meshArea([0, 0, 0, 1, 0, 0, 0, 1, 0])).toBeCloseTo(0.5, 10);
});
```

(The existing first line of `test/helpers.test.js` already imports `meshVolume, bboxSize`; replace that import line with the combined import above rather than duplicating it.)

Append to `test/manifold-backend.test.js`:

```js
test("genus is 0 for a solid box and 1 for a through-bored tube", () => {
  expect(k.box([0, 0, 0], [10, 10, 10]).genus()).toBe(0);
  const tube = k.cylinder(10, 10, 20).cut(k.cylinder(4, 4, 30).translate([0, 0, -5]));
  expect(tube.genus()).toBe(1);
});

test("isEmpty is false for a real solid", () => {
  expect(k.box([0, 0, 0], [1, 1, 1]).isEmpty()).toBe(false);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run test/helpers.test.js test/manifold-backend.test.js`
Expected: FAIL — `bounds`/`meshArea` undefined; `solid.genus`/`solid.isEmpty` not a function.

- [ ] **Step 3: Implement the mesh helpers**

Append to `src/testing/mesh.js`:

```js
// Axis-aligned bounds of a flat position array (x,y,z per vertex).
export function bounds(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let a = 0; a < 3; a++) {
    const v = positions[i + a];
    if (v < min[a]) min[a] = v;
    if (v > max[a]) max[a] = v;
  }
  return { min, max };
}

// Surface area (mm²) of a non-indexed triangle soup (9 floats per triangle).
export function meshArea(positions) {
  let area = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const ux = positions[i + 3] - positions[i],     uy = positions[i + 4] - positions[i + 1], uz = positions[i + 5] - positions[i + 2];
    const vx = positions[i + 6] - positions[i],     vy = positions[i + 7] - positions[i + 1], vz = positions[i + 8] - positions[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    area += Math.hypot(nx, ny, nz) / 2;
  }
  return area;
}
```

- [ ] **Step 4: Implement the Solid read methods**

In `src/framework/geometry/manifold-backend.js`, inside the `wrap` object, immediately after the `volume: () => m.volume(),` line, add:

```js
    genus: () => m.genus(),
    isEmpty: () => m.isEmpty(),
```

- [ ] **Step 5: Run them and watch them pass**

Run: `npx vitest run test/helpers.test.js test/manifold-backend.test.js`
Expected: PASS, output pristine.

- [ ] **Step 6: Commit**

```bash
git add src/testing/mesh.js src/framework/geometry/manifold-backend.js test/helpers.test.js test/manifold-backend.test.js
git commit -F - <<'EOF'
feat(testing): measurement primitives — mesh bounds/area + Solid genus/isEmpty

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1
EOF
```

---

### Task 4: `measure`

Assemble the report: per-sub-part and aggregate facts plus the overlap check.

**Files:**
- Create: `src/testing/measure.js`
- Modify: `src/testing.js` (export `buildView`, `measure`)
- Test: `test/measure.test.js`

**Interfaces:**
- Consumes: `buildView` (Task 2); `assemblyOverlaps(kernel, part, view, params)` from `src/framework/assembly.js`; `bounds`, `meshArea` (Task 3).
- Produces: `measure(kernel, part, view = firstView, params = {}) → { part, view, subparts[], aggregate, overlaps[], ok }`. Each `subparts` entry: `{ name, bbox:[x,y,z], volume, surfaceArea, triangleCount, watertight, holes }`. `aggregate`: `{ bbox, volume, surfaceArea, triangleCount }`. `ok` = every sub-part watertight AND no overlaps.

> Ordering is load-bearing: read every solid fact from `buildView`'s solids BEFORE calling `assemblyOverlaps`, because `assemblyOverlaps` calls `kernel.cleanup()` at its end, which frees those solids.

- [ ] **Step 1: Write the failing test**

Create `test/measure.test.js`:

```js
import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { measure } from "../src/testing/measure.js";

let k;
beforeAll(async () => { const wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" }); });

const boxPart = {
  meta: { title: "Box", units: "mm" },
  defaults: {},
  parts: { block: { views: ["v"], build: (kk) => kk.box([0, 0, 0], [10, 20, 5]) } },
  views: { v: { label: "V" } },
};
const tubePart = {
  meta: { title: "Tube", units: "mm" },
  defaults: {},
  parts: { tube: { views: ["v"], build: (kk) => kk.cylinder(10, 10, 20).cut(kk.cylinder(4, 4, 30).translate([0, 0, -5])) } },
  views: { v: { label: "V" } },
};

test("measure reports box facts: genus 0, watertight, volume ~1000, bbox ~[10,20,5]", () => {
  const r = measure(k, boxPart, "v");
  expect(r.subparts).toHaveLength(1);
  const s = r.subparts[0];
  expect(s.holes).toBe(0);
  expect(s.watertight).toBe(true);
  expect(s.volume).toBeCloseTo(1000, 0);
  expect(s.bbox[0]).toBeCloseTo(10, 1);
  expect(s.bbox[1]).toBeCloseTo(20, 1);
  expect(s.bbox[2]).toBeCloseTo(5, 1);
  expect(s.surfaceArea).toBeGreaterThan(0);
  expect(s.triangleCount).toBeGreaterThan(0);
  expect(r.overlaps).toEqual([]);
  expect(r.ok).toBe(true);
});

test("measure reports a through-bore tube as genus 1", () => {
  expect(measure(k, tubePart, "v").subparts[0].holes).toBe(1);
});

test("measure aggregate volume equals the single sub-part volume", () => {
  const r = measure(k, boxPart, "v");
  expect(r.aggregate.volume).toBeCloseTo(r.subparts[0].volume, 5);
});

test("measure defaults to the first declared view", () => {
  expect(measure(k, boxPart).view).toBe("v");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/measure.test.js`
Expected: FAIL — cannot resolve `../src/testing/measure.js`.

- [ ] **Step 3: Implement `measure`**

Create `src/testing/measure.js`:

```js
import { buildView } from "./build.js";
import { assemblyOverlaps } from "../framework/assembly.js";
import { bounds, meshArea } from "./mesh.js";

const size = ({ min, max }) => [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
const unionBounds = (list) => list.reduce(
  (acc, b) => ({ min: acc.min.map((v, i) => Math.min(v, b.min[i])), max: acc.max.map((v, i) => Math.max(v, b.max[i])) }),
  { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
);

// Headless geometric report for one view of a part (Manifold-only). Reads exact
// solid facts (volume/genus/emptiness) and mesh facts (bbox/area/triangles), plus
// the assembly overlap check. All solid facts are read BEFORE assemblyOverlaps,
// which frees the shared kernel's objects at its end.
//   → { part, view, subparts[], aggregate, overlaps[], ok }
export function measure(kernel, part, view = Object.keys(part.views)[0], params = {}) {
  const built = buildView(kernel, part, view, params);
  const subBounds = [];
  const subparts = built.map(({ name, solid, mesh }) => {
    const b = bounds(mesh.positions);
    subBounds.push(b);
    return {
      name,
      bbox: size(b),
      volume: solid.volume(),
      surfaceArea: meshArea(mesh.positions),
      triangleCount: mesh.triangles,
      watertight: !solid.isEmpty(),
      holes: solid.genus(),
    };
  });

  // Rebuilds with the same kernel and cleans up at its end — every solid fact
  // above is already read, so this is safe.
  const overlaps = assemblyOverlaps(kernel, part, view, params);
  kernel.cleanup?.();

  const aggregate = {
    bbox: subparts.length ? size(unionBounds(subBounds)) : [0, 0, 0],
    volume: subparts.reduce((a, s) => a + s.volume, 0),
    surfaceArea: subparts.reduce((a, s) => a + s.surfaceArea, 0),
    triangleCount: subparts.reduce((a, s) => a + s.triangleCount, 0),
  };
  return {
    part: part.meta?.title ?? view,
    view,
    subparts,
    aggregate,
    overlaps,
    ok: subparts.every((s) => s.watertight) && overlaps.length === 0,
  };
}
```

- [ ] **Step 4: Export from the testing barrel**

In `src/testing.js`, add these two lines (next to the existing exports):

```js
export { buildView } from "./testing/build.js";
export { measure } from "./testing/measure.js";
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run test/measure.test.js`
Expected: PASS, output pristine.

- [ ] **Step 6: Commit**

```bash
git add src/testing/measure.js src/testing.js test/measure.test.js
git commit -F - <<'EOF'
feat(testing): measure — headless geometric report for a part view

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1
EOF
```

---

### Task 5: `render`

Draw a view's meshes with three.js on a headless-gl context and write canonical-angle PNGs. The native deps (`gl`, `pngjs`) are **lazy-imported inside** the function so that importing `partforge/testing` for `measure` alone never loads the native module.

**Files:**
- Create: `src/testing/render.js`
- Modify: `src/testing.js` (export `renderViews`)
- Test: `test/render.test.js`

**Interfaces:**
- Consumes: `buildView` (Task 2); `three`; lazy `gl`, `pngjs`.
- Produces: `async renderViews(kernel, part, view = firstView, { views = ["iso","front","top"], out = "render", size = [800,600], edges = true, params = {} }) → string[]` (written file paths). Filenames: `<out>/<part-slug>-<view>-<angle>.png`.

> The model is Z-up (parts are modelled Z-up; the in-app viewer rotates them upright). Keep Z-up here and set `camera.up` per angle. Material/lighting mirror `src/framework/viewer.js` (HemisphereLight `0xbfd4ff`/`0x202024` @1.1, DirectionalLight `0xffffff` @1.4 at (8,14,10), `MeshStandardMaterial` color `0x9fb4cc` metalness 0.25 roughness 0.55). If `MeshStandardMaterial` renders blank under headless-gl's WebGL1 context (the Step-2 "part actually rendered" assertion will catch it), switch to `MeshPhongMaterial` with the same color — do not weaken the test.

- [ ] **Step 1: Write the failing test**

Create `test/render.test.js`:

```js
import { beforeAll, afterAll, expect, test } from "vitest";
import { rmSync, existsSync, statSync, readFileSync } from "node:fs";
import Module from "manifold-3d";
import { PNG } from "pngjs";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { renderViews } from "../src/testing/render.js";
import part from "../src/parts/demo.js";

let k;
const OUT = "test/.render-out";
beforeAll(async () => { const wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" }); });
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

test("renderViews writes a valid, non-blank PNG per requested angle", async () => {
  const files = await renderViews(k, part, "spacer", { views: ["iso", "front"], out: OUT, size: [320, 240] });
  expect(files).toHaveLength(2);
  for (const f of files) {
    expect(existsSync(f)).toBe(true);
    expect(statSync(f).size).toBeGreaterThan(0);
    const png = PNG.sync.read(readFileSync(f));
    expect(png.width).toBe(320);
    expect(png.height).toBe(240);
    // the part actually rendered — pixels differ from the scene background
    const bg = [0x15, 0x18, 0x1d];
    let nonBg = 0;
    for (let i = 0; i < png.data.length; i += 4)
      if (Math.abs(png.data[i] - bg[0]) > 8 || Math.abs(png.data[i + 1] - bg[1]) > 8 || Math.abs(png.data[i + 2] - bg[2]) > 8) nonBg++;
    expect(nonBg).toBeGreaterThan(100);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/render.test.js`
Expected: FAIL — cannot resolve `../src/testing/render.js`.

- [ ] **Step 3: Implement `render`**

Create `src/testing/render.js`:

```js
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { buildView } from "./build.js";

// Canonical camera angles. Model is Z-up; `dir` is the camera offset direction
// from the part centre, `up` the camera up vector for that angle.
const ANGLES = {
  iso:   { dir: [1, 1, 1],  up: [0, 0, 1] },
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  top:   { dir: [0, 0, 1],  up: [0, 1, 0] },
};

const slug = (s) => String(s).toLowerCase().replace(/\s+/g, "-");

// Render canonical-angle PNGs of one view of a part. Pure Node: builds meshes
// with the given Manifold kernel, draws them with three.js on a headless-gl
// context, writes one PNG per angle. Returns the written file paths. The native
// deps (gl, pngjs) are lazy-imported so importing this module's barrel for
// measure alone never loads them.
export async function renderViews(kernel, part, view = Object.keys(part.views)[0], {
  views = ["iso", "front", "top"], out = "render", size = [800, 600], edges = true, params = {},
} = {}) {
  const createGL = (await import("gl")).default;
  const { PNG } = await import("pngjs");
  const [W, H] = size;
  const built = buildView(kernel, part, view, params);

  // --- scene (lighting/material mirror src/framework/viewer.js) -------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(part.meta?.background ?? 0x15181d);
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202024, 1.1));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
  keyLight.position.set(8, 14, 10);
  scene.add(keyLight);

  const material = new THREE.MeshStandardMaterial({ color: 0x9fb4cc, metalness: 0.25, roughness: 0.55 });
  const group = new THREE.Group();
  for (const { mesh } of built) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    group.add(new THREE.Mesh(geo, material));
    if (edges && mesh.edges?.length) {
      const eg = new THREE.BufferGeometry();
      eg.setAttribute("position", new THREE.BufferAttribute(mesh.edges, 3));
      group.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x1c232d })));
    }
  }
  scene.add(group);
  kernel.cleanup?.(); // meshes are copied into BufferAttributes; free the WASM solids

  // --- framing -------------------------------------------------------------
  const box = new THREE.Box3().setFromObject(group);
  const center = box.getCenter(new THREE.Vector3());
  const span = box.getSize(new THREE.Vector3());
  const r = Math.max(span.x, span.y, span.z) || 10;
  const half = r * 0.62;             // ortho half-extent with a small margin
  const aspect = W / H;

  // --- headless-gl renderer ------------------------------------------------
  const gl = createGL(W, H, { preserveDrawingBuffer: true });
  const canvas = { width: W, height: H, addEventListener() {}, removeEventListener() {}, getContext: () => gl, style: {} };
  const renderer = new THREE.WebGLRenderer({ context: gl, canvas, antialias: false });
  renderer.setSize(W, H, false);

  mkdirSync(out, { recursive: true });
  const name = slug(part.meta?.title ?? view);
  const written = [];

  for (const angle of views) {
    const a = ANGLES[angle];
    if (!a) throw new Error(`unknown angle "${angle}" (use: ${Object.keys(ANGLES).join(", ")})`);
    const camera = new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, 0.1, r * 100);
    camera.up.set(...a.up);
    camera.position.copy(center).add(new THREE.Vector3(...a.dir).normalize().multiplyScalar(r * 4));
    camera.lookAt(center);
    renderer.render(scene, camera);

    const pixels = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const png = new PNG({ width: W, height: H });
    for (let y = 0; y < H; y++) {           // gl origin is bottom-left; PNG is top-left
      const srcRow = (H - 1 - y) * W * 4;
      png.data.set(pixels.subarray(srcRow, srcRow + W * 4), y * W * 4);
    }
    const file = join(out, `${name}-${view}-${angle}.png`);
    writeFileSync(file, PNG.sync.write(png));
    written.push(file);
  }

  renderer.dispose();
  return written;
}
```

- [ ] **Step 4: Export from the testing barrel**

In `src/testing.js`, add:

```js
export { renderViews } from "./testing/render.js";
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run test/render.test.js`
Expected: PASS — two non-blank 320×240 PNGs. (If blank, apply the `MeshPhongMaterial` fallback noted above and re-run.)

- [ ] **Step 6: Commit**

```bash
git add src/testing/render.js src/testing.js test/render.test.js
git commit -F - <<'EOF'
feat(testing): renderViews — canonical-angle PNGs via three.js + headless-gl

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1
EOF
```

---

### Task 6: `partforge` CLI + packaging

Wire the single `partforge` bin (subcommand dispatch, part loading, kernel boot, output, exit codes) and register it in `package.json`.

**Files:**
- Create: `bin/cli.js`
- Modify: `package.json` (add `bin`; add `"bin"` to `files`)
- Test: `test/cli.test.js`

**Interfaces:**
- Consumes: `measure` (Task 4), `renderViews` (Task 5), `createManifoldKernel`, `manifold-3d`.
- Produces: a CLI — `partforge measure <part-module> [view] [--json]` and `partforge render <part-module> [view] [--views a,b] [--out dir]`. Exit 0 on success (`measure` exits 1 when `!report.ok`); exit 1 on any error.

- [ ] **Step 1: Write the failing test**

Create `test/cli.test.js`:

```js
import { expect, test, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";

const run = (args) => execFileSync("node", ["bin/cli.js", ...args], { encoding: "utf8" });

afterAll(() => {
  rmSync("render", { recursive: true, force: true });
  rmSync("measure-spacer-spacer.json", { force: true });
});

test("CLI measure prints a report, writes JSON, exits 0 for a sound part", () => {
  const out = run(["measure", "src/parts/demo.js"]);
  expect(out).toMatch(/Spacer \/ spacer/);
  expect(out).toMatch(/watertight ✓/);
  expect(existsSync("measure-spacer-spacer.json")).toBe(true);
});

test("CLI render writes a PNG for the requested angle", () => {
  const out = run(["render", "src/parts/demo.js", "spacer", "--views", "iso"]);
  expect(out).toMatch(/wrote render\/spacer-spacer-iso\.png/);
  expect(existsSync("render/spacer-spacer-iso.png")).toBe(true);
});

test("CLI exits non-zero on a bad part path", () => {
  expect(() => run(["measure", "src/parts/does-not-exist.js"])).toThrow();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/cli.test.js`
Expected: FAIL — `bin/cli.js` does not exist (execFileSync throws).

- [ ] **Step 3: Implement the CLI**

Create `bin/cli.js`:

```js
#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { measure } from "../src/testing/measure.js";
import { renderViews } from "../src/testing/render.js";

const die = (msg) => { console.error(msg); process.exit(1); };
const slug = (s) => String(s).toLowerCase().replace(/\s+/g, "-");

const [, , cmd, partPath, ...rest] = process.argv;
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) {
    const key = rest[i].slice(2);
    flags[key] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
  } else positional.push(rest[i]);
}
const view = positional[0];

if (!["measure", "render"].includes(cmd)) die("usage: partforge <measure|render> <part-module> [view] [flags]");
if (!partPath) die(`usage: partforge ${cmd} <part-module> [view]`);

const mod = await import(pathToFileURL(resolve(process.cwd(), partPath)))
  .catch((e) => die(`cannot load part "${partPath}": ${e.message}`));
const part = mod.default;
if (!part?.parts || !part?.views) die(`"${partPath}" has no default-exported PartDefinition`);

const wasm = await Module(); wasm.setup();
const kernel = createManifoldKernel(wasm, { quality: "preview" });

try {
  if (cmd === "measure") {
    const report = measure(kernel, part, view);
    printMeasure(report);
    const file = `measure-${slug(report.part)}-${report.view}.json`;
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${file}`);
    if (flags.json) console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  } else {
    const views = typeof flags.views === "string" ? flags.views.split(",") : undefined;
    const files = await renderViews(kernel, part, view, { views, out: flags.out || "render" });
    for (const f of files) console.log(`wrote ${f}`);
    process.exit(0);
  }
} catch (e) {
  die(`${cmd} failed: ${e.message || e}`);
}

function printMeasure(r) {
  console.log(`${r.part} / ${r.view}`);
  for (const s of r.subparts) {
    console.log(`  ${s.name}  bbox ${s.bbox.map((n) => n.toFixed(1)).join("×")}  ` +
      `vol ${(s.volume / 1000).toFixed(2)}cm³  area ${(s.surfaceArea / 100).toFixed(1)}cm²  ` +
      `tris ${s.triangleCount}  ${s.watertight ? "watertight ✓" : "NOT watertight ✗"}  holes ${s.holes}`);
  }
  const a = r.aggregate;
  console.log(`  ── view  bbox ${a.bbox.map((n) => n.toFixed(1)).join("×")}  vol ${(a.volume / 1000).toFixed(2)}cm³  tris ${a.triangleCount}`);
  console.log(`  overlaps: ${r.overlaps.length ? r.overlaps.map((o) => `${o.a}×${o.b} (${o.volume.toFixed(1)}mm³)`).join(", ") : "none"}`);
}
```

- [ ] **Step 4: Register the bin and ship it**

In `package.json`, add a `"bin"` field (place it right after `"exports"`):

```json
  "bin": {
    "partforge": "./bin/cli.js"
  },
```

and add `"bin"` to the `"files"` array so it's published:

```json
  "files": [
    "src",
    "bin",
    "docs/AUTHORING-PARTS.md",
    "README.md"
  ],
```

- [ ] **Step 5: Make the CLI executable and run the tests**

Run: `chmod +x bin/cli.js && npx vitest run test/cli.test.js`
Expected: PASS — measure prints `Spacer / spacer` + `watertight ✓` and writes JSON; render writes the PNG; the bad path throws.

- [ ] **Step 6: Commit**

```bash
git add bin/cli.js package.json
git commit -F - <<'EOF'
feat(cli): partforge measure|render — shipped verification CLI

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1
EOF
```

---

### Task 7: Author docs

Document the two commands in the authoring guide so a human or LLM finds them.

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (append a section before "Conventions & gotchas")

- [ ] **Step 1: Add the section**

In `docs/AUTHORING-PARTS.md`, immediately before the `## Conventions & gotchas` heading, insert:

```markdown
## Verifying a part headlessly (render + measure)

Once the package is installed you get two CLI commands that build your part in
pure Node (no dev server, no browser) so you — or an LLM authoring the part — can
check it without opening the app:

    npx partforge measure src/parts/<part>.js [view]      # geometric facts
    npx partforge render  src/parts/<part>.js [view]       # canonical-angle PNGs

`measure` prints a report and writes `measure-<part>-<view>.json`: per sub-part
and per view it reports bounding box, volume, surface area, triangle count,
whether the solid is watertight, and the number of through-holes (genus), plus an
assembly overlap check. It exits non-zero if any sub-part isn't watertight or any
parts interpenetrate — so it doubles as a CI/agent gate. (Manifold output is
manifold by construction, so `watertight` is mainly a build-sanity check for
empty/degenerate results; `holes` is the informative topology number.)

`render` writes one PNG per angle (`iso`, `front`, `top` by default; choose with
`--views iso,front`, output dir with `--out`) to `render/`. The view defaults to
the part's first declared view.

The `measure` function is also exported for vitest (boot a Manifold kernel as in
"Testing a part", then `measure(kernel, part, "<view>")`):

    import { measure } from "partforge/testing";
    test("part is sound", () => {
      const r = measure(kernel, part, "<view>");
      expect(r.ok).toBe(true);
      expect(r.subparts[0].holes).toBe(1);   // e.g. expects one bore
    });
```

- [ ] **Step 2: Verify it reads correctly**

Run: `npx vitest run` (full suite — confirm nothing regressed)
Expected: all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/AUTHORING-PARTS.md
git commit -F - <<'EOF'
docs: document the render + measure verification commands

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1
EOF
```

---

## Final verification

After all tasks: `nvm use && npx vitest run` — the whole suite passes (build, measure primitives, measure, render, CLI, plus the pre-existing tests). Then use **superpowers:finishing-a-development-branch** to complete the `render-measure-harness` branch.
