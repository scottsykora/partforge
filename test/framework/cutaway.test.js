// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest";
import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

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

function createFixture({
  stencil = true,
  box,
  schedule: providedSchedule,
  localClippingEnabled = false,
} = {}) {
  const renderer = makeRenderer(stencil);
  renderer.localClippingEnabled = localClippingEnabled;
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
  const edgeMaterial = options.edgeMaterial
    ?? new THREE.LineBasicMaterial({ color: 0x111111 });
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

test("restores a borrowed renderer clipping flag after an enabled session", () => {
  const fixture = createFixture({ localClippingEnabled: true });

  expect(fixture.controller.setEnabled(true)).toBe(true);
  expect(fixture.renderer.localClippingEnabled).toBe(true);
  expect(fixture.controller.setEnabled(false)).toBe(true);
  expect(fixture.renderer.localClippingEnabled).toBe(true);

  expect(fixture.controller.setEnabled(true)).toBe(true);
  fixture.controller.dispose();
  expect(fixture.renderer.localClippingEnabled).toBe(true);
});

test("disable and dispose without activation leave the renderer clipping flag untouched", () => {
  const disabled = createFixture({ localClippingEnabled: true });
  expect(disabled.controller.setEnabled(false)).toBe(true);
  expect(disabled.renderer.localClippingEnabled).toBe(true);

  const disposed = createFixture({ localClippingEnabled: true });
  disposed.controller.dispose();
  expect(disposed.renderer.localClippingEnabled).toBe(true);
});

test("repeated enable does not overwrite the renderer clipping snapshot", () => {
  const fixture = createFixture({ localClippingEnabled: true });

  expect(fixture.controller.setEnabled(true)).toBe(true);
  fixture.renderer.localClippingEnabled = false;
  expect(fixture.controller.setEnabled(true)).toBe(true);
  expect(fixture.controller.setEnabled(false)).toBe(true);

  expect(fixture.renderer.localClippingEnabled).toBe(true);
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

test("geometry-only updates preserve prepared clipped materials without disposal", () => {
  const fixture = createFixture();
  const { mesh, edgeLines } = addSubpart(fixture);
  const replacementGeometry = new THREE.SphereGeometry(2);
  fixture.controller.setEnabled(true);
  const preparedMeshMaterial = mesh.material;
  const preparedEdgeMaterial = edgeLines.material;
  const meshDispose = vi.spyOn(preparedMeshMaterial, "dispose");
  const edgeDispose = vi.spyOn(preparedEdgeMaterial, "dispose");
  fixture.controller.setEnabled(false);

  fixture.controller.updateGeometry("body", replacementGeometry);
  fixture.controller.setEnabled(true);

  expect(mesh.material).toBe(preparedMeshMaterial);
  expect(edgeLines.material).toBe(preparedEdgeMaterial);
  expect(mesh.children.map((entry) => entry.geometry)).toEqual([
    replacementGeometry,
    replacementGeometry,
  ]);
  expect(meshDispose).not.toHaveBeenCalled();
  expect(edgeDispose).not.toHaveBeenCalled();
});

test("viewport size updates prepared cutaway LineMaterial clones", () => {
  const fixture = createFixture();
  const edgeMaterial = new LineMaterial({ color: 0x111111, linewidth: 1 });
  edgeMaterial.resolution.set(1, 1);
  const { edgeLines } = addSubpart(fixture, "body", { edgeMaterial });

  expect(fixture.controller.setViewportSize).toBeTypeOf("function");
  fixture.controller.setViewportSize(640, 480);
  fixture.controller.setEnabled(true);
  expect(edgeLines.material).not.toBe(edgeMaterial);
  expect(edgeLines.material.resolution.toArray()).toEqual([640, 480]);

  fixture.controller.setViewportSize(900, 700);
  expect(edgeLines.material.resolution.toArray()).toEqual([900, 700]);
});

test("theme refresh forwards exact feature-edge hatch colors and preserves exact originals", () => {
  const fixture = createFixture();
  const { mesh, material, edgeLines, edgeMaterial } = addSubpart(fixture);
  const cap = findCap(fixture.scene);
  fixture.controller.setEnabled(true);
  const oldClippedMesh = mesh.material;
  const oldClippedEdge = edgeLines.material;
  const oldMeshDispose = vi.spyOn(oldClippedMesh, "dispose");
  const oldEdgeDispose = vi.spyOn(oldClippedEdge, "dispose");
  material.color.set(0x16a34a);
  edgeMaterial.color.set(0xf8fafc);

  fixture.controller.setTheme("dark", 0x1c232d);
  expect(cap.material.uniforms.uInk.value.getHex()).toBe(0x1c232d);

  fixture.controller.setTheme("light", 0x33414f);

  expect(oldMeshDispose).toHaveBeenCalledOnce();
  expect(oldEdgeDispose).toHaveBeenCalledOnce();
  expect(mesh.material).not.toBe(oldClippedMesh);
  expect(mesh.material.color.getHex()).toBe(0x16a34a);
  expect(edgeLines.material).not.toBe(oldClippedEdge);
  expect(edgeLines.material.color.getHex()).toBe(0xf8fafc);
  expect(cap.material.uniforms.uInk.value.getHex()).toBe(0x33414f);
  fixture.controller.setEnabled(false);
  expect(mesh.material).toBe(material);
  expect(edgeLines.material).toBe(edgeMaterial);
});

test("auxiliary material registration preserves borrowed clipping state across sessions", () => {
  const fixture = createFixture();
  const material = new THREE.MeshBasicMaterial();
  const foreignPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), -3);
  const originalClippingPlanes = [foreignPlane];
  material.clippingPlanes = originalClippingPlanes;
  const initialVersion = material.version;
  const unregister = fixture.controller.registerClippableMaterial(material);
  const duplicateUnregister = fixture.controller.registerClippableMaterial(material);
  expect(material.clippingPlanes).toBe(originalClippingPlanes);
  expect(material.version).toBe(initialVersion);

  fixture.controller.setEnabled(true);
  const plane = material.clippingPlanes[0];
  expect(material.clippingPlanes).not.toBe(originalClippingPlanes);
  expect(plane).not.toBe(foreignPlane);
  const activeVersion = material.version;
  fixture.controller.flip();
  fixture.controller.reset();
  expect(material.clippingPlanes).toEqual([plane]);
  expect(material.version).toBe(activeVersion);

  fixture.controller.setEnabled(false);
  expect(material.clippingPlanes).toBe(originalClippingPlanes);
  expect(material.version).toBe(activeVersion + 1);
  fixture.controller.setEnabled(true);
  expect(material.clippingPlanes).toEqual([plane]);
  expect(material.version).toBe(activeVersion + 2);

  duplicateUnregister();
  expect(material.clippingPlanes).toEqual([plane]);
  expect(material.version).toBe(activeVersion + 2);
  unregister();
  expect(material.clippingPlanes).toBe(originalClippingPlanes);
  expect(material.version).toBe(activeVersion + 3);
  unregister();
  expect(material.clippingPlanes).toBe(originalClippingPlanes);
  expect(material.version).toBe(activeVersion + 3);
});

test.each([null, []])(
  "dispose restores an exact %s auxiliary clipping value",
  (originalClippingPlanes) => {
    const fixture = createFixture();
    const material = new THREE.MeshBasicMaterial();
    material.clippingPlanes = originalClippingPlanes;
    fixture.controller.registerClippableMaterial(material);
    fixture.controller.setEnabled(true);

    expect(material.clippingPlanes).not.toBe(originalClippingPlanes);
    fixture.controller.dispose();

    expect(material.clippingPlanes).toBe(originalClippingPlanes);
  },
);

test("failed activation preserves renderer and auxiliary clipping state", () => {
  const originalClippingPlanes = [new THREE.Plane()];
  const fixture = createFixture({
    box: new THREE.Box3(),
    localClippingEnabled: true,
  });
  const material = new THREE.MeshBasicMaterial();
  material.clippingPlanes = originalClippingPlanes;
  fixture.controller.registerClippableMaterial(material);

  expect(fixture.controller.setEnabled(true)).toBe(false);
  expect(fixture.renderer.localClippingEnabled).toBe(true);
  expect(material.clippingPlanes).toBe(originalClippingPlanes);
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

test("updateForCamera skips viewport work while the cutaway is disabled", () => {
  const fixture = createFixture();
  const getViewport = vi.spyOn(fixture.domElement, "getBoundingClientRect");

  fixture.controller.updateForCamera();
  expect(getViewport).not.toHaveBeenCalled();

  fixture.controller.setEnabled(true);
  getViewport.mockClear();
  fixture.controller.updateForCamera();
  expect(getViewport).toHaveBeenCalledOnce();

  fixture.controller.setEnabled(false);
  getViewport.mockClear();
  fixture.controller.updateForCamera();
  expect(getViewport).not.toHaveBeenCalled();
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

test("hover and focus restore active appearance and reschedule fade without moving the plane", () => {
  const fixture = createFixture();
  fixture.controller.setEnabled(true);
  const gizmo = findGizmo(fixture.scene);
  const fill = gizmo.children.find((child) => child.isMesh);
  fixture.timer.entries[0].callback();
  expect(fill.material.opacity).toBeLessThan(0.1);

  fixture.domElement.dispatchEvent(new PointerEvent("pointerenter"));

  expect(fill.material.opacity).toBeGreaterThan(0.1);
  expect(fixture.timer.entries).toHaveLength(2);
  expect(fixture.timer.entries[1].delay).toBe(800);
  fixture.timer.entries[1].callback();
  expect(fill.material.opacity).toBeLessThan(0.1);

  fixture.domElement.dispatchEvent(new FocusEvent("focus"));

  expect(fill.material.opacity).toBeGreaterThan(0.1);
  expect(fixture.timer.entries).toHaveLength(3);
  expect(fixture.timer.entries[2].delay).toBe(800);
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

test("viewer supplies visible transformed meshes as world-space cutaway bounds", async () => {
  class FakeRenderer {
    constructor(options) {
      this.options = options;
      this.domElement = document.createElement("canvas");
      this.localClippingEnabled = false;
    }
    getContext() { return { getContextAttributes: () => ({ stencil: true }) }; }
    setPixelRatio() {}
    setSize() {}
    setAnimationLoop(callback) { this.animationLoop = callback; }
    render() {}
    dispose() {}
  }

  vi.doMock("three", async (importOriginal) => ({
    ...(await importOriginal()),
    WebGLRenderer: FakeRenderer,
  }));

  let cutawayOptions;
  const fakeCutaway = {
    isSupported: true,
    isEnabled: false,
    setSubpart: vi.fn(),
    updateGeometry: vi.fn(),
    setVisible: vi.fn(),
    setEnabled: vi.fn((on) => {
      fakeCutaway.isEnabled = !!on;
      return true;
    }),
    flip: vi.fn(),
    reset: vi.fn(),
    setTheme: vi.fn(),
    setViewportSize: vi.fn(),
    isPointVisible: vi.fn(() => true),
    registerClippableMaterial: vi.fn(),
    updateForCamera: vi.fn(),
    dispose: vi.fn(),
  };
  vi.doMock("../../src/framework/cutaway.js", () => ({
    createCutaway: vi.fn((options) => {
      cutawayOptions = options;
      return fakeCutaway;
    }),
  }));

  const { createViewer } = await import("../../src/framework/viewer.js");
  const container = document.createElement("div");
  Object.defineProperties(container, {
    clientWidth: { value: 400 },
    clientHeight: { value: 300 },
  });
  document.body.appendChild(container);
  const viewer = createViewer(container, {
    meta: {},
    parts: { body: {}, hidden: {} },
  });
  const payload = (offset) => ({
    positions: new Float32Array([
      offset, 0, 0,
      offset + 2, 0, 0,
      offset, 4, 0,
    ]),
    triangles: 1,
  });
  viewer.setSubGeometry("body", payload(10));
  viewer.setSubGeometry("hidden", payload(100));
  viewer.showAssembly(["body"], { frame: true });

  const actual = cutawayOptions.getBounds();
  const expected = new THREE.Box3().setFromObject(viewer._subMeshes.body);

  expect(actual.min.distanceTo(expected.min)).toBeLessThan(1e-9);
  expect(actual.max.distanceTo(expected.max)).toBeLessThan(1e-9);
  expect(actual.max.x).toBeLessThan(50);
  expect(fakeCutaway.setSubpart).toHaveBeenCalledTimes(2);
  viewer.dispose();
  vi.doUnmock("three");
  vi.doUnmock("../../src/framework/cutaway.js");
});
