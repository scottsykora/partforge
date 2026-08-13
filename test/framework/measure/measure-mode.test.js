// @vitest-environment happy-dom
// Orchestrator against a minimal real-three fake viewer: enable -> always-on
// dims; hover -> feature dims; click -> pin + param reveal; regen re-anchor.
import { expect, test, vi } from "vitest";
import * as THREE from "three";
import { createMeasureMode } from "../../../src/framework/measure/measure-mode.js";

// A 20×10 plate: one sub-part, one labeled planar feature covering both
// triangles of its top face at z=2. Non-indexed, feature ids per triangle.
function plateMesh() {
  const positions = new Float32Array([
    0, 0, 2, 20, 0, 2, 20, 10, 2,
    0, 0, 2, 20, 10, 2, 0, 10, 2,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.userData.featureIds = new Uint16Array([1, 1]);
  geo.userData.features = ["top face"];
  return new THREE.Mesh(geo);
}

function fakeViewer(mesh) {
  const dom = document.createElement("div");
  const stage = document.createElement("div");
  stage.appendChild(dom);
  dom.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(10, 5, 40); // over the plate center, looking down -Z
  camera.lookAt(10, 5, 2);
  camera.updateMatrixWorld(true);
  mesh.name = "plate";
  mesh.updateMatrixWorld(true);
  const frameCbs = new Set();
  const handleHoverCbs = new Set();
  return {
    domElement: dom,
    stageElement: stage,
    camera,
    _subMeshes: { plate: mesh },
    onFrame: (cb) => { frameCbs.add(cb); return () => frameCbs.delete(cb); },
    registerCutawayMaterial: () => () => {},
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

function setup() {
  const mesh = plateMesh();
  const viewer = fakeViewer(mesh);
  const revealParam = vi.fn();
  const mode = createMeasureMode(viewer, {
    part,
    getContext: () => ({ view: "main", params: { plate_w: 20, wall: 3 } }),
    revealParam,
    schedule: (cb) => cb(), // synchronous for tests
  });
  return { mesh, viewer, mode, revealParam };
}

test("enable renders always-on overall dims; disable hides but keeps state", () => {
  const { viewer, mode } = setup();
  mode.setEnabled(true);
  const svg = mode.getOverlaySvg();
  expect(svg).not.toBeNull();
  const texts = [...svg.querySelectorAll("text")].map((t) => t.textContent);
  expect(texts).toContain("20.00"); // plate W
  expect(texts).toContain("10.00"); // plate D
  mode.setEnabled(false);
  expect(mode.getOverlaySvg()).toBeNull();
  mode.detach();
});

test("hover shows the feature's dims with a param link", () => {
  const { viewer, mode } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  const texts = [...mode.getOverlaySvg().querySelectorAll("text")].map((t) => t.textContent);
  expect(texts).toContain("20.00");
  expect(texts).toContain("plate_w"); // linked: unique read-key value match
  mode.detach();
});

test("click pins; pin survives a geometry swap; clearPins notifies", () => {
  const { mesh, viewer, mode } = setup();
  const onPins = vi.fn();
  mode.onPinsChange(onPins);
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
  viewer.domElement.dispatchEvent(new PointerEvent("pointerup", pointerOpts));
  viewer.domElement.dispatchEvent(new MouseEvent("click", pointerOpts));
  expect(mode.pinCount()).toBe(1);
  expect(onPins).toHaveBeenCalled();
  // simulate a regenerate: same labels, new geometry instance
  const fresh = plateMesh();
  viewer._subMeshes.plate.geometry = fresh.geometry;
  viewer.frame(); // dirty check picks up the new geometry
  expect(mode.pinCount()).toBe(1);
  const texts = [...mode.getOverlaySvg().querySelectorAll("text")].map((t) => t.textContent);
  expect(texts).toContain("20.00"); // pinned dim re-anchored and re-rendered
  mode.clearPins();
  expect(mode.pinCount()).toBe(0);
  mode.detach();
});

test("clicking a linked hovered dim reveals the param", () => {
  const { viewer, mode, revealParam } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  viewer.domElement.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
  viewer.domElement.dispatchEvent(new PointerEvent("pointerup", pointerOpts));
  viewer.domElement.dispatchEvent(new MouseEvent("click", pointerOpts));
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

test("overall dims project through the meshes' parent transform", () => {
  const mesh = plateMesh();
  const group = new THREE.Group();
  group.position.set(5, 0, 0);
  group.add(mesh);
  group.updateMatrixWorld(true);
  const viewer = fakeViewer(mesh);
  const mode = createMeasureMode(viewer, {
    part,
    getContext: () => ({ view: "main", params: {} }),
    revealParam: () => {},
    schedule: (cb) => cb(),
  });
  mode.setEnabled(true);
  const withParent = [...mode.getOverlaySvg().querySelectorAll("text")].map((t) => Number(t.getAttribute("x")));
  mode.detach();

  const mesh2 = plateMesh();
  const viewer2 = fakeViewer(mesh2);
  const mode2 = createMeasureMode(viewer2, {
    part,
    getContext: () => ({ view: "main", params: {} }),
    revealParam: () => {},
    schedule: (cb) => cb(),
  });
  mode2.setEnabled(true);
  const withoutParent = [...mode2.getOverlaySvg().querySelectorAll("text")].map((t) => Number(t.getAttribute("x")));
  mode2.detach();
  expect(withParent).not.toEqual(withoutParent); // parent translation must move the dims
});

// Regression: chip resolution used to parse the primitive's own (possibly
// colon-bearing) dim id back into an item id via startsWith, which collides
// whenever a Solid.label() itself contains a colon. Exercise the REAL path
// end to end: pin a feature, click its rendered chip (identified by the
// overlay's structured data-item-id, not by parsing dim text), confirm it
// resolves and un-pins by exact equality.
test("clicking a pinned chip resolves it by its structured item id and unpins", () => {
  const { viewer, mode } = setup();
  mode.setEnabled(true);
  // pin the feature via hover + click (same as the "click pins" test)
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  viewer.domElement.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
  viewer.domElement.dispatchEvent(new PointerEvent("pointerup", pointerOpts));
  viewer.domElement.dispatchEvent(new MouseEvent("click", pointerOpts));
  expect(mode.pinCount()).toBe(1);

  const chip = mode.getOverlaySvg().querySelector('g[data-item-id^="pin:"]');
  expect(chip).not.toBeNull();
  chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));

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

// Regression: chips live INSIDE the overlay, which sits over the canvas —
// moving onto a chip must not read as "left the canvas" (that flickered the
// always-on dim band and self-destructed the hover chip on approach).
test("pointerleave into the overlay keeps hover; leaving elsewhere clears it", () => {
  const { viewer, mode } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  const hasHover = () =>
    [...mode.getOverlaySvg().querySelectorAll("text")].map((t) => t.textContent).includes("plate_w");
  expect(hasHover()).toBe(true);

  // MouseEvent, not PointerEvent: happy-dom's PointerEvent doesn't reliably carry
  // relatedTarget through its constructor, but the "pointerleave" listener doesn't
  // distinguish event classes — only ev.type and ev.relatedTarget matter.
  const chip = mode.getOverlaySvg().querySelector("text");
  viewer.domElement.dispatchEvent(new MouseEvent("pointerleave", { relatedTarget: chip }));
  expect(hasHover()).toBe(true); // into the overlay ≠ leaving

  viewer.domElement.dispatchEvent(new MouseEvent("pointerleave", { relatedTarget: null }));
  expect(hasHover()).toBe(false); // genuinely left: hover cleared
  mode.detach();
});

// Regression: a visibility-only change (e.g. a cutaway/view toggle hiding the
// hovered sub-part) is hashed into frameSig, so the dirty check trips, but
// the mesh's geometry identity is untouched — the old check (geometry
// identity only) missed this and left a stale hover dim/highlight pointing
// at a now-invisible mesh.
test("stale hover is dropped when its mesh goes invisible, even with the same geometry", () => {
  const { mesh, viewer, mode } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  const hasHover = () =>
    [...mode.getOverlaySvg().querySelectorAll("text")].map((t) => t.textContent).includes("plate_w");
  expect(hasHover()).toBe(true);

  mesh.visible = false;
  viewer.frame(); // dirty check picks up the visibility flip

  expect(hasHover()).toBe(false);
  mode.detach();
});

// Regression: the cutaway gizmo and measure mode share the pointer over the
// same canvas; a handle drag must steal it the same way hover.js already does.
test("cutaway handle hover suppresses measure hover; releases resume it", () => {
  const { viewer, mode } = setup();
  mode.setEnabled(true);
  viewer.domElement.dispatchEvent(new PointerEvent("pointermove", pointerOpts));
  const hasHover = () =>
    [...mode.getOverlaySvg().querySelectorAll("text")].map((t) => t.textContent).includes("plate_w");
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
