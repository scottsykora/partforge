// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest";
import * as THREE from "three";

import { createCutaway } from "../../src/framework/cutaway.js";

const controllers = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose?.();
  document.body.innerHTML = "";
});

function makeRenderer(stencil = true) {
  const getContextAttributes = stencil === "throw"
    ? vi.fn(() => { throw new Error("context lost"); })
    : vi.fn(() => ({ stencil }));
  return {
    localClippingEnabled: false,
    getContext: vi.fn(() => ({ getContextAttributes })),
    getContextAttributes,
  };
}

function makeSchedule() {
  const entries = [];
  const schedule = vi.fn((callback, delay) => {
    const entry = { callback, delay, cancelled: false };
    entries.push(entry);
    return () => { entry.cancelled = true; };
  });
  return { schedule, entries };
}

function createFixture({ stencil = true, box, schedule: providedSchedule } = {}) {
  const renderer = makeRenderer(stencil);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1_000);
  camera.position.set(0, 0, 20);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const orbitControls = { enabled: true };
  const domElement = document.createElement("div");
  domElement.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 200,
    bottom: 200,
    width: 200,
    height: 200,
  });
  document.body.appendChild(domElement);
  let bounds = box ?? new THREE.Box3(
    new THREE.Vector3(-5, -4, -3),
    new THREE.Vector3(5, 4, 3),
  );
  const timer = providedSchedule ? null : makeSchedule();
  const controller = createCutaway({
    renderer,
    scene,
    camera,
    orbitControls,
    domElement,
    getBounds: () => bounds,
    schedule: providedSchedule ?? timer.schedule,
  });
  controllers.push(controller);
  return {
    renderer,
    scene,
    camera,
    orbitControls,
    domElement,
    timer,
    controller,
    setBounds(next) { bounds = next; },
  };
}

function addSubpart(fixture, name = "body", options = {}) {
  const geometry = options.geometry ?? new THREE.BoxGeometry(4, 6, 8);
  const material = options.material ?? new THREE.MeshStandardMaterial({
    color: 0x336699,
    opacity: 0.7,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  const edgeGeometry = new THREE.EdgesGeometry(geometry);
  const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x111111 });
  const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  fixture.scene.add(mesh, edgeLines);
  fixture.controller.setSubpart(name, mesh, edgeLines);
  return { geometry, material, mesh, edgeGeometry, edgeMaterial, edgeLines };
}

function findGizmo(scene) {
  return scene.children.find(
    (child) => child.isGroup && child.children.some((entry) => entry.isLineLoop),
  );
}

function findCap(scene) {
  return scene.children.find((child) => child.isMesh && child.material?.isShaderMaterial);
}

describe("createCutaway capability", () => {
  test.each([
    [true, true],
    [false, false],
    ["throw", false],
  ])("reports stencil capability %s as %s after one query", (stencil, expected) => {
    const fixture = createFixture({ stencil });

    expect(fixture.controller.isSupported).toBe(expected);
    expect(fixture.renderer.getContext).toHaveBeenCalledOnce();
    expect(fixture.renderer.getContextAttributes).toHaveBeenCalledOnce();
    expect(fixture.controller.isSupported).toBe(expected);
    expect(fixture.renderer.getContext).toHaveBeenCalledOnce();
    expect(fixture.renderer.getContextAttributes).toHaveBeenCalledOnce();
  });

  test("refuses unsupported activation without throwing or changing clipping state", () => {
    const fixture = createFixture({ stencil: false });
    addSubpart(fixture);

    expect(fixture.controller.setEnabled(true)).toBe(false);
    expect(fixture.controller.isEnabled).toBe(false);
    expect(fixture.renderer.localClippingEnabled).toBe(false);
    expect(findGizmo(fixture.scene).visible).toBe(false);
  });
});

