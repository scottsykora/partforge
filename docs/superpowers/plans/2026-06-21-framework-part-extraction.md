# Framework / Part Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the reusable rendering/export machinery from the drum-specific geometry so the app is generated from a single declarative `PartDefinition` script.

**Architecture:** Move all generic code under `src/framework/` (kernel + backends, job loop, workers, three.js viewer, controls, export, `mount()`). Reduce the drum to `src/parts/drum.js` — a `PartDefinition` object (params schema + procedural `build`/`place` functions per named sub-part). The framework derives views, caching, and export entirely from `part`. Pure refactor: no user-visible change.

**Tech Stack:** Vite 8 (ESM workers), Manifold (`manifold-3d`) + replicad/OpenCASCADE backends, three.js, Vitest 4.

## Global Constraints

- Node 24 required for all test/build commands. Every command below assumes `nvm use` was run first (the repo `.nvmrc` pins `24.16.0`). The default shell Node is v16 and will fail.
- Run the full suite with `npx vitest run`; a single file with `npx vitest run <path>`.
- OCCT and Manifold must NOT boot in the same Node process (vitest isolates files; keep OCCT-booting tests in their own files).
- Behavior must stay identical to `main` at every task boundary; the existing 27 tests stay green throughout.
- Every commit message ends with these two trailer lines verbatim:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1
  ```
- Work happens on branch `framework-extraction` (already created off `main`; the design spec is already committed there).
- `dist/` is gitignored; never stage it.

---

## File Structure (end state)

```
src/
  framework/
    index.js                 # export { mount }
    mount.js                 # wires viewer + controls + geometry-service + view/cache loop + export
    viewer.js                # three.js scene (from main.js); sub-part slots from Object.keys(part.parts)
    controls.js              # from src/controls.js; takes part.parameters
    geometry-service.js      # spawns the two named workers; postMessage/onmessage routing
    worker.js                # runWorker(part); backend chosen by self.name
    jobs.js                  # handle(kernel, part, msg, post) + viewSubParts(part, view, params)
    geometry/
      kernel.js              # contract doc (moved)
      manifold-backend.js    # moved
      occt-backend.js        # moved; imports ./fuzzy-cut.js
      helix-tube.js          # moved
      fuzzy-cut.js           # moved (framework-internal OCCT helper)
      polygon.js             # piePolygon / hexPolygon (was in geometry/kernel.js)
  parts/
    drum.js                  # the PartDefinition
    drum/
      params.js              # moved from src/params.js
      bodies.js              # buildSmallDrum/buildBigDrum/buildTensionerBlock/seatBlock (from src/drum.js)
  app.js                     # import part; mount(part, { worker })
  part-worker.js             # import part; runWorker(part)
  index.html                 # loads ./src/app.js
test/
  framework/jobs.test.js     # job loop against drum + fixture
  framework/view-subparts.test.js
  fixtures/demo-part.js      # minimal fixture PartDefinition
```

---

## Task 1: Move geometry into the framework

**Files:**
- Move: `src/geometry/{kernel.js,manifold-backend.js,occt-backend.js,helix-tube.js}` → `src/framework/geometry/`
- Move: `src/fuzzy-cut.js` → `src/framework/geometry/fuzzy-cut.js`
- Create: `src/framework/geometry/polygon.js`
- Modify: `src/framework/geometry/kernel.js` (remove the polygon helpers, now in polygon.js)
- Modify importers: `src/drum.js`, `src/geometry-jobs.js`, `src/preview-worker.js`, `src/export-worker.js`, and any test importing these paths.

**Interfaces:**
- Produces: `framework/geometry/polygon.js` exports `piePolygon(tipR, arcDeg, segs?)` and `hexPolygon(r)` (same signatures as today's `geometry/kernel.js`).
- Produces: backend modules importable at `../geometry/<name>.js` relative to `framework/`.

- [ ] **Step 1: Move the geometry files**

```bash
cd "src"
mkdir -p framework/geometry
git mv geometry/kernel.js framework/geometry/kernel.js
git mv geometry/manifold-backend.js framework/geometry/manifold-backend.js
git mv geometry/occt-backend.js framework/geometry/occt-backend.js
git mv geometry/helix-tube.js framework/geometry/helix-tube.js
git mv fuzzy-cut.js framework/geometry/fuzzy-cut.js
rmdir geometry
```

- [ ] **Step 2: Split the 2-D polygon helpers into `polygon.js`**

Create `src/framework/geometry/polygon.js` with the two functions currently at the bottom of `kernel.js`:

```js
// 2-D polygon helpers shared by parts that call kernel.prism().

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

Then delete `piePolygon` and `hexPolygon` (lines 24–44) from `src/framework/geometry/kernel.js`, leaving only the `@typedef` contract comment.

- [ ] **Step 3: Update imports in the moved + importing files**

In `src/framework/geometry/occt-backend.js`, the fuzzy-cut import path is unchanged (same folder now): confirm it reads `import { fuzzyCut } from "./fuzzy-cut.js";` (if it currently imports `../fuzzy-cut.js`, change to `./fuzzy-cut.js`).

