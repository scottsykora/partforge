# Click-to-select Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a click on the partforge 3-D viewer into a compact, semantic selection token (sub-part + local CAD point + normal + scoped param snapshot) an LLM can act on.

**Architecture:** A new isolated `src/framework/selection/` module with a hard layering rule — `resolve.js` and `format.js` are framework-free pure functions (data → data, headlessly testable); `pick.js` is the only three.js/DOM-aware file (raycast + coordinate transform). The viewer exposes the minimal handles `pick.js` needs. `mount.js` wires it all behind `?pick`, off by default. v1 ships the **L0** geometric anchor end-to-end; **L1** face-typing is designed-for in `resolve.js` (it accepts an optional `hit.face`) but `pick.js` never populates it yet.

**Tech Stack:** Node 24, ESM, Vite 8, three.js 0.184, Vitest 4 (+ happy-dom for DOM tests).

## Global Constraints

- **Repo:** all work lands in the **partforge** repo (this directory), not Robot KB.
- **Node:** `>=24` (`.nvmrc` pins it); ESM only (`"type": "module"`).
- **No new dependencies.** Use three.js (already present) and the existing test stack only.
- **License:** MIT (module ships inside partforge).
- **The core stays pure:** `resolve.js` and `format.js` import nothing from three.js, the DOM, or the geometry kernel. Only `param-deps.js` is allowed in `resolve.js`.
- **Units:** millimetres. Points quantize to **0.01 mm**; normals snap to an axis when within **3°** (cos 3° ≈ 0.99863).
- **DOM tests** start with `// @vitest-environment happy-dom` (the repo default env is node).
- **Commits:** conventional-commit subjects; every commit message ends with the
  `Co-Authored-By:` and `Claude-Session:` trailers configured for this session.
- **Run all tests** with `npm test` (`vitest run`); single file with `npx vitest run <path>`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/framework/selection/resolve.js` (new) | Pure core: `resolveSelection`, plus `quantizePoint` / `snapNormal` helpers. |
| `src/framework/selection/format.js` (new) | Pure serializer: `formatSelection` (`token` / `json` / `prompt`). |
| `src/framework/selection/pick.js` (new) | Viewer adapter: `attachPicker`, `worldToSubPartLocal`. Only three.js-aware file. |
| `src/framework/selection/index.js` (new) | Public surface — re-exports the three. |
| `src/framework/viewer.js` (modify) | Expose `camera`, `domElement`, `_subMeshes`, `flashPoint`; name each sub-mesh. |
| `src/framework/mount.js` (modify) | `?pick` parsing + Pick toggle button + toast + default clipboard `onPick`. |
| `test/selection-resolve.test.js` (new) | Unit tests for `resolve.js`. |
| `test/selection-format.test.js` (new) | Unit tests for `format.js`. |
| `test/selection-pick.test.js` (new) | Unit tests for `worldToSubPartLocal` + an `attachPicker` happy-path. |
| `test/selection-index.test.js` (new) | Asserts the public surface re-exports. |

---

## Task 1: `resolve.js` — pure core

**Files:**
- Create: `src/framework/selection/resolve.js`
- Test: `test/selection-resolve.test.js`

**Interfaces:**
- Consumes: `subPartReadKeys`, `RELEVANT_ALL` from `../param-deps.js`.
- Produces:
  - `resolveSelection(part, ctx, hit) → Selection`
    - `ctx = { view, params, derived }`
    - `hit = { subPart: string, pointLocal: [x,y,z], normalLocal: [x,y,z], face?: { kind, axis?, radius? } }`
    - `Selection = { subPart, point:[x,y,z], normal:[x,y,z], params:{}, feature?:{ kind, axis?, radius?, selector } }`
  - `quantizePoint([x,y,z]) → [x,y,z]` (round to 0.01 mm, no `-0`)
  - `snapNormal([x,y,z]) → [x,y,z]` (unit; snapped to ±axis within 3°, else normalized+quantized)

- [ ] **Step 1: Write the failing test**

```js
// test/selection-resolve.test.js
import { expect, test } from "vitest";
import { resolveSelection, quantizePoint, snapNormal } from "../src/framework/selection/resolve.js";

