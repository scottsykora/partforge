# partforge Viewer View API — Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public view API to the partforge mount runtime handle — read the active view, subscribe to view changes, set the view, and render a named view offscreen — so an embedder (partforge-cloud) can deep-link tabs, know the active tab, switch tabs, and capture the default-view thumbnail.

**Architecture:** Four additive members on the handle built from machinery that already exists. `createViewTabs` gains a programmatic `select(name)` that reuses its click path; `mount()` forwards the view name (already handed to `onChange`) to a new `onViewChange` embedder callback and emits the initial view once; `makeHandle` exposes `getView`/`setView`/`captureView`. `captureView` builds a named view's geometry offscreen and renders it from a canonical angle without touching the live scene. This is the `partforge` half of the cross-repo spec `partforge-cloud/docs/superpowers/specs/2026-08-05-viewer-tab-deep-linking-chat-design.md`; the cloud half is a separate plan that consumes the 0.45.0 release this one ships.

**Tech Stack:** Plain ESM, three.js, Manifold/OCCT WASM kernels, vitest (+ happy-dom for DOM units), Node 24.

## Global Constraints

- **Node 24.** Run `nvm use` before `npm install`, tests, or the CLI (the default shell Node is too old).
- **Version bump 0.44.0 → 0.45.0** in `package.json` (additive minor). Publishing is tag-driven after merge — never `npm publish` by hand.
- **Additive only.** Do not remove or rename any existing handle member; `test/framework/mount.test.js` locks the handle shape.
- **`captureView` must not mutate viewer state** — not the active view, `getView()`, `onViewChange`, the live scene, nor the live camera. It is a pure read that renders a hypothetical view offscreen.
- **Kernel isolation in tests:** OCCT and Manifold must not boot in the same process. Any test that boots a kernel uses `createManifoldKernel` and stays in its own file; keep pure-DOM unit tests kernel-free.
- **Import geometry helpers from `partforge/geometry`, never `partforge`,** in any worker-reachable code.
- On any build/test failure, grep `docs/ERROR-PATTERNS.md` for the symptom first.

---

### Task 1: `select(name)` — programmatic view switch in `createViewTabs`

**Files:**
- Modify: `src/framework/view-tabs.js:49-55` (the returned control object)
- Test: `test/framework/view-tabs.test.js` (append)