In `src/drum.js`, change:
```js
import { piePolygon, hexPolygon } from "./geometry/kernel.js";
```
to:
```js
import { piePolygon, hexPolygon } from "./framework/geometry/polygon.js";
```

In `src/preview-worker.js`, change:
```js
import { createManifoldKernel } from "./geometry/manifold-backend.js";
```
to:
```js
import { createManifoldKernel } from "./framework/geometry/manifold-backend.js";
```

In `src/export-worker.js`, change the two lines:
```js
import wasmUrl from "replicad-opencascadejs/src/replicad_single.wasm?url";
import { createOcctKernel } from "./geometry/occt-backend.js";
```
so the second becomes:
```js
import { createOcctKernel } from "./framework/geometry/occt-backend.js";
```

- [ ] **Step 4: Update test imports**

Update every test that imports a moved path. Search and replace:
- `../src/geometry/manifold-backend.js` → `../src/framework/geometry/manifold-backend.js`
- `../src/geometry/occt-backend.js` → `../src/framework/geometry/occt-backend.js`
- `../src/geometry/helix-tube.js` → `../src/framework/geometry/helix-tube.js`
- any `../src/geometry/kernel.js` import of `piePolygon`/`hexPolygon` → `../src/framework/geometry/polygon.js`

Run: `grep -rln "src/geometry/\|src/fuzzy-cut" test` to find them. Files to check include `test/manifold-backend.test.js`, `test/occt-backend.test.js`, `test/occt-kernel.js`, `test/helix-tube.test.js`, `test/kernel-helpers.test.js`, `test/helpers.js`.

- [ ] **Step 5: Run the full suite**

Run: `nvm use && npx vitest run`
Expected: `Tests 27 passed (27)`. If any fail with "Cannot find module", fix the missed import path and re-run.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move geometry + fuzzy-cut under src/framework/geometry

Pure file move; split pie/hex polygon helpers into polygon.js. No behavior change.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1"
```

---

## Task 2: `viewSubParts` + the fixture part

**Files:**
- Create: `src/framework/jobs.js` (only `viewSubParts` for now; `handle` arrives in Task 3)
- Create: `test/fixtures/demo-part.js`
- Create: `test/framework/view-subparts.test.js`

**Interfaces:**
- Produces: `viewSubParts(part, view, params) => string[]` — names of sub-parts whose `views` includes `view` and whose `enabled(params)` (if present) is true, in `Object.keys(part.parts)` order.
- Produces: a fixture `PartDefinition` with two sub-parts (`base` always on; `lid` gated by `params.with_lid`).

- [ ] **Step 1: Write the fixture part**

Create `test/fixtures/demo-part.js`:

```js
// Minimal PartDefinition used to test the framework generically (no drum knowledge).
export default {
  meta: { title: "Demo", units: "mm" },
  parameters: [
    { id: "size", title: "Size", presets: { Default: { r: 10, h: 5 } },
      advanced: [{ key: "r", label: "Radius", unit: "mm", min: 2, max: 40, step: 1 }] },
  ],
  defaults: { r: 10, h: 5, with_lid: 0 },
  derive: (p) => ({ rr: p.r * 2 }),
  parts: {
    base: { label: "Base", views: ["all", "base"], export: { name: "base" },
            build: (k, p, d) => k.cylinder(p.r, p.r, p.h) },
    lid:  { label: "Lid", views: ["all"], enabled: (p) => p.with_lid > 0,
            export: { name: "lid" },
            build: (k, p, d) => k.cylinder(p.r, p.r, 1).translate([0, 0, p.h]) },
  },
  views: { all: { label: "All" }, base: { label: "Base" } },
};
```

- [ ] **Step 2: Write the failing test**

Create `test/framework/view-subparts.test.js`:

```js
import { expect, test } from "vitest";
import { viewSubParts } from "../../src/framework/jobs.js";
import demo from "../fixtures/demo-part.js";

