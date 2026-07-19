# Viewer Cutaway Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a viewer-only, freely manipulable cutaway plane that clips the visible assembly and renders every exposed section with a procedural 45-degree hatch.

**Architecture:** Keep the feature inside the three.js viewer: pure plane/drag math feeds a custom combined gizmo, while per-subpart stencil passes draw hatched visual caps without changing cached geometry. A separate optional DOM controller wires the viewbar button to a narrow viewer API; mount resets the mode on view changes, and selection filters GPU-clipped hits.

**Tech Stack:** Plain ESM JavaScript, three.js r184 WebGLRenderer/local clipping/stencil materials, Vitest 4 with happy-dom, Vite 8, Playwright Chromium.

---

## Before starting

Work only in:

    /Users/scottsykora/Documents/Docs/pixite/code/Robot KB/partforge-cutaway

The branch is codex/viewer-cutaway and is based on origin/main at ab88a1b. The
approved design is docs/plans/2026-07-19-viewer-cutaway-design.md.

Use Node 24 for every npm/Vitest/Vite command:

~~~bash
cd "/Users/scottsykora/Documents/Docs/pixite/code/Robot KB/partforge-cutaway"
nvm use
npm ci
~~~

If any build or test fails, follow the repository rule first:

~~~bash
rg -n "literal error text|relevant symptom" docs/ERROR-PATTERNS.md
~~~

Use @superpowers:test-driven-development for each implementation task,
@superpowers:verification-before-completion for Task 10, and
@superpowers:requesting-code-review after the final green verification.

## Task 1: Pure plane pose and drag math

**Files:**

- Create: src/framework/cutaway-math.js
- Create: test/framework/cutaway-math.test.js

### Step 1: Write the failing math tests

Create test/framework/cutaway-math.test.js with focused tests for the public
helpers:

~~~js
import { expect, test } from "vitest";
import * as THREE from "three";
import {
  axisParameterFromRay,
  hatchSpacingForDiagonal,
  initialCutawayPose,
  planeFromPose,
  pointSurvivesPlane,
  signedAngleAroundAxis,
} from "../../src/framework/cutaway-math.js";

test("initial pose is centred, camera-facing, and sized from the assembly", () => {
  const box = new THREE.Box3(
    new THREE.Vector3(-5, -10, -15),
    new THREE.Vector3(5, 10, 15)
  );
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const pose = initialCutawayPose(box, camera);
  expect(pose.position.toArray()).toEqual([0, 0, 0]);
  expect(new THREE.Vector3(0, 0, 1).applyQuaternion(pose.quaternion).z).toBeCloseTo(1);
  expect(pose.size).toBeGreaterThan(box.getSize(new THREE.Vector3()).length());
});

test("plane pose clips the camera-facing half and flip reverses it", () => {
  const position = new THREE.Vector3(0, 0, 2);
  const quaternion = new THREE.Quaternion();
  const normal = new THREE.Vector3();
  const plane = new THREE.Plane();

  planeFromPose(plane, normal, position, quaternion, false);
  expect(pointSurvivesPlane(plane, new THREE.Vector3(0, 0, 1))).toBe(true);
  expect(pointSurvivesPlane(plane, new THREE.Vector3(0, 0, 3))).toBe(false);

  planeFromPose(plane, normal, position, quaternion, true);
  expect(pointSurvivesPlane(plane, new THREE.Vector3(0, 0, 1))).toBe(false);
  expect(pointSurvivesPlane(plane, new THREE.Vector3(0, 0, 3))).toBe(true);
});

test("hatch spacing scales with the part and clamps at both ends", () => {
  expect(hatchSpacingForDiagonal(1)).toBe(0.5);
  expect(hatchSpacingForDiagonal(120)).toBe(5);
  expect(hatchSpacingForDiagonal(10000)).toBe(12);
});

test("axisParameterFromRay finds movement along the normal axis", () => {
  const ray = new THREE.Ray(
    new THREE.Vector3(3, 5, 10),
    new THREE.Vector3(0, 0, -1)
  );
  expect(axisParameterFromRay(
    ray,
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 1, 0)
  )).toBeCloseTo(5);
});

test("signedAngleAroundAxis preserves direction", () => {
  const x = new THREE.Vector3(1, 0, 0);
  const y = new THREE.Vector3(0, 1, 0);
  const z = new THREE.Vector3(0, 0, 1);
  expect(signedAngleAroundAxis(x, y, z)).toBeCloseTo(Math.PI / 2);
  expect(signedAngleAroundAxis(y, x, z)).toBeCloseTo(-Math.PI / 2);
});
~~~

### Step 2: Run the new test and verify the expected failure

~~~bash
npx vitest run test/framework/cutaway-math.test.js
~~~

Expected: FAIL because src/framework/cutaway-math.js does not exist.

### Step 3: Implement the pure helpers