test("empty bounds refuse activation without changing materials or scheduling fade", () => {
  const fixture = createFixture({ box: new THREE.Box3() });
  const { mesh, material } = addSubpart(fixture);

  expect(fixture.controller.setEnabled(true)).toBe(false);

  expect(fixture.controller.isEnabled).toBe(false);
  expect(fixture.renderer.localClippingEnabled).toBe(false);
  expect(mesh.material).toBe(material);
  expect(fixture.timer.entries).toHaveLength(0);
  expect(findGizmo(fixture.scene).visible).toBe(false);
});

test("enable sections visible subparts at a centered camera-facing plane", () => {
  const fixture = createFixture();
  const { mesh, material, edgeLines, edgeMaterial } = addSubpart(fixture);
  const auxiliary = new THREE.MeshBasicMaterial();
  fixture.controller.registerClippableMaterial(auxiliary);

  expect(fixture.controller.setEnabled(true)).toBe(true);

  const plane = auxiliary.clippingPlanes[0];
  const center = new THREE.Vector3();
  expect(plane).toBeInstanceOf(THREE.Plane);
  expect(plane.distanceToPoint(center)).toBeCloseTo(0);
  expect(plane.normal.dot(fixture.camera.getWorldDirection(new THREE.Vector3()))).toBeCloseTo(1);
  expect(fixture.renderer.localClippingEnabled).toBe(true);
  expect(mesh.material).not.toBe(material);
  expect(mesh.material.clippingPlanes).toEqual([plane]);
  expect(edgeLines.material).not.toBe(edgeMaterial);
  expect(mesh.children.every((entry) => entry.visible)).toBe(true);
  expect(findCap(fixture.scene).visible).toBe(true);
  expect(findGizmo(fixture.scene).visible).toBe(true);
});

test("flip reverses point visibility without moving the geometric plane", () => {
  const fixture = createFixture();
  fixture.controller.setEnabled(true);
  const auxiliary = new THREE.MeshBasicMaterial();
  fixture.controller.registerClippableMaterial(auxiliary);
  const plane = auxiliary.clippingPlanes[0];
  const coplanar = plane.coplanarPoint(new THREE.Vector3());
  const before = coplanar.clone();
  const survivingPoint = coplanar.clone().addScaledVector(plane.normal, 2);

  expect(fixture.controller.isPointVisible(survivingPoint)).toBe(true);
  expect(fixture.controller.flip()).toBe(true);
  expect(fixture.controller.isPointVisible(survivingPoint)).toBe(false);
  expect(plane.coplanarPoint(new THREE.Vector3()).distanceTo(before)).toBeLessThan(1e-9);
});

test("reset recomputes the pose from changed world bounds and camera", () => {
  const fixture = createFixture();
  fixture.controller.setEnabled(true);
  const auxiliary = new THREE.MeshBasicMaterial();
  fixture.controller.registerClippableMaterial(auxiliary);
  const plane = auxiliary.clippingPlanes[0];
  const identity = plane;
  fixture.setBounds(new THREE.Box3(
    new THREE.Vector3(8, 16, 24),
    new THREE.Vector3(12, 24, 36),
  ));
  fixture.camera.position.set(20, 20, 30);
  fixture.camera.lookAt(10, 20, 30);
  fixture.camera.updateMatrixWorld(true);

  expect(fixture.controller.reset()).toBe(true);

  expect(plane).toBe(identity);
  expect(plane.distanceToPoint(new THREE.Vector3(10, 20, 30))).toBeCloseTo(0);
  expect(plane.normal.dot(fixture.camera.getWorldDirection(new THREE.Vector3()))).toBeCloseTo(1);
});

test("setVisible isolates section helpers to selected names", () => {
  const fixture = createFixture();
  const first = addSubpart(fixture, "first");
  const second = addSubpart(fixture, "second");
  fixture.controller.setVisible(["second"]);
  fixture.controller.setEnabled(true);

  expect(first.mesh.children.every((entry) => !entry.visible)).toBe(true);
  expect(second.mesh.children.every((entry) => entry.visible)).toBe(true);

  fixture.controller.setVisible(new Set(["first"]));
  expect(first.mesh.children.every((entry) => entry.visible)).toBe(true);
  expect(second.mesh.children.every((entry) => !entry.visible)).toBe(true);
});

