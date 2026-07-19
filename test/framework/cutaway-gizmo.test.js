// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import * as THREE from "three";

import { createCutawayGizmo } from "../../src/framework/cutaway-gizmo.js";

const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.gizmo.dispose();
  document.body.innerHTML = "";
});

function createFixture(overrides = {}) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1_000);
  camera.position.set(0, 0, 20);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const domElement = document.createElement("div");
  domElement.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 200,
    bottom: 200,
    width: 200,
    height: 200,
  });
  domElement.setPointerCapture = vi.fn();
  domElement.releasePointerCapture = vi.fn();
  document.body.appendChild(domElement);

  const orbitControls = { enabled: true };
  const onPoseChange = vi.fn();
  const gizmo = createCutawayGizmo({
    scene,
    camera,
    domElement,
    orbitControls,
    onPoseChange,
    ...overrides,
  });
  const fixture = {
    scene,
    camera,
    domElement,
    orbitControls,
    onPoseChange,
    gizmo,
  };
  fixtures.push(fixture);
  return fixture;
}

function pointer(domElement, type, { x = 100, y = 100, pointerId = 7 } = {}) {
  domElement.dispatchEvent(new PointerEvent(type, {
    pointerId,
    clientX: x,
    clientY: y,
    button: 0,
    bubbles: true,
  }));
}

test("setPose applies the plane pose and size while visibility remains controllable", () => {
  const { gizmo } = createFixture();
  const position = new THREE.Vector3(1, 2, 3);
  const quaternion = new THREE.Quaternion();

  gizmo.setPose({ position, quaternion, size: 12 });

  expect(gizmo.group.position.toArray()).toEqual([1, 2, 3]);
  expect(gizmo.group.quaternion.toArray()).toEqual([0, 0, 0, 1]);
  expect(gizmo.fill.scale.toArray()).toEqual([12, 12, 12]);
  gizmo.setVisible(false);
  expect(gizmo.group.visible).toBe(false);
  gizmo.setVisible(true);
  expect(gizmo.group.visible).toBe(true);
});

test("exposes enlarged hit proxies tagged with the three exact handle names", () => {
  const { gizmo } = createFixture();

  expect(gizmo.handles.translate.userData.cutawayHandle).toBe("translate");
  expect(gizmo.handles.rotateX.userData.cutawayHandle).toBe("rotate-x");
  expect(gizmo.handles.rotateY.userData.cutawayHandle).toBe("rotate-y");
  for (const proxy of Object.values(gizmo.handles)) {
    expect(proxy).toBeInstanceOf(THREE.Mesh);
    expect(proxy.material.opacity).toBe(0);
  }
});

test("active appearance makes the plane prominent and idle appearance leaves it subtle", () => {
  const { gizmo } = createFixture();

  gizmo.setActiveAppearance(true);
  const activeOpacity = gizmo.fill.material.opacity;
  gizmo.setActiveAppearance(false);

  expect(activeOpacity).toBeGreaterThan(0.1);
  expect(gizmo.fill.material.opacity).toBeLessThan(0.1);
  expect(gizmo.border.visible).toBe(true);
});

test("theme changes the fill, border, and visible handle colors in place", () => {
  const { gizmo } = createFixture();
  const dark = gizmo.fill.material.color.getHex();
  const borderDark = gizmo.border.material.color.getHex();
  const visibleHandle = gizmo.handleRoot.children.find(
    (child) => child.material?.opacity !== 0,
  );
  const handleDark = visibleHandle.material.color.getHex();

  gizmo.setTheme("light");

  expect(gizmo.fill.material.color.getHex()).not.toBe(dark);
  expect(gizmo.border.material.color.getHex()).not.toBe(borderDark);
  expect(visibleHandle.material.color.getHex()).not.toBe(handleDark);
});

test("updateForCamera preserves plane size while scaling handles for camera distance", () => {
  const { camera, gizmo } = createFixture();
  gizmo.setPose({
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    size: 20,
  });
  gizmo.updateForCamera();
  const nearScale = gizmo.handleRoot.scale.x;

  camera.position.z = 60;
  camera.updateMatrixWorld(true);
  gizmo.updateForCamera();

  expect(gizmo.handleRoot.scale.x).toBeGreaterThan(nearScale);
  expect(gizmo.fill.scale.toArray()).toEqual([20, 20, 20]);
});