const view = { v: { label: "V" } };
const part = {
  defaults: { a: 1, b: 2 }, views: view,
  parts: {
    one: { views: ["v"], build: (k, p) => k.cylinder(p.a, p.a, p.a) },        // reads a only
    two: { views: ["v"], build: (k, p) => k.box([0, 0, 0], [p.b, p.b, p.b]) }, // reads b only
  },
};
const ctx = { view: "v", params: { a: 1, b: 2 }, derived: {} };

test("quantizePoint rounds to 0.01mm and removes -0", () => {
  expect(quantizePoint([0.004, 5.2349, -0.001])).toEqual([0, 5.23, 0]);
});

test("snapNormal snaps a near-axis vector to the exact axis", () => {
  expect(snapNormal([0.999, 0.02, 0.0])).toEqual([1, 0, 0]);
  expect(snapNormal([0, -1.0, 0])).toEqual([0, -1, 0]);
});

test("snapNormal leaves an off-axis vector normalized (quantized)", () => {
  const n = snapNormal([1, 1, 0]);
  expect(n[0]).toBeCloseTo(0.71, 2);
  expect(n[1]).toBeCloseTo(0.71, 2);
  expect(n[2]).toBe(0);
});

test("L0: scopes params to the clicked sub-part's read keys, quantizes, snaps", () => {
  const sel = resolveSelection(part, ctx, {
    subPart: "one", pointLocal: [0, 0, 5.2349], normalLocal: [0.999, 0, 0.02],
  });
  expect(sel.subPart).toBe("one");
  expect(sel.point).toEqual([0, 0, 5.23]);
  expect(sel.normal).toEqual([1, 0, 0]);
  expect(sel.params).toEqual({ a: 1 });   // sub-part "one" reads only `a`
  expect(sel.feature).toBeUndefined();     // no face metadata → L0 only
});

