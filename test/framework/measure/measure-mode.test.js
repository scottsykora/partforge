// @vitest-environment happy-dom
// Orchestrator against a minimal real-three fake viewer: enable -> always-on
// dims; hover -> feature dims; click -> pin + param reveal; regen re-anchor.
// Dimensions are in-scene objects now, so the observation surface is the
// "pf-dims" group under the meshes' shared parent (each label mesh carries its
// item id in userData.pfDimItemId) rather than an SVG overlay.
import { expect, test, vi, beforeEach } from "vitest";
import * as THREE from "three";
import { createMeasureMode } from "../../../src/framework/measure/measure-mode.js";
import { raycastViewer } from "../../../src/framework/selection/raycast.js";
import { placeDims } from "../../../src/framework/measure/dim3-place.js";
import { classifyFeature } from "../../../src/framework/measure/feature-dims.js";

// Pass-through spy on the placement entry point: behaviour is untouched, but
// "which items were re-placed, and when" becomes observable — the base/hover
// split is otherwise invisible from the scene (identical drawings either way).
vi.mock("../../../src/framework/measure/dim3-place.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, placeDims: vi.fn(actual.placeDims) };
});

// dim3-scene's default label painter needs a real 2d context; happy-dom has
// none. Stub the minimum it touches and record every painted string, which is
// how the param-link assertions read label content.
const paintLog = [];
HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    font: "", fillStyle: "", strokeStyle: "", lineWidth: 0,
    lineJoin: "", textAlign: "", textBaseline: "",
    measureText: (t) => ({ width: 8 * String(t).length }),
    fillText: (t) => { paintLog.push(String(t)); },
    strokeText: (t) => { paintLog.push(String(t)); },
    beginPath() {}, roundRect() {}, fill() {}, stroke() {},
  };
};
beforeEach(() => { paintLog.length = 0; });

