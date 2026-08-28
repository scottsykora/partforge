# Annotation Ray Helpers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed a precomputed parts-frame pick ray in every sketch-payload anchor, and ship `annotationRay`/`rayPlane` reconstruction helpers on `partforge/oracle`, so an agent can place sketch geometry in part-space millimetres without reimplementing camera math.

**Architecture:** A new pure-math leaf `src/framework/oracle/annotation-ray.js` (no imports at all) implements both helpers; `src/oracle.js` re-exports them. `annotate-mode.js` gains a `partsInverse()` extraction and embeds per-anchor rays computed from the live `THREE.Raycaster` (origin canonicalized to the point nearest the camera position, so it is definitionally identical to the helper's output), rounded to 4 decimals. Everything is additive within ANNOTATION_VERSION 3.

**Tech Stack:** plain ESM JavaScript, vitest, three (test + annotate-mode side only — never in the oracle module).

**Spec:** `docs/superpowers/specs/2026-08-28-annotation-ray-design.md`

## Global Constraints

- `src/framework/oracle/annotation-ray.js` must be DOM-free, `three`-free, `node:`-free, and import **nothing** (`test/worker-layering.test.js` polices the folder).
- Error messages are exact, copied from the spec: `annotationRay: payload.camera.parts is null — the sketch was sent with no meshes (use { frame: "world" })`; `annotationRay: frame must be "parts" or "world"`; `annotationRay: screen must be [x, y] with each in 0..1`; `annotationRay: payload has no camera/viewport block`; `rayPlane: ray must be {origin, dir}`; `rayPlane: plane must be {point, normal} or "xy"|"yz"|"zx"`.
- Payload numbers round to 4 decimals (`round4`), matching the existing camera block. ANNOTATION_VERSION stays **3**; the anchor `ray` key is **omitted** (absent, not `null`) when `camera.parts` is `null`.
- `rayPlane` misses return `null` (parallel: `|denom| < 1e-9`; at/behind origin: `t ≤ 1e-6`) — never throws for a miss.
- No version bump: this branch already carries the unpublished 0.88.0 bump from PR #178, and the feature ships inside it.
- Every command below needs Node 24 first: `export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | sort -V | tail -1)/bin:$PATH"`.

---

### Task 1: `annotation-ray.js` — the pure helpers

**Files:**
- Create: `src/framework/oracle/annotation-ray.js`
- Test: `test/framework/oracle/annotation-ray.test.js` (new file)

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `annotationRay(payload, screen, { frame = "parts" } = {}) → { origin: number[3], dir: number[3] }` and `rayPlane(ray, plane) → { point: number[3], t: number } | null`. Task 2 re-exports these names verbatim; Task 3's tests import `annotationRay` from this path.

- [ ] **Step 1: Write the failing tests**

Create `test/framework/oracle/annotation-ray.test.js`:

```js
// Pure-math reconstruction of sketch-payload pick rays, and ray-plane
// intersection. Parity target: THREE.Raycaster.setFromCamera (spec
// 2026-08-28-annotation-ray-design.md).
import { expect, test } from "vitest";
import * as THREE from "three";
import { annotationRay, rayPlane } from "../../../src/framework/oracle/annotation-ray.js";

// A minimal v3-shaped payload: same camera in both frames so either can be
// exercised; aspect matches the camera.
const payload = (cam, aspect = 2) => ({
  camera: { world: cam, parts: cam },
  viewport: { aspect },
});

const PERSP = {
  pos: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0],
  projection: "perspective", fov: 90, orthoHeight: null,
};
const ORTHO = {
  pos: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0],
  projection: "orthographic", fov: null, orthoHeight: 40,
};

test("perspective: center ray runs along forward from the camera position", () => {
  const { origin, dir } = annotationRay(payload(PERSP), [0.5, 0.5]);
  expect(origin).toEqual([0, 0, 10]);
  expect(dir[0]).toBeCloseTo(0, 12);
  expect(dir[1]).toBeCloseTo(0, 12);
  expect(dir[2]).toBeCloseTo(-1, 12);
});

test("perspective: right edge tilts by tan(fov/2)·aspect", () => {
  // fov 90 → tan 45° = 1; aspect 2 → unnormalized dir [2, 0, -1]
  const { dir } = annotationRay(payload(PERSP), [1, 0.5]);
  const len = Math.hypot(2, 0, 1);
  expect(dir[0]).toBeCloseTo(2 / len, 12);
  expect(dir[1]).toBeCloseTo(0, 12);
  expect(dir[2]).toBeCloseTo(-1 / len, 12);
});

test("orthographic: origin slides in the camera plane, dir stays forward", () => {
  // screen [0,0] = top-left → nx −1, ny +1 → origin [−40, 20, 10]
  const { origin, dir } = annotationRay(payload(ORTHO), [0, 0]);
  expect(origin[0]).toBeCloseTo(-40, 12);
  expect(origin[1]).toBeCloseTo(20, 12);
  expect(origin[2]).toBeCloseTo(10, 12);
  expect(dir).toEqual([0, 0, -1]);
});

test("anchor objects pass straight through via their .screen", () => {
  const direct = annotationRay(payload(PERSP), [0.25, 0.75]);
  const viaAnchor = annotationRay(payload(PERSP), { at: "mid", screen: [0.25, 0.75], hit: null });
  expect(viaAnchor).toEqual(direct);
});

test("frame selection and its errors", () => {
  const p = payload(PERSP);
  expect(annotationRay(p, [0.5, 0.5], { frame: "world" }))
    .toEqual(annotationRay(p, [0.5, 0.5])); // same cam in both frames here
  expect(() => annotationRay({ ...p, camera: { world: PERSP, parts: null } }, [0.5, 0.5]))
    .toThrow('annotationRay: payload.camera.parts is null — the sketch was sent with no meshes (use { frame: "world" })');
  expect(() => annotationRay(p, [0.5, 0.5], { frame: "screen" }))
    .toThrow('annotationRay: frame must be "parts" or "world"');
  expect(() => annotationRay(p, [0.5, 1.5]))
    .toThrow("annotationRay: screen must be [x, y] with each in 0..1");
  expect(() => annotationRay({ camera: { parts: PERSP }, viewport: {} }, [0.5, 0.5]))
    .toThrow("annotationRay: payload has no camera/viewport block");
});

test("rayPlane: shorthand planes, custom planes, and t units", () => {
  const ray = { origin: [0, 0, 10], dir: [0, 0, -1] };
  expect(rayPlane(ray, "xy")).toEqual({ point: [0, 0, 0], t: 10 });
  const custom = rayPlane(ray, { point: [0, 0, 2], normal: [0, 0, 1] });
  expect(custom.t).toBeCloseTo(8, 12);
  expect(custom.point[2]).toBeCloseTo(2, 12);
  // yz and zx pass through the origin with x/y normals
  expect(rayPlane({ origin: [5, 0, 0], dir: [-1, 0, 0] }, "yz").t).toBe(5);
  expect(rayPlane({ origin: [0, 5, 0], dir: [0, -1, 0] }, "zx").t).toBe(5);
});

test("rayPlane misses return null: parallel and behind-origin", () => {
  expect(rayPlane({ origin: [0, 0, 10], dir: [1, 0, 0] }, "xy")).toBeNull();
  expect(rayPlane({ origin: [0, 0, -5], dir: [0, 0, -1] }, "xy")).toBeNull();
  // degenerate zero vectors fall out as parallel, not as a throw
  expect(rayPlane({ origin: [0, 0, 1], dir: [0, 0, 0] }, "xy")).toBeNull();
});

test("rayPlane input validation", () => {
  expect(() => rayPlane({ origin: [0, 0, 0] }, "xy"))
    .toThrow("rayPlane: ray must be {origin, dir}");
  expect(() => rayPlane({ origin: [0, 0, 1], dir: [0, 0, -1] }, "top"))
    .toThrow('rayPlane: plane must be {point, normal} or "xy"|"yz"|"zx"');
});

// ---- parity with three ------------------------------------------------------
// The helper must reproduce THREE.Raycaster.setFromCamera. Directions compare
// directly; origins compare after canonicalizing three's origin to the point
// on the ray line nearest the camera position (a no-op for perspective, the
// near-plane → camera-plane slide for orthographic) — the same
// canonicalization annotate-mode applies to embedded rays.
const GRID = [0, 0.25, 0.5, 0.75, 1];

function canonicalize(ray, camPos) {
  const toCam = camPos.clone().sub(ray.origin);
  return ray.origin.clone().add(ray.direction.clone().multiplyScalar(toCam.dot(ray.direction)));
}

function checkParity(camera, camBlock, aspect) {
  camera.lookAt(new THREE.Vector3(...camBlock.target));
  camera.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster();
  for (const sx of GRID) for (const sy of GRID) {
    raycaster.setFromCamera(new THREE.Vector2(2 * sx - 1, 1 - 2 * sy), camera);
    const mine = annotationRay(payload(camBlock, aspect), [sx, sy]);
    const threeOrigin = canonicalize(raycaster.ray, camera.position);
    for (let i = 0; i < 3; i++) {
      expect(mine.dir[i]).toBeCloseTo(raycaster.ray.direction.getComponent(i), 6);
      expect(mine.origin[i]).toBeCloseTo(threeOrigin.getComponent(i), 6);
    }
  }
}

test("parity with THREE.Raycaster: perspective, off-axis camera", () => {
  const cam = {
    pos: [30, 40, 50], target: [1, 2, 3], up: [0, 1, 0],
    projection: "perspective", fov: 45, orthoHeight: null,
  };
  const camera = new THREE.PerspectiveCamera(45, 2, 0.1, 1000);
  camera.position.set(...cam.pos);
  checkParity(camera, cam, 2);
});

test("parity with THREE.Raycaster: orthographic, off-axis camera", () => {
  const cam = {
    pos: [30, 40, 50], target: [1, 2, 3], up: [0, 1, 0],
    projection: "orthographic", fov: null, orthoHeight: 40,
  };
  // width = orthoHeight · aspect = 80 → left/right ±40, top/bottom ±20
  const camera = new THREE.OrthographicCamera(-40, 40, 20, -20, 0.1, 1000);
  camera.position.set(...cam.pos);
  checkParity(camera, cam, 2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/framework/oracle/annotation-ray.test.js`
Expected: FAIL — cannot resolve `src/framework/oracle/annotation-ray.js`.

- [ ] **Step 3: Implement the module**

Create `src/framework/oracle/annotation-ray.js`:

```js
// Reconstruct pick rays from a sketch annotation payload (ANNOTATION_VERSION 3)
// and intersect them with planes — the consumer-side half of the payload's
// camera block (spec: docs/superpowers/specs/2026-08-28-annotation-ray-design.md).
//
// Pure vector math on arrays: no three, no DOM, no node:, no imports at all
// (worker-layering holds this folder to that). The math mirrors
// THREE.Raycaster.setFromCamera exactly, with one deliberate normalization:
// an orthographic ray's origin sits on the plane through the camera POSITION
// (three puts it on the near plane) — the same canonicalization annotate-mode
// applies to the rays it embeds per anchor, so embedded and reconstructed rays
// are definitionally identical. Two stated caveats: perspective assumes
// camera zoom 1 (the viewer dollies perspective cameras, never zooms them;
// orthoHeight already folds zoom in at send time), and payload numbers are
// rounded to 4 decimals, so reconstruction agrees with the live raycaster to
// ~1e-4 relative — sub-micrometre at part scale.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b, c) => [a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));

// screen: [sx, sy] in the payload's anchor screen frame (each 0..1, y down),
// or any object carrying such a `screen` array (an anchor passes directly).
export function annotationRay(payload, screen, { frame = "parts" } = {}) {
  if (frame !== "parts" && frame !== "world") {
    throw new Error('annotationRay: frame must be "parts" or "world"');
  }
  const s = Array.isArray(screen) ? screen : screen?.screen;
  if (!Array.isArray(s) || s.length !== 2
      || !s.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) {
    throw new Error("annotationRay: screen must be [x, y] with each in 0..1");
  }
  if (frame === "parts" && payload?.camera?.parts === null) {
    throw new Error("annotationRay: payload.camera.parts is null — the sketch was sent with no meshes (use { frame: \"world\" })");
  }
  const cam = payload?.camera?.[frame];
  const aspect = payload?.viewport?.aspect;
  if (!cam?.pos || !cam.target || !cam.up || !Number.isFinite(aspect)) {
    throw new Error("annotationRay: payload has no camera/viewport block");
  }
  // Basis orthonormalized the way three's lookAt does it: `up` is a hint, not
  // trusted to be orthogonal to forward.
  const forward = norm(sub(cam.target, cam.pos));
  const right = norm(cross(forward, cam.up));
  const trueUp = cross(right, forward);
  const nx = 2 * s[0] - 1;
  const ny = 1 - 2 * s[1];
  if (cam.projection === "orthographic") {
    const halfH = cam.orthoHeight / 2;
    return {
      origin: add3(cam.pos, scale(right, nx * halfH * aspect), scale(trueUp, ny * halfH)),
      dir: forward,
    };
  }
  const t = Math.tan((cam.fov * Math.PI) / 360); // vertical fov, degrees
  return {
    origin: [cam.pos[0], cam.pos[1], cam.pos[2]],
    dir: norm(add3(forward, scale(right, nx * t * aspect), scale(trueUp, ny * t))),
  };
}

const PLANES = {
  xy: { point: [0, 0, 0], normal: [0, 0, 1] },
  yz: { point: [0, 0, 0], normal: [1, 0, 0] },
  zx: { point: [0, 0, 0], normal: [0, 1, 0] },
};

// Miss semantics match the payload's `hit: null`: parallel rays and
// intersections at/behind the origin return null rather than throwing. `t` is
// in units of |dir| (unit for payload/annotationRay rays).
export function rayPlane(ray, plane) {
  if (!Array.isArray(ray?.origin) || !Array.isArray(ray?.dir)) {
    throw new Error("rayPlane: ray must be {origin, dir}");
  }
  const p = typeof plane === "string" ? PLANES[plane] : plane;
  if (!Array.isArray(p?.point) || !Array.isArray(p?.normal)) {
    throw new Error('rayPlane: plane must be {point, normal} or "xy"|"yz"|"zx"');
  }
  const denom = dot(ray.dir, p.normal);
  if (Math.abs(denom) < 1e-9) return null;
  const t = dot(sub(p.point, ray.origin), p.normal) / denom;
  if (t <= 1e-6) return null;
  return { point: add3(ray.origin, scale(ray.dir, t), [0, 0, 0]), t };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/framework/oracle/annotation-ray.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Run the layering guard**

Run: `npx vitest run test/worker-layering.test.js`
Expected: PASS — the new module imports nothing, so the folder's closure stays clean.

- [ ] **Step 6: Commit**

```bash
git add src/framework/oracle/annotation-ray.js test/framework/oracle/annotation-ray.test.js
git commit -m "feat(oracle): annotationRay/rayPlane — reconstruct sketch pick rays, intersect planes"
```

---

### Task 2: publish on the oracle entry (exports + types)

**Files:**
- Modify: `src/oracle.js` (append two exports)
- Modify: `types/testing.d.ts` (declarations) and `types/oracle.d.ts` (re-export)
- Test: `test/oracle-entry.test.js` (extend the pinned surface list)

**Interfaces:**
- Consumes: `annotationRay`, `rayPlane` from Task 1 (exact names).
- Produces: `import { annotationRay, rayPlane } from "partforge/oracle"` (and via `partforge/testing`'s wholesale re-export, which needs no edit).

- [ ] **Step 1: Extend the failing surface test**

In `test/oracle-entry.test.js`, in the `"the entry exports the oracle surface"` test's name list, after `"matchMasks", "matchViews",` add:

```js
    // Sketch-payload ray reconstruction (annotation-ray.js)
    "annotationRay", "rayPlane",
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/oracle-entry.test.js`
Expected: FAIL — `annotationRay` undefined on the entry.

- [ ] **Step 3: Export from the entry**

Append to `src/oracle.js` (after the `matchMasks, matchViews` export line):

```js
// Sketch-annotation ray reconstruction — the consumer-side half of the
// annotation payload's camera block: rebuild the pick ray for any screen
// point, intersect it with a plane in parts-frame millimetres.
export { annotationRay, rayPlane } from "./framework/oracle/annotation-ray.js";
```

- [ ] **Step 4: Add type declarations**

In `types/testing.d.ts`, append near the other oracle declarations (end of the oracle section is fine):

```ts
// --- sketch-annotation rays --------------------------------------------------
export interface AnnotationRay { origin: [number, number, number]; dir: [number, number, number] }
export interface RayPlaneHit { point: [number, number, number]; t: number }
export type PlaneSpec =
  | { point: [number, number, number]; normal: [number, number, number] }
  | "xy" | "yz" | "zx";
/** Rebuild the pick ray for a screen point of an ANNOTATION_VERSION 3 payload. */
export function annotationRay(
  payload: { camera: unknown; viewport: { aspect: number } },
  screen: [number, number] | { screen: [number, number] },
  opts?: { frame?: "parts" | "world" },
): AnnotationRay;
/** Intersect a ray with a plane; null on parallel / behind-origin misses. */
export function rayPlane(ray: AnnotationRay, plane: PlaneSpec): RayPlaneHit | null;
```

In `types/oracle.d.ts`, extend the re-export list inside the existing `export { ... } from "./testing.js"` block (after the silhouette line):

```ts
  // sketch-annotation rays
  annotationRay, rayPlane,
  type AnnotationRay, type RayPlaneHit, type PlaneSpec,
```

- [ ] **Step 5: Run the entry tests to verify they pass**

Run: `npx vitest run test/oracle-entry.test.js`
Expected: PASS — surface, testing-re-export identity, and browser-safe-closure tests all green (the new module has no imports, so the closure walk is unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/oracle.js types/testing.d.ts types/oracle.d.ts test/oracle-entry.test.js
git commit -m "feat(oracle): export annotationRay/rayPlane from partforge/oracle with types"
```

---

### Task 3: embedded per-anchor rays in the payload

**Files:**
- Modify: `src/framework/annotate/annotate-mode.js` (FRAME_LEGEND, `partsInverse()` extraction, anchor loop)
- Test: `test/framework/annotate/annotate-mode.test.js`

**Interfaces:**
- Consumes: `annotationRay` from `src/framework/oracle/annotation-ray.js` (test-side only — the mode itself uses THREE).
- Produces: payload anchors of shape `{ at, run?, screen, ray?: { origin: number[3], dir: number[3] }, hit }` with `ray` absent when `camera.parts` is null; `FRAME_LEGEND["elements[].anchors[].ray"]`.

- [ ] **Step 1: Write the failing tests**

In `test/framework/annotate/annotate-mode.test.js`, add the import at the top (next to the THREE import):

```js
import { annotationRay, rayPlane } from "../../../src/framework/oracle/annotation-ray.js";
```

Then add these tests (after the existing `"send payload is v3: ..."` test):

```js
test("anchors carry no ray when the sketch was sent with no meshes", () => {
  const { payload } = sendOneStroke({ ortho: false }); // fixture has no sub meshes
  expect(payload.camera.parts).toBeNull();
  for (const el of payload.elements) {
    for (const anchor of el.anchors) expect(anchor).not.toHaveProperty("ray");
  }
});

describe("embedded anchor rays", () => {
  for (const ortho of [false, true]) {
    it(`match annotationRay's reconstruction (${ortho ? "orthographic" : "perspective"})`, () => {
      const { payload } = sendOneStrokeWithParts({ ortho });
      expect(payload.frames["elements[].anchors[].ray"]).toContain("parts frame");
      const anchors = payload.elements[0].anchors;
      expect(anchors.length).toBeGreaterThan(0);
      for (const anchor of anchors) {
        expect(anchor.ray).toBeDefined();
        // 4-decimal payload rounding on both sides → 5e-4 per component
        const rebuilt = annotationRay(payload, anchor);
        for (let i = 0; i < 3; i++) {
          expect(anchor.ray.origin[i]).toBeCloseTo(rebuilt.origin[i], 3);
          expect(anchor.ray.dir[i]).toBeCloseTo(rebuilt.dir[i], 3);
        }
      }
    });
  }
});