test("pointer cancellation restores the exact orbit state and releases capture", () => {
  const { domElement, orbitControls } = createFixture({
    pickHandle: () => "translate",
  });

  pointer(domElement, "pointerdown");
  expect(orbitControls.enabled).toBe(false);
  expect(domElement.setPointerCapture).toHaveBeenCalledWith(7);

  pointer(domElement, "pointercancel");
  expect(orbitControls.enabled).toBe(true);
  expect(domElement.releasePointerCapture).toHaveBeenCalledWith(7);
});

test("normal-axis dragging emits a finite translated pose", () => {
  const { domElement, onPoseChange, gizmo } = createFixture({
    pickHandle: () => "translate",
  });
  const quaternion = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    Math.PI / 2,
  );
  gizmo.setPose({ position: new THREE.Vector3(), quaternion, size: 20 });

  pointer(domElement, "pointerdown", { x: 100, y: 100 });
  pointer(domElement, "pointermove", { x: 130, y: 100 });

  expect(onPoseChange).toHaveBeenCalledOnce();
  const pose = onPoseChange.mock.calls[0][0];
  expect(pose.position.toArray().every(Number.isFinite)).toBe(true);
  expect(pose.position.length()).toBeGreaterThan(0);
  expect(pose.position).not.toBe(gizmo.group.position);
  expect(pose.size).toBe(20);
});

test("camera-parallel normal dragging falls back to smooth screen-space movement", () => {
  const { domElement, onPoseChange, gizmo } = createFixture({
    pickHandle: () => "translate",
  });
  gizmo.setPose({
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    size: 20,
  });

  pointer(domElement, "pointerdown", { x: 100, y: 100 });
  pointer(domElement, "pointermove", { x: 100, y: 90 });
  pointer(domElement, "pointermove", { x: 100, y: 80 });

  expect(onPoseChange).toHaveBeenCalledTimes(2);
  const firstZ = onPoseChange.mock.calls[0][0].position.z;
  const secondZ = onPoseChange.mock.calls[1][0].position.z;
  expect(firstZ).toBeGreaterThan(0);
  expect(secondZ).toBeCloseTo(firstZ * 2);
  expect(Number.isFinite(secondZ)).toBe(true);
});

test("rotation dragging emits a finite normalized quaternion", () => {
  const { camera, domElement, onPoseChange, gizmo } = createFixture({
    pickHandle: () => "rotate-x",
  });
  camera.position.set(5, 4, 20);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  gizmo.setPose({
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    size: 20,
  });

  pointer(domElement, "pointerdown", { x: 100, y: 70 });
  pointer(domElement, "pointermove", { x: 100, y: 130 });

  expect(onPoseChange).toHaveBeenCalledOnce();
  const quaternion = onPoseChange.mock.calls[0][0].quaternion;
  expect(quaternion.toArray().every(Number.isFinite)).toBe(true);
  expect(quaternion.length()).toBeCloseTo(1);
  expect(Math.abs(quaternion.x)).toBeGreaterThan(0);
});

test("dispose ends a drag, removes listeners and scene objects, and disposes owned resources once", () => {
  const pickHandle = vi.fn(() => "translate");
  const { scene, domElement, orbitControls, gizmo } = createFixture({ pickHandle });
  const geometries = new Set();
  const materials = new Set();
  gizmo.group.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    if (object.material) materials.add(object.material);
  });
  const geometryDisposals = [...geometries].map((resource) => vi.spyOn(resource, "dispose"));
  const materialDisposals = [...materials].map((resource) => vi.spyOn(resource, "dispose"));

  pointer(domElement, "pointerdown");
  expect(orbitControls.enabled).toBe(false);
  gizmo.dispose();
  gizmo.dispose();

  expect(gizmo.group.parent).toBeNull();
  expect(orbitControls.enabled).toBe(true);
  expect(domElement.releasePointerCapture).toHaveBeenCalledWith(7);
  for (const dispose of [...geometryDisposals, ...materialDisposals]) {
    expect(dispose).toHaveBeenCalledOnce();
  }

  pointer(domElement, "pointerdown");
  expect(pickHandle).toHaveBeenCalledOnce();
});