Create src/framework/cutaway-math.js:

~~~js
import * as THREE from "three";

const PLANE_LOCAL_NORMAL = new THREE.Vector3(0, 0, 1);
const MIN_HATCH_MM = 0.5;
const MAX_HATCH_MM = 12;
const HATCHES_ACROSS_DIAGONAL = 24;
const POINT_EPSILON = 1e-6;

export function hatchSpacingForDiagonal(diagonal) {
  return THREE.MathUtils.clamp(
    diagonal / HATCHES_ACROSS_DIAGONAL,
    MIN_HATCH_MM,
    MAX_HATCH_MM
  );
}

export function initialCutawayPose(box, camera) {
  const position = box.getCenter(new THREE.Vector3());
  const diagonal = Math.max(box.getSize(new THREE.Vector3()).length(), 1);
  const normal = camera.getWorldDirection(new THREE.Vector3()).negate().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(PLANE_LOCAL_NORMAL, normal);
  return {
    position,
    quaternion,
    size: diagonal * 1.25,
    hatchSpacing: hatchSpacingForDiagonal(diagonal),
  };
}

export function planeFromPose(plane, normalTarget, position, quaternion, flipped) {
  normalTarget.copy(PLANE_LOCAL_NORMAL).applyQuaternion(quaternion).normalize();
  if (flipped) normalTarget.negate();
  return plane.setFromNormalAndCoplanarPoint(normalTarget, position);
}

export function pointSurvivesPlane(plane, point, epsilon = POINT_EPSILON) {
  return plane.distanceToPoint(point) <= epsilon;
}

export function axisParameterFromRay(ray, axisOrigin, axisDirection) {
  const axis = axisDirection.clone().normalize();
  const w0 = ray.origin.clone().sub(axisOrigin);
  const b = ray.direction.dot(axis);
  const d = ray.direction.dot(w0);
  const e = axis.dot(w0);
  const denominator = 1 - b * b;
  if (Math.abs(denominator) < 1e-6) return null;
  return (e - b * d) / denominator;
}

export function signedAngleAroundAxis(from, to, axis) {
  const a = from.clone().normalize();
  const b = to.clone().normalize();
  return Math.atan2(axis.dot(a.clone().cross(b)), a.dot(b));
}
~~~

### Step 4: Run the focused test

~~~bash
npx vitest run test/framework/cutaway-math.test.js
~~~

Expected: 5 tests PASS.

### Step 5: Commit

~~~bash
git add src/framework/cutaway-math.js test/framework/cutaway-math.test.js
git commit -m "test: define cutaway plane math"
~~~

## Task 2: Stencil section render sets and hatch shader

**Files:**

- Create: src/framework/cutaway-render.js
- Create: test/framework/cutaway-render.test.js

### Step 1: Write failing render-graph tests

The tests must use real three.js objects but no WebGL context. Cover:

~~~js
// test/framework/cutaway-render.test.js
import { expect, test, vi } from "vitest";
import * as THREE from "three";
import {
  createHatchMaterial,
  createSectionRenderSet,
} from "../../src/framework/cutaway-render.js";

function fixture() {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(4, 4, 4),
    new THREE.MeshStandardMaterial({ color: 0x336699 })
  );
  mesh.name = "body";
  scene.add(mesh);
  const lines = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry),
    new THREE.LineBasicMaterial({ color: 0x111111 })
  );
  scene.add(lines);
  return { scene, mesh, lines };
}

test("section set uses isolated increment/decrement stencil passes", () => {
  const { scene, mesh, lines } = fixture();
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const capGeometry = new THREE.PlaneGeometry(1, 1);
  const set = createSectionRenderSet({
    scene, mesh, edgeLines: lines, plane, capGeometry, order: 0,
  });

  expect(set.back.material.side).toBe(THREE.BackSide);
  expect(set.back.material.stencilZPass).toBe(THREE.IncrementWrapStencilOp);
  expect(set.front.material.side).toBe(THREE.FrontSide);
  expect(set.front.material.stencilZPass).toBe(THREE.DecrementWrapStencilOp);
  expect(set.cap.material.stencilFunc).toBe(THREE.NotEqualStencilFunc);
  expect(set.cap.onAfterRender).toBeTypeOf("function");
});

test("enable swaps clipped materials and disable restores originals", () => {
  const { scene, mesh, lines } = fixture();
  const originalMesh = mesh.material;
  const originalLines = lines.material;
  const set = createSectionRenderSet({
    scene,
    mesh,
    edgeLines: lines,
    plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
    capGeometry: new THREE.PlaneGeometry(1, 1),
    order: 0,
  });

  set.setEnabled(true);
  expect(mesh.material).not.toBe(originalMesh);
  expect(mesh.material.clippingPlanes).toHaveLength(1);
  expect(lines.material.clippingPlanes).toHaveLength(1);
  set.setEnabled(false);
  expect(mesh.material).toBe(originalMesh);
  expect(lines.material).toBe(originalLines);
});