test("geometry replacement is shared by stencil passes and remains caller-owned", () => {
  const fixture = createFixture();
  const { mesh, geometry } = addSubpart(fixture);
  const replacement = new THREE.SphereGeometry(3);
  const originalDispose = vi.spyOn(geometry, "dispose");
  const replacementDispose = vi.spyOn(replacement, "dispose");

  fixture.controller.updateGeometry("body", replacement);

  expect(mesh.children.map((entry) => entry.geometry)).toEqual([replacement, replacement]);
  fixture.controller.dispose();
  expect(originalDispose).not.toHaveBeenCalled();
  expect(replacementDispose).not.toHaveBeenCalled();
});

test("geometry updates refresh changed source materials while disabled", () => {
  const fixture = createFixture();
  const { mesh, edgeLines } = addSubpart(fixture);
  const replacementGeometry = new THREE.SphereGeometry(2);
  const replacementMaterial = new THREE.MeshStandardMaterial({
    color: 0x22c55e,
    opacity: 0.45,
    transparent: true,
    depthWrite: false,
  });
  const replacementEdgeMaterial = new THREE.LineBasicMaterial({ color: 0xf8fafc });
  mesh.material = replacementMaterial;
  edgeLines.material = replacementEdgeMaterial;

  fixture.controller.updateGeometry("body", replacementGeometry);
  fixture.controller.setEnabled(true);

  expect(findCap(fixture.scene).material.uniforms.uBase.value.getHex()).toBe(0x22c55e);
  expect(findCap(fixture.scene).material.uniforms.uOpacity.value).toBe(0.45);
  fixture.controller.setEnabled(false);
  expect(mesh.material).toBe(replacementMaterial);
  expect(edgeLines.material).toBe(replacementEdgeMaterial);
});

test("auxiliary material registration tracks state and stable Plane identity", () => {
  const fixture = createFixture();
  const material = new THREE.MeshBasicMaterial();
  const initialVersion = material.version;
  const unregister = fixture.controller.registerClippableMaterial(material);
  const duplicateUnregister = fixture.controller.registerClippableMaterial(material);
  expect(material.clippingPlanes).toBeNull();
  expect(material.version).toBe(initialVersion);

  fixture.controller.setEnabled(true);
  const plane = material.clippingPlanes[0];
  const activeVersion = material.version;
  fixture.controller.flip();
  fixture.controller.reset();
  expect(material.clippingPlanes).toEqual([plane]);
  expect(material.version).toBe(activeVersion);

  duplicateUnregister();
  expect(material.clippingPlanes).toEqual([plane]);
  unregister();
  expect(material.clippingPlanes).toBeNull();
  expect(material.version).toBe(activeVersion + 1);
  unregister();
  expect(material.version).toBe(activeVersion + 1);
});

test("updateForCamera delegates observable screen scaling to the gizmo", () => {
  const fixture = createFixture();
  fixture.controller.setEnabled(true);
  const gizmo = findGizmo(fixture.scene);
  const handleRoot = gizmo.children.find((child) => child.isGroup);
  fixture.controller.updateForCamera();
  const nearScale = handleRoot.scale.x;

  fixture.camera.position.z = 80;
  fixture.camera.updateMatrixWorld(true);
  fixture.controller.updateForCamera();

  expect(handleRoot.scale.x).toBeGreaterThan(nearScale);
});