**Interfaces:**
- Consumes: nothing new. Uses the existing in-closure `view`, `partKey`, `saveView`, `setActive`, `onChange`.
- Produces: `createViewTabs(...)` return value gains `select(name) => boolean`. `select` sets the active view, persists it via `saveView(partKey, name)`, updates the active button class, and fires `onChange(name)` — identical to a user click. Returns `true` if `name` is a real tab (including when it's already active), `false` if unknown.

- [ ] **Step 1: Write the failing tests**

Append to `test/framework/view-tabs.test.js`:

```js
test("select(name) switches the active tab, persists it, and fires onChange", () => {
  const onChange = vi.fn();
  const ctl = createViewTabs(el, part, { onChange });
  onChange.mockClear(); // ignore any construction-time calls

  const ok = ctl.select("drum");

  expect(ok).toBe(true);
  expect(ctl.current()).toBe("drum");
  expect(el.querySelector("button.on").dataset.part).toBe("drum");
  expect(sessionStorage.getItem("partforge:view:Test part")).toBe("drum");
  expect(onChange).toHaveBeenCalledWith("drum");
});

test("select(unknown) is rejected with false and changes nothing", () => {
  const onChange = vi.fn();
  const ctl = createViewTabs(el, part, { onChange });
  const before = ctl.current();
  onChange.mockClear();

  const ok = ctl.select("nope");

  expect(ok).toBe(false);
  expect(ctl.current()).toBe(before);
  expect(onChange).not.toHaveBeenCalled();
});

test("select(current) is a no-op that still reports true", () => {
  const onChange = vi.fn();
  const ctl = createViewTabs(el, part, { onChange });
  const current = ctl.current();
  onChange.mockClear();

  const ok = ctl.select(current);

  expect(ok).toBe(true);
  expect(onChange).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
nvm use && npx vitest run test/framework/view-tabs.test.js -t "select"
```
Expected: FAIL — `ctl.select is not a function`.

- [ ] **Step 3: Add `select` to the returned control**

In `src/framework/view-tabs.js`, replace the `return { current, detach }` block (lines 49-55) with:

```js
  return {
    current: () => view,
    // Programmatic switch — the click path without the click. Used by an
    // embedder (mount's handle.setView) to change tabs from outside the DOM.
    // Returns false for a name that isn't a tab so callers can validate.
    select: (name) => {
      if (name === view) return true; // already active — nothing to do
      const btn = [...el.querySelectorAll("button[data-part]")].find((b) => b.dataset.part === name);
      if (!btn) return false;
      view = name;
      saveView(partKey, view);
      setActive(btn);
      onChange(view);
      return true;
    },
    detach: () => {
      el.removeEventListener("click", onClick);
      if (generated) el.innerHTML = ""; // we generated these buttons; hand-written markup stays
    },
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
nvm use && npx vitest run test/framework/view-tabs.test.js
```
Expected: PASS (all view-tabs tests, including the three new ones).

- [ ] **Step 5: Commit**

```bash
git add src/framework/view-tabs.js test/framework/view-tabs.test.js
git commit -m "feat(view-tabs): programmatic select(name) reusing the click path"
```

---

### Task 2: `onViewChange` embedder callback in `mount()`

**Files:**
- Modify: `src/framework/mount.js:127-128` (option destructure), `src/framework/mount.js:216-220` (tabs wiring + initial emit)
- Test: `test/framework/mount.test.js` (append)

**Interfaces:**
- Consumes: Task 1's `select` (indirectly, via later tasks). Uses existing `tabsCtl.current()`.
- Produces: `mount(part, { …, onViewChange })` — a new optional callback, peer of `onBuild`/`onPick`/`onDownload`. Fires **once synchronously during mount** with the initial resolved view, then again on **every** view change (user click or programmatic `select`), always with the new view name string.

- [ ] **Step 1: Write the failing test**

Append to `test/framework/mount.test.js` (this file already mounts a real part; follow the existing mount-test helper pattern at the top of the file for `createWorker`/fixtures). Add:

```js
test("onViewChange fires once on mount with the initial view, then on each change", async () => {
  const seen = [];
  const runtime = await mountTestPart({ onViewChange: (name) => seen.push(name) });
  await runtime.ready;

  // Initial emit happened synchronously during mount, before ready resolved.
  expect(seen).toEqual([runtime.getView()]);

  const other = otherViewName(runtime); // a declared view != the current one
  runtime.setView(other);
  expect(seen).toEqual([expect.any(String), other]);

  runtime.dispose();
});
```

Note for the implementer: `mountTestPart` / `otherViewName` are thin helpers — reuse the existing mount harness in this file (grep for the existing `mount(` call and the multi-view fixture). If a two-view fixture doesn't exist yet, add one with `views: { a: {…}, b: {…} }` mirroring `view-tabs.test.js`'s `part`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
nvm use && npx vitest run test/framework/mount.test.js -t "onViewChange fires once"
```
Expected: FAIL — `seen` is empty (callback never invoked) / `runtime.setView` undefined (Task 3 adds it; this test also exercises Task 3, so it stays red until both land — acceptable, or stub `setView` via `tabsCtl` first).

- [ ] **Step 3: Destructure the option**

`src/framework/mount.js:127` — add `onViewChange` to the options:

```js
export function mount(part, { createWorker, elements = {}, onBuild, onPick, onDownload, onViewChange,
                              container: legacyContainer, controls: legacyControls } = {}) {
```

- [ ] **Step 4: Forward the name and emit the initial view**

`src/framework/mount.js:216-220` — extend the `onChange` handler and add the initial emit right after `const view = …`:

```js
    const tabsCtl = createViewTabs(els.tabs, part, {
      onChange: (name) => {
        pendingPosed.clear(); cutawayChrome.reset(); refreshView(); updateRelevance(); loop.kick(); animCtl?.autoplayKick();
        onViewChange?.(name);
      },
    });
    cleanup.defer(() => tabsCtl.detach());
    const view = () => tabsCtl.current();
    // Tell the embedder the starting tab exactly once, synchronously, so a host
    // (partforge-cloud) never has to poll getView() to learn where we opened.
    onViewChange?.(tabsCtl.current());
```

- [ ] **Step 5: Run the test to verify it passes** (after Task 3 lands, or with a temporary `setView` stub)

```bash
nvm use && npx vitest run test/framework/mount.test.js -t "onViewChange fires once"
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/framework/mount.js test/framework/mount.test.js
git commit -m "feat(mount): onViewChange embedder callback (initial + every change)"
```

---

### Task 3: `getView` / `setView` on the mount handle

**Files:**
- Modify: `src/framework/mount.js:30` (makeHandle signature), `src/framework/mount.js:561-568` (construction call)
- Test: `test/framework/mount.test.js` (append + extend the handle-shape lock at ~line 862)

**Interfaces:**
- Consumes: Task 1's `tabsCtl.select`, the existing `view` closure (`() => tabsCtl.current()`).
- Produces: handle gains `getView(): string` (never null once mounted) and `setView(name): boolean` (delegates to `tabsCtl.select`; `true` on a real tab, `false` on unknown; a real switch flows through `onViewChange`). `makeHandle` accepts `getView`/`setView` params.

- [ ] **Step 1: Write the failing tests**

Append to `test/framework/mount.test.js`:

```js
test("getView returns the active view; setView switches it and rejects unknowns", async () => {
  const runtime = await mountTestPart();
  await runtime.ready;

  const start = runtime.getView();
  expect(typeof start).toBe("string");

  const other = otherViewName(runtime);
  expect(runtime.setView(other)).toBe(true);
  expect(runtime.getView()).toBe(other);

  expect(runtime.setView("does-not-exist")).toBe(false);
  expect(runtime.getView()).toBe(other); // unchanged

  runtime.dispose();
});
```

Extend the direct-`makeHandle` shape lock (the test around line 862, "makeHandle always exposes a callable setHostPane") to assert the new members are wired through:

```js
  expect(typeof handle.getView).toBe("function");
  expect(typeof handle.setView).toBe("function");
  expect(typeof handle.captureView).toBe("function"); // added in Task 4
```

(When adding these to the existing `makeHandle({...})` fixture in that test, pass `getView: () => "a"`, `setView: () => true`, `captureView: async () => null` so the fixture stays self-contained.)

- [ ] **Step 2: Run the tests to verify they fail**

```bash
nvm use && npx vitest run test/framework/mount.test.js -t "getView returns the active view"
```
Expected: FAIL — `runtime.getView is not a function`.

- [ ] **Step 3: Add params to `makeHandle` and return them**

`src/framework/mount.js:30` — extend the destructure and the returned object:

```js
export function makeHandle({ ready, dispose, viewer, setParams, listExportableParts, exportParts, setHostPane, animation, getView, setView, captureView }) {
  return {
    ready, dispose, setParams,
    animation: animation ?? null,
    // Active view name (never null once mounted). See onViewChange for the push side.
    getView,
    // Programmatic tab switch; false for a name the part doesn't declare.
    setView,
    // Offscreen render of a named view (default when omitted). See Task 4.
    captureView,
    captureViews: (viewNames) => viewer.captureCanonicalViews(viewNames),
    // …rest unchanged…
```

(Insert `getView`, `setView`, `captureView` near the top of the returned object; leave every existing member exactly as-is.)

- [ ] **Step 4: Pass them at the construction site**

`src/framework/mount.js:561` — extend the `makeHandle({ … })` call:

```js
    return makeHandle({
      ready, dispose, viewer, setParams,
      setHostPane: paneTabs.setHostPane,
      getView: view,                         // () => tabsCtl.current()
      setView: (name) => tabsCtl.select(name),
      captureView,                           // defined in Task 4
      listExportableParts: () =>
        exportablePartNames(part, params).map((name) => ({ name, label: partLabel(part, name) })),
      exportParts: (opts) => exportCtl.exportParts(opts),
      animation: animCtl?.runtime ?? null,
    });
```

Note: `captureView` is a function defined in Task 4. To keep this task green on its own, temporarily define `const captureView = async () => null;` just above the return; Task 4 replaces that stub with the real implementation.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
nvm use && npx vitest run test/framework/mount.test.js
```
Expected: PASS (handle-shape lock + getView/setView behavior + Task 2's onViewChange test now green).

- [ ] **Step 6: Commit**

```bash
git add src/framework/mount.js test/framework/mount.test.js
git commit -m "feat(mount): getView/setView on the runtime handle"
```

---

### Task 4A: Job-correlated capture-build channel

**Why:** The live build reply (`type:"meshes"`) has **no job id** and is owned exclusively by the regen loop (`onWorkerMessage` mutates the live cache + display). `captureView` must get meshes for a (possibly non-active) view **without** touching live state, so it needs its own correlated request/reply — modeled exactly on `createExportController`'s `pending` Map (`src/framework/export-controller.js:18-65`, already consumed first in `onWorkerMessage` at `mount.js:366`).

**Files:**
- Modify: `src/framework/jobs.js` (worker: handle a new `capture-generate` message)
- Create: `src/framework/capture-build.js` (main thread: a tiny correlated request controller)
- Modify: `src/framework/mount.js:364-366` (route `capture-meshes` replies before the `meshes` case)
- Test: `test/framework/capture-build.test.js` (new), `test/jobs.test.js` (worker branch, if present — else add to `test/framework/`)

**Interfaces:**
- Consumes: `service.send(msg, backend)` (`geometry-service.js:19-38`, a dumb pipe — no change), `viewSubParts(part, view, params)` (`part-model.js:16`).
- Produces:
  - Worker: a `{ type:"capture-generate", jobId, subparts, view, params, cache }` message → replies `{ type:"capture-meshes", jobId, meshes }` using the **same** per-sub-part build+cache-round code as `generate` (so the worker's geometry memo is reused when `cache:true`). Never sets `isStale`/`superseded` semantics — it is a one-shot.
  - `createCaptureBuild({ send })` → `{ request({ subparts, view, params, backend }): Promise<meshes>, handleMessage(data): boolean, dispose() }`. `request` allocates a `jobId`, stores the resolver in a `pending` Map, calls `send({type:"capture-generate", jobId, …}, backend)`, and resolves when `handleMessage` sees the matching `capture-meshes`. `handleMessage` returns `true` when it consumed the message.

- [ ] **Step 1: Write the failing worker-branch test**

Create `test/framework/capture-build.test.js`:

```js
import { expect, test, vi } from "vitest";
import { createCaptureBuild } from "../../src/framework/capture-build.js";

test("request resolves with the meshes from the matching capture-meshes reply", async () => {
  const sent = [];
  const cb = createCaptureBuild({ send: (msg) => sent.push(msg) });

  const p = cb.request({ subparts: ["a", "b"], view: "assembly", params: {}, backend: "manifold" });

  expect(sent).toHaveLength(1);
  const { jobId, type } = sent[0];
  expect(type).toBe("capture-generate");

  const meshes = [{ name: "a" }, { name: "b" }];
  const consumed = cb.handleMessage({ type: "capture-meshes", jobId, meshes });
  expect(consumed).toBe(true);
  await expect(p).resolves.toEqual(meshes);
});

test("handleMessage ignores non-capture and unknown-jobId messages", () => {
  const cb = createCaptureBuild({ send: () => {} });
  expect(cb.handleMessage({ type: "meshes", meshes: [] })).toBe(false);
  expect(cb.handleMessage({ type: "capture-meshes", jobId: 999, meshes: [] })).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
nvm use && npx vitest run test/framework/capture-build.test.js
```
Expected: FAIL — cannot find `capture-build.js`.

- [ ] **Step 3: Implement `createCaptureBuild`**

Create `src/framework/capture-build.js`:

```js
// Correlated one-shot geometry builds for captureView — a private channel that
// does NOT go through the regen loop. Same shape as export-controller's pending
// Map: allocate a jobId, resolve when the matching capture-meshes reply arrives.
export function createCaptureBuild({ send }) {
  let nextId = 1;
  const pending = new Map(); // jobId -> resolve
  return {
    request({ subparts, view, params, backend }) {
      const jobId = nextId++;
      return new Promise((resolve) => {
        pending.set(jobId, resolve);
        // cache:true so the worker reuses its per-sub-part geometry memo (the
        // expensive CSG); only the per-view place() + meshing re-run.
        send({ type: "capture-generate", jobId, subparts, view, params, cache: true }, backend);
      });
    },
    handleMessage(data) {
      if (data?.type !== "capture-meshes") return false;
      const resolve = pending.get(data.jobId);
      if (!resolve) return false;
      pending.delete(data.jobId);
      resolve(data.meshes);
      return true;
    },
    dispose() { pending.clear(); },
  };
}
```

- [ ] **Step 4: Add the worker branch in `jobs.js`**

In `src/framework/jobs.js`, factor the per-sub-part build loop (currently in the `generate` handler, `jobs.js:56-82`) so a `capture-generate` message runs the **same** build but replies with `capture-meshes` and its `jobId`, and skips the staleness/`superseded` machinery. Minimal form:

```js
if (msg.type === "capture-generate") {
  const meshes = [];
  for (const name of msg.subparts) {
    if (msg.cache !== false) kernel.beginSubPart?.(name);
    try {
      const mesh = buildPosed(part, kernel, name, msg.view, msg.params).toMesh({ quality: "preview" });
      meshes.push({ name, ...mesh });
    } finally {
      kernel.endSubPart?.();
      kernel.cleanup?.();
    }
  }
  post({ type: "capture-meshes", jobId: msg.jobId, meshes }, transferOf(meshes));
  return;
}
```

(Reuse the existing `buildPosed`/`transfer` helpers already in scope in this file — grep for how the `generate` branch builds `transfer` from mesh buffers, and mirror it as `transferOf`.)

- [ ] **Step 5: Route capture replies in mount before the live `meshes` case**

`src/framework/mount.js` — create the controller near the geometry service (after `service` is created, ~line 444) and consume its replies first in `onWorkerMessage` (alongside `exportCtl.handleMessage`, `mount.js:366`):

```js
const captureBuild = createCaptureBuild({ send: (msg, backend) => service.send(msg, backend) });
cleanup.defer(() => captureBuild.dispose());
```
```js
// in onWorkerMessage, BEFORE `case "meshes"` and next to exportCtl.handleMessage:
if (captureBuild.handleMessage(data)) return;
```
Add the import at the top of `mount.js`: `import { createCaptureBuild } from "./capture-build.js";`

- [ ] **Step 6: Run tests**

```bash
nvm use && npx vitest run test/framework/capture-build.test.js && npx vitest run test/jobs.test.js
```
Expected: PASS (worker `capture-generate` builds; controller correlates).

- [ ] **Step 7: Commit**

```bash
git add src/framework/capture-build.js src/framework/jobs.js src/framework/mount.js test/framework/capture-build.test.js
git commit -m "feat(capture): job-correlated capture-build channel (off the regen loop)"
```

---

### Task 4B: `renderMeshPayloads` — offscreen render of an arbitrary mesh set

**Why:** `renderOffscreen` (`viewer.js:429-478`) hardcodes the live `scene`. We add a sibling that assembles a **throwaway** scene from mesh payloads and renders it from a canonical angle, reusing the exact pivot rotation, `materialFor`, `buildGeometry`, capture lights, `cameraPoseForView`, and sRGB/JPEG readback — then disposes everything.

**Files:**
- Modify: `src/framework/viewer.js` (export `buildGeometry`; refactor `renderOffscreen` to accept a `scene`; add `renderMeshPayloads`; expose it on the viewer object)
- Test: `test/framework/viewer-capture-view.test.js` (new)

**Interfaces:**
- Consumes: `buildGeometry(payload)` (`viewer.js:258`), `materialFor(name)` (`viewer.js:150`), the `pivot.rotation.x = -Math.PI/2` convention (`viewer.js:142`), `cameraPoseForView(view, { center, radius })` (`view-angles.js:23`), `createCaptureLights`/`captureLightPoses` (`viewer-lighting.js:25-66`), `srgbEncodeInPlace` (`viewer.js:29`).
- Produces: `viewer.renderMeshPayloads(payloads, { angle = "iso", size = 640, quality = 0.8 })` → a JPEG data URL string. `payloads` is the `[{name, positions, normals, indices, …}]` array from Task 4A (placement already baked by the worker `place`, shared-frame coords). Pure: it builds a local scene, renders, and disposes it; it never touches the live `scene`, `camera`, `subMesh`, or `subCache`.

- [ ] **Step 1: Write the failing test**

Create `test/framework/viewer-capture-view.test.js`. Follow the existing `viewer-*.test.js` harness (they construct a viewer against a stub canvas/GL — grep `test/framework/viewer-frame-guard.test.js` for the WebGL stub). Assert behavior, not pixels:

```js
test("renderMeshPayloads returns a JPEG data URL and leaves the live scene untouched", () => {
  const { viewer, liveCameraPos } = makeViewerWithLiveScene(); // helper per existing viewer tests
  const before = liveCameraPos();

  const url = viewer.renderMeshPayloads([cubePayload("a")], { angle: "iso", size: 64 });

  expect(url).toMatch(/^data:image\/jpeg;base64,/);
  expect(liveCameraPos()).toEqual(before);       // live camera not moved
  expect(viewer.hasSubMesh("a")).toBe(false);    // nothing added to the live scene
});
```

(`cubePayload(name)` returns a minimal `{ name, positions:Float32Array, normals, indices, triangles:12 }` unit cube — reuse any existing mesh-payload fixture in the viewer tests.)

- [ ] **Step 2: Run to verify it fails**

```bash
nvm use && npx vitest run test/framework/viewer-capture-view.test.js
```
Expected: FAIL — `viewer.renderMeshPayloads is not a function`.

- [ ] **Step 3: Export `buildGeometry` and parameterize `renderOffscreen`**

In `src/framework/viewer.js`: change `buildGeometry`'s declaration so it is reachable by `renderMeshPayloads` (it already lives in the closure — just call it directly). Refactor `renderOffscreen` (`viewer.js:429`) to take the scene as an argument with the live scene as default, so the existing callers are unchanged:

```js
// was: function renderOffscreen(pose, opts) { … renderer.render(scene, cam); … }
function renderOffscreen(pose, opts, renderScene = scene) {
  // …unchanged setup…
  renderer.render(renderScene, cam);   // viewer.js:454 — the one substantive change
  // …unchanged readback + srgbEncodeInPlace + toDataURL + finally-restore…
}
```

- [ ] **Step 4: Add `renderMeshPayloads`**

Add near the other capture closures (after `captureCurrent`, ~`viewer.js:511`):

```js
// Offscreen render of an arbitrary mesh set (a non-active view), for thumbnails.
// Assembles a throwaway pivot/partsGroup mirroring the live convention, frames it
// from a canonical angle, renders, and disposes everything. Never touches live state.
function renderMeshPayloads(payloads, { angle = "iso", size = 640, quality = 0.8 } = {}) {
  const tmpScene = new THREE.Scene();
  const tmpPivot = new THREE.Group();
  tmpPivot.rotation.x = -Math.PI / 2;          // model Z-up -> vertical, same as live pivot
  tmpScene.add(tmpPivot);
  const capLights = createCaptureLights();      // camera-relative lights (viewer-lighting.js)
  for (const l of capLights.lights) tmpScene.add(l);

  const built = [];
  const box = new THREE.Box3();
  for (const payload of payloads) {
    const geo = buildGeometry(payload);         // shared-frame coords, NOT recentred
    const mesh = new THREE.Mesh(geo, materialFor(payload.name));
    tmpPivot.add(mesh);
    built.push(mesh);
    geo.computeBoundingBox();
    box.union(geo.boundingBox);
  }
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
  const pose = cameraPoseForView(angle, { center, radius }); // view-angles.js:23

  try {
    return renderOffscreen(pose, { width: size, height: size, fov: 35, quality }, tmpScene);
  } finally {
    for (const mesh of built) { mesh.geometry.userData.edges?.dispose(); mesh.geometry.dispose(); }
    capLights.dispose?.();
  }
}
```

Expose it on the returned viewer object (where `captureCurrent`/`captureCanonicalViews` are returned): add `renderMeshPayloads,`.

- [ ] **Step 5: Run the test to verify it passes**

```bash
nvm use && npx vitest run test/framework/viewer-capture-view.test.js
```
Expected: PASS.

- [ ] **Step 6: Run the full viewer suite (guard the `renderOffscreen` refactor)**

```bash
nvm use && npx vitest run test/framework/viewer-frame-guard.test.js test/framework/viewer-pose.test.js
```
Expected: PASS — existing offscreen callers unaffected by the added `renderScene` default.

- [ ] **Step 7: Commit**

```bash
git add src/framework/viewer.js test/framework/viewer-capture-view.test.js
git commit -m "feat(viewer): renderMeshPayloads — offscreen render of a non-active view"
```

---

### Task 4C: `captureView` on the handle

**Files:**
- Modify: `src/framework/mount.js` (define `captureView`; replace the Task 3 stub; add `resolveDefaultView` import)
- Test: `test/framework/mount-capture-view.test.js` (new — boots a Manifold kernel; keep it in its own file for kernel isolation)

**Interfaces:**
- Consumes: Task 4A's `captureBuild.request(...)`, Task 4B's `viewer.renderMeshPayloads(...)`, `viewSubParts(part, view, params)`, `resolveDefaultView(part)` (`default-view.js:30`), `backendFor()` (`mount.js:194`), `params` (`mount.js:221`).
- Produces: `handle.captureView(viewName?, { size = 640, quality = 0.8, angle = "iso" }?) → Promise<string | null>`. Omitted/unknown `viewName` → `resolveDefaultView(part)`. Builds that view's sub-parts (correlated, `cache:true`), renders them offscreen, returns a JPEG data URL. Resolves `null` on any failure. **Does not** change the active view, `getView()`, `onViewChange`, or the live scene.

- [ ] **Step 1: Write the failing test**

Create `test/framework/mount-capture-view.test.js`:

```js
// @vitest-environment happy-dom
import { afterEach, expect, test } from "vitest";
// Boots a real Manifold kernel via the mount test harness. Kernel-isolated file.

test("captureView() renders the default view without disturbing the active tab", async () => {
  const runtime = await mountMultiViewPart(); // active tab = a non-default view
  await runtime.ready;
  const activeBefore = runtime.getView();

  const url = await runtime.captureView(); // no name → default view
  expect(url).toMatch(/^data:image\/jpeg;base64,/);
  expect(runtime.getView()).toBe(activeBefore); // active tab untouched

  runtime.dispose();
});

test("captureView(unknownName) falls back to the default view (non-null)", async () => {
  const runtime = await mountMultiViewPart();
  await runtime.ready;
  await expect(runtime.captureView("no-such-view")).resolves.toMatch(/^data:image\/jpeg/);
  runtime.dispose();
});
```

(`mountMultiViewPart` mounts a two-view fixture whose default view differs from the initially active tab — reuse the harness from `test/framework/mount.test.js`. The existing suite already boots the kernel for real builds; follow that setup.)

- [ ] **Step 2: Run to verify it fails**

```bash
nvm use && npx vitest run test/framework/mount-capture-view.test.js
```
Expected: FAIL — `captureView` is the Task 3 stub returning `null`, so the data-URL match fails.

- [ ] **Step 3: Implement `captureView`, replacing the stub**

`src/framework/mount.js` — add the import and replace `const captureView = async () => null;` (the Task 3 stub) with:

```js
// (top of file) import { resolveDefaultView } from "./default-view.js";

const captureView = async (viewName, opts = {}) => {
  try {
    const target = (viewName && part.views?.[viewName]) ? viewName : resolveDefaultView(part);
    const subparts = viewSubParts(part, target, params);
    if (!subparts.length) return null;
    const meshes = await captureBuild.request({ subparts, view: target, params, backend: backendFor() });
    return viewer.renderMeshPayloads(meshes, { size: 640, quality: 0.8, angle: "iso", ...opts });
  } catch {
    return null; // best-effort: a failed thumbnail never breaks the caller
  }
};
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
nvm use && npx vitest run test/framework/mount-capture-view.test.js
```
Expected: PASS.

- [ ] **Step 5: Run the whole framework suite**

```bash
nvm use && npm test
```
Expected: PASS (no regressions; handle-shape lock from Task 3 now satisfied by the real `captureView`).

- [ ] **Step 6: Commit**

```bash
git add src/framework/mount.js test/framework/mount-capture-view.test.js
git commit -m "feat(mount): captureView(name?) renders a view offscreen, default when unnamed"
```

---

### Task 5: Docs + version bump to 0.45.0

**Files:**
- Modify: `src/framework/mount.js` (the embedding-contract doc block, ~lines 86-122)
- Modify: `docs/AUTHORING-PARTS.md` (the embedding/runtime-handle section)
- Modify: `package.json` (`0.44.0` → `0.45.0`)
- Test: `test/kernel-contract.test.js` is unaffected (no kernel op change); the handle-shape lock (Task 3) is the doc's executable twin.

**Interfaces:**
- Consumes: everything above. Produces: no code — documentation + the release version the cloud plan pins.

- [ ] **Step 1: Document the four new members in the `mount.js` embedding contract**

In the embedding-contract comment (the `//   const runtime = mount(...)` block, `mount.js:86-122`), add lines describing:
```
//   runtime.getView();                  // active view name (string)
//   const off = runtime.onViewChange((name) => …); // fires once on mount + on every change
//   runtime.setView("lid");             // switch tab; false if the part has no such view
//   await runtime.captureView();        // JPEG data URL of the DEFAULT view rendered
//                                        // offscreen (pass a name for a specific view),
//                                        // never disturbing the active tab; null on failure
```
Also add `onViewChange` to the destructured-options list in that same comment (peer of `onBuild`/`onPick`/`onDownload`).

- [ ] **Step 2: Document in AUTHORING-PARTS.md**

In `docs/AUTHORING-PARTS.md`, find the runtime-handle / embedding section (the table or list that documents `setParams`/`captureCurrent`/`captureViews`/`setHostPane`) and add rows for `getView()`, `onViewChange(cb)`, `setView(name)`, and `captureView(name?, opts?)` with the same one-line semantics as Step 1. If the section notes the default-view rule, cross-reference `resolveDefaultView` / `default-view.js`.

- [ ] **Step 3: Bump the version**

Edit `package.json`: `"version": "0.44.0"` → `"version": "0.45.0"`.

- [ ] **Step 4: Full suite + smoke**

```bash
nvm use && npm test && npm run check
```
Expected: PASS (whole vitest suite; the headless smoke boots the demo apps in real Chromium).

- [ ] **Step 5: Commit**

```bash
git add src/framework/mount.js docs/AUTHORING-PARTS.md package.json
git commit -m "docs: document the view API; chore: 0.45.0"
```

---

## Release (after merge to `main`)

Not part of task execution — the human release step. Once this branch merges:

```bash
git fetch origin main
git tag v0.45.0 origin/main   # must equal package.json exactly
git push origin v0.45.0        # triggers .github/workflows/publish.yml
```
Verify `npm view partforge version` shows `0.45.0`, then the cloud plan can re-pin.

## Self-Review

- **Spec coverage:** view primitives — Tasks 1-3 (features a/b/c enablement); `captureView` offscreen default-view render — Tasks 4A-4C (feature d enablement); docs + 0.45.0 release — Task 5. All Phase-1 spec items covered.
- **Type consistency:** `select(name)→bool` (Task 1) is what `setView` delegates to (Task 3). `onViewChange(name:string)` (Task 2) matches the handle doc (Task 5). `captureView(viewName?, opts?)→Promise<string|null>` (Task 4C) matches `renderMeshPayloads(payloads, opts)→string` (Task 4B) and `captureBuild.request(...)→Promise<meshes>` (Task 4A).
- **Kernel isolation:** only Task 4C boots a kernel, in its own file.