test("geometry replacement is shared and disposal does not dispose it", () => {
  const { scene, mesh, lines } = fixture();
  const shared = new THREE.BoxGeometry(8, 8, 8);
  const dispose = vi.spyOn(shared, "dispose");
  const set = createSectionRenderSet({
    scene,
    mesh,
    edgeLines: lines,
    plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
    capGeometry: new THREE.PlaneGeometry(1, 1),
    order: 0,
  });
  set.setGeometry(shared);
  expect(set.back.geometry).toBe(shared);
  expect(set.front.geometry).toBe(shared);
  set.dispose();
  expect(dispose).not.toHaveBeenCalled();
});

test("hatch shader receives color, opacity, theme, spacing, and cap size", () => {
  const material = createHatchMaterial({
    color: 0x336699, opacity: 0.4, theme: "dark",
  });
  material.userData.setHatch({ spacing: 3, size: 90 });
  expect(material.uniforms.uBase.value.getHex()).toBe(0x336699);
  expect(material.uniforms.uOpacity.value).toBe(0.4);
  expect(material.uniforms.uScale.value).toBe(30);
  material.userData.setTheme("light");
  expect(material.uniforms.uInk.value.getHex()).not.toBe(0xffffff);
});
~~~

### Step 2: Verify the tests fail

~~~bash
npx vitest run test/framework/cutaway-render.test.js
~~~

Expected: FAIL because cutaway-render.js does not exist.

### Step 3: Implement the stencil material factories

In src/framework/cutaway-render.js, import three.js and create:

~~~js
function stencilMaterial(side, zPass) {
  return new THREE.MeshBasicMaterial({
    side,
    depthWrite: false,
    depthTest: false,
    colorWrite: false,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: zPass,
  });
}
~~~

Back faces use IncrementWrapStencilOp and front faces use
DecrementWrapStencilOp. The cap material uses NotEqualStencilFunc with stencil
reference zero and ReplaceStencilOp for fail, z-fail, and z-pass. Set
cap.onAfterRender to call renderer.clearStencil().

### Step 4: Implement the procedural hatch material

createHatchMaterial returns a ShaderMaterial with uniforms uBase, uInk,
uOpacity, and uScale. Use PlaneGeometry UV coordinates so the hatch remains
anchored to the section plane:

~~~glsl
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
~~~

~~~glsl
varying vec2 vUv;
uniform vec3 uBase;
uniform vec3 uInk;
uniform float uOpacity;
uniform float uScale;
void main() {
  float coordinate = (vUv.x + vUv.y) * uScale;
  float distanceToLine = abs(fract(coordinate) - 0.5);
  float antialias = max(fwidth(coordinate), 0.001);
  float stripe = 1.0 - smoothstep(0.08 - antialias, 0.08 + antialias, distanceToLine);
  gl_FragColor = vec4(mix(uBase, uInk, stripe), uOpacity);
}
~~~

Expose material.userData.setHatch({ spacing, size }) and setTheme(mode). Dark
mode uses a light hatch ink and light mode a dark hatch ink. Set transparent and
depthWrite from opacity.

### Step 5: Implement createSectionRenderSet

The returned object must expose:

~~~js
{
  back,
  front,
  cap,
  setEnabled(on),
  setVisible(on),
  setGeometry(geometry),
  setCapPose({ position, quaternion, size, spacing }),
  setTheme(mode),
  dispose(),
}
~~~

Required behavior:

- back and front share mesh.geometry and are children of mesh so they inherit the
  exact subpart world transform.
- cap is a scene child using the shared capGeometry.
- the clipped surface and edge materials are clones; the originals are restored
  when disabled.
- render order is explicit: each section gets its own stencil/cap order, all
  clipped surfaces render after caps, and edge lines render after surfaces.
- disabling hides stencil/cap objects and restores original render orders.
- dispose removes created objects and disposes only cloned/stencil/hatch
  materials. It must not dispose mesh.geometry, edgeLines.geometry, or the shared
  capGeometry.

### Step 6: Run focused tests

~~~bash
npx vitest run test/framework/cutaway-render.test.js
~~~

Expected: all render-graph tests PASS.

### Step 7: Commit

~~~bash
git add src/framework/cutaway-render.js test/framework/cutaway-render.test.js
git commit -m "feat: add stencil cutaway render passes"
~~~

## Task 3: Combined cut-plane gizmo

**Files:**

- Create: src/framework/cutaway-gizmo.js
- Create: test/framework/cutaway-gizmo.test.js

### Step 1: Write failing lifecycle and pose tests

Use a real Scene and PerspectiveCamera, plus a DOM element with
getBoundingClientRect, setPointerCapture, releasePointerCapture, and
hasPointerCapture stubs. Test:

