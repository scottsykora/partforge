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

const part = {
  parts: { plate: { label: "Plate", build: () => {} } },
  views: { main: { parts: ["plate"] } },
};
const pointerOpts = { bubbles: true, clientX: 50, clientY: 50, pointerId: 1 };

function setup({ parts, mesh = plateMesh() } = {}) {
  const viewer = fakeViewer(mesh, parts);
  const revealParam = vi.fn();
  const mode = createMeasureMode(viewer, {
    part,
    getContext: () => ({ view: "main", params: { plate_w: 20, wall: 3 } }),
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
  return { mesh, viewer, mode, revealParam, dimGroup, itemIds, hasHover };
}

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