test("round trip: an anchor's ray passes through its raycast hit", () => {
  // Aim the stroke so its start lands inside the fixture triangle (vertices
  // (0,0,0)/(1,0,0)/(0,1,0)): at fov 45 / z 10 / aspect 2 the screen band
  // sx ∈ (0.5, 0.56), sy ∈ (0.38, 0.5) projects into the triangle's interior.
  const camera = perspectiveCamera();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo);
  new THREE.Group().add(mesh);
  const { canvas, onSend, mode } = fixture({ viewer: { camera, _subMeshes: { body: mesh } } });
  mode.setEnabled(true);
  drag(canvas, [116, 65], [130, 80]); // start = screen (0.53, 0.45)
  mode.send();
  const payload = onSend.mock.calls[0][0];
  const anchor = payload.elements[0].anchors.find((a) => a.hit);
  expect(anchor, "no anchor hit the fixture triangle — retune the drag").toBeDefined();
  // plane through the hit point, perpendicular to the ray: the intersection
  // must give the hit point back (embedded ray, raycast, and helper agree)
  const back = rayPlane(anchor.ray, { point: anchor.hit.pointLocal, normal: anchor.ray.dir });
  expect(back).not.toBeNull();
  for (let i = 0; i < 3; i++) expect(back.point[i]).toBeCloseTo(anchor.hit.pointLocal[i], 2);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/framework/annotate/annotate-mode.test.js`
Expected: the three new tests FAIL (`anchor.ray` undefined, legend key missing); the no-meshes test may pass vacuously — that is fine, it pins the omission rule against regression.

- [ ] **Step 3: Add the legend key**

In `src/framework/annotate/annotate-mode.js`, inside `FRAME_LEGEND` after the `"elements[].anchors[].screen"` entry, add:

```js
  "elements[].anchors[].ray":
    "origin (mm) and unit dir in the parts frame — intersect with a plane (partforge/oracle's rayPlane) to place sketch geometry; present only when the model had meshes at send time",
```

- [ ] **Step 4: Extract `partsInverse()` and rewire `cameraBlock`**

In `annotate-mode.js`, replace the parent-lookup lines inside `cameraBlock()`:

```js
    const parent = Object.values(viewer._subMeshes ?? {})[0]?.parent ?? null;
    if (!parent) return { world, parts: null };
    parent.updateWorldMatrix(true, false);
    const inv = parent.matrixWorld.clone().invert();
```

with a parameter — `function cameraBlock(inv)` — and the body line:

```js
    if (!inv) return { world, parts: null };
```

Directly above `cameraBlock`, add:

```js
  // The shared parts parent's inverse world matrix, or null when no meshes
  // exist. cameraBlock() and send()'s anchor-ray loop both map through this —
  // one definition keeps the payload's parts frame single-sourced.
  function partsInverse() {
    const parent = Object.values(viewer._subMeshes ?? {})[0]?.parent ?? null;
    if (!parent) return null;
    parent.updateWorldMatrix(true, false);
    return parent.matrixWorld.clone().invert();
  }
```

- [ ] **Step 5: Embed the rays in `send()`**

In `send()`, before the `const elements = ...` block, add:

```js
    const inv = partsInverse();
    // Per-anchor pick rays, from the LIVE camera (the exact code path that
    // produces `hit`), origin canonicalized to the point on the ray line
    // nearest the camera position — a no-op for perspective, and for
    // orthographic it slides three's near-plane origin onto the plane through
    // the camera position, making the embedded ray definitionally identical
    // to annotationRay's reconstruction (spec: annotation-ray design).
    const rayCaster = new THREE.Raycaster();
    const anchorRay = (screen) => {
      if (!inv) return null; // no parts frame → no ray (same rule as hits)
      rayCaster.setFromCamera(new THREE.Vector2(2 * screen[0] - 1, 1 - 2 * screen[1]), viewer.camera);
      const { origin, direction } = rayCaster.ray;
      const along = viewer.camera.position.clone().sub(origin).dot(direction);
      origin.add(direction.clone().multiplyScalar(along));
      origin.applyMatrix4(inv);
      direction.transformDirection(inv); // rigid → exact for directions
      return { origin: origin.toArray().map(round4), dir: direction.toArray().map(round4) };
    };
```

In the anchors map, add the ray between `screen` and `hit`:

```js
        const ray = anchorRay(screen);
        return {
          at,
          ...(run !== undefined ? { run } : {}), // center anchors span all runs
          screen: screen.map(round4),
          ...(ray ? { ray } : {}), // omitted, not null, when no parts frame
          hit: hit ? { subPart: hit.subPart, pointLocal: hit.pointLocal } : null,
        };
```

And change the payload assembly's camera line to reuse the matrix:

```js
      camera: cameraBlock(inv),
```

- [ ] **Step 6: Run the annotate suite to verify it passes**

Run: `npx vitest run test/framework/annotate`
Expected: PASS — the three new tests and every existing one (the `cameraBlock` refactor must not change its output; the existing camera-block describe covers that).

- [ ] **Step 7: Commit**

```bash
git add src/framework/annotate/annotate-mode.js test/framework/annotate/annotate-mode.test.js
git commit -m "feat(annotate): embed parts-frame pick rays on payload anchors"
```

---

### Task 4: documentation + full-suite gate

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (annotation-payload section, after the self-describing-payload paragraph added 2026-08-28)
- Modify: `AGENTS.md` (annotate section, one clause)

**Interfaces:**
- Consumes: everything above; no code changes.
- Produces: nothing downstream.

- [ ] **Step 1: Extend AUTHORING-PARTS.md**

Directly after the paragraph ending "…each anchor of a gapped element carries the `run` index of the visible fragment it sits on." add:

```markdown
**Reconstructing rays from a sketch payload.** Every anchor also carries
`ray: { origin, dir }` — a pick ray in the **parts frame** (mm origin, unit
direction), computed from the live camera at send time and rounded to 4
decimals; it is omitted when `camera.parts` is `null` (no meshes at send
time — the same condition under which no `hit` can exist). Unlike `hit`,
the ray is present even where the stroke crosses empty space, so any anchor
can be projected onto a construction plane. For screen points that have no
anchor (a circle's rim, a grid over a region), `partforge/oracle` exports
`annotationRay(payload, screenOrAnchor, { frame? })` — the same ray,
reconstructed from the payload's camera block (perspective and orthographic
both) — and `rayPlane(ray, plane)` intersects either kind of ray with
`{ point, normal }` or the shorthand origin planes `"xy" | "yz" | "zx"`,
returning `{ point, t }` in mm or `null` on a parallel / behind-origin miss
(the same miss semantics as `hit: null`). End to end:

```js
import { annotationRay, rayPlane } from "partforge/oracle";
const anchor = payload.elements.find((e) => e.id === "e3")
  .anchors.find((a) => a.at === "center");
const hit = rayPlane(anchor.ray ?? annotationRay(payload, anchor), "xy");
// → boss where the sketched circle's center points, on the z=0 plane:
//   k.prism({ points: circleProfile(r_mm, [hit.point[0], hit.point[1]]), h })
```
```

- [ ] **Step 2: Extend AGENTS.md**

In the `src/framework/` annotate bullet, after "sent to the host via `onAnnotationSend` as a v3 semantic payload", insert: "whose anchors carry parts-frame pick rays (`partforge/oracle`'s `annotationRay`/`rayPlane` reconstruct and intersect them)".

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS, all files.

- [ ] **Step 4: Commit**

```bash
git add docs/AUTHORING-PARTS.md AGENTS.md
git commit -m "docs: anchor rays + annotationRay/rayPlane on partforge/oracle"
```

---

## Self-review notes (already applied)

- Spec coverage: payload rays + omission rule + legend (Task 3), helpers + exact errors + math (Task 1), oracle entry + types + surface pin (Task 2), docs incl. AGENTS.md line (Task 4), all five spec test bullets mapped (unit + parity → Task 1; consistency + omission + round-trip → Task 3; surface/layering → Tasks 1–2). No version bump per Global Constraints.
- Type consistency: `annotationRay(payload, screen, { frame })` / `rayPlane(ray, plane)` names and shapes identical across Tasks 1, 2, 3, 4.
- The round-trip test's screen-band comment was verified against the fixture: fov 45 → tan 22.5° ≈ 0.4142, camera z=10 → half-height 4.142 mm, aspect 2 → half-width 8.284 mm; triangle x,y ∈ (0,1) → sx ∈ (0.5, 0.560), sy ∈ (0.379, 0.5); the drag start (116, 65) maps to (0.53, 0.45) via RECT (left 10, top 20, 200×100).
