# Automatic Backend Selection + Native Fillet/Chamfer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parts that use `fillet`/`chamfer` are auto-routed to the OCCT backend (native, exact CAD rounding); everything else stays on Manifold (fast) — with no per-part declaration required.

**Architecture:** Native `fillet`/`chamfer` are added to the OCCT (replicad) backend; the Manifold backend throws a `KernelCapabilityError` for them. A geometry-free **probe** runs each part's `build` against a recording kernel to detect which ops it uses and pick the backend; a **capability-error backstop** in the worker reroutes if the probe ever misses. `mount`, the geometry service, and the CLI route per detected backend.

**Tech Stack:** Node 24, Manifold (`manifold-3d`), replicad/OCCT, three.js viewer, Vitest, Playwright (existing `check-app`).

## Global Constraints

- **Node 24** (`.nvmrc` = 24.16.0). Run `nvm use` first (the `nvm` function is in-shell); default Node is v16 and fails. Tests: `npx vitest run`.
- **Units are millimetres.**
- **Manifold and OCCT must never boot in the same process** — they stay in separate workers / separate test files. OCCT tests boot via `bootOcctKernel()` and live in their own files.
- **Manifold WASM objects are freed via `kernel.cleanup()`** (optional-chained; OCCT has none).
- **OCCT-only op set (v1):** `fillet`, `chamfer`. Detection triggers on these.
- **replicad transforms consume their input shape** — never reuse a solid after `cut`/`fillet`/`chamfer`/etc.; build a fresh one. (`volume()` is a query and does not consume.)
- **Part `build(k,p,d)` is pure construction** (DOM-free, side-effect-free) — the probe re-runs it.
- **Every commit message ends with this footer** (use `git commit -F - <<'EOF' … EOF`):
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1
  ```
- Work on the existing `auto-backend-fillet` branch.

---

### Task 1: Capability-error mechanism

Define the error, make the Manifold backend throw it for `fillet`/`chamfer`, and make the job loop translate it into a `needs-occt` signal.

**Files:**
- Create: `src/framework/geometry/errors.js`
- Modify: `src/framework/geometry/manifold-backend.js` (add `fillet`/`chamfer` to the `wrap` object, ~line 64 near `toMesh`)
- Modify: `src/framework/jobs.js` (the `catch` block, ~line 68)
- Test: `test/capability.test.js`

**Interfaces:**
- Produces: `class KernelCapabilityError extends Error` with `this.code = "NEEDS_OCCT"`. On a Manifold `Solid`: `fillet()` and `chamfer()` throw it. `handle(...)` posts `{ type: "needs-occt" }` (instead of `{ type: "error" }`) when a build throws a `NEEDS_OCCT` error.

- [ ] **Step 1: Write the failing test**

Create `test/capability.test.js`:

```js
import { beforeAll, expect, test, vi } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { KernelCapabilityError } from "../src/framework/geometry/errors.js";
import { handle } from "../src/framework/jobs.js";

let k;
beforeAll(async () => { const w = await Module(); w.setup(); k = createManifoldKernel(w, { quality: "preview" }); });

test("Manifold fillet/chamfer throw KernelCapabilityError with code NEEDS_OCCT", () => {
  expect(() => k.box([0, 0, 0], [1, 1, 1]).fillet(0.1)).toThrow(KernelCapabilityError);
  try { k.box([0, 0, 0], [1, 1, 1]).chamfer(0.1); } catch (e) { expect(e.code).toBe("NEEDS_OCCT"); }
});

test("handle() posts needs-occt when a build uses an OCCT-only op on Manifold", async () => {
  const part = {
    defaults: {}, views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (kk) => kk.box([0, 0, 0], [2, 2, 2]).fillet(0.5) } },
  };
  const post = vi.fn();
  await handle(k, part, { type: "generate", subparts: ["a"], view: "v", params: {} }, post);
  expect(post).toHaveBeenCalledWith({ type: "needs-occt" });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/capability.test.js`
Expected: FAIL — cannot resolve `errors.js` / `fillet` is not a function.

- [ ] **Step 3: Create the error class**

Create `src/framework/geometry/errors.js`:

```js
// Thrown by a backend that can't perform a requested op (e.g. Manifold has no
// fillet/chamfer). The framework catches `.code === "NEEDS_OCCT"` and reroutes
// the part to the OCCT backend.
export class KernelCapabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = "KernelCapabilityError";
    this.code = "NEEDS_OCCT";
  }
}
```

- [ ] **Step 4: Make Manifold throw for fillet/chamfer**

In `src/framework/geometry/manifold-backend.js`, add the import at the top (after the existing `helixTube` import):

```js
import { KernelCapabilityError } from "./errors.js";
```

Then inside the `wrap` object, immediately after the `toIndexedMesh: () => indexedMeshOut(m),` line, add:

```js
    fillet: () => { throw new KernelCapabilityError("fillet requires the OCCT backend"); },
    chamfer: () => { throw new KernelCapabilityError("chamfer requires the OCCT backend"); },