test("L1: when hit.face is present, emits a finder-ready selector", () => {
  const sel = resolveSelection(part, ctx, {
    subPart: "one", pointLocal: [0, 0, 5.2], normalLocal: [1, 0, 0],
    face: { kind: "cylinder", axis: "Z", radius: 1.7 },
  });
  expect(sel.feature).toEqual({
    kind: "cylinder", axis: "Z", radius: 1.7,
    selector: { dir: "Z", near: [0, 0, 5.2] },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/selection-resolve.test.js`
Expected: FAIL — `Failed to resolve import "../src/framework/selection/resolve.js"`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/framework/selection/resolve.js
// Pure core: turn a backend-agnostic raycast hit into a semantic Selection.
// No three.js, no DOM, no kernel — only the param-deps read-key analysis.
import { subPartReadKeys, RELEVANT_ALL } from "../param-deps.js";

const COS_3DEG = 0.99863; // a normal within 3° of an axis snaps to that axis
const q2 = (x) => { const r = Math.round(x * 100) / 100; return r === 0 ? 0 : r; }; // 0.01mm, kill -0

export function quantizePoint(p) {
  return [q2(p[0]), q2(p[1]), q2(p[2])];
}

export function snapNormal(n) {
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const u = [n[0] / len, n[1] / len, n[2] / len];
  let ai = 0; // index of the dominant axis
  if (Math.abs(u[1]) > Math.abs(u[ai])) ai = 1;
  if (Math.abs(u[2]) > Math.abs(u[ai])) ai = 2;
  if (Math.abs(u[ai]) >= COS_3DEG) {
    const axis = [0, 0, 0];
    axis[ai] = u[ai] > 0 ? 1 : -1;
    return axis;
  }
  return [q2(u[0]), q2(u[1]), q2(u[2])];
}

// Only the params the clicked sub-part actually reads — "this geometry, at these inputs".
function scopeParams(part, view, params, subPart) {
  const reads = subPartReadKeys(part, view, params);
  const keys = reads === RELEVANT_ALL
    ? Object.keys(params)
    : [...(reads.get(subPart) ?? Object.keys(params))];
  const out = {};
  for (const k of keys) out[k] = params[k];
  return out;
}

export function resolveSelection(part, ctx, hit) {
  const point = quantizePoint(hit.pointLocal);
  const selection = {
    subPart: hit.subPart,
    point,
    normal: snapNormal(hit.normalLocal),
    params: scopeParams(part, ctx.view, ctx.params, hit.subPart),
  };
  if (hit.face) {
    // L1 — feature.selector is the author's own { dir, inPlane, at, near } vocabulary,
    // so the LLM can drop it straight into a faces(...)/edges(...) call.
    const feature = { kind: hit.face.kind, selector: { near: point } };
    if (hit.face.axis != null) { feature.axis = hit.face.axis; feature.selector.dir = hit.face.axis; }
    if (hit.face.radius != null) feature.radius = hit.face.radius;
    selection.feature = feature;
  }
  return selection;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/selection-resolve.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/selection/resolve.js test/selection-resolve.test.js
git commit -m "feat: add selection resolve core (L0 anchor + L1 selector)"
```

---

## Task 2: `format.js` — serializer

**Files:**
- Create: `src/framework/selection/format.js`
- Test: `test/selection-format.test.js`

**Interfaces:**
- Consumes: a `Selection` object (Task 1's `resolveSelection` output shape).
- Produces: `formatSelection(selection, { style } = {}) → string | object`
  - `style: "token"` (default) → compact one-line string
  - `style: "json"` → the `Selection` object (returned as-is)
  - `style: "prompt"` → one natural-language sentence (string)

- [ ] **Step 1: Write the failing test**

```js
// test/selection-format.test.js
import { expect, test } from "vitest";
import { formatSelection } from "../src/framework/selection/format.js";

const L0 = { subPart: "spacer", point: [0, 0, 5.2], normal: [1, 0, 0], params: { bore: 3.4, h: 10 } };
const L1 = { ...L0, feature: { kind: "cylinder", axis: "Z", radius: 1.7, selector: { dir: "Z", near: [0, 0, 5.2] } } };

test("token style: L0 line", () => {
  expect(formatSelection(L0)).toBe("@spacer · pt(0,0,5.2) n(+X) · {bore:3.4,h:10}");
});

test("token style: L1 prepends the typed face", () => {
  expect(formatSelection(L1, { style: "token" }))
    .toBe("@spacer · cyl-face r=1.7 axis=Z · pt(0,0,5.2) n(+X) · {bore:3.4,h:10}");
});

test("token style: off-axis normal prints as a tuple", () => {
  const s = { ...L0, normal: [0.71, 0.71, 0] };
  expect(formatSelection(s)).toContain("n(0.71,0.71,0)");
});

test("json style returns the object unchanged", () => {
  expect(formatSelection(L1, { style: "json" })).toEqual(L1);
});

test("prompt style is a natural-language sentence", () => {
  const s = formatSelection(L0, { style: "prompt" });
  expect(s).toContain("spacer");
  expect(s).toContain("(0, 0, 5.2)");
  expect(s).toContain("bore: 3.4");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/selection-format.test.js`
Expected: FAIL — cannot resolve `format.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/framework/selection/format.js
// Pure serializer. No three.js, no DOM. Three styles for the same Selection:
//   token  — compact clipboard/CLI line
//   json   — the structured object (embedded tool-call transport)
//   prompt — one natural-language sentence an LLM ingests well
const AXIS_LABEL = { "1,0,0": "+X", "-1,0,0": "-X", "0,1,0": "+Y", "0,-1,0": "-Y", "0,0,1": "+Z", "0,0,-1": "-Z" };

const fmtNormal = (n) => AXIS_LABEL[n.join(",")] ?? `(${n.join(",")})`;
const fmtParams = (p) => Object.entries(p).map(([k, v]) => `${k}:${v}`).join(",");

function tokenStyle(s) {
  const head = `@${s.subPart}`;
  const feat = s.feature
    ? ` · ${s.feature.kind === "cylinder"
        ? `cyl-face r=${s.feature.radius} axis=${s.feature.axis}`
        : `${s.feature.kind}-face`}`
    : "";
  return `${head}${feat} · pt(${s.point.join(",")}) n(${fmtNormal(s.normal)}) · {${fmtParams(s.params)}}`;
}

function promptStyle(s) {
  const params = Object.entries(s.params).map(([k, v]) => `${k}: ${v}`).join(", ");
  const feat = s.feature ? ` a ${s.feature.kind} face,` : "";
  return `On sub-part **${s.subPart}**, the user pointed at${feat} local point (${s.point.join(", ")}), `
    + `normal ${fmtNormal(s.normal)}, with params {${params}}.`;
}

export function formatSelection(selection, { style = "token" } = {}) {
  if (style === "json") return selection;
  if (style === "prompt") return promptStyle(selection);
  return tokenStyle(selection);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/selection-format.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/selection/format.js test/selection-format.test.js
git commit -m "feat: add selection token/json/prompt serializer"
```

---

## Task 3: viewer exposure + `flashPoint`

**Files:**
- Modify: `src/framework/viewer.js` (sub-mesh creation loop ~line 79; the return statement at line 229)

**Interfaces:**
- Consumes: nothing new.
- Produces (new on the viewer object returned by `createViewer`):
  - `camera` — the `THREE.PerspectiveCamera`
  - `domElement` — `renderer.domElement`
  - `_subMeshes` — `{ [name]: THREE.Mesh }` (each mesh has `.name === name`)
  - `flashPoint([x,y,z]world) → void` — drop a small marker at a world point for ~1.2 s

This file instantiates `WebGLRenderer`, so it is **not** headlessly unit-testable; verify via the existing `npm run check` smoke (boots a real app in Chromium) and `npm run build`.

- [ ] **Step 1: Name each sub-mesh**

In the sub-mesh creation block (currently):

```js
  const subMesh = Object.fromEntries(
    names.map((n) => [n, new THREE.Mesh(new THREE.BufferGeometry(), materialFor(n))])
  );
  for (const m of Object.values(subMesh)) {
    m.visible = false;
    partsGroup.add(m);
  }
```

replace the loop so each mesh carries its sub-part name (used to identify a raycast hit):

```js
  const subMesh = Object.fromEntries(
    names.map((n) => [n, new THREE.Mesh(new THREE.BufferGeometry(), materialFor(n))])
  );
  for (const [n, m] of Object.entries(subMesh)) {
    m.name = n;
    m.visible = false;
    partsGroup.add(m);
  }
```

- [ ] **Step 2: Add `flashPoint` (place just above the `return` at the end of `createViewer`)**

```js
  // Transient marker at a world-space point — visual confirmation of a pick.
  function flashPoint(world) {
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(1.2, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffcc33, depthTest: false })
    );
    dot.renderOrder = 999;
    dot.position.set(world[0], world[1], world[2]);
    scene.add(dot);
    setTimeout(() => { scene.remove(dot); dot.geometry.dispose(); dot.material.dispose(); }, 1200);
  }
```

- [ ] **Step 3: Extend the return**

Change the final return from:

```js
  return { showAssembly, hideAssembly, setSubGeometry, resize, dispose, frame, setAutoRotate, setTheme, getCameraState, setCameraState, onCameraEnd, _subCache: subCache };
```

to:

```js
  return { showAssembly, hideAssembly, setSubGeometry, resize, dispose, frame, setAutoRotate, setTheme, getCameraState, setCameraState, onCameraEnd, _subCache: subCache, camera, domElement: renderer.domElement, _subMeshes: subMesh, flashPoint };
```

- [ ] **Step 4: Verify nothing regressed**

Run: `npm test`
Expected: PASS (existing suite unchanged — no test imports the viewer directly).

Run: `npm run build`
Expected: build completes with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/framework/viewer.js
git commit -m "feat: expose camera/meshes and add flashPoint to the viewer"
```

---

## Task 4: `pick.js` — viewer adapter

**Files:**
- Create: `src/framework/selection/pick.js`
- Test: `test/selection-pick.test.js`

**Interfaces:**
- Consumes:
  - `resolveSelection` from `./resolve.js`
  - a viewer exposing `camera`, `domElement`, `_subMeshes`, `flashPoint` (Task 3)
- Produces:
  - `worldToSubPartLocal(mesh, world) → [x,y,z]` — invert the mesh's world transform (pivot rotation + per-view recentring) to recover shared-frame CAD coords. `world` may be a `THREE.Vector3` or `[x,y,z]`.
  - `attachPicker(viewer, { part, getContext, onPick }) → { setActive(bool), detach() }`
    - `getContext() → { view, params, derived }` (supplied by the caller; read fresh per click)
    - On a click while active: raycast visible sub-meshes; on a hit, build `hit`, call `resolveSelection`, `viewer.flashPoint(worldPoint)`, then `onPick(selection)`.

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import * as THREE from "three";
import { worldToSubPartLocal, attachPicker } from "../src/framework/selection/pick.js";

const view = { v: { label: "V" } };
const part = {
  defaults: { a: 1 }, views: view,
  parts: { one: { views: ["v"], build: (k, p) => k.cylinder(p.a, p.a, p.a) } },
};

test("worldToSubPartLocal inverts the pivot rotation + recentring", () => {
  // Replicate the viewer's hierarchy: pivot (rot x=-90°) → partsGroup (offset) → mesh.
  const pivot = new THREE.Group();
  pivot.rotation.x = -Math.PI / 2;
  const partsGroup = new THREE.Group();
  partsGroup.position.set(-5, 0, 0); // recentre offset
  pivot.add(partsGroup);
  const mesh = new THREE.Mesh(new THREE.BufferGeometry());
  partsGroup.add(mesh);
  pivot.updateMatrixWorld(true);

  // A CAD-local point (2,0,3) maps to some world point; the helper must round-trip it.
  const local = new THREE.Vector3(2, 0, 3);
  const world = mesh.localToWorld(local.clone());
  const back = worldToSubPartLocal(mesh, world);
  expect(back[0]).toBeCloseTo(2, 5);
  expect(back[1]).toBeCloseTo(0, 5);
  expect(back[2]).toBeCloseTo(3, 5);
});

afterEach(() => { document.body.innerHTML = ""; });

test("attachPicker raycasts a click and delivers a resolved selection", () => {
  // Camera at +Z looking at origin; a unit box at origin fills the centre of the view.
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4));
  mesh.name = "one";
  mesh.visible = true;
  mesh.updateMatrixWorld(true);

  const domElement = document.createElement("div");
  domElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  document.body.appendChild(domElement);

  const flashPoint = vi.fn();
  const viewer = { camera, domElement, _subMeshes: { one: mesh }, flashPoint };
  const onPick = vi.fn();
  const picker = attachPicker(viewer, {
    part,
    getContext: () => ({ view: "v", params: { a: 1 }, derived: {} }),
    onPick,
  });
  picker.setActive(true);

  // Click dead-centre → NDC (0,0) → ray hits the box.
  domElement.dispatchEvent(new MouseEvent("click", { clientX: 100, clientY: 100, bubbles: true }));

  expect(onPick).toHaveBeenCalledTimes(1);
  expect(onPick.mock.calls[0][0].subPart).toBe("one");
  expect(flashPoint).toHaveBeenCalledTimes(1);
  picker.detach();
});

test("clicks do nothing when the picker is inactive", () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  const domElement = document.createElement("div");
  domElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  document.body.appendChild(domElement);
  const onPick = vi.fn();
  const picker = attachPicker({ camera, domElement, _subMeshes: {}, flashPoint: () => {} }, {
    part, getContext: () => ({ view: "v", params: {}, derived: {} }), onPick,
  });
  domElement.dispatchEvent(new MouseEvent("click", { clientX: 10, clientY: 10, bubbles: true }));
  expect(onPick).not.toHaveBeenCalled();
  picker.detach();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/selection-pick.test.js`
Expected: FAIL — cannot resolve `pick.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/framework/selection/pick.js
// Viewer adapter — the ONLY three.js/DOM-aware file in the selection module.
// Raycasts a click against the visible sub-meshes, converts the hit to the
// sub-part's local CAD frame, and hands a resolved Selection to onPick.
import * as THREE from "three";
import { resolveSelection } from "./resolve.js";

// Invert the mesh's world transform (pivot rotation + per-view recentring) to recover
// shared-frame CAD coords — the same frame build() models in.
export function worldToSubPartLocal(mesh, world) {
  const v = Array.isArray(world) ? new THREE.Vector3(world[0], world[1], world[2]) : world.clone();
  mesh.worldToLocal(v);
  return [v.x, v.y, v.z];
}

export function attachPicker(viewer, { part, getContext, onPick }) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let active = false;

  function onClick(ev) {
    if (!active) return;
    const rect = viewer.domElement.getBoundingClientRect();
    ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, viewer.camera);

    const meshes = Object.values(viewer._subMeshes).filter((m) => m.visible);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return;

    const selection = resolveSelection(part, getContext(), {
      subPart: hit.object.name,
      pointLocal: worldToSubPartLocal(hit.object, hit.point),
      // face.normal is in the geometry's local frame, which equals the CAD frame here
      // (the mesh carries no local transform; only its parents rotate/recentre).
      normalLocal: hit.face ? [hit.face.normal.x, hit.face.normal.y, hit.face.normal.z] : [0, 0, 0],
      // hit.face metadata (kind/axis/radius) is the L1 increment — not populated yet.
    });
    viewer.flashPoint([hit.point.x, hit.point.y, hit.point.z]);
    onPick(selection);
  }

  viewer.domElement.addEventListener("click", onClick);
  return {
    setActive: (on) => { active = !!on; },
    detach: () => viewer.domElement.removeEventListener("click", onClick),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/selection-pick.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/selection/pick.js test/selection-pick.test.js
git commit -m "feat: add raycast picker + worldToSubPartLocal transform"
```

---

## Task 5: public surface + `?pick` wiring

**Files:**
- Create: `src/framework/selection/index.js`
- Test: `test/selection-index.test.js`
- Modify: `src/framework/mount.js`

**Interfaces:**
- Consumes: `resolveSelection`, `formatSelection`, `attachPicker`, `worldToSubPartLocal` from the module files; the viewer (Task 3) and `part`/`view`/`params` already in scope inside `mount`.
- Produces: `src/framework/selection/index.js` re-exporting the four functions. `mount` activates a Pick toggle under `?pick`.

- [ ] **Step 1: Write the failing index test**

```js
// test/selection-index.test.js
import { expect, test } from "vitest";
import * as selection from "../src/framework/selection/index.js";

test("the module re-exports its public surface", () => {
  expect(typeof selection.resolveSelection).toBe("function");
  expect(typeof selection.formatSelection).toBe("function");
  expect(typeof selection.attachPicker).toBe("function");
  expect(typeof selection.worldToSubPartLocal).toBe("function");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/selection-index.test.js`
Expected: FAIL — cannot resolve `index.js`.

- [ ] **Step 3: Write `index.js`**

```js
// src/framework/selection/index.js
// Public surface for the click-to-select module. The future agent harness depends
// only on attachPicker's onPick callback + the Selection contract — nothing else.
export { resolveSelection, quantizePoint, snapNormal } from "./resolve.js";
export { formatSelection } from "./format.js";
export { attachPicker, worldToSubPartLocal } from "./pick.js";
```

- [ ] **Step 4: Run the index test to verify it passes**

Run: `npx vitest run test/selection-index.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Wire `?pick` into `mount.js`**

Add the import near the other framework imports at the top of `mount.js` (alongside `import { createDebugOverlay } from "./debug-overlay.js";`):

```js
import { attachPicker, formatSelection } from "./selection/index.js";
```

After the viewer is created and `view`/`params` are in scope (place this block next to the `?debug` overlay activation — search for `const debug = qs.has("debug");`), add:

```js
  // ?pick enables click-to-select: a toggle button + a transient toast. Off by
  // default — no button, no listener, no behavior change. Deleting this block and
  // the selection/ dir reverts the app exactly.
  if (qs.has("pick")) {
    const btn = document.createElement("button");
    btn.id = "pf-pick";
    btn.textContent = "Pick";
    btn.title = "Click a surface to copy a selection token";
    Object.assign(btn.style, {
      position: "fixed", left: "12px", bottom: "12px", zIndex: 9999,
      font: "12px system-ui, sans-serif", padding: "6px 10px", cursor: "pointer",
    });
    document.body.appendChild(btn);

    const toast = document.createElement("div");
    Object.assign(toast.style, {
      position: "fixed", left: "12px", bottom: "48px", zIndex: 9999, maxWidth: "60ch",
      font: "12px ui-monospace, monospace", padding: "6px 10px", borderRadius: "4px",
      background: "rgba(20,24,29,0.92)", color: "#d8e0ea", display: "none",
      whiteSpace: "pre-wrap", wordBreak: "break-word",
    });
    document.body.appendChild(toast);

    const picker = attachPicker(viewer, {
      part,
      getContext: () => ({ view, params, derived: part.derive ? part.derive({ ...part.defaults, ...params }) : {} }),
      onPick: (selection) => {
        const token = formatSelection(selection, { style: "token" });
        navigator.clipboard?.writeText(token);
        toast.textContent = `copied: ${token}`;
        toast.style.display = "block";
        setTimeout(() => { toast.style.display = "none"; }, 4000);
      },
    });

    btn.addEventListener("click", () => {
      const on = !btn.classList.toggle("on");
      picker.setActive(!on);
      btn.style.outline = btn.classList.contains("on") ? "2px solid #ffcc33" : "";
    });
  }
```

> If `part`, `view`, `params`, or `viewer` are named differently or not yet in scope at the insertion point, move the block lower in `mount` so all four are defined. Do not rename them.

- [ ] **Step 6: Verify the suite and a real boot**

Run: `npm test`
Expected: PASS (full suite, including the new selection tests).

Run: `npm run build`
Expected: build completes with no errors.

(Manual, optional but recommended: `npm run dev`, open `/demo.html?pick`, toggle **Pick**, click the spacer, confirm a `copied: @spacer · pt(…) n(…) · {…}` toast and a clipboard token. Without `?pick`, confirm no Pick button appears.)

- [ ] **Step 7: Commit**

```bash
git add src/framework/selection/index.js test/selection-index.test.js src/framework/mount.js
git commit -m "feat: expose selection module and wire ?pick toggle into mount"
```

---

## Self-review notes

- **Spec coverage:** module shape & 4-file boundary (Tasks 1,2,4,5) ✓; `Selection` contract incl. scoped params + L1 `feature.selector` (Task 1) ✓; progressive L0-ships / L1-designed-for-but-deferred (`resolve.js` accepts `hit.face`; `pick.js` never sets it) ✓; coordinate transform as a tested pure helper `worldToSubPartLocal` (Task 4) ✓; three output styles (Task 2) ✓; `?pick` opt-in mirroring `?debug`, self-created DOM, clean removal (Task 5) ✓; the `onPick` + `Selection` seam for the future harness (Tasks 4,5) ✓; quantization 0.01 mm / normal-snap 3° (Task 1) ✓; testing plan headless for pure files, smoke for browser files ✓.
- **Out of scope (correctly absent):** the agent harness, L1 face-id mesh plumbing, pins/annotations (B), screenshot-context (C), `parseToken`, persistence/multi-select.
- **Type consistency:** `Selection`, `hit { subPart, pointLocal, normalLocal, face? }`, and `ctx { view, params, derived }` are identical across resolve/format/pick/mount; viewer additions `camera`/`domElement`/`_subMeshes`/`flashPoint` match `pick.js`'s consumption.
- **Placeholders:** none — every code step is complete.
