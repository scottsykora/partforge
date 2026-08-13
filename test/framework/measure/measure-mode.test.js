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
  return {
    domElement: dom,
    stageElement: stage,
    camera,
    _subMeshes: { plate: mesh },
    onFrame: (cb) => { frameCbs.add(cb); return () => frameCbs.delete(cb); },
    registerCutawayMaterial: () => () => {},
    frame: () => { for (const cb of [...frameCbs]) cb(16); },
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

test("onModeChange fires on enable and disable", () => {
  const { mode } = setup();
  const cb = vi.fn();
  mode.onModeChange(cb);
  mode.setEnabled(true);
  mode.setEnabled(false);
  expect(cb).toHaveBeenCalledTimes(2);
  mode.detach();
});