~~~js
const gizmo = createCutawayGizmo({
  scene,
  camera,
  domElement,
  orbitControls: { enabled: true },
  onPoseChange: vi.fn(),
});

gizmo.setPose({
  position: new THREE.Vector3(1, 2, 3),
  quaternion: new THREE.Quaternion(),
  size: 40,
});
gizmo.setVisible(true);
expect(gizmo.group.position.toArray()).toEqual([1, 2, 3]);
expect(gizmo.fill.visible).toBe(true);
expect(gizmo.handles.translate.userData.cutawayHandle).toBe("translate");
expect(gizmo.handles.rotateX.userData.cutawayHandle).toBe("rotate-x");
expect(gizmo.handles.rotateY.userData.cutawayHandle).toBe("rotate-y");

gizmo.setActiveAppearance(false);
expect(gizmo.fill.material.opacity).toBeLessThan(0.1);
gizmo.dispose();
expect(scene.children).not.toContain(gizmo.group);
~~~

Also test that a synthetic pointercancel while dragging restores
orbitControls.enabled and releases capture. Inject a pickHandle callback in the
test so the event path does not depend on pixel-perfect raycasting.

### Step 2: Verify the tests fail

~~~bash
npx vitest run test/framework/cutaway-gizmo.test.js
~~~

Expected: FAIL because cutaway-gizmo.js does not exist.

### Step 3: Build the gizmo scene graph

createCutawayGizmo must build one Group containing:

- A unit PlaneGeometry fill with a themed transparent MeshBasicMaterial.
- A LineLoop square border.
- A local +Z shaft and cone for normal translation.
- A ring about local X and a ring about local Y.
- Invisible, enlarged hit meshes for the shaft and both rings.

Tag each hit mesh with userData.cutawayHandle. Scale the plane, ring radii,
visible line widths, and hit regions from pose.size. Keep the visible handles a
stable apparent size by updating their scale from camera distance in an
updateForCamera() method called by the viewer render loop.

### Step 4: Implement direct manipulation

Register pointerdown, pointermove, pointerup, pointercancel,
lostpointercapture, pointerleave, and window blur.

On pointerdown:

1. Raycast only the invisible hit meshes, unless the injected pickHandle test
   hook returns a handle.
2. Capture the pointer and save the starting position/quaternion.
3. For translate, save the world normal and axisParameterFromRay result.
4. For rotation, save the selected world axis, intersect the pointer ray with a
   plane normal to that axis through the gizmo center, and save the normalized
   radial vector.
5. Set orbitControls.enabled to false, preserving its prior value.

On pointermove:

- Translate by the difference between current and starting axis parameters.
- Rotate by signedAngleAroundAxis from the saved radial vector to the current
  radial vector. Premultiply the starting quaternion by a world-axis rotation.
- Copy the new pose into group.position/group.quaternion and call onPoseChange
  with cloned values.

On every end/cancel/blur path, release capture and restore the prior
orbitControls.enabled value.

### Step 5: Implement active/idle appearance

setActiveAppearance(true) makes the fill translucent and the handles vivid.
setActiveAppearance(false) leaves the border and handles visible but reduces
the fill below 0.1 opacity. The higher-level cutaway controller will own the
idle timer; the gizmo only applies requested appearance.

setTheme(mode) updates fill, border, and handle colors. setVisible(false) ends
any active drag. dispose is idempotent and removes all listeners, geometry, and
materials.

### Step 6: Run focused tests

~~~bash
npx vitest run test/framework/cutaway-gizmo.test.js test/framework/cutaway-math.test.js
~~~

Expected: all tests PASS.

### Step 7: Commit

~~~bash
git add src/framework/cutaway-gizmo.js test/framework/cutaway-gizmo.test.js
git commit -m "feat: add combined cut-plane gizmo"
~~~

## Task 4: Cutaway controller

**Files:**

- Create: src/framework/cutaway.js
- Create: test/framework/cutaway.test.js
- Modify: src/framework/cutaway-render.js
- Modify: test/framework/cutaway-render.test.js

### Step 1: Write failing controller tests

Build a fixture with a fake renderer:

~~~js
const renderer = {
  localClippingEnabled: false,
  getContext: () => ({
    getContextAttributes: () => ({ stencil: true }),
  }),
};
~~~

Use a scene, camera, fake orbit controls, one visible box mesh, and edge lines.
Test these behaviors:

- isSupported() is true only with a stencil-capable context.
- setEnabled(true) returns false when bounds are empty.
- setEnabled(true) with bounds creates a centred camera-facing pose, turns on
  local clipping, and reveals the stencil/cap/gizmo.
- flip() reverses point visibility without moving the plane.
- reset() restores the initial pose.
- setVisible names controls each section render set independently.
- registerClippableMaterial immediately receives the active plane and is reset
  on disable/unregister.