test("viewSubParts returns sub-parts in the view whose enabled() passes", () => {
  expect(viewSubParts(demo, "all", { with_lid: 0 })).toEqual(["base"]);
  expect(viewSubParts(demo, "all", { with_lid: 1 })).toEqual(["base", "lid"]);
  expect(viewSubParts(demo, "base", { with_lid: 1 })).toEqual(["base"]);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `nvm use && npx vitest run test/framework/view-subparts.test.js`
Expected: FAIL — "Cannot find module ... jobs.js" or "viewSubParts is not a function".

- [ ] **Step 4: Implement `viewSubParts`**

Create `src/framework/jobs.js`:

```js
// Names of the sub-parts a view shows: declared in the view and enabled for these
// params. Order follows Object.keys(part.parts) (definition order).
export function viewSubParts(part, view, params) {
  return Object.keys(part.parts).filter((name) => {
    const sp = part.parts[name];
    const inView = sp.views.includes(view);
    const on = sp.enabled ? !!sp.enabled(params) : true;
    return inView && on;
  });
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `nvm use && npx vitest run test/framework/view-subparts.test.js`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add src/framework/jobs.js test/fixtures/demo-part.js test/framework/view-subparts.test.js
git commit -m "feat(framework): viewSubParts + a fixture PartDefinition

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1"
```

---

## Task 3: The generalized job loop + the drum `PartDefinition`

**Files:**
- Modify: `src/framework/jobs.js` (add `handle`)
- Move: `src/params.js` → `src/parts/drum/params.js`
- Move: `src/drum.js` body functions → `src/parts/drum/bodies.js` (keep the function bodies verbatim)
- Create: `src/parts/drum.js` (the PartDefinition)
- Modify: `src/parts/drum/bodies.js` — refactor `seatBlock(kernel, block, p, d)` to `seatBlock(block, p, d)` (kernel arg is unused); update its one caller
- Modify: `src/geometry-jobs.js` — re-export from the new location OR update workers (handled in Task 4). For now keep `src/geometry-jobs.js` working by delegating.
- Create: `test/framework/jobs.test.js`
- Modify: `test/occt-step.test.js`, `test/geometry-jobs.test.js`, `test/drum-occt.test.js`, `test/parity.test.js` import paths for `drum.js`/`params.js`.

**Interfaces:**
- Consumes: `viewSubParts` (Task 2).
- Produces: `handle(kernel, part, msg, post) => Promise<void>`. Messages:
  - `{ type:"generate", subparts:string[], view:string, params }` → posts `{ type:"meshes", meshes:[{name,positions,normals,indices,triangles,edges}], ms }`
  - `{ type:"export-stl", view:string, params }` → posts `{ type:"download-parts", ext:"stl", mime:"model/stl", parts:[{name,data}] }`
  - `{ type:"export-step", view:string, params }` → posts `{ type:"download", data, filename, mime }`
  - progress via `{ type:"progress", phase }`
- Produces: `src/parts/drum.js` default export — the drum `PartDefinition`.
- Produces: `src/parts/drum/bodies.js` exports `buildSmallDrum`, `buildBigDrum`, `buildTensionerBlock`, `seatBlock(block, p, d)`.
- Produces: `src/parts/drum/params.js` exports `DEFAULTS`, `SECTIONS`, `derive`.

- [ ] **Step 1: Move params + drum bodies**

```bash
cd "src"
mkdir -p parts/drum
git mv params.js parts/drum/params.js
git mv drum.js parts/drum/bodies.js
```

In `src/parts/drum/bodies.js`:
- Update its imports: `./params.js` stays correct (same folder); change `./framework/geometry/polygon.js` to `../../framework/geometry/polygon.js`.
- Remove the public `buildParts`/`buildSubPart` exports' reliance on view strings (they are replaced by the part's `parts`/`place`); KEEP the four geometry builders exported: `buildSmallDrum`, `buildBigDrum`, `buildTensionerBlock`, `seatBlock`. Leave `buildParts` and `buildSubPart` in place for now (still imported by `src/geometry-jobs.js`) — they are deleted in Task 4 Step 5.
- Refactor `seatBlock(kernel, block, p, d)` → `seatBlock(block, p, d)` (drop the unused `kernel` param) and update its call inside `buildSubPart` from `seatBlock(kernel, buildTensionerBlock(kernel, p, d), p, d)` to `seatBlock(buildTensionerBlock(kernel, p, d), p, d)`.

- [ ] **Step 2: Write the drum PartDefinition**

Create `src/parts/drum.js`:

```js
import { DEFAULTS, SECTIONS, derive } from "./drum/params.js";
import { buildSmallDrum, buildBigDrum, buildTensionerBlock, seatBlock } from "./drum/bodies.js";

// motor base offset, mirrors bodies.js
const baseH = (p) => (p.motor_mount ? p.motor_flange_t + p.motor_standoff_h : 0);

export default {
  meta: { title: "Capstan Drum", units: "mm", background: 0x15181d },
  parameters: SECTIONS,
  defaults: DEFAULTS,
  derive,
  parts: {
    small: {
      label: "Small drum",
      views: ["both", "small"],
      export: { name: "small_drum" },
      build: (k, p, d) => buildSmallDrum(k, p, d),
      // display: always seated in the shared assembly frame (view-independent so
      // the mesh caches across views). export: assembled only in the "both" view.
      place: (solid, { view, purpose, p, d }) => {
        const off = [-d.centerDist, 0, -baseH(p)];
        if (purpose === "display") return solid.translate(off);
        return view === "both" ? solid.translate(off) : solid;
      },
    },
    big: {
      label: "Big drum",
      views: ["both", "big"],
      export: { name: "big_drum" },
      build: (k, p, d) => buildBigDrum(k, p, d),
    },
    block: {
      label: "Tensioner block",
      views: ["both"],
      enabled: (p) => p.tensioner_pocket_depth > 0,
      export: { name: "tensioner_block" },
      build: (k, p, d) => buildTensionerBlock(k, p, d), // flat / standalone (canonical)
      place: (solid, { purpose, p, d }) =>
        purpose === "display" ? seatBlock(solid, p, d) : solid,
    },
  },
  views: { both: { label: "Assembly" }, small: { label: "Small" }, big: { label: "Big" } },
};
```

- [ ] **Step 3: Write the failing test for `handle`**

Create `test/framework/jobs.test.js`:

```js
import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../../src/framework/geometry/manifold-backend.js";
import { handle } from "../../src/framework/jobs.js";
import demo from "../fixtures/demo-part.js";

let k;
beforeAll(async () => { const w = await Module(); w.setup(); k = createManifoldKernel(w, { quality: "preview" }); });

test("generate posts one mesh per requested sub-part", async () => {
  const posted = [];
  await handle(k, demo, { type: "generate", subparts: ["base"], view: "all", params: {} }, (m) => posted.push(m));
  const meshes = posted.find((m) => m.type === "meshes");
  expect(meshes.meshes.map((x) => x.name)).toEqual(["base"]);
  expect(meshes.meshes[0].triangles).toBeGreaterThan(0);
});

test("export-stl builds the view's enabled sub-parts and names them via export.name", async () => {
  const posted = [];
  await handle(k, demo, { type: "export-stl", view: "all", params: { with_lid: 1 } }, (m) => posted.push(m));
  const dl = posted.find((m) => m.type === "download-parts");
  expect(dl.parts.map((p) => p.name)).toEqual(["base", "lid"]);
  expect(dl.parts[0].data.byteLength).toBeGreaterThan(0);
});

test("export-step emits a final 'writing STEP file' progress before the (unsupported) write", async () => {
  const posted = [];
  await handle(k, demo, { type: "export-step", view: "base", params: {} }, (m) => posted.push(m));
  const phases = posted.filter((m) => m.type === "progress").map((m) => m.phase);
  expect(phases[phases.length - 1]).toBe("writing STEP file");
  // Manifold kernel can't write STEP → an error is posted (build + progress still ran)
  expect(posted.some((m) => m.type === "error")).toBe(true);
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `nvm use && npx vitest run test/framework/jobs.test.js`
Expected: FAIL — "handle is not a function".

- [ ] **Step 5: Implement `handle` in `src/framework/jobs.js`**

Add to `src/framework/jobs.js` (keep `viewSubParts`):

```js
// Handle one geometry job, posting results/progress via `post`. Backend-agnostic,
// part-agnostic: all part specifics come through `part`.
export async function handle(kernel, part, msg, post) {
  const onProgress = (phase) => post({ type: "progress", phase });
  const p = { ...part.defaults, ...msg.params };
  const d = part.derive ? part.derive(p) : {};

  const buildPosed = (name, purpose, view) => {
    const sp = part.parts[name];
    const solid = sp.build(kernel, p, d);
    return sp.place ? sp.place(solid, { view, purpose, p, d }) : solid;
  };
  const exportName = (name) => part.parts[name].export?.name ?? name;
  const label = (name) => part.parts[name].label ?? name;

  try {
    if (msg.type === "generate") {
      const t0 = Date.now();
      const meshes = [];
      for (const name of msg.subparts) {
        onProgress(`building ${label(name)}`);
        const m = buildPosed(name, "display", msg.view).toMesh({ quality: "preview" });
        meshes.push({ name, positions: m.positions, normals: m.normals, indices: m.indices, triangles: m.triangles, edges: m.edges });
        kernel.cleanup?.();
      }
      post({ type: "meshes", meshes, ms: Date.now() - t0 });
    } else if (msg.type === "export-stl") {
      const out = [];
      for (const name of viewSubParts(part, msg.view, p)) {
        onProgress(`building ${label(name)}`);
        out.push({ name: exportName(name), data: await buildPosed(name, "export", msg.view).toSTL({ quality: "print" }) });
      }
      post({ type: "download-parts", ext: "stl", mime: "model/stl", parts: out });
    } else if (msg.type === "export-step") {
      const solids = viewSubParts(part, msg.view, p).map((name) => {
        onProgress(`building ${label(name)}`);
        return { name: exportName(name), solid: buildPosed(name, "export", msg.view) };
      });
      onProgress("writing STEP file");
      const data = await kernel.toSTEP(solids);
      post({ type: "download", data, filename: `${msg.view}.step`, mime: "application/step" });
    }
  } catch (err) {
    post({ type: "error", message: String(err?.message || err) });
  } finally {
    kernel.cleanup?.();
  }
}
```

- [ ] **Step 6: Run the new test to verify it passes**

Run: `nvm use && npx vitest run test/framework/jobs.test.js`
Expected: PASS (3 tests).

- [ ] **Step 7: Repoint the old paths so the existing suite still builds**

The old `src/geometry-jobs.js` still imports `./drum.js`. Update it to import from the new bodies location so the legacy workers keep working until Task 4:
```js
import { buildSubPart, buildParts } from "./parts/drum/bodies.js";
```
Update test import paths that referenced the moved files:
- `../src/drum.js` → `../src/parts/drum/bodies.js` (in `test/occt-step.test.js`, `test/drum-occt.test.js`, `test/parity.test.js`, `test/geometry-jobs.test.js`)
- `../src/params.js` → `../src/parts/drum/params.js` (wherever imported)
Run `grep -rln "src/drum.js\|src/params.js" test src` to find every reference.

- [ ] **Step 8: Run the full suite**

Run: `nvm use && npx vitest run`
Expected: `Tests 30 passed (30)` (27 existing + 3 new). Fix any missed import path and re-run.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(framework): generalized job loop + drum PartDefinition

handle(kernel, part, msg, post) drives generate/export-stl/export-step from the
part's parts/views/build/place. Drum reshaped into parts/drum.js over the
existing geometry builders (moved to parts/drum/).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1"
```

---

## Task 4: Generalized workers + part-worker entry

**Files:**
- Create: `src/framework/worker.js` (`runWorker(part)`)
- Create: `src/part-worker.js` (thin app entry)
- Modify: `src/main.js` — replace the two `new Worker(...)` calls with two named instances of `part-worker.js` (geometry-service comes in Task 6; for now wire inline in main.js, passing `view` in messages)
- Delete: `src/preview-worker.js`, `src/export-worker.js`, `src/geometry-jobs.js`
- Delete: `buildParts`/`buildSubPart` from `src/parts/drum/bodies.js`
- Modify: `test/geometry-jobs.test.js` → delete (superseded by `test/framework/jobs.test.js`); migrate any unique assertions first.

**Interfaces:**
- Consumes: `handle` (Task 3), `viewSubParts`.
- Produces: `runWorker(part)` — installs `self.onmessage`; on the first message it lazily creates the kernel for the backend named by `self.name` (`"manifold"` → Manifold, `"occt"` → OCCT), posts `{ type:"ready" }` once the manifold kernel is up, posts `{ type:"progress", phase:"loading exact kernel" }` before a cold OCCT boot, then calls `handle`. Transfers mesh/STL buffers.

- [ ] **Step 1: Write `runWorker`**

Create `src/framework/worker.js`:

```js
// Worker runtime shared by every part. The host spawns this entry twice, named
// "manifold" (preview + STL) and "occt" (STEP), via the Worker `name` option.
// Each instance lazily loads only its own backend, so OCCT's 11 MB WASM loads
// only in the worker that needs it, and only on first use.
import { handle, viewSubParts } from "./jobs.js";

async function manifoldKernel() {
  const [{ default: Module }, { createManifoldKernel }] = await Promise.all([
    import("manifold-3d"),
    import("./geometry/manifold-backend.js"),
  ]);
  const wasm = await Module();
  wasm.setup();
  return { preview: createManifoldKernel(wasm, { quality: "preview" }),
           print:   createManifoldKernel(wasm, { quality: "print" }) };
}

async function occtKernel() {
  const [{ default: opencascade }, wasmUrlMod, replicad, { createOcctKernel }] = await Promise.all([
    import("replicad-opencascadejs/src/replicad_single.js"),
    import("replicad-opencascadejs/src/replicad_single.wasm?url"),
    import("replicad"),
    import("./geometry/occt-backend.js"),
  ]);
  const OC = await opencascade({ locateFile: () => wasmUrlMod.default });
  replicad.setOC(OC);
  return createOcctKernel(replicad);
}

export function runWorker(part) {
  const backend = self.name === "occt" ? "occt" : "manifold";
  let manifold = null;   // { preview, print }
  let occt = null;
  let booting = null;

  if (backend === "manifold") {
    booting = manifoldKernel().then((m) => { manifold = m; postMessage({ type: "ready" }); });
  }

  const transferOf = (m) => {
    if (m.type === "meshes") {
      const t = [];
      for (const x of m.meshes) {
        t.push(x.positions.buffer);
        if (x.normals?.buffer) t.push(x.normals.buffer);
        if (x.indices?.buffer) t.push(x.indices.buffer);
        if (x.edges?.buffer) t.push(x.edges.buffer);
      }
      return t;
    }
    if (m.type === "download-parts") return m.parts.map((p) => (ArrayBuffer.isView(p.data) ? p.data.buffer : p.data));
    if (m.type === "download") return [m.data];
    return [];
  };

  self.onmessage = async (e) => {
    let kernel;
    if (backend === "manifold") {
      await booting;
      kernel = e.data.type === "export-stl" ? manifold.print : manifold.preview;
    } else {
      if (!occt) {
        postMessage({ type: "progress", phase: "loading exact kernel" });
        booting = booting ?? occtKernel().then((k) => (occt = k));
        await booting;
      }
      kernel = occt;
    }
    await handle(kernel, part, e.data, (m) => postMessage(m, transferOf(m)));
  };
}

export { viewSubParts };
```

- [ ] **Step 2: Write the thin app worker entry**

Create `src/part-worker.js`:

```js
import part from "./parts/drum.js";
import { runWorker } from "./framework/worker.js";
runWorker(part);
```

- [ ] **Step 3: Rewire `main.js` to spawn the two named workers**

In `src/main.js`, replace:
```js
const previewWorker = new Worker(new URL("./preview-worker.js", import.meta.url), { type: "module" });
const exportWorker = new Worker(new URL("./export-worker.js", import.meta.url), { type: "module" });
```
with:
```js
const workerUrl = new URL("./part-worker.js", import.meta.url);
const previewWorker = new Worker(workerUrl, { type: "module", name: "manifold" });
const exportWorker = new Worker(workerUrl, { type: "module", name: "occt" });
```
Then add `view` to every geometry message so `handle` can pose for the active view. Change the three `postMessage` calls:
```js
genWorker.postMessage({ type: "generate", subparts: missing, params });          // → add view: part_view
previewWorker.postMessage({ type: "export-stl", part, params });                  // → { type:"export-stl", view: part_view, params }
exportWorker.postMessage({ type: "export-step", part, params });                  // → { type:"export-step", view: part_view, params }
```
Here the active view variable in `main.js` is currently named `part` (the tab). Rename that local to `view` to avoid colliding with the imported part definition is done in Task 6; for THIS task, keep the existing local name but send it as the `view` field, e.g. `{ type: "generate", subparts: missing, view: part, params }`. (The `?backend=occt` preview toggle and `genWorker` selection stay as-is.)

- [ ] **Step 4: Delete the superseded modules + legacy builders**

```bash
git rm src/preview-worker.js src/export-worker.js src/geometry-jobs.js
```
In `src/parts/drum/bodies.js`, delete the now-unused `buildParts` and `buildSubPart` exports (and the `seatBlock`-for-display path they contained). Keep `buildSmallDrum`, `buildBigDrum`, `buildTensionerBlock`, `seatBlock`.
Migrate any still-unique assertion from `test/geometry-jobs.test.js` into `test/framework/jobs.test.js`, then `git rm test/geometry-jobs.test.js`.

- [ ] **Step 5: Run the full suite**

Run: `nvm use && npx vitest run`
Expected: green; total = 30 minus whatever `test/geometry-jobs.test.js` contributed plus any reassigned. Confirm no `Cannot find module` for the deleted files.

- [ ] **Step 6: Manual smoke (workers only run in the browser)**

```bash
nvm use && npm run build
```
Expected: build succeeds. Then `npm run dev`, open the printed URL, hard-reload, and confirm: preview renders, STL downloads (lit, high-res), STEP downloads with stepped progress. (Worker logic can't run in vitest/jsdom; this is the worker verification.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(framework): part-agnostic worker runtime

Single runWorker(part) spawned twice (manifold/occt by Worker name); each
lazily loads only its backend. Replaces preview/export workers + geometry-jobs.
Messages now carry the active view so the job loop can pose sub-parts.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1"
```

---

## Task 5: Extract the three.js viewer

**Files:**
- Create: `src/framework/viewer.js`
- Modify: `src/main.js` (consume the viewer instead of inline scene code)
- Create: `test/framework/viewer-smoke.test.js` (guards the pure geometry-buffer→BufferGeometry helper if extracted; otherwise omitted — see Step 1)

**Interfaces:**
- Produces: `createViewer(container, part) => { showAssembly(names), hideAssembly(), setSubGeometry(name, payload), resize(), dispose() }` where `payload = { positions, normals, indices, triangles, edges }`.
- The viewer owns: renderer, scene, camera, OrbitControls, lights, grid, the `pivot`/`partsGroup`, one `THREE.Mesh` + one `LineSegments2` per `Object.keys(part.parts)`, crease-normal + edge-line construction (`buildGeometry`), and camera framing (`showAssembly`).

- [ ] **Step 1: Move the scene code into `viewer.js`**

Create `src/framework/viewer.js` by moving, verbatim, these pieces from `src/main.js`: the THREE imports, renderer/scene/camera/controls/lights/grid setup, `material`, `pivot`/`partsGroup`, the `subMesh`/`subLines` construction, `CREASE_ANGLE`/`EDGE_ANGLE`/`lineMaterial`, `buildGeometry`, `showAssembly`/`hideAssembly`, `resize`, and the `renderer.setAnimationLoop` render loop. Wrap them in:

```js
export function createViewer(container, part) {
  const names = Object.keys(part.parts);
  // ...moved setup, with subMesh/subLines built by iterating `names` instead of
  // the literal { small, big, block } object...
  container.appendChild(renderer.domElement);
  if (part.meta?.background != null) scene.background = new THREE.Color(part.meta.background);

  const subCache = Object.fromEntries(names.map((n) => [n, null]));
  function setSubGeometry(name, payload) { /* subCache[name] = buildGeometry(payload); attach to mesh+line */ }
  // showAssembly / hideAssembly unchanged but iterate `names`
  function dispose() { renderer.setAnimationLoop(null); renderer.dispose(); container.removeChild(renderer.domElement); }
  return { showAssembly, hideAssembly, setSubGeometry, resize, dispose, _subCache: subCache };
}
```

Replace the literal `{ small: …, big: …, block: … }` in `subMesh`/`subLines` with `Object.fromEntries(names.map((n) => [n, new THREE.Mesh(...)]))` etc. Everything else (crease normals, edge lines, framing math) is copied unchanged.

- [ ] **Step 2: Consume the viewer from `main.js`**

In `src/main.js`, delete the moved scene code and replace with:
```js
import { createViewer } from "./framework/viewer.js";
const viewer = createViewer(document.getElementById("app"), part);
```
Repoint the cache/show calls: where `main.js` did `subCache[m.name] = buildGeometry(m)` use `viewer.setSubGeometry(m.name, m)`; where it called `showAssembly(needed)`/`hideAssembly()` call `viewer.showAssembly(needed)`/`viewer.hideAssembly()`. The per-sub-part `cacheVersion`/`isCurrent` bookkeeping stays in `main.js` (it is view/version logic, not scene logic), but reads geometry presence from the viewer (`viewer._subCache[n]`).

- [ ] **Step 3: Run the suite + build**

Run: `nvm use && npx vitest run && npm run build`
Expected: tests green (viewer has no node tests; it is browser-only), build succeeds.

- [ ] **Step 4: Manual smoke**

`npm run dev`, hard-reload: preview renders and frames correctly, tab switches recenter, edges/shading look identical to before.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(framework): extract three.js viewer from main.js

createViewer(container, part) owns the scene + per-sub-part mesh/line slots,
built from Object.keys(part.parts). No visual change.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1"
```

---

## Task 6: `mount()` + geometry-service; collapse entry points

**Files:**
- Create: `src/framework/geometry-service.js`
- Create: `src/framework/mount.js`
- Create: `src/framework/index.js`
- Move: `src/controls.js` → `src/framework/controls.js` (modify to take `part.parameters`)
- Create: `src/app.js`
- Delete: `src/main.js`
- Modify: `index.html` (script src → `./src/app.js`)

**Interfaces:**
- Produces: `createGeometryService({ workerUrl, onMessage }) => { generate(msg), exportStl(msg), exportStep(msg) }` — spawns the two named workers, routes both `onmessage` streams to `onMessage`, posts with the right worker.
- Produces: `mount(part, { worker, container?, controls? }) => void` — full app wiring (viewer + controls + service + view/cache loop + export buttons), using today's `main.js` logic generalized over `part`.
- Produces: `buildControls(root, parameters, onDirty)` — `controls.js` now takes `parameters` instead of importing `SECTIONS`.
- Produces: `framework/index.js` re-exports `{ mount }`.

- [ ] **Step 1: Generalize `controls.js`**

```bash
git mv src/controls.js src/framework/controls.js
```
In `src/framework/controls.js`, delete `import { SECTIONS } from "./params.js";` and change the signature:
```js
export function buildControls(root, parameters, onDirty) {
  for (const sec of parameters) { /* ...unchanged, using `parameters` in place of SECTIONS... */ }
}
```

- [ ] **Step 2: Write the geometry-service**

Create `src/framework/geometry-service.js`:

```js
// Main-thread side of the two geometry workers. Spawns both (manifold/occt),
// funnels their messages to one handler, and routes outbound jobs to the right one.
export function createGeometryService({ workerUrl, onMessage, occtPreview = false }) {
  const preview = new Worker(workerUrl, { type: "module", name: "manifold" });
  const exporter = new Worker(workerUrl, { type: "module", name: "occt" });
  preview.onmessage = onMessage;
  exporter.onmessage = onMessage;
  const genWorker = occtPreview ? exporter : preview;
  return {
    generate: (msg) => genWorker.postMessage(msg),
    exportStl: (msg) => preview.postMessage(msg),
    exportStep: (msg) => exporter.postMessage(msg),
  };
}
```

- [ ] **Step 3: Write `mount()`**

Create `src/framework/mount.js` by moving the orchestration from `src/main.js` (status/busy DOM helpers, the per-sub-part cache + `paramsVersion`/`genVersion` bookkeeping, `viewSubParts`-driven `missingParts`/`refreshView`/`maybeGenerate`/`scheduleGenerate`, the view-tab segmented control, the download helpers, and the message switch), generalized:

```js
import { createViewer } from "./viewer.js";
import { buildControls } from "./controls.js";
import { createGeometryService } from "./geometry-service.js";
import { viewSubParts } from "./jobs.js";
import { zipSync } from "fflate";

export function mount(part, { worker, container = document.getElementById("app"),
                              controls = document.getElementById("controls") } = {}) {
  const params = { ...part.defaults };
  let view = Object.keys(part.views)[0];
  const viewer = createViewer(container, part);
  // ...status/busy helpers (moved verbatim from main.js)...
  // ...cacheVersion bookkeeping keyed off Object.keys(part.parts)...
  const occtPreview = new URLSearchParams(location.search).get("backend") === "occt";
  const service = createGeometryService({ workerUrl: worker, onMessage: onWorkerMessage, occtPreview });
  buildControls(controls, part.parameters, onParamChange);
  // build the view tabs from part.views; on click set `view`, refreshView(), maybeGenerate()
  // maybeGenerate(): missing = viewSubParts(part, view, params).filter(stale);
  //   service.generate({ type:"generate", subparts: missing, view, params })
  // export buttons → service.exportStl({ type:"export-stl", view, params }) / exportStep(...)
  // onWorkerMessage: same switch as today (ready/progress/meshes/download-parts/download/error),
  //   writing meshes via viewer.setSubGeometry, composing views via viewer.showAssembly.
}
```

Move the bodies verbatim from `main.js`, substituting: hardcoded sub-part names → `Object.keys(part.parts)`; `viewParts(part, params)` → `viewSubParts(part, view, params)`; the three `postMessage` calls → `service.*`; geometry writes → `viewer.setSubGeometry`. The HTML element ids (`status`, `download`, `download-step`, `busy`, `phase`, `part` tab bar) stay as today.

- [ ] **Step 4: Public entry + app glue**

Create `src/framework/index.js`:
```js
export { mount } from "./mount.js";
```
Create `src/app.js`:
```js
import part from "./parts/drum.js";
import { mount } from "./framework/index.js";
mount(part, { worker: new URL("./part-worker.js", import.meta.url) });
```
```bash
git rm src/main.js
```
In `index.html`, change the module script tag's `src` from `./src/main.js` to `./src/app.js` (or `/src/app.js` — match the existing form).

- [ ] **Step 5: Run suite + build**

Run: `nvm use && npx vitest run && npm run build`
Expected: tests green, build succeeds.

- [ ] **Step 6: Manual smoke (full app)**

`npm run dev`, hard-reload. Verify end-to-end against `main`'s behavior: control panel (presets, advanced sliders, feature checkboxes), live regenerate, tab switching, STL export (lit + high-res), STEP export (progress + downloads), `?backend=occt` toggle.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(framework): mount() + geometry-service; app.js entry

main.js becomes a 3-line app.js that mounts the drum PartDefinition. The view/
cache loop, controls, worker orchestration, and export are now part-driven.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1"
```

---

## Task 7: Prove reuse with a second part

**Files:**
- Create: `src/parts/demo.js` (promote `test/fixtures/demo-part.js` content, or import it)
- Create: `test/framework/reuse.test.js`

**Interfaces:**
- Consumes: `handle`, `viewSubParts`, a Manifold kernel.
- Produces: a headless test that a *non-drum* part drives generate + STL export through the framework, guarding against drum-knowledge leaking back into `framework/`.

- [ ] **Step 1: Write the reuse test**

Create `test/framework/reuse.test.js`:

```js
import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../../src/framework/geometry/manifold-backend.js";
import { handle, viewSubParts } from "../../src/framework/jobs.js";
import demo from "../fixtures/demo-part.js";

let k;
beforeAll(async () => { const w = await Module(); w.setup(); k = createManifoldKernel(w, { quality: "preview" }); });

test("a non-drum part renders all its enabled sub-parts", async () => {
  expect(viewSubParts(demo, "all", { with_lid: 1 })).toEqual(["base", "lid"]);
  const posted = [];
  await handle(k, demo, { type: "generate", subparts: ["base", "lid"], view: "all", params: { with_lid: 1 } }, (m) => posted.push(m));
  const meshes = posted.find((m) => m.type === "meshes").meshes;
  expect(meshes.map((m) => m.name)).toEqual(["base", "lid"]);
  expect(meshes.every((m) => m.triangles > 0)).toBe(true);
});

test("a non-drum part exports STL named by export.name", async () => {
  const posted = [];
  await handle(k, demo, { type: "export-stl", view: "base", params: {} }, (m) => posted.push(m));
  expect(posted.find((m) => m.type === "download-parts").parts.map((p) => p.name)).toEqual(["base"]);
});
```

- [ ] **Step 2: Run it to verify it passes**

Run: `nvm use && npx vitest run test/framework/reuse.test.js`
Expected: PASS (2 tests). (Logic already exists from Tasks 2–3; this is the guardrail.)

- [ ] **Step 3: Full suite + build**

Run: `nvm use && npx vitest run && npm run build`
Expected: all green, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add test/framework/reuse.test.js src/parts/demo.js
git commit -m "test(framework): prove a non-drum part reuses the whole pipeline

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1"
```

---

## Final verification

- [ ] `nvm use && npx vitest run` → all green
- [ ] `nvm use && npm run build` → succeeds
- [ ] `npm run dev` smoke: preview, tab switch, STL (lit/high-res), STEP (progress), `?backend=occt`
- [ ] `git grep -n "small\|big\|block" src/framework` returns no drum-specific sub-part names (only generic code)
- [ ] Merge `framework-extraction` → `main` (`--no-ff`) and push (triggers GitHub Pages deploy)
