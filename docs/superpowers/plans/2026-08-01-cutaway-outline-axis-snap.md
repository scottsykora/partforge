# Cutaway Cut-Face Outline and Axis Snapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw a CAD-style outline around every cutaway cut face, and align the section plane to canonical axes on enable, on reset, and while rotating the gizmo.

**Architecture:** A pure plane/triangle slice produces 3D segments per subpart, rendered with `LineSegments2` + `LineMaterial` — the same renderer the viewer's feature edges already use. Each outline is parented to its subpart mesh and re-slices only when a cheap per-frame signature check (plane, world matrix, geometry) changes. Axis alignment goes through one shared `nearestCanonicalAxis` helper used by both the initial pose and the 7° rotation snap.

**Tech Stack:** three.js r184 (`LineSegments2`, `LineSegmentsGeometry`, `LineMaterial`, `THREE.Plane`), Vitest, happy-dom for DOM-touching tests.

## Global Constraints

- **Node 24.** Run `nvm use` before `npm install`, tests, or the CLI. The default shell Node is too old and geometry/tests fail confusingly.
- **Units are millimetres** throughout.
- **Design spec:** `docs/superpowers/specs/2026-08-01-cutaway-outline-axis-snap-design.md`. Read it before starting.
- **On any build or test failure, grep `docs/ERROR-PATTERNS.md` for the symptom first** — it maps literal error text to cause to fix.
- **OCCT and Manifold must not boot in the same process.** Nothing in this plan boots a kernel; keep it that way — every new test is a pure-geometry or DOM test.
- Tests that touch the DOM start with the pragma comment `// @vitest-environment happy-dom` on line 1 (see `test/framework/cutaway.test.js`).
- Exact snap threshold: **7 degrees**. Exact slice budget: **2 ms**. Exact outline render order base: **2,500,000**.
- Run a single test file with `npx vitest run test/framework/<file>.test.js`, and a single test by name with `npx vitest run -t "<name>"`.

---

### Task 1: Nearest canonical axis and axis-aligned initial pose

**Files:**
- Modify: `src/framework/cutaway-math.js`
- Test: `test/framework/cutaway-math.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `nearestCanonicalAxis(direction: THREE.Vector3, target?: THREE.Vector3) => THREE.Vector3` — returns `target`, set to a signed unit axis. Used by Task 8.

- [ ] **Step 1: Write the failing tests**

Append to `test/framework/cutaway-math.test.js`. Add `nearestCanonicalAxis` to the existing import block at the top of the file (it imports from `../../src/framework/cutaway-math.js`).

```js
test("nearest canonical axis picks the signed axis closest to a direction", () => {
  const axis = new THREE.Vector3();

  expect(nearestCanonicalAxis(new THREE.Vector3(1, 0, 0), axis).toArray()).toEqual([1, 0, 0]);
  expect(nearestCanonicalAxis(new THREE.Vector3(-1, 0, 0), axis).toArray()).toEqual([-1, 0, 0]);
  expect(nearestCanonicalAxis(new THREE.Vector3(0, 1, 0), axis).toArray()).toEqual([0, 1, 0]);
  expect(nearestCanonicalAxis(new THREE.Vector3(0, -1, 0), axis).toArray()).toEqual([0, -1, 0]);
  expect(nearestCanonicalAxis(new THREE.Vector3(0, 0, 1), axis).toArray()).toEqual([0, 0, 1]);
  expect(nearestCanonicalAxis(new THREE.Vector3(0, 0, -1), axis).toArray()).toEqual([0, 0, -1]);

  // dominant-but-not-exact
  expect(nearestCanonicalAxis(new THREE.Vector3(0.2, -0.9, 0.3), axis).toArray())
    .toEqual([0, -1, 0]);
});

test("nearest canonical axis breaks ties in X, Y, Z order", () => {
  // The default isometric framing (camera at 18, 12, 18) is an exact tie
  // between -X and -Z; a strictly-greater comparison keeps the earlier axis.
  const isometric = new THREE.Vector3(-18, -12, -18).normalize();
  expect(nearestCanonicalAxis(isometric).toArray()).toEqual([-1, 0, 0]);

  expect(nearestCanonicalAxis(new THREE.Vector3(0, 1, 1).normalize()).toArray())
    .toEqual([0, 1, 0]);
});

test("nearest canonical axis falls back to +Z for degenerate directions", () => {
  expect(nearestCanonicalAxis(new THREE.Vector3(0, 0, 0)).toArray()).toEqual([0, 0, 1]);
  expect(nearestCanonicalAxis(new THREE.Vector3(NaN, 1, 0)).toArray()).toEqual([0, 0, 1]);
});