- updateGeometry swaps stencil references without disposing the new geometry.
- disable clears local clipping and hides all created render objects.
- dispose is idempotent.

### Step 2: Verify the tests fail

~~~bash
npx vitest run test/framework/cutaway.test.js
~~~

Expected: FAIL because cutaway.js does not exist.

### Step 3: Implement createCutaway

The controller owns one stable Plane, one shared cap PlaneGeometry, one gizmo,
and a Map of section render sets. Its public API is:

~~~js
{
  isSupported,
  isEnabled,
  setSubpart,
  updateGeometry,
  setVisible,
  setEnabled,
  reset,
  flip,
  setTheme,
  isPointVisible,
  registerClippableMaterial,
  updateForCamera,
  dispose,
}
~~~

Implementation rules:

- Query getContextAttributes().stencil once and catch capability-query errors.
- setSubpart(name, mesh, edgeLines) replaces and disposes an old set with the
  same name.
- setEnabled(true) calls getBounds(), rejects an empty Box3, obtains
  initialCutawayPose, and applies it to the Plane, cap meshes, and gizmo.
- on every gizmo pose callback, update planeFromPose and every cap transform.
- flip toggles a boolean and calls planeFromPose without changing position or
  quaternion.
- reset recomputes from current bounds and camera.
- setEnabled(false) clears the idle timer, hides the gizmo/sets, unregisters
  clipping from auxiliary materials, and sets renderer.localClippingEnabled to
  false.
- setEnabled(true), hover/focus, and onPoseChange call showActive(), which resets
  an 800 ms timeout that fades the plane through gizmo.setActiveAppearance(false).
- registerClippableMaterial tracks materials in a Set and returns an unregister
  function. Synchronization sets clippingPlanes to [plane] while enabled and
  null while disabled, then sets needsUpdate when the array length changes.
- isPointVisible returns true while disabled and otherwise delegates to
  pointSurvivesPlane.
- updateForCamera delegates to the gizmo.
- dispose disables first, then disposes sets, gizmo, and shared cap geometry.

### Step 4: Add source-display propagation

When a source mesh material changes or a geometry regeneration updates display
state, the render set must refresh its clipped clone and cap tint without
losing the original material reference. Add refreshSourceMaterial() to the
render-set API and test color plus opacity propagation.

### Step 5: Run focused controller tests

~~~bash
npx vitest run test/framework/cutaway.test.js test/framework/cutaway-render.test.js
~~~

Expected: all tests PASS.

### Step 6: Commit

~~~bash
git add src/framework/cutaway.js src/framework/cutaway-render.js test/framework/cutaway.test.js test/framework/cutaway-render.test.js
git commit -m "feat: coordinate cutaway rendering and interaction"
~~~

## Task 5: Integrate cutaway with the viewer lifecycle

**Files:**

- Modify: src/framework/viewer.js:1-282
- Modify: test/framework/cutaway.test.js

### Step 1: Add a failing integration-shaped controller test

In test/framework/cutaway.test.js, add a test whose source mesh sits beneath a
rotated/recentred parent group. Use Box3.setFromObject to supply world bounds,
enable cutaway, and assert the initial plane passes through the resulting world
box center. This locks the coordinate-space contract used by viewer.js.

### Step 2: Run the test and verify it fails before integration adjustments

~~~bash
npx vitest run test/framework/cutaway.test.js
~~~

Expected: FAIL until the controller consumes world-space bounds correctly.

### Step 3: Wire createCutaway into viewer.js

Make these exact structural changes:

1. Import createCutaway from ./cutaway.js.
2. Construct WebGLRenderer with { antialias: true, stencil: true }.
3. After subMesh and subLines exist, create getVisibleWorldBounds() using
   Box3.expandByObject for visible meshes after updateWorldMatrix(true, false).
4. Create one cutaway controller with renderer, scene, camera, controls, and
   getVisibleWorldBounds.
5. Register every name/mesh/line tuple with cutaway.
6. In setSubGeometry, call cutaway.updateGeometry(name, newGeometry) before
   disposing the previous cached geometry.
7. In showAssembly, call cutaway.setVisible(visibleNames) after mesh visibility
   and framing are updated.
8. In hideAssembly, call cutaway.setVisible([]).
9. In setTheme, forward mode to cutaway.
10. In resize or the render loop, call cutaway.updateForCamera() so handle size
    remains usable while zooming.
11. Dispose cutaway before cached geometries and shared viewer materials.

### Step 4: Add the narrow viewer API and auto-rotation arbitration

Replace the direct auto-rotation setter with requested state:

~~~js
let autoRotateRequested = true;
function syncAutoRotate() {
  controls.autoRotate = autoRotateRequested && !cutaway.isEnabled();
}
function setAutoRotate(on) {
  autoRotateRequested = !!on;
  syncAutoRotate();
}
function setCutawayEnabled(on) {
  const changed = cutaway.setEnabled(on);
  syncAutoRotate();
  return changed;
}
~~~