test("active appearance schedules an 800ms fade and disable cancels it", () => {
  const fixture = createFixture();
  fixture.controller.setEnabled(true);
  const gizmo = findGizmo(fixture.scene);
  const fill = gizmo.children.find((child) => child.isMesh);
  expect(fill.material.opacity).toBeGreaterThan(0.1);
  expect(fixture.timer.entries).toHaveLength(1);
  expect(fixture.timer.entries[0].delay).toBe(800);

  fixture.timer.entries[0].callback();
  expect(fill.material.opacity).toBeLessThan(0.1);
  fixture.controller.reset();
  const pending = fixture.timer.entries.at(-1);
  fixture.controller.setEnabled(false);

  expect(pending.cancelled).toBe(true);
  expect(gizmo.visible).toBe(false);
});

test("replacing a subpart refreshes source display properties and restores exact materials", () => {
  const fixture = createFixture();
  const first = addSubpart(fixture);
  const firstOwned = first.mesh.children.map((entry) => entry.material);
  const replacementMaterial = new THREE.MeshStandardMaterial({
    color: 0xf97316,
    opacity: 0.4,
    transparent: true,
    depthWrite: false,
  });
  const replacementMesh = new THREE.Mesh(first.geometry, replacementMaterial);
  const replacementLineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff });
  const replacementLines = new THREE.LineSegments(first.edgeGeometry, replacementLineMaterial);
  fixture.scene.add(replacementMesh, replacementLines);
  const firstOwnedDisposals = firstOwned.map((material) => vi.spyOn(material, "dispose"));

  fixture.controller.setSubpart("body", replacementMesh, replacementLines);
  fixture.controller.setEnabled(true);

  expect(firstOwnedDisposals.every((spy) => spy.mock.calls.length === 1)).toBe(true);
  expect(findCap(fixture.scene).material.uniforms.uBase.value.getHex()).toBe(0xf97316);
  expect(findCap(fixture.scene).material.uniforms.uOpacity.value).toBe(0.4);
  fixture.controller.setEnabled(false);
  expect(replacementMesh.material).toBe(replacementMaterial);
  expect(replacementLines.material).toBe(replacementLineMaterial);
});

test("disable restores exact source state and dispose is idempotent and ownership-safe", () => {
  const fixture = createFixture();
  const { geometry, material, mesh, edgeGeometry, edgeMaterial, edgeLines } = addSubpart(fixture);
  const geometryDispose = vi.spyOn(geometry, "dispose");
  const materialDispose = vi.spyOn(material, "dispose");
  const edgeGeometryDispose = vi.spyOn(edgeGeometry, "dispose");
  const edgeMaterialDispose = vi.spyOn(edgeMaterial, "dispose");
  fixture.controller.setEnabled(true);

  expect(fixture.controller.setEnabled(false)).toBe(true);
  expect(fixture.controller.isEnabled).toBe(false);
  expect(fixture.renderer.localClippingEnabled).toBe(false);
  expect(mesh.material).toBe(material);
  expect(edgeLines.material).toBe(edgeMaterial);

  fixture.controller.dispose();
  fixture.controller.dispose();
  expect(geometryDispose).not.toHaveBeenCalled();
  expect(materialDispose).not.toHaveBeenCalled();
  expect(edgeGeometryDispose).not.toHaveBeenCalled();
  expect(edgeMaterialDispose).not.toHaveBeenCalled();
});

test("world-space recentered parent bounds place the initial plane through the world-box center", () => {
  const parent = new THREE.Group();
  parent.position.set(12, -7, 5);
  parent.rotation.set(0.4, 0.7, -0.2);
  const child = new THREE.Mesh(new THREE.BoxGeometry(3, 5, 7));
  child.position.set(4, 2, -3);
  parent.add(child);
  parent.updateWorldMatrix(true, true);
  const worldBounds = new THREE.Box3().setFromObject(parent);
  const fixture = createFixture({ box: worldBounds });
  fixture.controller.setEnabled(true);
  const auxiliary = new THREE.MeshBasicMaterial();
  fixture.controller.registerClippableMaterial(auxiliary);

  expect(auxiliary.clippingPlanes[0].distanceToPoint(
    worldBounds.getCenter(new THREE.Vector3()),
  )).toBeCloseTo(0);
});