test("initial pose snaps the plane normal to a canonical axis", () => {
  const box = new THREE.Box3(
    new THREE.Vector3(-5, -4, -3),
    new THREE.Vector3(5, 4, 3),
  );
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(18, 12, 18);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const pose = initialCutawayPose(box, camera);
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(pose.quaternion);

  expect(normal.x).toBeCloseTo(-1);
  expect(normal.y).toBeCloseTo(0);
  expect(normal.z).toBeCloseTo(0);

  // A rotation between two axis vectors maps axes to axes, so the plane's
  // in-plane directions come out axis-aligned and the gizmo reads square.
  const inPlane = new THREE.Vector3(1, 0, 0).applyQuaternion(pose.quaternion);
  for (const component of inPlane.toArray()) {
    expect(Math.abs(Math.abs(component) - Math.round(Math.abs(component)))).toBeLessThan(1e-6);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/framework/cutaway-math.test.js`
Expected: FAIL — `nearestCanonicalAxis is not a function`.

- [ ] **Step 3: Implement**

In `src/framework/cutaway-math.js`, add the exported helper above `initialCutawayPose`:

```js
// Nearest signed canonical axis (+/-X, +/-Y, +/-Z) to `direction`. Axes are
// scanned X, Y, Z and replaced only on a strictly larger |component|, so a tie
// resolves to the earlier axis — the default isometric framing is an exact tie
// between -X and -Z and lands on -X. Degenerate input falls back to +Z.
export function nearestCanonicalAxis(direction, target = new THREE.Vector3()) {
  const components = [direction.x, direction.y, direction.z];
  if (!components.every(Number.isFinite)) return target.set(0, 0, 1);

  let bestIndex = -1;
  let bestScore = 0;
  for (let i = 0; i < 3; i++) {
    const score = Math.abs(components[i]);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  if (bestIndex < 0) return target.set(0, 0, 1);

  // Built by setComponent rather than negating a unit axis: multiplying a zero
  // component by -1 yields -0, and toEqual([0, -1, 0]) does not accept -0.
  return target.set(0, 0, 0).setComponent(bestIndex, components[bestIndex] < 0 ? -1 : 1);
}
```

Then change the normal in `initialCutawayPose` from the raw camera direction to the snapped axis:

```js
export function initialCutawayPose(box, camera) {
  const position = box.getCenter(new THREE.Vector3());
  const diagonal = Math.max(box.getSize(new THREE.Vector3()).length(), 1);
  // Square the cut plane up with the part rather than the camera: the axis
  // nearest the view direction, so the near half is still what gets cut away.
  const normal = nearestCanonicalAxis(
    camera.getWorldDirection(new THREE.Vector3()).normalize(),
  );
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    PLANE_LOCAL_NORMAL,
    normal,
  );

  return {
    position,
    quaternion,
    size: diagonal * 1.25,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/framework/cutaway-math.test.js`
Expected: PASS, including the pre-existing "initial pose centers the plane..." test — its camera sits on +Z looking at the origin, so the direction `(0, 0, -1)` is already a canonical axis and the expected normal is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/framework/cutaway-math.js test/framework/cutaway-math.test.js
git commit -m "feat: snap the initial cutaway plane to the nearest canonical axis"
```

---

### Task 2: Plane/triangle slice

**Files:**
- Create: `src/framework/cutaway-outline.js`
- Test: `test/framework/cutaway-outline.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `sectionSegments(geometry: THREE.BufferGeometry, plane: THREE.Plane) => Float32Array` — flat `x,y,z` pairs, two points per segment, in the geometry's own frame. Used by Task 3.

- [ ] **Step 1: Write the failing test**

Create `test/framework/cutaway-outline.test.js`:

```js
import { describe, expect, test } from "vitest";
import * as THREE from "three";

import { sectionSegments } from "../../src/framework/cutaway-outline.js";

// Every emitted point, as Vector3s.
function points(segments) {
  const out = [];
  for (let i = 0; i < segments.length; i += 3) {
    out.push(new THREE.Vector3(segments[i], segments[i + 1], segments[i + 2]));
  }
  return out;
}

function segmentCount(segments) {
  return segments.length / 6;
}

function totalLength(segments) {
  let sum = 0;
  for (let i = 0; i < segments.length; i += 6) {
    sum += Math.hypot(
      segments[i + 3] - segments[i],
      segments[i + 4] - segments[i + 1],
      segments[i + 5] - segments[i + 2],
    );
  }
  return sum;
}

// A single triangle, given as three [x, y, z] triples.
function triangle(a, b, c) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([...a, ...b, ...c]), 3),
  );
  return geometry;
}

describe("sectionSegments", () => {
  test("cuts a box into its cross-section boundary", () => {
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);

    const segments = sectionSegments(geometry, plane);

    // The four side faces straddle the plane, two triangles each.
    expect(segmentCount(segments)).toBe(8);
    // Those eight segments tile the 2x2 square's perimeter exactly once.
    expect(totalLength(segments)).toBeCloseTo(8, 5);
    for (const point of points(segments)) {
      expect(point.x).toBeCloseTo(0, 6);
      expect(Math.max(Math.abs(point.y), Math.abs(point.z))).toBeCloseTo(1, 6);
    }
  });

  test("agrees between indexed and non-indexed geometry", () => {
    const indexed = new THREE.BoxGeometry(2, 2, 2);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.25);

    const fromIndexed = sectionSegments(indexed, plane);
    const fromSoup = sectionSegments(indexed.toNonIndexed(), plane);

    expect(segmentCount(fromSoup)).toBe(segmentCount(fromIndexed));
    expect(totalLength(fromSoup)).toBeCloseTo(totalLength(fromIndexed), 5);
  });

  test("emits inner and outer loops for a section with a hole", () => {
    // A torus in the XY plane, sliced by that plane, sections into two
    // concentric circles: the hole boundary at r=2 and the outer at r=4.
    const geometry = new THREE.TorusGeometry(3, 1, 8, 24);
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

    const segments = sectionSegments(geometry, plane);
    const radii = points(segments).map((p) => Math.hypot(p.x, p.y));

    expect(segmentCount(segments)).toBe(48);
    for (const point of points(segments)) expect(point.z).toBeCloseTo(0, 6);
    expect(radii.filter((r) => Math.abs(r - 2) < 1e-6).length).toBe(48);
    expect(radii.filter((r) => Math.abs(r - 4) < 1e-6).length).toBe(48);
  });

  test("returns nothing when the plane misses the geometry", () => {
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -5);

    expect(sectionSegments(geometry, plane)).toEqual(new Float32Array(0));
  });

  test("returns nothing for geometry without positions", () => {
    expect(sectionSegments(new THREE.BufferGeometry(), new THREE.Plane()))
      .toEqual(new Float32Array(0));
    expect(sectionSegments(null, new THREE.Plane())).toEqual(new Float32Array(0));
  });

  test("a plane touching one vertex emits no segment", () => {
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const grazing = triangle([0, 0, 0], [1, 1, 0], [-1, 1, 0]);

    expect(sectionSegments(grazing, plane)).toEqual(new Float32Array(0));
  });

  test("a plane crossing through one vertex emits one segment from it", () => {
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const crossing = triangle([0, 0, 0], [2, 1, 0], [2, -1, 0]);

    const segments = sectionSegments(crossing, plane);

    expect(segmentCount(segments)).toBe(1);
    expect([...segments.slice(0, 3)]).toEqual([0, 0, 0]);
    expect(segments[4]).toBeCloseTo(0, 6); // the far endpoint is on the plane too
    expect(segments[3]).toBeCloseTo(2, 6);
  });

  test("a triangle lying in the plane emits nothing", () => {
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const coplanar = triangle([0, 0, 0], [1, 0, 0], [0, 0, 1]);

    expect(sectionSegments(coplanar, plane)).toEqual(new Float32Array(0));
  });

  test("every emitted point survives the plane's keep-rule", () => {
    const geometry = new THREE.SphereGeometry(3, 16, 12);
    const plane = new THREE.Plane(new THREE.Vector3(0.3, 0.8, 0.5).normalize(), -0.4);

    const segments = sectionSegments(geometry, plane);

    expect(segmentCount(segments)).toBeGreaterThan(0);
    for (const point of points(segments)) {
      // Same rule as pointSurvivesPlane: the outline sits exactly on the
      // boundary of the kept half, never inside the discarded one.
      expect(plane.distanceToPoint(point)).toBeGreaterThanOrEqual(-1e-6);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/framework/cutaway-outline.test.js`
Expected: FAIL — cannot resolve `../../src/framework/cutaway-outline.js`.

- [ ] **Step 3: Implement**

Create `src/framework/cutaway-outline.js`:

```js
import * as THREE from "three";

// Matches POINT_EPSILON in cutaway-math.js: a vertex this close to the plane
// counts as lying on it, so a grazing plane produces neither duplicate nor
// zero-length segments.
const ON_PLANE_EPSILON = 1e-6;

const _vertices = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _distances = [0, 0, 0];
const _signs = [0, 0, 0];
const _crossing = new THREE.Vector3();

// Plane/triangle intersection over a BufferGeometry, in the geometry's own
// frame. Emits one segment per crossing triangle. Handles indexed (OCCT) and
// non-indexed (Manifold) geometry alike.
//
// Degenerate contact is resolved so each boundary edge is emitted exactly once:
//   - a triangle lying in the plane emits nothing; its neighbours bound it;
//   - a triangle touching the plane at one vertex only emits nothing;
//   - a triangle with an edge in the plane emits that edge only when its third
//     vertex is on the clipped side, so the two triangles sharing that edge do
//     not both emit it.
export function sectionSegments(geometry, plane) {
  const position = geometry?.getAttribute?.("position");
  if (!position) return new Float32Array(0);

  const index = geometry.getIndex?.() ?? null;
  const count = index ? index.count : position.count;
  const out = [];

  for (let i = 0; i + 2 < count; i += 3) {
    for (let k = 0; k < 3; k++) {
      _vertices[k].fromBufferAttribute(position, index ? index.getX(i + k) : i + k);
      const distance = plane.distanceToPoint(_vertices[k]);
      _distances[k] = distance;
      _signs[k] = distance > ON_PLANE_EPSILON
        ? 1
        : distance < -ON_PLANE_EPSILON ? -1 : 0;
    }

    const onPlane = (_signs[0] === 0 ? 1 : 0)
      + (_signs[1] === 0 ? 1 : 0)
      + (_signs[2] === 0 ? 1 : 0);

    if (onPlane === 3) continue;

    if (onPlane === 2) {
      const solo = _signs[0] !== 0 ? 0 : _signs[1] !== 0 ? 1 : 2;
      if (_signs[solo] !== -1) continue;
      pushPoint(out, _vertices[(solo + 1) % 3]);
      pushPoint(out, _vertices[(solo + 2) % 3]);
      continue;
    }

    if (onPlane === 1) {
      const zero = _signs[0] === 0 ? 0 : _signs[1] === 0 ? 1 : 2;
      const a = (zero + 1) % 3;
      const b = (zero + 2) % 3;
      if (_signs[a] === _signs[b]) continue;
      pushPoint(out, _vertices[zero]);
      pushPoint(out, crossingPoint(a, b));
      continue;
    }

    if (_signs[0] === _signs[1] && _signs[1] === _signs[2]) continue;
    for (let k = 0; k < 3; k++) {
      const a = k;
      const b = (k + 1) % 3;
      if (_signs[a] === _signs[b]) continue;
      pushPoint(out, crossingPoint(a, b));
    }
  }

  return new Float32Array(out);
}

function crossingPoint(a, b) {
  const t = _distances[a] / (_distances[a] - _distances[b]);
  return _crossing.copy(_vertices[a]).lerp(_vertices[b], t);
}

function pushPoint(out, point) {
  out.push(point.x, point.y, point.z);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/framework/cutaway-outline.test.js`
Expected: PASS, 9 tests.

If the torus counts come out wrong, the cause is the two-vertices-on-plane rule: the torus has whole rings of vertices exactly at `z = 0`, and each in-plane edge must be emitted by exactly one of the two triangles sharing it.

- [ ] **Step 5: Commit**

```bash
git add src/framework/cutaway-outline.js test/framework/cutaway-outline.test.js
git commit -m "feat: plane/triangle slice for cutaway section outlines"
```

---

### Task 3: Section outline object

**Files:**
- Modify: `src/framework/cutaway-outline.js`
- Test: `test/framework/cutaway-outline.test.js`

**Interfaces:**
- Consumes: `sectionSegments` from Task 2.
- Produces: `createSectionOutline({ mesh, plane, inkColor, now? }) => { object, refresh(), setVisible(on), setSuppressed(on), setInk(color), setTransparent(on), setViewportSize(width, height), sliceCost(), dispose() }`.
  - `object` is a `LineSegments2` parented to `mesh`.
  - `refresh()` returns `true` when it re-sliced, `false` when nothing changed or the outline is hidden.
  - `sliceCost()` returns the duration in ms of the most recent slice (`0` before any).
  - `now` defaults to `performance.now`; injected for deterministic tests.

- [ ] **Step 1: Write the failing test**

Append to `test/framework/cutaway-outline.test.js`. Extend the import at the top to `import { createSectionOutline, sectionSegments } from "../../src/framework/cutaway-outline.js";`

```js
describe("createSectionOutline", () => {
  function createFixture({ now } = {}) {
    const parent = new THREE.Group();
    parent.position.set(10, 0, 0);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(2, 2, 2),
      new THREE.MeshStandardMaterial(),
    );
    parent.add(mesh);
    parent.updateMatrixWorld(true);
    // World-space plane through the mesh's centre (which sits at x = 10).
    const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -10);
    const outline = createSectionOutline({
      mesh,
      plane,
      inkColor: 0x1c232d,
      now,
    });
    outline.setVisible(true);
    return { parent, mesh, plane, outline };
  }

  test("parents a fat-line object to the mesh and slices in mesh-local space", () => {
    const { mesh, outline } = createFixture();

    expect(outline.object.parent).toBe(mesh);
    expect(mesh.children).toContain(outline.object);
    expect(outline.object.frustumCulled).toBe(false);

    expect(outline.refresh()).toBe(true);
    expect(outline.object.visible).toBe(true);

    // Local coordinates: the mesh is at x = 10 in world, so the world plane at
    // x = 10 is the local plane at x = 0.
    const positions = outline.object.geometry.attributes.instanceStart.data.array;
    for (let i = 0; i < positions.length; i += 3) {
      expect(positions[i]).toBeCloseTo(0, 5);
    }
  });

  test("re-slices only when the plane, transform, or geometry changes", () => {
    const { mesh, plane, outline } = createFixture();

    expect(outline.refresh()).toBe(true);
    expect(outline.refresh()).toBe(false);

    plane.constant = -10.5;
    expect(outline.refresh()).toBe(true);
    expect(outline.refresh()).toBe(false);

    // A transform change with no plane change still moves the section: the
    // plane is world-fixed, so recentring slides the part through it.
    mesh.position.set(0, 0.3, 0);
    mesh.updateMatrixWorld(true);
    expect(outline.refresh()).toBe(true);
    expect(outline.refresh()).toBe(false);

    mesh.geometry = new THREE.BoxGeometry(3, 3, 3);
    expect(outline.refresh()).toBe(true);
    expect(outline.refresh()).toBe(false);
  });

  test("hides itself when the plane misses the mesh", () => {
    const { plane, outline } = createFixture();

    outline.refresh();
    expect(outline.object.visible).toBe(true);

    plane.constant = -100;
    outline.refresh();
    expect(outline.object.visible).toBe(false);
  });

  test("visibility and suppression both gate the object", () => {
    const { outline } = createFixture();
    outline.refresh();

    outline.setSuppressed(true);
    expect(outline.object.visible).toBe(false);
    outline.setSuppressed(false);
    expect(outline.object.visible).toBe(true);

    outline.setVisible(false);
    expect(outline.object.visible).toBe(false);
  });

  test("skips slicing while hidden and catches up when shown", () => {
    const { plane, outline } = createFixture();
    outline.refresh();

    outline.setVisible(false);
    plane.constant = -10.25;
    expect(outline.refresh()).toBe(false);

    outline.setVisible(true);
    expect(outline.refresh()).toBe(true);
  });

  test("records the slice cost from the injected clock", () => {
    let clock = 0;
    const { outline } = createFixture({ now: () => (clock += 4) });

    expect(outline.sliceCost()).toBe(0);
    outline.refresh();
    expect(outline.sliceCost()).toBe(4);
  });

  test("ink, transparency, and viewport size reach the line material", () => {
    const { outline } = createFixture();

    outline.setInk(0xff0000);
    expect(outline.object.material.color.getHex()).toBe(0xff0000);

    outline.setTransparent(true);
    expect(outline.object.material.transparent).toBe(true);

    outline.setViewportSize(800, 600);
    expect(outline.object.material.resolution.toArray()).toEqual([800, 600]);
  });

  test("dispose detaches the object and releases its resources", () => {
    const { mesh, outline } = createFixture();
    outline.refresh();
    const material = outline.object.material;
    const disposeSpy = vi.spyOn(material, "dispose");

    outline.dispose();

    expect(mesh.children).not.toContain(outline.object);
    expect(disposeSpy).toHaveBeenCalled();
    expect(outline.refresh()).toBe(false);
  });
});
```

Add `vi` to the vitest import at the top of the file: `import { describe, expect, test, vi } from "vitest";`

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/framework/cutaway-outline.test.js`
Expected: FAIL — `createSectionOutline is not a function`.

- [ ] **Step 3: Implement**

Add to `src/framework/cutaway-outline.js` — extend the imports at the top:

```js
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
```

Then append:

```js
const defaultNow = () => (typeof performance !== "undefined" ? performance.now() : 0);

// One cut-face outline for one subpart. The object is parented to the mesh, the
// same trick the stencil helpers use, so it inherits every present and future
// transform including the pose fast path — and it always slices whatever
// `mesh.geometry` currently draws, so the outline cannot disagree with the
// surface it bounds.
//
// The section moves for four unrelated reasons (plane pose, geometry swap,
// frameTo recentring the assembly under a world-fixed plane, and setSubPose),
// and only the first two notify the cutaway. Rather than thread invalidation
// through all four, refresh() compares a signature and re-slices when it
// differs — roughly 21 float compares per frame.
export function createSectionOutline({ mesh, plane, inkColor, now = defaultNow }) {
  const material = new LineMaterial({
    color: inkColor,
    linewidth: 1,
    // The outline lies exactly in the cap plane; pull it toward the viewer so
    // the coincident-depth line wins against the cap it sits in.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  material.resolution.set(1, 1);
  // Deliberately no clippingPlanes: the outline sits at distance ~0 from its
  // own plane, and clipping it would speckle.

  const object = new LineSegments2(new LineSegmentsGeometry(), material);
  object.frustumCulled = false;
  object.visible = false;
  mesh.add(object);

  const localPlane = new THREE.Plane();
  const inverse = new THREE.Matrix4();
  const lastNormal = new THREE.Vector3(NaN, NaN, NaN);
  const lastMatrix = new THREE.Matrix4();
  let lastConstant = NaN;
  let lastGeometry = null;
  let lastCost = 0;
  let hasSegments = false;
  let visible = false;
  let suppressed = false;
  let disposed = false;

  function applyVisibility() {
    object.visible = visible && hasSegments && !suppressed && !disposed;
  }

  function slice(geometry, matrixWorld) {
    const start = now();
    localPlane.copy(plane).applyMatrix4(inverse.copy(matrixWorld).invert());
    const segments = geometry
      ? sectionSegments(geometry, localPlane)
      : new Float32Array(0);
    hasSegments = segments.length > 0;
    const previous = object.geometry;
    const next = new LineSegmentsGeometry();
    if (hasSegments) next.setPositions(segments);
    object.geometry = next;
    previous?.dispose();
    lastCost = now() - start;
    applyVisibility();
  }

  function refresh() {
    if (disposed || !visible || suppressed) return false;
    mesh.updateWorldMatrix(true, false);
    const geometry = mesh.geometry;
    if (
      geometry === lastGeometry
      && plane.constant === lastConstant
      && plane.normal.equals(lastNormal)
      && mesh.matrixWorld.equals(lastMatrix)
    ) {
      return false;
    }
    lastGeometry = geometry;
    lastConstant = plane.constant;
    lastNormal.copy(plane.normal);
    lastMatrix.copy(mesh.matrixWorld);
    slice(geometry, mesh.matrixWorld);
    return true;
  }

  return {
    object,
    refresh,
    sliceCost: () => lastCost,
    setVisible(on) {
      if (disposed) return;
      visible = Boolean(on);
      applyVisibility();
    },
    setSuppressed(on) {
      if (disposed) return;
      suppressed = Boolean(on);
      applyVisibility();
    },
    setInk(color) {
      if (!disposed) material.color.set(color);
    },
    setTransparent(on) {
      if (disposed || material.transparent === Boolean(on)) return;
      material.transparent = Boolean(on);
      material.needsUpdate = true;
    },
    setViewportSize(width, height) {
      if (!disposed) material.resolution.set(width, height);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      object.visible = false;
      mesh.remove(object);
      object.geometry?.dispose();
      material.dispose();
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/framework/cutaway-outline.test.js`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/framework/cutaway-outline.js test/framework/cutaway-outline.test.js
git commit -m "feat: per-subpart cutaway outline object with dirty-check re-slicing"
```

---

### Task 4: Wire the outline into the section render set

**Files:**
- Modify: `src/framework/cutaway-render.js`
- Test: `test/framework/cutaway-render.test.js`

**Interfaces:**
- Consumes: `createSectionOutline` from Task 3.
- Produces: `createSectionRenderSet` gains a `now` option and four methods on its return value: `refreshOutline() => boolean`, `outlineSliceCost() => number`, `setOutlineSuppressed(on)`, and `outline` (the object from Task 3, exposed for tests). Also exports `OUTLINE_ORDER_BASE = 2_500_000`.

- [ ] **Step 1: Write the failing test**

Append to `test/framework/cutaway-render.test.js`. Extend the import block to include `OUTLINE_ORDER_BASE`.

```js
describe("section outline", () => {
  test("adds an outline to the mesh, ordered above edges and below the overlay", () => {
    const { mesh, renderSet } = createFixture({ order: 3 });

    expect(OUTLINE_ORDER_BASE).toBe(2_500_000);
    expect(OUTLINE_ORDER_BASE).toBeLessThan(CUTAWAY_OVERLAY_RENDER_ORDER);
    expect(mesh.children).toContain(renderSet.outline.object);
    expect(renderSet.outline.object.renderOrder).toBe(OUTLINE_ORDER_BASE + 3);
    expect(renderSet.outline.object.material.clippingPlanes).toBeNull();
  });

  test("outline visibility follows the cap", () => {
    const { renderSet } = createFixture();

    renderSet.setEnabled(true);
    renderSet.setVisible(true);
    renderSet.refreshOutline();
    expect(renderSet.outline.object.visible).toBe(true);

    renderSet.setVisible(false);
    expect(renderSet.outline.object.visible).toBe(false);

    renderSet.setVisible(true);
    renderSet.refreshOutline();
    renderSet.setEnabled(false);
    expect(renderSet.outline.object.visible).toBe(false);
  });

  test("suppression hides the outline without clearing its visibility", () => {
    const { renderSet } = createFixture();
    renderSet.setEnabled(true);
    renderSet.setVisible(true);
    renderSet.refreshOutline();

    renderSet.setOutlineSuppressed(true);
    expect(renderSet.outline.object.visible).toBe(false);

    renderSet.setOutlineSuppressed(false);
    expect(renderSet.outline.object.visible).toBe(true);
  });

  test("hatch ink, viewport size, and transparency reach the outline", () => {
    const { renderSet } = createFixture();

    renderSet.setHatchInk(0x00ff00);
    expect(renderSet.outline.object.material.color.getHex()).toBe(0x00ff00);

    renderSet.setViewportSize(640, 480, 2);
    expect(renderSet.outline.object.material.resolution.toArray()).toEqual([640, 480]);

    // The fixture's source material is translucent, so the cap is transparent
    // and the outline must join it in the transparent draw list.
    expect(renderSet.outline.object.material.transparent).toBe(true);
  });

  test("reports the outline slice cost from the injected clock", () => {
    let clock = 0;
    const { renderSet } = createFixture({ now: () => (clock += 3) });
    renderSet.setEnabled(true);
    renderSet.setVisible(true);

    expect(renderSet.outlineSliceCost()).toBe(0);
    renderSet.refreshOutline();
    expect(renderSet.outlineSliceCost()).toBe(3);
  });

  test("dispose removes the outline from the mesh", () => {
    const { mesh, renderSet } = createFixture();

    renderSet.dispose();

    expect(mesh.children).not.toContain(renderSet.outline.object);
  });
});
```

Update `createFixture` in that file to accept and forward `now`, and to make the outline visible by default is NOT needed — the render set drives visibility. Change its signature and the `createSectionRenderSet` call:

```js
function createFixture({
  order = 0,
  inkColor = 0x2468ac,
  edgeMaterial: providedEdgeMaterial,
  now,
} = {}) {
```

```js
  const renderSet = createSectionRenderSet({
    scene,
    mesh,
    edgeLines,
    plane,
    capGeometry,
    order,
    inkColor,
    now,
  });
```

The fixture's plane is `new THREE.Plane(new THREE.Vector3(1, 0, 0), 0)` and its mesh is transformed away from the origin, so add this line to `createFixture` right before the `createSectionRenderSet` call so the plane actually crosses the mesh and the slice produces segments:

```js
  mesh.updateWorldMatrix(true, false);
  plane.setFromNormalAndCoplanarPoint(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld),
  );
```

Also import `CUTAWAY_OVERLAY_RENDER_ORDER` in the test file's import block if it is not already there.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/framework/cutaway-render.test.js`
Expected: FAIL — `OUTLINE_ORDER_BASE` is undefined and `renderSet.outline` is undefined.

- [ ] **Step 3: Implement**

In `src/framework/cutaway-render.js`:

Add the import at the top:

```js
import { createSectionOutline } from "./cutaway-outline.js";
```

Add the order constant next to the existing ones:

```js
export const OUTLINE_ORDER_BASE = 2_500_000;
```

Add `now` to the destructured options of `createSectionRenderSet`:

```js
export function createSectionRenderSet({
  scene,
  mesh,
  edgeLines,
  plane,
  capGeometry,
  order,
  inkColor,
  now,
}) {
```

After the `cap.renderOrder = stencilOrder + 1;` line, create the outline:

```js
  // Cut-face outline: real 3D segments sliced from the mesh, drawn with the
  // same fat-line renderer as the viewer's feature edges. Ordered above the
  // clipped edges so it wins the coincident depth against its own cap.
  const outline = createSectionOutline({ mesh, plane, inkColor, now });
  outline.object.renderOrder = OUTLINE_ORDER_BASE + order;
  outline.setTransparent(capMaterial.transparent);
```

Extend `updateHelperVisibility`:

```js
  function updateHelperVisibility() {
    const on = enabled && visible && !disposed;
    back.visible = on;
    front.visible = on;
    cap.visible = on;
    outline.setVisible(on);
  }
```

Extend `setHatchInk`:

```js
  function setHatchInk(color) {
    if (disposed) return;
    capMaterial.userData.setInkColor(color);
    outline.setInk(color);
  }
```

Extend `setViewportSize`:

```js
  function setViewportSize(width, height, pixelRatio = 1) {
    if (disposed) return;
    viewportSize = { width, height, pixelRatio };
    setLineResolution(clippedEdgeMaterial, width, height);
    outline.setViewportSize(width, height);
    capMaterial.userData.setScreenScale(pixelRatio);
  }
```

In `refreshSourceMaterial`, after the line `if (clippedEdgeMaterial && capMaterial.transparent) makeTransparent(clippedEdgeMaterial);`, add:

```js
    outline.setTransparent(capMaterial.transparent);
```

In `dispose`, before `for (const material of ownedMaterials) material.dispose();`, add:

```js
    outline.dispose();
```

Add to the returned object:

```js
    outline,
    refreshOutline: outline.refresh,
    outlineSliceCost: outline.sliceCost,
    setOutlineSuppressed: outline.setSuppressed,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/framework/cutaway-render.test.js`
Expected: PASS, including all pre-existing tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/framework/cutaway-render.js test/framework/cutaway-render.test.js
git commit -m "feat: attach the cut-face outline to each section render set"
```

---

### Task 5: Refresh outlines every frame from the controller

**Files:**
- Modify: `src/framework/cutaway.js`
- Test: `test/framework/cutaway.test.js`

**Interfaces:**
- Consumes: `refreshOutline()` from Task 4.
- Produces: `createCutaway` gains a `now` option, forwarded to every render set. `updateForCamera()` also refreshes section outlines.

- [ ] **Step 1: Write the failing test**

Append to `test/framework/cutaway.test.js`:

```js
describe("section outlines", () => {
  test("updateForCamera re-slices outlines while enabled", () => {
    const fixture = createFixture();
    const { mesh } = addSubpart(fixture);
    fixture.controller.setEnabled(true);

    const outline = fixture.controller._renderSetFor("body").outline;
    fixture.controller.updateForCamera();
    expect(outline.object.visible).toBe(true);

    // A world-fixed plane with a moved part still changes the section.
    const before = outline.object.geometry;
    mesh.position.set(0, 0, 1.5);
    mesh.updateMatrixWorld(true);
    fixture.controller.updateForCamera();
    expect(outline.object.geometry).not.toBe(before);
  });

  test("updateForCamera does not re-slice while disabled", () => {
    const fixture = createFixture();
    addSubpart(fixture);
    // Spy on the render set, not the outline: refreshSections looks the method
    // up on the render set at call time, so a spy there is what intercepts.
    const renderSet = fixture.controller._renderSetFor("body");
    const refresh = vi.spyOn(renderSet, "refreshOutline");

    fixture.controller.updateForCamera();

    expect(refresh).not.toHaveBeenCalled();
  });

  test("flipping leaves the outline segments alone", () => {
    const fixture = createFixture();
    addSubpart(fixture);
    fixture.controller.setEnabled(true);
    fixture.controller.updateForCamera();

    const outline = fixture.controller._renderSetFor("body").outline;
    const before = outline.object.geometry.attributes.instanceStart.data.array.slice();

    fixture.controller.flip();
    fixture.controller.updateForCamera();

    const after = outline.object.geometry.attributes.instanceStart.data.array;
    expect([...after]).toEqual([...before]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/framework/cutaway.test.js -t "section outlines"`
Expected: FAIL — `fixture.controller._renderSetFor is not a function`.

- [ ] **Step 3: Implement**

In `src/framework/cutaway.js`:

Add `now` to the destructured options:

```js
export function createCutaway({
  renderer,
  scene,
  camera,
  orbitControls,
  domElement,
  getBounds,
  edgeColor,
  schedule = defaultSchedule,
  now,
}) {
```

Forward it in `setSubpart`'s `createSectionRenderSet` call:

```js
    const renderSet = createSectionRenderSet({
      scene,
      mesh,
      edgeLines,
      plane,
      capGeometry,
      order,
      inkColor: hatchInk,
      now,
    });
```

Add the refresh helper next to `updateForCamera` and call it there:

```js
  // Per-frame maintenance while the cutaway is on: the gizmo rescales for the
  // camera, and every visible section re-slices its outline if anything it
  // depends on moved. Both are cheap no-ops when nothing changed.
  function refreshSections() {
    for (const { renderSet } of renderSets.values()) renderSet.refreshOutline();
  }

  function updateForCamera() {
    if (!enabled || disposed) return;
    gizmo.updateForCamera();
    refreshSections();
  }
```

Add a test-only accessor to the returned object, next to the other members:

```js
    _renderSetFor: (name) => renderSets.get(name)?.renderSet ?? null,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/framework/cutaway.test.js`
Expected: PASS, including the two pre-existing `updateForCamera` tests.

- [ ] **Step 5: Commit**

```bash
git add src/framework/cutaway.js test/framework/cutaway.test.js
git commit -m "feat: refresh cutaway outlines each frame while enabled"
```

---

### Task 6: Gizmo drag-change callback

**Files:**
- Modify: `src/framework/cutaway-gizmo.js`
- Test: `test/framework/cutaway-gizmo.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `createCutawayGizmo` accepts `onDragChange = (active: boolean) => {}`, called with `true` when a drag starts and `false` when it ends by any route. Used by Task 7.

- [ ] **Step 1: Write the failing test**

Append to `test/framework/cutaway-gizmo.test.js`:

```js
test("drag change fires once on start and once on every termination route", () => {
  for (const finish of ["pointerup", "pointercancel", "lostpointercapture", "pointerleave", "blur"]) {
    const onDragChange = vi.fn();
    const { domElement, gizmo } = createFixture({
      pickHandle: () => "translate",
      onDragChange,
    });
    gizmo.setVisible(true);

    pointer(domElement, "pointerdown");
    expect(onDragChange).toHaveBeenCalledTimes(1);
    expect(onDragChange).toHaveBeenLastCalledWith(true);

    if (finish === "blur") window.dispatchEvent(new Event("blur"));
    else pointer(domElement, finish);

    expect(onDragChange).toHaveBeenCalledTimes(2);
    expect(onDragChange).toHaveBeenLastCalledWith(false);
  }
});

test("drag change does not fire when no drag is in flight", () => {
  const onDragChange = vi.fn();
  const { domElement, gizmo } = createFixture({
    pickHandle: () => null,
    onDragChange,
  });
  gizmo.setVisible(true);

  pointer(domElement, "pointerdown");
  pointer(domElement, "pointerup");

  expect(onDragChange).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/framework/cutaway-gizmo.test.js -t "drag change"`
Expected: FAIL — `onDragChange` is never called (0 calls received).

- [ ] **Step 3: Implement**

In `src/framework/cutaway-gizmo.js`, add the option:

```js
  onHandleHoverChange = () => {},
  onDragChange = () => {},
  pickHandle,
```

In `onPointerDown`, after `drag = nextDrag;`, add:

```js
    onDragChange(true);
```

In `endDrag`, after `safeRelease(ending.pointerId);`, add:

```js
    onDragChange(false);
```

`endDrag` already returns early when there is no drag, so the callback is balanced across pointerup, pointercancel, lost capture, pointerleave, window blur, `setVisible(false)`, and `dispose`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/framework/cutaway-gizmo.test.js`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/framework/cutaway-gizmo.js test/framework/cutaway-gizmo.test.js
git commit -m "feat: report gizmo drag start and end to the cutaway controller"
```

---

### Task 7: Suppress outlines during expensive drags

**Files:**
- Modify: `src/framework/cutaway.js`
- Test: `test/framework/cutaway.test.js`

**Interfaces:**
- Consumes: `onDragChange` from Task 6; `outlineSliceCost()` and `setOutlineSuppressed()` from Task 4.
- Produces: no new public API. Exported constant `OUTLINE_SLICE_BUDGET_MS = 2` from `cutaway.js` for the test to reference.

- [ ] **Step 1: Write the failing test**

Extend the file's import to `import { OUTLINE_SLICE_BUDGET_MS, createCutaway } from "../../src/framework/cutaway.js";`

These tests drive the clock, so `createFixture` in `test/framework/cutaway.test.js` has to accept and forward it. Add `now` to its options and to the `createCutaway` call:

```js
function createFixture({
  stencil = true,
  box,
  schedule: providedSchedule,
  localClippingEnabled = false,
  edgeColor = 0x1c232d,
  now,
} = {}) {
```

```js
  const controller = createCutaway({
    renderer,
    scene,
    camera,
    orbitControls,
    domElement,
    getBounds: () => bounds,
    schedule: providedSchedule ?? timer.schedule,
    edgeColor,
    now,
  });
```

Then append to the `describe("section outlines", ...)` block:

```js
  test("outlines keep tracking the plane during a cheap drag", () => {
    let clock = 0;
    const fixture = createFixture({ now: () => (clock += 0.5) });
    addSubpart(fixture);
    fixture.controller.setEnabled(true);
    fixture.controller.updateForCamera();

    const outline = fixture.controller._renderSetFor("body").outline;
    expect(outline.sliceCost()).toBeLessThan(OUTLINE_SLICE_BUDGET_MS);

    fixture.controller._setDragging(true);
    expect(outline.object.visible).toBe(true);
  });

  test("outlines hide for the drag when the last slice blew the budget", () => {
    let clock = 0;
    const fixture = createFixture({ now: () => (clock += 25) });
    addSubpart(fixture);
    fixture.controller.setEnabled(true);
    fixture.controller.updateForCamera();

    const outline = fixture.controller._renderSetFor("body").outline;
    expect(outline.sliceCost()).toBeGreaterThan(OUTLINE_SLICE_BUDGET_MS);
    expect(outline.object.visible).toBe(true);

    fixture.controller._setDragging(true);
    expect(outline.object.visible).toBe(false);

    fixture.controller._setDragging(false);
    expect(outline.object.visible).toBe(true);
  });

  test("a drag that ends re-slices whatever moved while outlines were hidden", () => {
    let clock = 0;
    const fixture = createFixture({ now: () => (clock += 25) });
    const { mesh } = addSubpart(fixture);
    fixture.controller.setEnabled(true);
    fixture.controller.updateForCamera();

    const outline = fixture.controller._renderSetFor("body").outline;
    fixture.controller._setDragging(true);
    const stale = outline.object.geometry;
    mesh.position.set(0, 0, 1.5);
    mesh.updateMatrixWorld(true);
    fixture.controller._setDragging(false);

    expect(outline.object.geometry).not.toBe(stale);
  });
```

The `_setDragging` accessor exists so the controller's policy is testable without synthesising gizmo pointer events; Task 6 already proved the gizmo calls it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/framework/cutaway.test.js -t "outlines hide"`
Expected: FAIL — `OUTLINE_SLICE_BUDGET_MS` is undefined and `_setDragging` is not a function.

- [ ] **Step 3: Implement**

In `src/framework/cutaway.js`, add the constant next to `IDLE_DELAY_MS`:

```js
// Slicing rides on top of everything else in the frame, so the whole visible
// assembly gets about an eighth of a 60 fps frame before outlines step aside
// for the duration of a drag.
export const OUTLINE_SLICE_BUDGET_MS = 2;
```

Add the state next to the other `let` declarations:

```js
  let outlinesSuppressed = false;
```

Add the policy near `refreshSections`:

```js
  // Outlines re-slice on every frame of a gizmo drag. On heavy assemblies that
  // is the one place the cost could show, so decide once at drag start — from
  // costs already measured, so the drag never pays a spike to discover it is
  // too expensive — and hide all of them or none. Half-outlined assemblies read
  // as broken.
  function setDragging(active) {
    if (disposed) return;
    if (active) {
      let total = 0;
      for (const { renderSet } of renderSets.values()) total += renderSet.outlineSliceCost();
      outlinesSuppressed = total > OUTLINE_SLICE_BUDGET_MS;
    } else {
      outlinesSuppressed = false;
    }
    for (const { renderSet } of renderSets.values()) {
      renderSet.setOutlineSuppressed(outlinesSuppressed);
    }
    if (!active) refreshSections();
  }
```

Wire it into the gizmo construction:

```js
  const gizmo = createCutawayGizmo({
    scene,
    overlayScene,
    camera,
    domElement,
    orbitControls,
    onPoseChange,
    onActivity: showActive,
    onHandleHoverChange: publishHandleHover,
    onDragChange: setDragging,
  });
```

New render sets must inherit the current suppression, so in `setSubpart`, next to the existing `renderSet.setVisible(...)` / `renderSet.setEnabled(...)` calls, add:

```js
    renderSet.setOutlineSuppressed(outlinesSuppressed);
```

Add the test accessor to the returned object next to `_renderSetFor`:

```js
    _setDragging: setDragging,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/framework/cutaway.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/cutaway.js test/framework/cutaway.test.js
git commit -m "feat: stand outlines down during drags that blow the slice budget"
```

---

### Task 8: Rotation snapping

**Files:**
- Modify: `src/framework/cutaway-math.js`
- Modify: `src/framework/cutaway-gizmo.js`
- Test: `test/framework/cutaway-math.test.js`
- Test: `test/framework/cutaway-gizmo.test.js`

**Interfaces:**
- Consumes: `nearestCanonicalAxis` from Task 1.
- Produces: `AXIS_SNAP_RADIANS` (7 degrees in radians) and `snapQuaternionToAxis(quaternion, maxAngle?, target?) => THREE.Quaternion` from `cutaway-math.js`.

- [ ] **Step 1: Write the failing tests**

Append to `test/framework/cutaway-math.test.js` (add `AXIS_SNAP_RADIANS` and `snapQuaternionToAxis` to the import block):

```js
test("axis snap threshold is 7 degrees", () => {
  expect(AXIS_SNAP_RADIANS).toBeCloseTo((7 * Math.PI) / 180, 10);
});

test("snapping pulls a near-axis normal exactly onto the axis", () => {
  const nudged = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    (4 * Math.PI) / 180,
  );

  const snapped = snapQuaternionToAxis(nudged);
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(snapped);

  expect(normal.x).toBeCloseTo(0, 6);
  expect(normal.y).toBeCloseTo(0, 6);
  expect(normal.z).toBeCloseTo(1, 6);
});

test("snapping leaves a normal outside the threshold alone", () => {
  const nudged = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    (12 * Math.PI) / 180,
  );

  const snapped = snapQuaternionToAxis(nudged);
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(snapped);

  expect(normal.angleTo(new THREE.Vector3(0, 0, 1))).toBeCloseTo((12 * Math.PI) / 180, 6);
});

test("snapping preserves in-plane roll so the gizmo rings do not spin", () => {
  const roll = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    Math.PI / 3,
  );
  const tilt = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    (3 * Math.PI) / 180,
  );
  const pose = tilt.clone().multiply(roll);

  const snapped = snapQuaternionToAxis(pose);
  const rolledAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(snapped);
  const expected = new THREE.Vector3(1, 0, 0).applyQuaternion(roll);

  // The normal lands on +Z, and the in-plane direction stays where the roll
  // put it rather than jumping to whatever setFromUnitVectors would pick.
  expect(new THREE.Vector3(0, 0, 1).applyQuaternion(snapped).z).toBeCloseTo(1, 6);
  expect(rolledAxis.angleTo(expected)).toBeLessThan(0.06); // within the 3-degree tilt
});

test("snapping honours a custom threshold and writes into a target", () => {
  const nudged = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    (10 * Math.PI) / 180,
  );
  const target = new THREE.Quaternion();

  const result = snapQuaternionToAxis(nudged, (12 * Math.PI) / 180, target);

  expect(result).toBe(target);
  expect(new THREE.Vector3(0, 0, 1).applyQuaternion(result).z).toBeCloseTo(1, 6);
});
```

Append to `test/framework/cutaway-gizmo.test.js`. First extend the `pointer` helper with a `shiftKey` option:

```js
function pointer(domElement, type, {
  x = 100,
  y = 100,
  pointerId = 7,
  pointerType = "mouse",
  shiftKey = false,
} = {}) {
  domElement.dispatchEvent(new PointerEvent(type, {
    pointerId,
    pointerType,
    clientX: x,
    clientY: y,
    button: 0,
    shiftKey,
    bubbles: true,
  }));
}
```

Then add the tests:

```js
// Camera on +Z looking at the origin, so the initial plane normal is -Z and a
// rotate-x drag runs in screen-rotate mode: SCREEN_ROTATION_RADIANS_PER_PIXEL
// is PI/240, i.e. 0.75 degrees per pixel of vertical drag.
function rotateBy(fixture, pixels, { shiftKey = false } = {}) {
  const { domElement } = fixture;
  pointer(domElement, "pointerdown", { x: 100, y: 100 });
  pointer(domElement, "pointermove", { x: 100, y: 100 + pixels, shiftKey });
  pointer(domElement, "pointerup", { x: 100, y: 100 + pixels });
  return new THREE.Vector3(0, 0, 1).applyQuaternion(fixture.gizmo.group.quaternion);
}

test("rotation snaps to a canonical axis inside the threshold", () => {
  const fixture = createFixture({ pickHandle: () => "rotate-x" });
  fixture.gizmo.setVisible(true);
  setProductionPose(fixture);

  // 5 px is 3.75 degrees, inside the 7-degree snap zone.
  const normal = rotateBy(fixture, 5);

  expect(normal.angleTo(new THREE.Vector3(0, 0, -1))).toBeCloseTo(0, 6);
});

test("rotation past the threshold is left alone", () => {
  const fixture = createFixture({ pickHandle: () => "rotate-x" });
  fixture.gizmo.setVisible(true);
  setProductionPose(fixture);

  // 12 px is 9 degrees, outside the snap zone.
  const normal = rotateBy(fixture, 12);

  expect(normal.angleTo(new THREE.Vector3(0, 0, -1)))
    .toBeCloseTo((9 * Math.PI) / 180, 4);
});

test("holding shift disables snapping", () => {
  const fixture = createFixture({ pickHandle: () => "rotate-x" });
  fixture.gizmo.setVisible(true);
  setProductionPose(fixture);

  const normal = rotateBy(fixture, 5, { shiftKey: true });

  expect(normal.angleTo(new THREE.Vector3(0, 0, -1)))
    .toBeCloseTo((3.75 * Math.PI) / 180, 4);
});

test("translation is never snapped", () => {
  const fixture = createFixture({ pickHandle: () => "translate" });
  fixture.gizmo.setVisible(true);
  const pose = setProductionPose(fixture);

  pointer(fixture.domElement, "pointerdown", { x: 100, y: 100 });
  pointer(fixture.domElement, "pointermove", { x: 100, y: 80 });
  pointer(fixture.domElement, "pointerup", { x: 100, y: 80 });

  expect(fixture.gizmo.group.quaternion.angleTo(pose.quaternion)).toBeCloseTo(0, 6);
  expect(fixture.gizmo.group.position.equals(pose.position)).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/framework/cutaway-math.test.js test/framework/cutaway-gizmo.test.js`
Expected: FAIL — `snapQuaternionToAxis is not a function`, and the gizmo snap tests report the raw 3.75-degree rotation instead of 0.

- [ ] **Step 3: Implement**

In `src/framework/cutaway-math.js`, add below `nearestCanonicalAxis`:

```js
export const AXIS_SNAP_RADIANS = (7 * Math.PI) / 180;

// Pull a plane pose onto the nearest canonical axis once its normal is within
// `maxAngle` of one. The correction is the minimal rotation carrying the normal
// onto the axis, not a rebuilt quaternion, so the plane's in-plane roll survives
// and the gizmo rings do not visibly spin at the moment of snapping. Roll does
// not affect the clip either way.
export function snapQuaternionToAxis(
  quaternion,
  maxAngle = AXIS_SNAP_RADIANS,
  target = new THREE.Quaternion(),
) {
  const normal = PLANE_LOCAL_NORMAL.clone().applyQuaternion(quaternion).normalize();
  const axis = nearestCanonicalAxis(normal);
  if (normal.angleTo(axis) > maxAngle) return target.copy(quaternion);
  return target
    .setFromUnitVectors(normal, axis)
    .multiply(quaternion)
    .normalize();
}
```

In `src/framework/cutaway-gizmo.js`, extend the import from `./cutaway-math.js`:

```js
import {
  axisParameterFromRay,
  signedAngleAroundAxis,
  snapQuaternionToAxis,
} from "./cutaway-math.js";
```

Add a scratch quaternion next to the other module-level scratch state inside the factory (near `const raycaster = new THREE.Raycaster();`):

```js
  const _snapped = new THREE.Quaternion();
```

Add the helper next to `notifyPose`:

```js
  // Rotation lands on a canonical axis when it gets close to one. Shift is read
  // per move rather than latched at pointer-down, so it can be pressed and
  // released mid-drag; it is unbound during a gizmo drag because orbit controls
  // are already disabled.
  function snapRotation(candidate, event) {
    candidate.normalize();
    return event.shiftKey ? candidate : snapQuaternionToAxis(candidate, undefined, _snapped);
  }
```

In `onPointerMove`, in the `screen-rotate` branch, replace:

```js
      group.quaternion.copy(delta.multiply(drag.startQuaternion)).normalize();
```

with:

```js
      group.quaternion.copy(snapRotation(delta.multiply(drag.startQuaternion), event));
```

And make the same replacement in the `plane-rotate` path at the end of `onPointerMove` (the final `group.quaternion.copy(...)` in the function). Leave the translate branch untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/framework/cutaway-math.test.js test/framework/cutaway-gizmo.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/cutaway-math.js src/framework/cutaway-gizmo.js test/framework/cutaway-math.test.js test/framework/cutaway-gizmo.test.js
git commit -m "feat: snap cutaway rotation to canonical axes within 7 degrees"
```

---

### Task 9: Full verification and version bump

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: everything above.
- Produces: a release-ready branch.

- [ ] **Step 1: Run the whole suite**

```bash
nvm use && npm test
```

Expected: PASS, no skipped or failing files. If a viewer test fails on a cutaway mock missing a new method, add the method to the mock in `test/framework/viewer-cutaway.test.js` or `test/framework/viewer-pose.test.js` — those files stub the controller with `vi.fn()` members.

- [ ] **Step 2: Production build**

```bash
npm run build
```

Expected: build completes with no errors.

- [ ] **Step 3: Headless smoke check in real Chromium**

```bash
npm run check
```

Expected: all three demo apps boot clean. This needs Playwright's Chromium; if it is missing, install it with `npm i -D playwright && npx playwright install chromium`.

- [ ] **Step 4: Interactive check**

```bash
npm run dev
```

Open `/planter.html`, turn the cutaway on, and confirm by eye:

1. The cut face has a crisp outline in the same ink as the hatch, including a ring around the interior bore.
2. The plane starts square with the part, not tilted to the camera.
3. Dragging the rotate rings snaps the plane flat onto an axis as it gets close, and holding Shift lets it sit a couple of degrees off.
4. The outline tracks the plane live while dragging.
5. Switch to the light theme: the outline ink follows.
6. Switch view tabs: the outline follows the recentred assembly rather than lagging behind it.

- [ ] **Step 5: Bump the version**

In `package.json`, change `"version": "0.38.1"` to `"version": "0.39.0"` — new viewer behavior, no breaking API change. Publishing is tag-driven and happens after merge (see the Releasing section of `AGENTS.md`); do not run `npm publish`.

- [ ] **Step 6: Commit**

```bash
git add package.json
git commit -m "chore: 0.39.0"
```

---

## Notes for the implementer

- **Why the outline is not clipped.** Every other material in the section render set carries `clippingPlanes = [plane]`. The outline deliberately does not: it lies at distance ~0 from that exact plane, so GPU clipping would drop fragments at random along it.
- **Why the outline reads `mesh.geometry` rather than taking a geometry argument.** `viewer.setSubGeometry` calls `cutaway.updateGeometry` before `showAssembly` assigns the new geometry to the mesh. Slicing whatever the mesh currently draws means the outline can never disagree with the surface it bounds, whatever order those calls arrive in.
- **Picking is unaffected.** `src/framework/selection/raycast.js` uses `intersectObjects(meshes, false)` — non-recursive — so children of a subpart mesh (the stencil helpers, and now the outline) are never hit-tested.