Return these additional methods from createViewer:

~~~js
cutawaySupported: cutaway.isSupported,
cutawayEnabled: cutaway.isEnabled,
setCutawayEnabled,
flipCutaway: cutaway.flip,
resetCutaway: cutaway.reset,
isWorldPointVisible: cutaway.isPointVisible,
registerCutawayMaterial: cutaway.registerClippableMaterial,
~~~

Do not expose scene, renderer, orbit controls, stencil objects, or plane mutation.

### Step 5: Run focused and regression tests

~~~bash
npx vitest run test/framework/cutaway.test.js test/framework/viewer-controls.test.js
~~~

Expected: PASS.

### Step 6: Commit

~~~bash
git add src/framework/viewer.js test/framework/cutaway.test.js
git commit -m "feat: integrate cutaway with viewer lifecycle"
~~~

## Task 6: Make selection and hover respect the cut

**Files:**

- Modify: src/framework/selection/raycast.js:24-42
- Modify: src/framework/selection/hover.js:29-127
- Modify: test/selection-raycast.test.js
- Modify: test/selection-hover.test.js

### Step 1: Write a failing removed-side raycast test

Extend makeViewer in test/selection-raycast.test.js so it can accept an optional
isWorldPointVisible predicate. Add:

~~~js
test("raycast skips a clipped front hit and returns the retained back hit", () => {
  const viewer = makeViewer();
  viewer.isWorldPointVisible = (point) => point.z < 0;
  const hit = raycastViewer(viewer, 100, 100);
  expect(hit).not.toBeNull();
  expect(hit.pointWorld.z).toBeCloseTo(-2, 4);
});

test("raycast behavior is unchanged without a visibility predicate", () => {
  const viewer = makeViewer();
  delete viewer.isWorldPointVisible;
  expect(raycastViewer(viewer, 100, 100).pointWorld.z).toBeCloseTo(2, 4);
});
~~~

### Step 2: Verify the raycast test fails

~~~bash
npx vitest run test/selection-raycast.test.js
~~~

Expected: the removed-side test reports the front z=2 intersection.

### Step 3: Filter the complete intersection list

In raycastViewer, replace [0] lookup with:

~~~js
const hits = raycaster.intersectObjects(meshes, false);
const hit = hits.find((candidate) =>
  viewer.isWorldPointVisible?.(candidate.point) ?? true
);
~~~

Keep the returned selection payload unchanged.

### Step 4: Write a failing hover-material registration test

In test/selection-hover.test.js, add registerCutawayMaterial to the fake viewer:

~~~js
const unregister = vi.fn();
viewer.registerCutawayMaterial = vi.fn(() => unregister);
const hover = attachHoverLabels(viewer, { part, schedule: (fn) => fn() });
expect(viewer.registerCutawayMaterial).toHaveBeenCalledTimes(1);
hover.detach();
expect(unregister).toHaveBeenCalledTimes(1);
~~~

### Step 5: Register the hover overlay material

Immediately after creating the hover MeshBasicMaterial:

~~~js
const unregisterCutaway = viewer.registerCutawayMaterial?.(material) ?? (() => {});
~~~

Call unregisterCutaway during detach before disposing the material. Raise the
overlay renderOrder above clipped surfaces/feature lines as defined in
cutaway-render.js.

### Step 6: Run selection tests

~~~bash
npx vitest run test/selection-raycast.test.js test/selection-hover.test.js test/selection-pick.test.js
~~~

Expected: all PASS.

### Step 7: Commit

~~~bash
git add src/framework/selection/raycast.js src/framework/selection/hover.js test/selection-raycast.test.js test/selection-hover.test.js
git commit -m "fix: make selection respect viewer cutaway"
~~~

## Task 7: Optional cutaway DOM controls

**Files:**

- Create: src/framework/cutaway-controls.js
- Create: test/framework/cutaway-controls.test.js

### Step 1: Write the failing DOM tests

Use happy-dom and a fake viewer with:

~~~js
function fakeViewer({ supported = true } = {}) {
  let enabled = false;
  return {
    domElement: document.createElement("canvas"),
    cutawaySupported: vi.fn(() => supported),
    cutawayEnabled: vi.fn(() => enabled),
    setCutawayEnabled: vi.fn((on) => {
      enabled = supported && on;
      return enabled === on;
    }),
    flipCutaway: vi.fn(),
    resetCutaway: vi.fn(),
  };
}
~~~

Cover:

- Primary click enables/disables and synchronizes aria-pressed plus .on.
- Flip and Reset buttons are generated adjacent to the primary button only while
  active and call the viewer API.
- reset() disables the mode and synchronizes the DOM.
- Escape on the focused canvas disables the mode.
- Unsupported state disables the button and sets an explanatory title.
- Missing primary button is a no-op handle.
- detach removes listeners and generated DOM; double-detach is safe.