// A 20×10 plate: one sub-part, one labeled planar feature covering both
// triangles of its top face at z=2. Non-indexed, feature ids per triangle.
// `halfLabeled` leaves the upper-left triangle unlabeled (see the label-pick
// test, which needs a spot where a raycast resolves to something OTHER than
// the pinned feature).
function plateMesh({ halfLabeled = false } = {}) {
  const positions = new Float32Array([
    0, 0, 2, 20, 0, 2, 20, 10, 2,
    0, 0, 2, 20, 10, 2, 0, 10, 2,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.userData.featureIds = new Uint16Array([1, halfLabeled ? 0 : 1]);
  geo.userData.features = ["top face"];
  return new THREE.Mesh(geo);
}

// `parts` is the meshes' shared parent group — the frame every dimension is
// placed in, and the node the dim group parents itself under.
function fakeViewer(mesh, parts = new THREE.Group()) {
  const dom = document.createElement("div");
  const stage = document.createElement("div");
  stage.appendChild(dom);
  dom.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(10, 5, 40); // over the plate center, looking down -Z
  camera.lookAt(10, 5, 2);
  camera.updateMatrixWorld(true);
  mesh.name = "plate";
  if (mesh.parent !== parts) parts.add(mesh);
  parts.updateMatrixWorld(true);
  const frameCbs = new Set();
  const handleHoverCbs = new Set();
  const themeCbs = new Set();
  return {
    domElement: dom,
    stageElement: stage,
    camera,
    _subMeshes: { plate: mesh },
    __parts: parts,
    onFrame: (cb) => { frameCbs.add(cb); return () => frameCbs.delete(cb); },
    registerCutawayMaterial: () => () => {},
    registerCanonicalCaptureHidden: () => () => {},
    getTheme: () => "dark",
    onThemeChange: (cb) => { themeCbs.add(cb); return () => themeCbs.delete(cb); },
    fireTheme: (m) => { for (const cb of [...themeCbs]) cb(m); },
    frame: () => { for (const cb of [...frameCbs]) cb(16); },
    onCutawayHandleHover: (cb) => { handleHoverCbs.add(cb); return () => handleHoverCbs.delete(cb); },
    fireHandleHover: (handle) => { for (const cb of [...handleHoverCbs]) cb(handle); },
  };
}

// Two views over the SAME sub-part: switching between them changes nothing
// about the meshes, only which pins apply.
const part = {
  parts: { plate: { label: "Plate", build: () => {} } },
  views: { main: { parts: ["plate"] }, alt: { parts: ["plate"] } },
};
const pointerOpts = { bubbles: true, clientX: 50, clientY: 50, pointerId: 1 };

function setup({ parts, mesh = plateMesh() } = {}) {
  const viewer = fakeViewer(mesh, parts);
  const revealParam = vi.fn();
  const ctx = { view: "main", params: { plate_w: 20, wall: 3 } };
  const mode = createMeasureMode(viewer, {
    part,
    getContext: () => ctx,
    revealParam,
    schedule: (cb) => cb(), // synchronous for tests
  });
  // the dim group under the meshes' shared parent
  const dimGroup = () => viewer.__parts.children.find((c) => c.name === "pf-dims");
  // one entry per rendered dimension label, tagged with the item it belongs to
  const itemIds = () => (dimGroup()?.children ?? [])
    .filter((c) => c.userData.pfDimItemId)
    .map((c) => c.userData.pfDimItemId);
  const hasHover = () => itemIds().includes("hover");
  // world positions of one item's dim labels, for "did the placement move?"
  const labelPositions = (prefix) => {
    viewer.__parts.updateMatrixWorld(true);
    return (dimGroup()?.children ?? [])
      .filter((c) => c.userData.pfDimItemId?.startsWith(prefix))
      .map((c) => c.getWorldPosition(new THREE.Vector3()).toArray());
  };
  return { mesh, viewer, mode, ctx, revealParam, dimGroup, itemIds, hasHover, labelPositions };
}

// Mirror viewer.setSubPose: a rigid pose written straight onto mesh.matrix.
const poseSubMesh = (mesh, matrix) => {
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(matrix);
  mesh.matrixWorldNeedsUpdate = true;
};

const clickAt = (dom, x = 50, y = 50) => {
  const opts = { ...pointerOpts, clientX: x, clientY: y };
  dom.dispatchEvent(new PointerEvent("pointerdown", opts));
  dom.dispatchEvent(new PointerEvent("pointerup", opts));
  dom.dispatchEvent(new MouseEvent("click", opts));
};

test("enable renders always-on overall dims; disable clears but keeps state", () => {
  const { mode, dimGroup, itemIds } = setup();
  mode.setEnabled(true);
  expect(dimGroup()).toBeDefined();
  expect(itemIds()).toContain("overall");
  // the plate is flat, so only its W and D extents are dimensioned
  expect(itemIds().filter((id) => id === "overall").length).toBe(2);
  expect(paintLog).toContain("20.00 mm"); // plate W
  expect(paintLog).toContain("10.00 mm"); // plate D
  expect(mode.isEnabled()).toBe(true);

  mode.setEnabled(false);
  expect(mode.isEnabled()).toBe(false);
  expect(dimGroup().children.length).toBe(0); // cleared, group kept for re-enable
  mode.setEnabled(true);
  expect(itemIds()).toContain("overall"); // state survives the toggle
  mode.detach();
});

test("the dim group is parented under the meshes' shared group", () => {
  // v2's answer to "dims follow the pivot rotation / per-view recentring":
  // they are children of the same node the meshes hang off, so the parent
  // transform applies to them for free.
  const parts = new THREE.Group();
  parts.position.set(5, 0, 0);
  const { viewer, mode, dimGroup } = setup({ parts });
  mode.setEnabled(true);
  expect(dimGroup()).toBeDefined();
  expect(dimGroup().parent).toBe(viewer.__parts);
  expect(viewer._subMeshes.plate.parent).toBe(viewer.__parts);
  mode.detach();
});

test("hover shows the feature's dims with a param link", () => {
  const { viewer, mode, hasHover } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  expect(hasHover()).toBe(true);
  expect(paintLog).toContain("plate_w"); // linked: unique read-key value match
  mode.detach();
});

test("click pins; pin survives a geometry swap; clearPins notifies", () => {
  const { viewer, mode, itemIds } = setup();
  const onPins = vi.fn();
  mode.onPinsChange(onPins);
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  expect(mode.pinCount()).toBe(1);
  expect(onPins).toHaveBeenCalled();
  expect(itemIds().some((id) => id.startsWith("pin:"))).toBe(true);

  // simulate a regenerate: same labels, new geometry instance
  const fresh = plateMesh();
  viewer._subMeshes.plate.geometry = fresh.geometry;
  viewer.frame(); // dirty check picks up the new geometry
  expect(mode.pinCount()).toBe(1);
  // pinned dim re-anchored against the new geometry and re-rendered
  expect(itemIds().some((id) => id.startsWith("pin:"))).toBe(true);

  mode.clearPins();
  expect(mode.pinCount()).toBe(0);
  expect(itemIds().some((id) => id.startsWith("pin:"))).toBe(false);
  mode.detach();
});

test("a pin whose feature label disappears goes dormant without being dropped", () => {
  const { viewer, mode, itemIds } = setup();
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  expect(mode.pinCount()).toBe(1);

  // regenerate into geometry that no longer carries the pinned label
  const bare = plateMesh();
  bare.geometry.userData.features = [];
  bare.geometry.userData.featureIds = new Uint16Array([0, 0]);
  viewer._subMeshes.plate.geometry = bare.geometry;
  viewer.frame();
  expect(mode.pinCount()).toBe(1); // still pinned, just unresolvable
  expect(itemIds().some((id) => id.startsWith("pin:"))).toBe(false);
  mode.detach();
});

test("clicking a linked hovered dim reveals the param", () => {
  const { viewer, mode, revealParam } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  clickAt(viewer.domElement);
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

// Regression (carried over from the chip-click case): a pinned dimension is
// un-pinned by clicking its LABEL, resolved by the structured item id carried
// on the label mesh — never by parsing the rendered dim text, which can itself
// contain colons when a Solid.label() does.
test("clicking a pinned dim's label resolves it by item id and unpins", () => {
  // Half-labeled plate: the pinned feature covers only one triangle, so one of
  // its dim labels lands over UNLABELED geometry. A click there that fell
  // through to the raycast would pin the sub-part bbox (pinCount 2) instead of
  // un-pinning — which is what makes this test see the label-pick path.
  const { viewer, mode, dimGroup } = setup({ mesh: plateMesh({ halfLabeled: true }) });
  mode.setEnabled(true);
  clickAt(viewer.domElement, 64.1, 55.6); // inside the labeled triangle
  expect(mode.pinCount()).toBe(1);

  viewer.__parts.updateMatrixWorld(true);
  const screenOf = (o) => {
    const p = o.getWorldPosition(new THREE.Vector3()).project(viewer.camera);
    return { x: ((p.x + 1) / 2) * 100, y: ((1 - p.y) / 2) * 100 };
  };
  const target = dimGroup().children
    .filter((c) => c.userData.pfDimItemId?.startsWith("pin:"))
    .map(screenOf)
    .find(({ x, y }) => raycastViewer(viewer, x, y)?.feature == null);
  expect(target).toBeDefined();
  clickAt(viewer.domElement, target.x, target.y);

  expect(mode.pinCount()).toBe(0);
  mode.detach();
});

// Regression: pins are per view, but the frame dirty check only watches the
// meshes — and two views can share an identical mesh set, so switching between
// them changes nothing it hashes. v1 caught this incidentally through its
// camera hash (a view switch reframes); v2 has no camera hash, so the active
// view is seeded into the signature explicitly. Without that, view A's pinned
// dims keep drawing over view B.
test("switching views drops the other view's pinned dims", () => {
  const { viewer, mode, ctx, itemIds } = setup();
  mode.setEnabled(true);
  clickAt(viewer.domElement); // pin in view "main"
  expect(mode.pinCount()).toBe(1);
  expect(itemIds().some((id) => id.startsWith("pin:"))).toBe(true);

  ctx.view = "alt"; // same meshes, same poses, same geometry — only the view moved
  viewer.frame();
  expect(mode.pinCount()).toBe(0); // "alt" has no pins of its own
  expect(itemIds().some((id) => id.startsWith("pin:"))).toBe(false);

  ctx.view = "main";
  viewer.frame();
  expect(mode.pinCount()).toBe(1);
  expect(itemIds().some((id) => id.startsWith("pin:"))).toBe(true);
});

// transformSpec's job: carry a spec out of the mesh's own geometry frame into
// the parts frame dim3-place works in. The overall dim gets there by a
// different route (its bounds are composed with mesh.matrix directly), so
// these two pin the pinned-item path — the only user of the plane and bbox
// branches — against a real (translated) pose.
test("a posed mesh moves its pinned PLANE dim by the pose", () => {
  const { mesh, viewer, mode, labelPositions } = setup();
  mode.setEnabled(true);
  clickAt(viewer.domElement); // pin the "top face" feature -> plane spec
  expect(mode.pinCount()).toBe(1);
  viewer.frame(); // settle scene.tick()'s screen-constant label sizing before capturing
  const before = labelPositions("pin:");
  expect(before.length).toBeGreaterThan(0);

  poseSubMesh(mesh, new THREE.Matrix4().makeTranslation(5, 0, 0));
  viewer.frame(); // the pose is hashed, so this rebuilds
  const after = labelPositions("pin:");

  expect(after.length).toBe(before.length);
  after.forEach((p, i) => {
    expect(p[0]).toBeCloseTo(before[i][0] + 5, 5); // translated along X
    expect(p[1]).toBeCloseTo(before[i][1], 5);
    expect(p[2]).toBeCloseTo(before[i][2], 5);
  });
  mode.detach();
});

test("a posed mesh moves its pinned BBOX dim by the pose", () => {
  // half-labeled plate: clicking the unlabeled triangle pins the sub-part
  // bounding box, which is the spec kind that goes through transformSpec's
  // Box3 branch.
  const { mesh, viewer, mode, itemIds, labelPositions } = setup({ mesh: plateMesh({ halfLabeled: true }) });
  mode.setEnabled(true);
  clickAt(viewer.domElement, 50, 48); // over the UNLABELED triangle
  expect(itemIds()).toContain("pin:plate:bbox:0");
  viewer.frame(); // settle scene.tick()'s screen-constant label sizing before capturing
  const before = labelPositions("pin:");
  expect(before.length).toBeGreaterThan(0);

  poseSubMesh(mesh, new THREE.Matrix4().makeTranslation(5, 0, 0));
  viewer.frame();
  const after = labelPositions("pin:");

  expect(after.length).toBe(before.length);
  after.forEach((p, i) => {
    expect(p[0]).toBeCloseTo(before[i][0] + 5, 5);
    expect(p[1]).toBeCloseTo(before[i][1], 5);
    expect(p[2]).toBeCloseTo(before[i][2], 5);
  });
  // a pure translation must not change the measured extents
  expect(paintLog.filter((t) => t === "20.00 mm").length).toBeGreaterThan(0);
  expect(paintLog).not.toContain("25.00 mm");
  mode.detach();
});

// Open tube (wall triangles only, one labeled feature), axis along Y — not Z
// like feature-dims.test.js's tube() — so it sits crosswise to this file's
// fixed camera ray (straight down -Z through x=10, y=5) and gets hit by a
// click at the default (50, 50). Centered on (cx, length/2, cz) so classifyFeature's
// fitted center lands there too.
function cylinderMesh({ r = 3, length = 10, seg = 24, cx = 10, cz = 2, id = 1, label = "boss" } = {}) {
  const pos = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (2 * Math.PI * i) / seg, a1 = (2 * Math.PI * (i + 1)) / seg;
    const p0 = [r * Math.cos(a0), r * Math.sin(a0)], p1 = [r * Math.cos(a1), r * Math.sin(a1)];
    pos.push(cx + p0[0], 0, cz + p0[1], cx + p1[0], 0, cz + p1[1], cx + p1[0], length, cz + p1[1]);
    pos.push(cx + p0[0], 0, cz + p0[1], cx + p1[0], length, cz + p1[1], cx + p0[0], length, cz + p0[1]);
  }
  const positions = new Float32Array(pos);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.userData.featureIds = new Uint16Array(positions.length / 9).fill(id);
  geo.userData.features = [label];
  return new THREE.Mesh(geo);
}

// transformSpec's cylinder branch (measure-mode.js's `dir()`/`pt()` mapping of
// center/axis/top/bottom/rimDir) is otherwise uncovered: the two pose tests
// above pin the plane and bbox branches, the only other users of the pinned-
// item path, against a real (translated) pose, and this closes the parked gap
// for the third kind under a real ROTATION.
//
// The pose rotates 90° about Z, pivoted on the feature's own classified
// center (T·R·T⁻¹) rather than the parts origin. That keeps the pose a real
// rotation (so transformSpec's `dir()` path — not just `pt()`'s translation
// case — actually runs) while leaving the camera-relative-to-center geometry
// that drives dim3-place's ⌀-direction (`du`) choice untouched by the pose:
// with the center fixed, the expected rotated label position follows directly
// from the pose matrix, rather than needing to re-derive evaluateChoices'
// hysteresis/direction heuristics inside the test.
test("a posed mesh rotates its pinned CYLINDER dim's ⌀ label through transformSpec", () => {
  const mesh = cylinderMesh();
  const { viewer, mode, itemIds, labelPositions } = setup({ mesh });
  mode.setEnabled(true);
  clickAt(viewer.domElement); // pin the "boss" wall feature -> cylinder spec
  expect(mode.pinCount()).toBe(1);
  expect(itemIds()).toContain("pin:plate:boss:0");
  viewer.frame(); // settle scene.tick()'s screen-constant label sizing before capturing
  const before = labelPositions("pin:"); // [⌀ label, depth label]
  expect(before.length).toBeGreaterThan(0);

  const rawSpec = classifyFeature(
    { positions: mesh.geometry.getAttribute("position").array, featureIds: mesh.geometry.userData.featureIds },
    1,
  );
  expect(rawSpec.kind).toBe("cylinder");
  const [cx, cy, cz] = rawSpec.anchors.center;

  const pose = new THREE.Matrix4()
    .makeTranslation(cx, cy, cz)
    .multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2))
    .multiply(new THREE.Matrix4().makeTranslation(-cx, -cy, -cz));
  poseSubMesh(mesh, pose);
  viewer.frame(); // pose is hashed, so this rebuilds
  const after = labelPositions("pin:");

  expect(after.length).toBe(before.length);
  // The ⌀ label is always index 0 (placeCylinder pushes it before the depth
  // dim's label). A 90° Z-rotation about (cx, cy, cz) maps a point offset
  // (dx, dy, dz) from that center to (-dy, dx, dz).
  const [bx, by, bz] = before[0];
  const [ax, ay, az] = after[0];
  expect(ax - cx).toBeCloseTo(-(by - cy), 3);
  expect(ay - cy).toBeCloseTo(bx - cx, 3);
  expect(az - cz).toBeCloseTo(bz - cz, 3);
  mode.detach();
});

// Regression: the pose hash used to carry only the matrix diagonal, so a
// rotation and its mirror image (θ and −θ about X share cos θ on the diagonal)
// with the same translation read as identical — and v2 has no camera hash left
// to notice. The full rotation basis is hashed instead.
test("an opposite-sign pose rotation is not mistaken for the same pose", () => {
  const { mesh, viewer, mode, labelPositions } = setup();
  mode.setEnabled(true);
  clickAt(viewer.domElement);
  expect(mode.pinCount()).toBe(1);

  const posed = (t) => new THREE.Matrix4().makeRotationX(t).setPosition(1, 2, 3);
  poseSubMesh(mesh, posed(Math.PI / 6));
  viewer.frame();
  const plus = labelPositions("pin:");
  expect(plus.length).toBeGreaterThan(0);

  poseSubMesh(mesh, posed(-Math.PI / 6)); // same diagonal, same translation
  viewer.frame();
  const minus = labelPositions("pin:");

  expect(minus.length).toBe(plus.length);
  expect(minus).not.toEqual(plus);
  mode.detach();
});

// The placement pipeline (vertex scans, raycasts) must run on CHANGE, not per
// frame. scene.update() replaces every child object, so child identity across
// frames is a direct read on "did we re-place?".
test("a steady frame does not re-place; only a side-choice flip does", () => {
  const { viewer, mode, dimGroup } = setup();
  mode.setEnabled(true);
  const kids = () => [...dimGroup().children];
  // identity, not deep equality: scene.update() builds brand-new child objects,
  // so "same objects" means update() was never called.
  const same = (a, b) => a.length === b.length && a.every((o, i) => o === b[i]);
  const first = kids();
  expect(first.length).toBeGreaterThan(0);

  for (let i = 0; i < 5; i++) viewer.frame(); // nothing changed at all
  expect(same(kids(), first)).toBe(true);

  // a nudge too small to flip which side any dim hangs off
  viewer.camera.position.set(10.5, 5.2, 40);
  viewer.frame();
  expect(same(kids(), first)).toBe(true);

  // straight through to the other side: every extension direction flips
  viewer.camera.position.set(10, 5, -40);
  viewer.frame();
  expect(same(kids(), first)).toBe(false);
  expect(kids().length).toBe(first.length);
  mode.detach();
});

// Hover changes on every rAF while the pointer moves, and placeBox scans every
// vertex of the meshes it covers — so a hover move must re-place the hover item
// ALONE, reusing the cached always-on/pinned drawings. Read straight off
// placeDims: which items each call was asked to place.
test("hovering re-places only the hover dim, reusing the cached base drawings", () => {
  const { viewer, mode, hasHover } = setup();
  mode.setEnabled(true);
  // enable places the base set once
  expect(placeDims.mock.calls.at(-1)[0].map((i) => i.id)).toEqual(["overall"]);

  placeDims.mockClear();
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  expect(hasHover()).toBe(true);
  expect(placeDims.mock.calls.map((c) => c[0].map((i) => i.id))).toEqual([["hover"]]);

  // and again on the next move: still just the hover item
  placeDims.mockClear();
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", { ...pointerOpts, clientX: 52 }));
  expect(placeDims.mock.calls.map((c) => c[0].map((i) => i.id))).toEqual([["hover"]]);

  // pinning changes the base set, so that one does re-place both
  placeDims.mockClear();
  clickAt(viewer.domElement);
  expect(mode.pinCount()).toBe(1);
  expect(placeDims.mock.calls.map((c) => c[0].map((i) => i.id)))
    .toEqual([["overall", "pin:plate:top face:0"], ["hover"]]);
  mode.detach();
});

test("onModeChange fires on enable and disable", () => {
  const { mode } = setup();
  const cb = vi.fn();
  mode.onModeChange(cb);
  mode.setEnabled(true);
  mode.setEnabled(false);
  expect(cb).toHaveBeenCalledTimes(2);
  mode.detach();
});

test("pointerleave clears the hover dim", () => {
  const { viewer, mode, hasHover } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  expect(hasHover()).toBe(true);
  viewer.domElement.dispatchEvent(new MouseEvent("pointerleave"));
  expect(hasHover()).toBe(false);
  mode.detach();
});

// Regression: a visibility-only change (e.g. a cutaway/view toggle hiding the
// hovered sub-part) trips the mesh signature, but the mesh's geometry identity
// is untouched — the old check (geometry identity only) missed this and left a
// stale hover dim/highlight pointing at a now-invisible mesh.
test("stale hover is dropped when its mesh goes invisible, even with the same geometry", () => {
  const { mesh, viewer, mode, hasHover } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  expect(hasHover()).toBe(true);

  mesh.visible = false;
  viewer.frame(); // dirty check picks up the visibility flip

  expect(hasHover()).toBe(false);
  mode.detach();
});

// Regression: the cutaway gizmo and measure mode share the pointer over the
// same canvas; a handle drag must steal it the same way hover.js already does.
test("cutaway handle hover suppresses measure hover; releases resume it", () => {
  const { viewer, mode, hasHover } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  expect(hasHover()).toBe(true);

  viewer.fireHandleHover("radius"); // gizmo drag starts
  expect(hasHover()).toBe(false); // suppressed: hover dim + highlight dropped

  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", { ...pointerOpts, clientX: 51 }));
  expect(hasHover()).toBe(false); // moves ignored while suppressed

  viewer.fireHandleHover(null); // gizmo released
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  expect(hasHover()).toBe(true); // hovering works again
  mode.detach();
});

test("a theme change repaints the dims and detach removes the group", () => {
  const { viewer, mode, dimGroup } = setup();
  mode.setEnabled(true);
  expect(dimGroup()).toBeDefined();
  expect(() => viewer.fireTheme("light")).not.toThrow();
  expect(dimGroup().children.length).toBeGreaterThan(0);
  mode.detach();
  expect(dimGroup()).toBeUndefined(); // group removed from the parts group
});

test("frame ticks are harmless before and after the mode is enabled", () => {
  const { viewer, mode } = setup();
  expect(() => viewer.frame()).not.toThrow(); // never enabled: no scene yet
  mode.setEnabled(true);
  expect(() => viewer.frame()).not.toThrow(); // steady state: cheap re-score
  mode.detach();
});