```

- [ ] **Step 5: Make handle() translate the error**

In `src/framework/jobs.js`, replace the `catch` block:

```js
  } catch (err) {
    post({ type: "error", message: String(err?.message || err) });
  } finally {
```

with:

```js
  } catch (err) {
    if (err?.code === "NEEDS_OCCT") post({ type: "needs-occt" });
    else post({ type: "error", message: String(err?.message || err) });
  } finally {
```

- [ ] **Step 6: Run it and watch it pass**

Run: `npx vitest run test/capability.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/framework/geometry/errors.js src/framework/geometry/manifold-backend.js src/framework/jobs.js test/capability.test.js
git commit -F - <<'EOF'
feat(geometry): capability-error mechanism for OCCT-only ops

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1
EOF
```

---

### Task 2: Edge selector mapping

A pure function turning a declarative selector into a replicad `EdgeFinder` filter (or `undefined` for all edges, or a passed-through raw function).

**Files:**
- Create: `src/framework/geometry/edge-selector.js`
- Test: `test/edge-selector.test.js`

**Interfaces:**
- Produces: `toEdgeFinder(selector) → undefined | ((e) => e)`. `selector`: `undefined` → `undefined`; a function → returned as-is; an object → a filter that calls `e.inDirection(vec)` for `{dir}` (`"X"|"Y"|"Z"` mapped to a unit vector, or a raw `[x,y,z]`), `e.inPlane(plane, at)` for `{inPlane, at?}`, and `e.containsPoint(point)` for `{near}` (combined in that order).

- [ ] **Step 1: Write the failing test**

Create `test/edge-selector.test.js`:

```js
import { expect, test } from "vitest";
import { toEdgeFinder } from "../src/framework/geometry/edge-selector.js";

// A stand-in EdgeFinder that records the calls and chains.
function mockFinder() {
  const calls = [];
  const f = {
    inDirection(d) { calls.push(["inDirection", d]); return f; },
    inPlane(p, o) { calls.push(["inPlane", p, o]); return f; },
    containsPoint(pt) { calls.push(["containsPoint", pt]); return f; },
  };
  return { f, calls };
}

test("undefined selector → undefined (all edges)", () => {
  expect(toEdgeFinder(undefined)).toBeUndefined();
});

test("a function selector is passed through unchanged", () => {
  const fn = (e) => e;
  expect(toEdgeFinder(fn)).toBe(fn);
});

test("{dir} maps named axis to inDirection(unit vector)", () => {
  const { f, calls } = mockFinder();
  toEdgeFinder({ dir: "Z" })(f);
  expect(calls).toEqual([["inDirection", [0, 0, 1]]]);
});

test("{dir:[..]} passes a raw vector through", () => {
  const { f, calls } = mockFinder();
  toEdgeFinder({ dir: [1, 0, 0] })(f);
  expect(calls).toEqual([["inDirection", [1, 0, 0]]]);
});

test("{inPlane, at} and {near} map to inPlane/containsPoint", () => {
  const { f, calls } = mockFinder();
  toEdgeFinder({ inPlane: "XY", at: 5, near: [1, 2, 3] })(f);
  expect(calls).toEqual([["inPlane", "XY", 5], ["containsPoint", [1, 2, 3]]]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/edge-selector.test.js`
Expected: FAIL — cannot resolve `edge-selector.js`.

- [ ] **Step 3: Implement**

Create `src/framework/geometry/edge-selector.js`:

```js
// Map partforge's declarative edge selector onto a replicad EdgeFinder filter.
//   undefined          → undefined (all edges)
//   (e) => e...         → passed through (raw replicad finder escape hatch)
//   { dir, inPlane, at, near } → a filter applying the given criteria (AND)
const AXIS = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

export function toEdgeFinder(selector) {
  if (selector == null) return undefined;
  if (typeof selector === "function") return selector;
  return (e) => {
    let f = e;
    if (selector.dir != null) f = f.inDirection(Array.isArray(selector.dir) ? selector.dir : AXIS[selector.dir]);
    if (selector.inPlane != null) f = f.inPlane(selector.inPlane, selector.at);
    if (selector.near != null) f = f.containsPoint(selector.near);
    return f;
  };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/edge-selector.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/edge-selector.js test/edge-selector.test.js
git commit -F - <<'EOF'
feat(geometry): declarative edge-selector → replicad EdgeFinder mapping

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1
EOF
```

---

### Task 3: OCCT backend — fillet, chamfer, volume, indexed mesh

Add the native CAD ops and the two missing mesh/measure methods to the replicad backend.

**Files:**
- Modify: `src/framework/geometry/occt-backend.js`
- Test: `test/occt-fillet.test.js`

**Interfaces:**
- Consumes: `toEdgeFinder` (Task 2); replicad's `measureVolume`.
- Produces: on an OCCT `Solid`: `fillet(radius, selector?)`, `chamfer(distance, selector?)`, `volume() → number`, `toIndexedMesh() → { positions: Float32Array, indices: Uint32Array }`.

- [ ] **Step 1: Write the failing test**

Create `test/occt-fillet.test.js`:

```js
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

test("volume() returns the solid volume", () => {
  expect(k.box([0, 0, 0], [10, 10, 10]).volume()).toBeCloseTo(1000, 0);
});

test("fillet removes a little volume and still meshes", () => {
  const sharp = k.box([0, 0, 0], [20, 20, 20]).volume();          // 8000
  const filleted = k.box([0, 0, 0], [20, 20, 20]).fillet(2, { dir: "Z" });
  const v = filleted.volume();
  expect(v).toBeLessThan(sharp);
  expect(v).toBeGreaterThan(7000);                                // only 4 edges rounded
  expect(filleted.toMesh().triangles).toBeGreaterThan(0);
});

test("selecting all edges removes more than selecting only vertical edges", () => {
  const vertical = k.box([0, 0, 0], [20, 20, 20]).fillet(2, { dir: "Z" }).volume();
  const all = k.box([0, 0, 0], [20, 20, 20]).fillet(2).volume();
  expect(all).toBeLessThan(vertical);
});

test("chamfer removes volume", () => {
  expect(k.box([0, 0, 0], [20, 20, 20]).chamfer(2).volume()).toBeLessThan(8000);
});

test("toIndexedMesh returns positions and indices", () => {
  const m = k.box([0, 0, 0], [5, 5, 5]).toIndexedMesh();
  expect(m.positions.length).toBeGreaterThan(0);
  expect(m.indices.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/occt-fillet.test.js`
Expected: FAIL — `volume`/`fillet`/`chamfer`/`toIndexedMesh` not a function.

- [ ] **Step 3: Implement**

In `src/framework/geometry/occt-backend.js`, add the import at the top:

```js
import { toEdgeFinder } from "./edge-selector.js";
```

Add `measureVolume` to the destructured replicad API (the `const { … } = replicad;` line near the top of `createOcctKernel`):

```js
  const { makeCylinder, makeBox, makeCircle, makeHelix, assembleWire, genericSweep,
          makeCompound, loft, draw, exportSTEP, measureVolume } = replicad;
```

Then inside the `wrap` object, after the `toSTL:` line, add:

```js
    fillet: (radius, selector) => wrap(shape.fillet(radius, toEdgeFinder(selector))),
    chamfer: (distance, selector) => wrap(shape.chamfer(distance, toEdgeFinder(selector))),
    volume: () => measureVolume(shape),
    toIndexedMesh: () => {
      const m = shape.mesh(MESH.preview);
      return { positions: Float32Array.from(m.vertices), indices: Uint32Array.from(m.triangles) };
    },
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/occt-fillet.test.js`
Expected: PASS (first run boots OCCT — a few seconds is normal).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/occt-backend.js test/occt-fillet.test.js
git commit -F - <<'EOF'
feat(geometry): OCCT native fillet/chamfer + volume/toIndexedMesh

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1
EOF
```

---

### Task 4: Backend probe + detection

A geometry-free recording kernel and the `detectBackend` function.

**Files:**
- Create: `src/framework/geometry/probe.js`
- Test: `test/probe.test.js`

**Interfaces:**
- Produces: `OCCT_ONLY` (a `Set` = `{"fillet","chamfer"}`); `createProbeKernel() → { kernel, used }` (a recording kernel + the `Set` of op names invoked); `detectBackend(part, params = {}) → "occt" | "manifold"` (honors `part.meta.backend`, else probes every sub-part's `build` with `{...defaults, ...params}` and returns `"occt"` iff an `OCCT_ONLY` op was used).

- [ ] **Step 1: Write the failing test**

Create `test/probe.test.js`:

```js
import { expect, test } from "vitest";
import { detectBackend } from "../src/framework/geometry/probe.js";

const view = { v: { label: "V" } };
const plain = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) => k.box([0, 0, 0], [1, 1, 1]) } } };
const fillets = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) => k.box([0, 0, 0], [1, 1, 1]).fillet(0.1) } } };
const conditional = {
  defaults: { round: 0 }, views: view,
  parts: { a: { views: ["v"], build: (k, p) => p.round > 0 ? k.box([0, 0, 0], [1, 1, 1]).fillet(p.round) : k.box([0, 0, 0], [1, 1, 1]) } },
};

test("a part using fillet routes to occt", () => { expect(detectBackend(fillets)).toBe("occt"); });
test("a plain part routes to manifold", () => { expect(detectBackend(plain)).toBe("manifold"); });
test("meta.backend overrides detection", () => { expect(detectBackend({ ...plain, meta: { backend: "occt" } })).toBe("occt"); });
test("a conditional fillet is detected only when its param enables it", () => {
  expect(detectBackend(conditional)).toBe("manifold");
  expect(detectBackend(conditional, { round: 1 })).toBe("occt");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/probe.test.js`
Expected: FAIL — cannot resolve `probe.js`.

- [ ] **Step 3: Implement**

Create `src/framework/geometry/probe.js`:

```js
// Geometry-free backend detection. A probe kernel records every op a part's
// build() invokes (returning chainable no-op proxies, dummy values for queries);
// if an OCCT-only op was used, the part needs the OCCT backend.
export const OCCT_ONLY = new Set(["fillet", "chamfer"]);

export function createProbeKernel() {
  const used = new Set();
  const note = (name) => used.add(name);
  const proxy = {
    cut() { note("cut"); return proxy; },
    cutAll() { note("cutAll"); return proxy; },
    intersect() { note("intersect"); return proxy; },
    translate() { note("translate"); return proxy; },
    rotate() { note("rotate"); return proxy; },
    mirror() { note("mirror"); return proxy; },
    fillet() { note("fillet"); return proxy; },
    chamfer() { note("chamfer"); return proxy; },
    volume() { note("volume"); return 1; },
    toMesh() { note("toMesh"); return { positions: new Float32Array(9), normals: new Float32Array(9), triangles: 1, edges: new Float32Array(0) }; },
    toSTL() { note("toSTL"); return new ArrayBuffer(0); },
    toIndexedMesh() { note("toIndexedMesh"); return { positions: new Float32Array(9), indices: new Uint32Array(3) }; },
  };
  const kernel = {
    cylinder() { note("cylinder"); return proxy; },
    box() { note("box"); return proxy; },
    prism() { note("prism"); return proxy; },
    helixSweptTube() { note("helixSweptTube"); return proxy; },
    union() { note("union"); return proxy; },
    toSTEP() { note("toSTEP"); return Promise.resolve(new ArrayBuffer(0)); },
    cleanup() {},
  };
  return { kernel, used };
}

export function detectBackend(part, params = {}) {
  if (part.meta?.backend) return part.meta.backend;
  const p = { ...part.defaults, ...params };
  const d = part.derive ? part.derive(p) : {};
  const { kernel, used } = createProbeKernel();
  for (const name of Object.keys(part.parts)) {
    try { part.parts[name].build(kernel, p, d); } catch { /* probe miss → capability backstop covers it */ }
  }
  for (const op of used) if (OCCT_ONLY.has(op)) return "occt";
  return "manifold";
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/probe.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/probe.js test/probe.test.js
git commit -F - <<'EOF'
feat(geometry): backend probe + detectBackend

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1
EOF
```

---

### Task 5: Filleted-box example part + app glue

A worked example that uses `fillet` + `chamfer` (so it auto-routes to OCCT) and a runnable dev app for it.

**Files:**
- Create: `src/parts/filleted-box.js`
- Create: `src/app-filleted-box.js`
- Create: `src/filleted-box-worker.js`
- Create: `filleted-box.html`
- Test: `test/filleted-box.test.js`

**Interfaces:**
- Consumes: the OCCT `fillet`/`chamfer` (Task 3).
- Produces: a default-exported `PartDefinition` (`meta.title = "Filleted Box"`, one view `box`, one sub-part `body`) whose build fillets the vertical edges and chamfers the base edges.

- [ ] **Step 1: Write the failing test**

Create `test/filleted-box.test.js`:

```js
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { buildView } from "../src/testing/build.js";
import part from "../src/parts/filleted-box.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

test("filleted-box builds on OCCT and is smaller than the raw box", () => {
  const built = buildView(k, part, "box", {});
  expect(built).toHaveLength(1);
  const p = part.defaults;
  const rawBox = p.w * p.d * p.h;
  expect(built[0].solid.volume()).toBeLessThan(rawBox);   // fillet + bore removed material (chamfer off by default)
  expect(built[0].mesh.triangles).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/filleted-box.test.js`
Expected: FAIL — cannot resolve `filleted-box.js`.

- [ ] **Step 3: Create the part**

Create `src/parts/filleted-box.js`:

```js
// Example part exercising native CAD ops — it auto-routes to the OCCT backend
// because it uses fillet (and chamfer when enabled). Vertical edges are rounded
// and an optional bore drilled; the base chamfer is off by default (turn it up to
// try chamfering, kept off in defaults so the gating build uses only the fillet).
export default {
  meta: { title: "Filleted Box", units: "mm", background: 0x15181d },
  parameters: [
    {
      id: "box", title: "Box",
      advanced: [
        { key: "w", label: "Width", unit: "mm", min: 10, max: 80, step: 1 },
        { key: "d", label: "Depth", unit: "mm", min: 10, max: 80, step: 1 },
        { key: "h", label: "Height", unit: "mm", min: 5, max: 40, step: 1 },
        { key: "fillet", label: "Edge fillet", unit: "mm", min: 0, max: 10, step: 0.5 },
        { key: "chamfer", label: "Base chamfer", unit: "mm", min: 0, max: 5, step: 0.5 },
        { key: "bore", label: "Bore", unit: "mm", min: 0, max: 24, step: 0.5 },
      ],
    },
  ],
  defaults: { w: 40, d: 30, h: 16, fillet: 3, chamfer: 0, bore: 8 },
  parts: {
    body: {
      label: "Body",
      views: ["box"],
      build: (k, p) => {
        let s = k.box([0, 0, 0], [p.w, p.d, p.h]);
        if (p.fillet > 0) s = s.fillet(p.fillet, { dir: "Z" });          // 4 vertical edges
        if (p.chamfer > 0) s = s.chamfer(p.chamfer, { inPlane: "XY", at: 0 }); // base edges
        if (p.bore > 0) s = s.cut(k.cylinder(p.bore / 2, p.bore / 2, p.h + 2).translate([p.w / 2, p.d / 2, -1]));
        return s;
      },
    },
  },
  views: { box: { label: "Box" } },
};
```

- [ ] **Step 4: Create the app glue**

Create `src/app-filleted-box.js`:

```js
import part from "./parts/filleted-box.js";
import { mount } from "./framework/index.js";

mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./filleted-box-worker.js", import.meta.url), { type: "module", name }),
});
```

Create `src/filleted-box-worker.js`:

```js
import part from "./parts/filleted-box.js";
import { runWorker } from "./framework/worker.js";
runWorker(part);
```

Create `filleted-box.html` (copy of `demo.html` structure, repointed). Its element IDs must match what `mount` looks up:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Filleted Box — native fillet/chamfer (OCCT)</title>
  </head>
  <body>
    <div id="app"></div>
    <div id="topbar">
      <div class="seg" id="part"><button data-part="box" class="on">Box</button></div>
    </div>
    <div id="viewbar">
      <button id="pause" title="Pause rotation">⏸</button>
      <button id="reframe" title="Reframe">⛶</button>
      <button id="theme" title="Toggle light/dark">◐</button>
    </div>
    <div id="panel">
      <h1>Filleted Box</h1>
      <p class="sub">Native fillet/chamfer · auto-routes to OCCT</p>
      <div id="controls"></div>
      <div class="dl">
        <div class="dl-head">Download</div>
        <div class="dl-row">
          <button id="download-step" disabled>STEP</button>
          <button id="download" disabled>STL</button>
          <button id="download-3mf" disabled>3MF</button>
        </div>
      </div>
      <div id="status">booting kernel…</div>
      <p class="hint">Drag to orbit · scroll to zoom.</p>
    </div>
    <div id="busy"><div class="ring"></div><div class="phase" id="phase">booting kernel…</div></div>
    <script type="module" src="/src/app-filleted-box.js"></script>
  </body>
</html>
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx vitest run test/filleted-box.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/parts/filleted-box.js src/app-filleted-box.js src/filleted-box-worker.js filleted-box.html test/filleted-box.test.js
git commit -F - <<'EOF'
feat(parts): filleted-box example (native fillet/chamfer, auto-OCCT)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1
EOF
```

---

### Task 6: measure — support backends without topology/intersect

`measure` must not crash on an OCCT part: report `watertight`/`holes` as `null` when the solid lacks `isEmpty`/`genus`, and skip the overlap check when the solid lacks `intersect`.

**Files:**
- Modify: `src/testing/measure.js`
- Test: `test/measure-occt.test.js`

**Interfaces:**
- Produces: `measure(...)` returns `watertight: boolean | null`, `holes: number | null`, `overlaps: []` when intersection is unsupported, and `ok` that is `true` unless a sub-part is explicitly `watertight === false` or there are overlaps.

- [ ] **Step 1: Write the failing test**

Create `test/measure-occt.test.js`:

```js
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { measure } from "../src/testing/measure.js";

let k;
const part = {
  meta: { title: "OcctBox", backend: "occt" }, defaults: {}, views: { v: { label: "V" } },
  parts: { a: { views: ["v"], build: (kk) => kk.box([0, 0, 0], [10, 10, 10]) } },
};
beforeAll(async () => { k = await bootOcctKernel(); });

test("measure works on an OCCT part: volume present, topology null, no crash", () => {
  const r = measure(k, part, "v");
  const s = r.subparts[0];
  expect(s.volume).toBeCloseTo(1000, 0);
  expect(s.bbox[0]).toBeCloseTo(10, 1);
  expect(s.triangleCount).toBeGreaterThan(0);
  expect(s.watertight).toBeNull();
  expect(s.holes).toBeNull();
  expect(r.overlaps).toEqual([]);
  expect(r.ok).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/measure-occt.test.js`
Expected: FAIL — `solid.isEmpty`/`genus`/`intersect` is not a function (current `measure` calls them directly).

- [ ] **Step 3: Implement the guards**

In `src/testing/measure.js`, in the `subparts` map, change the `watertight`/`holes` fields:

```js
      watertight: typeof solid.isEmpty === "function" ? !solid.isEmpty() : null,
      holes: typeof solid.genus === "function" ? solid.genus() : null,
```

Replace the overlaps line:

```js
  const overlaps = assemblyOverlaps(kernel, part, view, params);
```

with:

```js
  const canIntersect = built.length > 0 && typeof built[0].solid.intersect === "function";
  const overlaps = canIntersect ? assemblyOverlaps(kernel, part, view, params) : [];
```

Change the `ok` computation so a `null` (unknown) watertight doesn't fail it:

```js
    ok: subparts.every((s) => s.watertight !== false) && overlaps.length === 0,
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/measure-occt.test.js test/measure.test.js`
Expected: PASS (both the new OCCT test and the existing Manifold `measure` test).

- [ ] **Step 5: Commit**

```bash
git add src/testing/measure.js test/measure-occt.test.js
git commit -F - <<'EOF'
feat(testing): measure tolerates OCCT solids (null topology, skip overlaps)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1
EOF
```

---

### Task 7: Geometry service — per-backend routing

Make outbound preview/STL/3MF jobs take an explicit `backend`; STEP stays OCCT.

**Files:**
- Modify: `src/framework/geometry-service.js`
- Test: `test/geometry-service.test.js`

**Interfaces:**
- Produces: `createGeometryService({ createWorker, onMessage }) → { generate(msg, backend), exportStl(msg, backend), export3mf(msg, backend), exportStep(msg) }`. `generate`/`exportStl`/`export3mf` post to `workers[backend]` (default `"manifold"`); `exportStep` always posts to the OCCT worker. (The old `occtPreview` option is removed.)

- [ ] **Step 1: Write the failing test**

Create `test/geometry-service.test.js`:

```js
import { expect, test } from "vitest";
import { createGeometryService } from "../src/framework/geometry-service.js";

function fakeWorkers() {
  const posts = { manifold: [], occt: [] };
  const createWorker = (name) => ({ postMessage: (m) => posts[name].push(m), onmessage: null });
  return { posts, createWorker };
}

test("generate routes to the named backend; default is manifold", () => {
  const { posts, createWorker } = fakeWorkers();
  const s = createGeometryService({ createWorker, onMessage: () => {} });
  s.generate({ type: "generate", a: 1 }, "occt");
  s.generate({ type: "generate", a: 2 });
  expect(posts.occt).toEqual([{ type: "generate", a: 1 }]);
  expect(posts.manifold).toEqual([{ type: "generate", a: 2 }]);
});

test("exportStep always routes to occt", () => {
  const { posts, createWorker } = fakeWorkers();
  const s = createGeometryService({ createWorker, onMessage: () => {} });
  s.exportStep({ type: "export-step" });
  expect(posts.occt).toEqual([{ type: "export-step" }]);
});

test("exportStl routes to the named backend", () => {
  const { posts, createWorker } = fakeWorkers();
  const s = createGeometryService({ createWorker, onMessage: () => {} });
  s.exportStl({ type: "export-stl" }, "occt");
  expect(posts.occt).toEqual([{ type: "export-stl" }]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/geometry-service.test.js`
Expected: FAIL — current `generate` ignores a backend arg and routes by the fixed `occtPreview`.

- [ ] **Step 3: Implement**

Replace the body of `src/framework/geometry-service.js` (keep the file's leading comment) with:

```js
export function createGeometryService({ createWorker, onMessage }) {
  const workers = { manifold: createWorker("manifold"), occt: createWorker("occt") };
  workers.manifold.onmessage = onMessage;
  workers.occt.onmessage = onMessage;
  return {
    generate: (msg, backend = "manifold") => workers[backend].postMessage(msg),
    exportStl: (msg, backend = "manifold") => workers[backend].postMessage(msg),
    export3mf: (msg, backend = "manifold") => workers[backend].postMessage(msg),
    exportStep: (msg) => workers.occt.postMessage(msg), // STEP is always OCCT
  };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/geometry-service.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry-service.js test/geometry-service.test.js
git commit -F - <<'EOF'
feat(framework): per-backend job routing in the geometry service

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1
EOF
```

---

### Task 8: mount — auto-route by detected backend + needs-occt backstop

Wire detection into the app: route each build to the detected backend, honor a URL override, and re-dispatch to OCCT on the capability-error signal. Verified end-to-end in the browser via `check-app`.

**Files:**
- Modify: `src/framework/mount.js`
- Verify: `scripts/check-app.mjs filleted-box.html` (no new file)

**Interfaces:**
- Consumes: `detectBackend` (Task 4); the backend-routed `service.generate/exportStl/export3mf` (Task 7); the `{ type: "needs-occt" }` message (Task 1).

- [ ] **Step 1: Import detection and add a backend resolver**

In `src/framework/mount.js`, add to the imports:

```js
import { detectBackend } from "./geometry/probe.js";
```

Replace the `occtPreview` line:

```js
  // ?backend=occt routes preview generate through the OCCT worker (dev toggle).
  const occtPreview = new URLSearchParams(location.search).get("backend") === "occt";
```

with a forced-backend override + a resolver:

```js
  // ?backend=occt|manifold forces the backend; otherwise it's detected per part.
  let forcedBackend = new URLSearchParams(location.search).get("backend");
  if (forcedBackend !== "occt" && forcedBackend !== "manifold") forcedBackend = null;
  const backendFor = () => forcedBackend ?? detectBackend(part, params);
```

- [ ] **Step 2: Update the service construction and routing**

Change the service creation (remove `occtPreview`):

```js
  const service = createGeometryService({ createWorker, onMessage: onWorkerMessage });
```

In `maybeGenerate`, pass the backend:

```js
    service.generate({ type: "generate", subparts: missing, view, params }, backendFor());
```

In the export handlers, pass the backend to STL and 3MF (STEP is already OCCT-only):

```js
  dlBtn.addEventListener("click", () => {
    showBusy("exporting STL");
    service.exportStl({ type: "export-stl", view, params }, backendFor());
  });
```

```js
  dl3mfBtn?.addEventListener("click", () => {
    showBusy("exporting 3MF");
    service.export3mf({ type: "export-3mf", view, params }, backendFor());
  });
```

- [ ] **Step 3: Handle the needs-occt backstop**

In `onWorkerMessage`, add a case (next to `case "error":`):

```js
      case "needs-occt":
        forcedBackend = "occt"; // probe missed; this part needs OCCT — stick to it
        generating = false;
        maybeGenerate();
        break;
```

- [ ] **Step 4: Verify the demo (manifold) still routes correctly**

Run: `nvm use && node scripts/check-app.mjs demo.html`
Expected: `booted: true` — the demo has no fillet, so it stays on Manifold (regression check).

- [ ] **Step 5: Verify the filleted box auto-routes to OCCT and builds in-browser**

Run: `node scripts/check-app.mjs filleted-box.html`
Expected: `booted: true   status: "... triangles ..."   errors: 0` — `mount` detects `fillet`, routes to the OCCT worker, which builds and meshes the filleted box.

- [ ] **Step 6: Commit**

```bash
git add src/framework/mount.js
git commit -F - <<'EOF'
feat(framework): auto-route parts to OCCT/Manifold by detected ops

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1
EOF
```

---

### Task 9: CLI — auto-select the kernel

`partforge render`/`measure` boots the OCCT kernel for OCCT parts, Manifold otherwise, and prints `null` topology cleanly.

**Files:**
- Modify: `bin/cli.js`
- Test: `test/cli-occt.test.js`

**Interfaces:**
- Consumes: `detectBackend` (Task 4); `bootOcctKernel` (existing `src/testing/occt.js`); the filleted-box example (Task 5); `measure`'s nullable topology (Task 6).

- [ ] **Step 1: Write the failing test**

Create `test/cli-occt.test.js`:

```js
import { expect, test, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";

const run = (args) => execFileSync("node", ["bin/cli.js", ...args], { encoding: "utf8" });

afterAll(() => {
  rmSync("render", { recursive: true, force: true });
  rmSync("measure-filleted-box-box.json", { force: true });
});

test("render auto-selects OCCT for a filleted part and writes a PNG", () => {
  const out = run(["render", "src/parts/filleted-box.js", "box", "--views", "iso"]);
  expect(out).toMatch(/wrote render\/filleted-box-box-iso\.png/);
  expect(existsSync("render/filleted-box-box-iso.png")).toBe(true);
});

test("measure runs on the OCCT part and prints n/a topology", () => {
  const out = run(["measure", "src/parts/filleted-box.js"]);
  expect(out).toMatch(/Filleted Box \/ box/);
  expect(out).toMatch(/watertight n\/a/);
  expect(existsSync("measure-filleted-box-box.json")).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/cli-occt.test.js`
Expected: FAIL — the CLI always boots Manifold, so the filleted build throws (or prints `holes null`/crashes).

- [ ] **Step 3: Auto-select the kernel**

In `bin/cli.js`, add imports:

```js
import { detectBackend } from "../src/framework/geometry/probe.js";
import { bootOcctKernel } from "../src/testing/occt.js";
```

Replace the fixed kernel boot:

```js
const wasm = await Module(); wasm.setup();
const kernel = createManifoldKernel(wasm, { quality: "preview" });
```

with backend-aware boot:

```js
let kernel;
if (detectBackend(part) === "occt") {
  kernel = await bootOcctKernel();
} else {
  const wasm = await Module(); wasm.setup();
  kernel = createManifoldKernel(wasm, { quality: "preview" });
}
```

- [ ] **Step 4: Print nullable topology cleanly**

In `printMeasure`, replace the sub-part line so `null` reads `n/a`:

```js
  for (const s of r.subparts) {
    const wt = s.watertight === null ? "watertight n/a" : (s.watertight ? "watertight ✓" : "NOT watertight ✗");
    const holes = s.holes === null ? "holes n/a" : `holes ${s.holes}`;
    console.log(`  ${s.name}  bbox ${s.bbox.map((n) => n.toFixed(1)).join("×")}  ` +
      `vol ${(s.volume / 1000).toFixed(2)}cm³  area ${(s.surfaceArea / 100).toFixed(1)}cm²  ` +
      `tris ${s.triangleCount}  ${wt}  ${holes}`);
  }
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run test/cli-occt.test.js test/cli.test.js`
Expected: PASS (the new OCCT CLI test and the existing Manifold CLI test).

- [ ] **Step 6: Commit**

```bash
git add bin/cli.js test/cli-occt.test.js
git commit -F - <<'EOF'
feat(cli): auto-select OCCT/Manifold kernel by detected ops

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1
EOF
```

---

### Task 10: Author docs

Document fillet/chamfer + automatic backend selection in the authoring guide.

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (insert before `## Conventions & gotchas`)

- [ ] **Step 1: Add the section**

In `docs/AUTHORING-PARTS.md`, immediately before the `## Conventions & gotchas` heading, insert:

```markdown
## Fillet & chamfer (automatic OCCT backend)

Two backends build your part: **Manifold** (fast meshes — preview, STL, 3MF) and
**OCCT/replicad** (exact B-rep — STEP). Most parts run on Manifold. But Manifold has no
fillet, so if your `build` calls a **CAD-only op** the framework automatically routes the
whole part to OCCT — no declaration needed:

| Op | Meaning |
|---|---|
| `s.fillet(radius, selector?)` | round edges (curve-following, exact) |
| `s.chamfer(distance, selector?)` | bevel edges |

`selector` chooses which edges (omit it for **all** edges):

- `{ dir: "X"｜"Y"｜"Z" }` — edges running along an axis (e.g. `{dir:"Z"}` = the vertical edges)
- `{ inPlane: "XY"｜"XZ"｜"YZ", at }` — edges lying in a plane (e.g. base edges: `{inPlane:"XY", at:0}`)
- `{ near: [x,y,z] }` — edges passing through a point
- a raw `(edgeFinder) => edgeFinder` replicad finder, for anything fancier

```js
let s = k.box([0,0,0],[40,30,16]);
s = s.fillet(3, { dir: "Z" });            // round the 4 vertical edges
s = s.chamfer(1, { inPlane: "XY", at: 0 }); // bevel the base
```

See `src/parts/filleted-box.js` for the worked example.

**Automatic backend selection.** Before building, the framework runs a geometry-free *probe*
of your `build` to see whether it uses a CAD-only op, and routes accordingly — Manifold for
everything else (so sweep-heavy parts like the drum stay fast). Force it with
`meta.backend: "occt" | "manifold"` if you ever need to. Because an OCCT part is built
entirely on OCCT, its fillets are exact in the STEP **and** present in the printed STL.

> Trade-off: OCCT is much slower on heavy swept geometry (helical grooves), so don't reach for
> `fillet`/`chamfer` on a sweep-heavy part — design those edges in, or keep the part on Manifold.

> `partforge measure` reports `watertight`/`holes` as `n/a` for OCCT parts (Manifold-only
> topology); `render` works on both.
```

- [ ] **Step 2: Verify the full suite is green**

Run: `nvm use && npx vitest run`
Expected: all tests PASS (capability, edge-selector, occt-fillet, probe, filleted-box, measure-occt, geometry-service, cli-occt, plus the pre-existing suite).

- [ ] **Step 3: Commit**

```bash
git add docs/AUTHORING-PARTS.md
git commit -F - <<'EOF'
docs: fillet/chamfer + automatic backend selection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1
EOF
```

---

## Final verification

After all tasks: `nvm use && npx vitest run` (full suite green) and `node scripts/check-app.mjs filleted-box.html` (OCCT auto-route boots in-browser). Then use **superpowers:finishing-a-development-branch** to complete the `auto-backend-fillet` branch.