### Step 2: Verify the tests fail

~~~bash
npx vitest run test/framework/cutaway-controls.test.js
~~~

Expected: FAIL because cutaway-controls.js does not exist.

### Step 3: Implement attachCutawayControls

Export:

~~~js
export function attachCutawayControls(viewer, { cutaway: button } = {}) {
  // returns { reset, detach }
}
~~~

Implementation details:

- If button is absent, return no-op reset/detach.
- Set type=button, aria-pressed=false, and a default title if the host omitted
  one.
- If unsupported, set disabled=true and title to
  "Cutaway requires a stencil-capable WebGL context".
- Create a span.pf-cutaway-actions containing Flip and Reset buttons and insert
  it after the primary button. Keep it hidden while inactive.
- sync() reads viewer.cutawayEnabled(), toggles aria-pressed/.on, and toggles
  actions.hidden.
- Toggle calls setCutawayEnabled(!current), then sync.
- Reset action calls resetCutaway; it does not turn the feature off.
- The handle reset() means view-state reset: call setCutawayEnabled(false), then
  sync.
- Give the canvas tabIndex=0 only if it has no tabindex. On a pointerdown, focus
  the canvas with preventScroll=true so Escape is scoped to recent viewer
  interaction.
- Listen for Escape on the canvas and on the generated/action buttons.
- detach removes every listener and generated node but does not dispose viewer
  resources.

### Step 4: Run the DOM tests

~~~bash
npx vitest run test/framework/cutaway-controls.test.js
~~~

Expected: all PASS.

### Step 5: Commit

~~~bash
git add src/framework/cutaway-controls.js test/framework/cutaway-controls.test.js
git commit -m "feat: add accessible cutaway viewer controls"
~~~

## Task 8: Mount wiring and view reset

**Files:**

- Modify: src/framework/mount.js:1-314
- Modify: test/framework/mount.test.js

### Step 1: Extend the mount fake and element fixture

Add the cutaway viewer methods to fakeViewers:

~~~js
cutawaySupported: vi.fn(() => true),
cutawayEnabled: vi.fn(() => false),
setCutawayEnabled: vi.fn(() => true),
flipCutaway: vi.fn(),
resetCutaway: vi.fn(),
isWorldPointVisible: vi.fn(() => true),
registerCutawayMaterial: vi.fn(() => vi.fn()),
~~~

Add cutaway: mk("button") to elements.chrome and append it with the other chrome
buttons.

### Step 2: Write failing mount tests

Add tests that:

1. Full element refs cause no getElementById lookup and cutaway click calls
   viewer.setCutawayEnabled(true).
2. Legacy #cutaway fallback is resolved when present.
3. Clicking cutaway after a completed build posts no worker messages.
4. Switching to a second view calls setCutawayEnabled(false) and resets the
   control UI.
5. dispose detaches the cutaway control so later clicks do nothing.

For the view-change test, create a two-view part:

~~~js
const part = makePart();
part.views.other = { label: "Other" };
part.parts.body.views = ["main", "other"];
~~~

Click the generated Other tab and assert the reset before completing any new
worker result.

### Step 3: Verify the mount tests fail

~~~bash
npx vitest run test/framework/mount.test.js
~~~

Expected: FAIL because mount does not resolve or attach cutaway.

### Step 4: Wire the controller

In mount.js:

- Import attachCutawayControls from ./cutaway-controls.js.
- Resolve chrome.cutaway from elements.chrome.cutaway or byId("cutaway").
- Attach it immediately after createViewer so the tab callback can use it:

~~~js
const cutawayChrome = attachCutawayControls(viewer, {
  cutaway: els.chrome.cutaway,
});
~~~

- Change the view tab callback to call cutawayChrome.reset() before refreshView,
  updateRelevance, and loop.kick.
- Call cutawayChrome.detach() during dispose before viewer.dispose().
- Keep attachViewerControls responsible only for pause/reframe/theme/camera
  persistence.

### Step 5: Run mount and chrome tests

~~~bash
npx vitest run test/framework/mount.test.js test/framework/cutaway-controls.test.js test/framework/viewer-controls.test.js
~~~

Expected: all PASS.

### Step 6: Commit

~~~bash
git add src/framework/mount.js test/framework/mount.test.js
git commit -m "feat: wire cutaway into mounted viewer apps"
~~~

## Task 9: Example chrome, styling, documentation, and browser smoke

**Files:**

- Modify: demo.html:18-23
- Modify: planter.html:18-23
- Modify: filleted-box.html:13-18
- Modify: src/framework/app.css:131-165
- Modify: docs/AUTHORING-PARTS.md:503-539
- Modify: scripts/check-app.mjs:37-65

### Step 1: Add a failing smoke expectation

Extend scripts/check-app.mjs with a cutaway flag. After boot:

~~~js
let cutaway = false;
const cutawayButton = page.locator("#cutaway");
if (await cutawayButton.count()) {
  await cutawayButton.click();
  cutaway = await cutawayButton.getAttribute("aria-pressed") === "true";
  await sleep(200);
}
~~~

Include cutaway in the printed result and require booted && hovered && cutaway
for success. Run only after the dev HTML is updated in Step 2; before runtime
wiring it should fail or report cutaway false.

### Step 2: Add the optional button to all example viewbars

Insert before Pause:

~~~html
<button id="cutaway" title="Cutaway section" aria-label="Toggle cutaway section">◩</button>
~~~

Do not add inline or page-specific CSS.

### Step 3: Style the expanded action group and unsupported state

Near the existing #viewbar rules, add:

~~~css
#viewbar .pf-cutaway-actions { display: flex; gap: 4px; }
#viewbar .pf-cutaway-actions[hidden] { display: none; }
#viewbar button:disabled { opacity: .38; cursor: not-allowed; }
#viewbar button:disabled:hover { color: var(--pf-muted-2); background: transparent; }
~~~

Retain existing token use, button dimensions, focus rings, dark/light behavior,
and compact top-right layout. Do not style three.js gizmo colors in CSS.

### Step 4: Update the authoring/embedding contract

In the Wiring a part into a runnable app section:

- Change the structural-markup table entry to list
  #pause / #reframe / #cutaway / #theme.
- Explain that #cutaway is optional, viewer-only, resets on a view change, and
  never changes exports.
- Add elements.chrome.cutaway beside the other optional embedding refs.
- State that hosts omitting it get no cutaway UI.

### Step 5: Run the production build

~~~bash
npm run build
~~~

Expected: PASS; all configured HTML entries and workers bundle successfully.

### Step 6: Run the focused Chromium smoke

~~~bash
CHECK_PORT=5179 node scripts/check-app.mjs demo.html
~~~

Expected output includes booted: true, hovered: true, cutaway: true, errors: 0.

### Step 7: Commit

~~~bash
git add demo.html planter.html filleted-box.html src/framework/app.css docs/AUTHORING-PARTS.md scripts/check-app.mjs
git commit -m "docs: expose cutaway mode in example apps"
~~~

## Task 10: Full verification and visual acceptance

**Files:**

- Modify only if verification exposes a defect; add the smallest regression test
  beside the failing behavior before fixing it.

### Step 1: Run every cutaway-related unit test together

~~~bash
npx vitest run test/framework/cutaway-math.test.js test/framework/cutaway-render.test.js test/framework/cutaway-gizmo.test.js test/framework/cutaway.test.js test/framework/cutaway-controls.test.js test/framework/mount.test.js test/selection-raycast.test.js test/selection-hover.test.js
~~~

Expected: PASS.

### Step 2: Run the full unit suite

~~~bash
npm test
~~~

Expected: PASS with no unhandled rejections or leaked-handle warnings.

### Step 3: Build production assets

~~~bash
npm run build
~~~

Expected: PASS.

### Step 4: Smoke all three backends/examples on distinct ports

~~~bash
CHECK_PORT=5179 node scripts/check-app.mjs demo.html
CHECK_PORT=5180 node scripts/check-app.mjs planter.html
CHECK_PORT=5181 node scripts/check-app.mjs filleted-box.html
~~~

Expected for each: booted true, hovered true, cutaway true, errors 0.

### Step 5: Perform manual visual acceptance in Chromium

Start the dev server:

~~~bash
npm run dev
~~~

For demo.html:

- Enable cutaway and confirm the spacer bore remains a hole in the hatched cap.
- Drag the normal handle continuously; verify no regeneration/busy indicator.
- Tilt with both rings, Flip, Reset, orbit outside the handles, and press Escape.
- Verify clipped-away feature edges and hover hits do not remain.

For planter.html:

- Cut through the wall and interior; verify a stable single 45-degree hatch.
- Switch views and verify cutaway turns off.
- Toggle light/dark while active and inspect contrast.

For filleted-box.html:

- Cut through fillets/chamfers and inspect cap continuity.
- Confirm OCCT-generated geometry behaves identically and no worker job occurs
  during manipulation.

Also resize the viewport, zoom far in/out, and verify handle size and invisible
hit targets remain usable.

### Step 6: Check repository cleanliness and diff scope

~~~bash
git status --short
git diff origin/main...HEAD --check
git diff --stat origin/main...HEAD
~~~

Expected: clean status; no whitespace errors; changes limited to the approved
viewer, controls, selection, examples, tests, smoke script, and docs.

### Step 7: Commit any verification-only fixes

Only if Step 1-6 required changes:

~~~bash
git add <exact regression test and fix files>
git commit -m "fix: harden viewer cutaway behavior"
~~~

Re-run every command affected by the fix and record the final results before
claiming completion.
