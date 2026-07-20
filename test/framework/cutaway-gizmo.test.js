// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import { createCutawayGizmo } from "../../src/framework/cutaway-gizmo.js";
import { initialCutawayPose } from "../../src/framework/cutaway-math.js";
import { CUTAWAY_OVERLAY_RENDER_ORDER } from "../../src/framework/cutaway-render.js";

const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.gizmo.dispose();
    fixture.orbitControls.dispose?.();
  }
  document.body.innerHTML = "";
});

function createFixture(overrides = {}) {
  const { createOrbitControls, ...gizmoOverrides } = overrides;
  const scene = new THREE.Scene();
  const overlayScene = new THREE.Scene();
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

  const orbitControls = createOrbitControls?.(camera, domElement) ?? { enabled: true };
  const onPoseChange = vi.fn();
  const gizmo = createCutawayGizmo({
    scene,
    overlayScene,
    camera,
    domElement,
    orbitControls,
    onPoseChange,
    ...gizmoOverrides,
  });
  const fixture = {
    scene,
    overlayScene,
    camera,
    domElement,
    orbitControls,
    onPoseChange,
    gizmo,
  };
  fixtures.push(fixture);
  return fixture;
}

function pointer(domElement, type, {
  x = 100,
  y = 100,
  pointerId = 7,
  pointerType = "mouse",
} = {}) {
  domElement.dispatchEvent(new PointerEvent(type, {
    pointerId,
    pointerType,
    clientX: x,
    clientY: y,
    button: 0,
    bubbles: true,
  }));
}

function setProductionPose(fixture) {
  const box = new THREE.Box3(
    new THREE.Vector3(-5, -4, -3),
    new THREE.Vector3(5, 4, 3),
  );
  const pose = initialCutawayPose(box, fixture.camera);
  fixture.gizmo.setPose(pose);
  return pose;
}

function clientPoint(fixture, worldPoint) {
  const rect = fixture.domElement.getBoundingClientRect();
  const projected = worldPoint.clone().project(fixture.camera);
  return {
    x: rect.left + (projected.x + 1) * 0.5 * rect.width,
    y: rect.top + (1 - projected.y) * 0.5 * rect.height,
  };
}

function arcMeshes(gizmo) {
  const arcRoot = gizmo.handleRoot.children.find(
    (child) => child.getObjectById(gizmo.handles.rotateX.id),
  );
  return arcRoot?.children ?? [];
}

function sampledCenterlineZ(gizmo, mesh) {
  const { radius, arc } = mesh.geometry.parameters;
  gizmo.group.updateWorldMatrix(true, true);
  return [0.1, 0.5, 0.9].map((fraction) => {
    const theta = arc * fraction;
    const worldPoint = mesh.localToWorld(new THREE.Vector3(
      radius * Math.cos(theta),
      radius * Math.sin(theta),
      0,
    ));
    return gizmo.group.worldToLocal(worldPoint).z;
  });
}

function handleThickness(gizmo, handle) {
  if (handle === "translate") {
    return gizmo.handleVisuals.translate.children[0].geometry.parameters.radiusTop;
  }
  return gizmo.handleVisuals[handle].geometry.parameters.tube;
}

function expectOnlyHandleThickened(gizmo, hoveredHandle) {
  const baseThickness = {
    translate: 0.025,
    rotateX: 0.015,
    rotateY: 0.015,
  };
  for (const [handle, visual] of Object.entries(gizmo.handleVisuals)) {
    expect(visual.scale.toArray()).toEqual([1, 1, 1]);
    if (handle === hoveredHandle) {
      expect(handleThickness(gizmo, handle)).toBeGreaterThan(baseThickness[handle]);
    } else {
      expect(handleThickness(gizmo, handle)).toBe(baseThickness[handle]);
    }
  }
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
  expect(gizmo.handleRoot.visible).toBe(false);
  gizmo.setVisible(true);
  expect(gizmo.group.visible).toBe(true);
  expect(gizmo.handleRoot.visible).toBe(true);
});

test("mounts the ghost plane in the main scene and all visible and hit handles in one overlay scene", () => {
  const { scene, overlayScene, gizmo } = createFixture();

  expect(gizmo.group.parent).toBe(scene);
  expect(gizmo.fill.parent).toBe(gizmo.group);
  expect(gizmo.border.parent).toBe(gizmo.group);
  expect(gizmo.handleRoot.parent).toBe(overlayScene);
  expect(gizmo.group.getObjectById(gizmo.handleRoot.id)).toBeUndefined();

  const overlayMeshes = [];
  gizmo.handleRoot.traverse((object) => {
    if (object.isMesh) overlayMeshes.push(object);
  });
  expect(overlayMeshes).toHaveLength(7);
  expect(overlayMeshes).toEqual(expect.arrayContaining(Object.values(gizmo.handles)));
  for (const mesh of overlayMeshes) {
    let root = mesh;
    while (root.parent) root = root.parent;
    expect(root).toBe(overlayScene);
  }

  const position = new THREE.Vector3(2, 3, 4);
  const quaternion = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    Math.PI / 4,
  );
  gizmo.setPose({ position, quaternion, size: 20 });
  expect(gizmo.handleRoot.position.toArray()).toEqual(position.toArray());
  expect(gizmo.handleRoot.quaternion.toArray()).toEqual(quaternion.toArray());
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

test("uses real half-torus geometry for both visible rotation arcs and hit proxies", () => {
  const { gizmo } = createFixture();
  const arcs = arcMeshes(gizmo);
  const visibleArcs = arcs.filter((mesh) => mesh.material?.opacity !== 0);
  const hitArcs = arcs.filter((mesh) => mesh.userData.cutawayHandle?.startsWith("rotate"));

  expect(arcs).toHaveLength(4);
  expect(visibleArcs).toHaveLength(2);
  expect(hitArcs).toHaveLength(2);
  for (const arc of [...visibleArcs, ...hitArcs]) {
    expect(arc.geometry).toBeInstanceOf(THREE.TorusGeometry);
    expect(arc.geometry.parameters.arc).toBe(Math.PI);
  }
});

test("mirrors visual and hit arc centerlines between the clipped-away half spaces", () => {
  const { gizmo } = createFixture();
  const arcs = arcMeshes(gizmo);

  expect(gizmo.setFlipped).toBeTypeOf("function");
  if (typeof gizmo.setFlipped !== "function") return;
  expect(arcs).toHaveLength(4);
  for (const arc of arcs) {
    expect(sampledCenterlineZ(gizmo, arc).every((z) => z < 0)).toBe(true);
  }

  gizmo.setFlipped(true);

  for (const arc of arcs) {
    expect(sampledCenterlineZ(gizmo, arc).every((z) => z > 0)).toBe(true);
  }
});

test.each([
  [false, -1],
  [true, 1],
])("only the visible %s-flipped half of a rotation proxy raycasts", (flipped, visibleSign) => {
  const { gizmo } = createFixture();
  expect(gizmo.setFlipped).toBeTypeOf("function");
  if (typeof gizmo.setFlipped !== "function") return;
  gizmo.setPose({
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    size: 10,
  });
  gizmo.setFlipped(flipped);
  gizmo.group.updateWorldMatrix(true, true);
  gizmo.handleRoot.updateWorldMatrix(true, true);
  const radius = gizmo.handles.rotateY.geometry.parameters.radius
    * gizmo.handleRoot.scale.x;
  const rays = [
    {
      handle: gizmo.handles.rotateX,
      originAt: (z) => new THREE.Vector3(5, 0, z),
      direction: new THREE.Vector3(-1, 0, 0),
    },
    {
      handle: gizmo.handles.rotateY,
      originAt: (z) => new THREE.Vector3(0, 5, z),
      direction: new THREE.Vector3(0, -1, 0),
    },
  ];

  for (const { handle, originAt, direction } of rays) {
    const intersectionsAt = (z) => new THREE.Raycaster(
      originAt(z),
      direction,
    ).intersectObject(handle, false);
    expect(intersectionsAt(visibleSign * radius).length).toBeGreaterThan(0);
    expect(intersectionsAt(-visibleSign * radius)).toHaveLength(0);
  }
});

test.each([
  [1, 0.01],
  [100, 0.1],
  [1_000, 0.25],
])("offsets only the ghost plane toward the empty side for size %s", (size, expectedOffset) => {
  const { gizmo } = createFixture();
  const position = new THREE.Vector3(1, 2, 3);
  const quaternion = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    Math.PI / 3,
  );

  gizmo.setPose({ position, quaternion, size });

  expect(gizmo.group.position.toArray()).toEqual(position.toArray());
  expect(gizmo.group.quaternion.toArray()).toEqual(quaternion.toArray());
  expect(gizmo.fill.position.z).toBeCloseTo(-expectedOffset);
  expect(gizmo.border.position.z).toBeCloseTo(-expectedOffset);
  expect(gizmo.setFlipped).toBeTypeOf("function");
  if (typeof gizmo.setFlipped !== "function") return;

  gizmo.setFlipped(true);

  expect(gizmo.group.position.toArray()).toEqual(position.toArray());
  expect(gizmo.group.quaternion.toArray()).toEqual(quaternion.toArray());
  expect(gizmo.fill.position.z).toBeCloseTo(expectedOffset);
  expect(gizmo.border.position.z).toBeCloseTo(expectedOffset);
});

test("visible controls share overlay depth while the translucent fill remains depth-tested", () => {
  const { gizmo } = createFixture();
  const visibleHandles = [];
  gizmo.handleRoot.traverse((child) => {
    if (child.isMesh && child.material?.opacity !== 0) visibleHandles.push(child);
  });

  expect(visibleHandles).toHaveLength(4);
  for (const handle of visibleHandles) {
    expect(handle.material.transparent).toBe(true);
    expect(handle.material.depthTest).toBe(true);
    expect(handle.material.depthWrite).toBe(true);
    expect(handle.renderOrder).toBe(0);
    expect(handle.parent === gizmo.handleRoot || handle.parent?.parent === gizmo.handleRoot)
      .toBe(true);
  }
  expect(gizmo.border.material.transparent).toBe(true);
  expect(gizmo.border.material.depthTest).toBe(false);
  expect(gizmo.border.material.depthWrite).toBe(false);
  expect(gizmo.border.renderOrder).toBeGreaterThan(CUTAWAY_OVERLAY_RENDER_ORDER);
  expect(gizmo.fill.material.depthTest).toBe(true);
  expect(gizmo.fill.material.depthWrite).toBe(false);
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

test("reports hover, focus, and successful handle presses only while visible and alive", () => {
  const onActivity = vi.fn();
  const { domElement, gizmo } = createFixture({
    onActivity,
    pickHandle: () => "translate",
  });

  domElement.dispatchEvent(new PointerEvent("pointerenter"));
  pointer(domElement, "pointermove");
  domElement.dispatchEvent(new FocusEvent("focus"));
  pointer(domElement, "pointerdown");

  expect(onActivity).toHaveBeenCalledTimes(4);

  gizmo.setVisible(false);
  domElement.dispatchEvent(new PointerEvent("pointerenter"));
  pointer(domElement, "pointermove");
  domElement.dispatchEvent(new FocusEvent("focus"));
  pointer(domElement, "pointerdown");
  expect(onActivity).toHaveBeenCalledTimes(4);

  gizmo.dispose();
  gizmo.setVisible(true);
  domElement.dispatchEvent(new PointerEvent("pointerenter"));
  pointer(domElement, "pointermove");
  domElement.dispatchEvent(new FocusEvent("focus"));
  pointer(domElement, "pointerdown");
  expect(onActivity).toHaveBeenCalledTimes(4);
});

test("theme changes the fill, border, and visible handle colors in place", () => {
  const { gizmo } = createFixture();
  const dark = gizmo.fill.material.color.getHex();
  const borderDark = gizmo.border.material.color.getHex();
  const visibleHandle = gizmo.handleVisuals.translate.children[0];
  const handleDark = visibleHandle.material.color.getHex();

  gizmo.setTheme("light");

  expect(gizmo.fill.material.color.getHex()).not.toBe(dark);
  expect(gizmo.border.material.color.getHex()).not.toBe(borderDark);
  expect(visibleHandle.material.color.getHex()).not.toBe(handleDark);
});

test("passive hover publishes only transitions and emphasizes one stable visual at a time", () => {
  let picked = "translate";
  const onHandleHoverChange = vi.fn();
  const { domElement, gizmo } = createFixture({
    onHandleHoverChange,
    pickHandle: () => picked,
  });
  gizmo.setActiveAppearance(false);

  const translateMaterial = gizmo.handleVisuals.translate.children[0].material;
  const translateBase = translateMaterial.color.clone();
  pointer(domElement, "pointermove");

  expect(onHandleHoverChange).toHaveBeenCalledTimes(1);
  expect(onHandleHoverChange).toHaveBeenLastCalledWith("translate");
  expectOnlyHandleThickened(gizmo, "translate");
  expect(gizmo.handleVisuals.translate.children[0].geometry.parameters.height).toBe(0.58);
  expect(gizmo.handleVisuals.translate.children[1].geometry.parameters.height).toBe(0.2);
  expect(translateMaterial.color.r).toBeGreaterThan(translateBase.r);
  expect(translateMaterial.color.g).toBeGreaterThan(translateBase.g);
  expect(translateMaterial.color.b).toBeGreaterThan(translateBase.b);
  expect(translateMaterial.opacity).toBe(1);
  for (const proxy of Object.values(gizmo.handles)) {
    expect(proxy.scale.toArray()).toEqual([1, 1, 1]);
  }

  pointer(domElement, "pointermove");
  expect(onHandleHoverChange).toHaveBeenCalledTimes(1);

  picked = "rotate-x";
  pointer(domElement, "pointermove");
  expect(onHandleHoverChange).toHaveBeenLastCalledWith("rotate-x");
  expectOnlyHandleThickened(gizmo, "rotateX");
  expect(gizmo.handleVisuals.rotateX.geometry.parameters.radius).toBe(0.42);
  expect(translateMaterial.color.getHex()).toBe(translateBase.getHex());

  picked = null;
  pointer(domElement, "pointermove");
  expect(onHandleHoverChange.mock.calls.map(([handle]) => handle)).toEqual([
    "translate",
    "rotate-x",
    null,
  ]);
  expectOnlyHandleThickened(gizmo, null);

  picked = "rotate-y";
  pointer(domElement, "pointermove", { pointerType: "touch" });
  expect(onHandleHoverChange).toHaveBeenCalledTimes(3);
});

test("passive hover uses the real priority pick path at the projected gizmo center", () => {
  const onHandleHoverChange = vi.fn();
  const fixture = createFixture({ onHandleHoverChange });
  const pose = setProductionPose(fixture);
  fixture.gizmo.setFlipped(true);
  fixture.gizmo.updateForCamera();
  const center = clientPoint(fixture, pose.position);

  pointer(fixture.domElement, "pointermove", center);

  expect(onHandleHoverChange).toHaveBeenCalledOnce();
  expect(onHandleHoverChange).toHaveBeenLastCalledWith("translate");
  expectOnlyHandleThickened(fixture.gizmo, "translate");
});

test("press emphasizes without a prior move and locks hover until the next passive move", () => {
  let picked = "translate";
  const onHandleHoverChange = vi.fn();
  const { domElement, gizmo } = createFixture({
    onHandleHoverChange,
    pickHandle: () => picked,
  });

  pointer(domElement, "pointerdown");
  expect(onHandleHoverChange).toHaveBeenLastCalledWith("translate");
  expectOnlyHandleThickened(gizmo, "translate");

  picked = "rotate-x";
  pointer(domElement, "pointermove", { x: 110 });
  expect(onHandleHoverChange).toHaveBeenCalledTimes(1);
  expectOnlyHandleThickened(gizmo, "translate");

  pointer(domElement, "pointerup", { x: 110 });
  domElement.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 7 }));
  expect(onHandleHoverChange).toHaveBeenCalledTimes(1);
  expectOnlyHandleThickened(gizmo, "translate");

  pointer(domElement, "pointermove", { x: 110 });
  expect(onHandleHoverChange.mock.calls.map(([handle]) => handle)).toEqual([
    "translate",
    "rotate-x",
  ]);
  expectOnlyHandleThickened(gizmo, "rotateX");

  picked = null;
  pointer(domElement, "pointermove", { x: 120 });
  expect(onHandleHoverChange).toHaveBeenLastCalledWith(null);
});

test("an unrelated pointer leaving does not clear or end the active drag", () => {
  const onHandleHoverChange = vi.fn();
  const { domElement, gizmo, onPoseChange, orbitControls } = createFixture({
    onHandleHoverChange,
    pickHandle: () => "translate",
  });

  pointer(domElement, "pointerdown", { pointerId: 1 });
  pointer(domElement, "pointerleave", { pointerId: 2 });

  expect(orbitControls.enabled).toBe(false);
  expect(onHandleHoverChange.mock.calls.map(([handle]) => handle)).toEqual([
    "translate",
  ]);
  expectOnlyHandleThickened(gizmo, "translate");

  pointer(domElement, "pointermove", { pointerId: 1, y: 90 });
  expect(onPoseChange).toHaveBeenCalledOnce();
});

test.each([
  ["pointerleave", false],
  ["pointercancel", true],
  ["lostpointercapture", true],
  ["blur", false],
  ["hide", false],
  ["dispose", false],
])("%s clears published hover state", (action, startDrag) => {
  const onHandleHoverChange = vi.fn();
  const { domElement, gizmo } = createFixture({
    onHandleHoverChange,
    pickHandle: () => "translate",
  });
  if (startDrag) pointer(domElement, "pointerdown");
  else pointer(domElement, "pointermove");
  expect(onHandleHoverChange).toHaveBeenLastCalledWith("translate");

  if (action === "blur") window.dispatchEvent(new Event("blur"));
  else if (action === "hide") gizmo.setVisible(false);
  else if (action === "dispose") gizmo.dispose();
  else domElement.dispatchEvent(new PointerEvent(action, { pointerId: 7 }));

  expect(onHandleHoverChange).toHaveBeenLastCalledWith(null);
  expectOnlyHandleThickened(gizmo, null);
});

test("theme and active appearance changes preserve the hovered advantage", () => {
  const { domElement, gizmo } = createFixture({
    pickHandle: () => "rotate-y",
  });
  pointer(domElement, "pointermove");

  gizmo.setActiveAppearance(false);
  gizmo.setTheme("light");
  const hoveredMaterial = gizmo.handleVisuals.rotateY.material;
  const normalMaterial = gizmo.handleVisuals.rotateX.material;
  const lightRotateY = new THREE.Color(0x1769aa);
  expect(hoveredMaterial.opacity).toBe(1);
  expect(normalMaterial.opacity).toBe(0.48);
  expect(hoveredMaterial.color.r).toBeGreaterThan(lightRotateY.r);
  expect(hoveredMaterial.color.g).toBeGreaterThan(lightRotateY.g);
  expect(hoveredMaterial.color.b).toBeGreaterThan(lightRotateY.b);
  expectOnlyHandleThickened(gizmo, "rotateY");

  gizmo.setActiveAppearance(true);
  expect(hoveredMaterial.opacity).toBe(1);
  expectOnlyHandleThickened(gizmo, "rotateY");
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

test("perspective scaling uses parented world position and effective zoomed FOV", () => {
  const { camera, domElement, gizmo } = createFixture();
  const cameraParent = new THREE.Group();
  cameraParent.position.z = 40;
  cameraParent.add(camera);
  cameraParent.updateWorldMatrix(true, true);
  gizmo.setPose({
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    size: 100,
  });

  const expectedScale = () => {
    const rect = domElement.getBoundingClientRect();
    const worldPosition = camera.getWorldPosition(new THREE.Vector3());
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const depth = Math.abs(gizmo.group.position.clone().sub(worldPosition).dot(forward));
    return 2 * depth
      * Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2)
      / rect.height
      * 72;
  };

  gizmo.updateForCamera();
  const unzoomedScale = gizmo.handleRoot.scale.x;
  expect(unzoomedScale).toBeCloseTo(expectedScale());

  camera.zoom = 2;
  camera.updateProjectionMatrix();
  gizmo.updateForCamera();

  expect(gizmo.handleRoot.scale.x).toBeCloseTo(expectedScale());
  expect(gizmo.handleRoot.scale.x).toBeLessThan(unzoomedScale);
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

test("a gizmo press is handled before earlier-registered OrbitControls", () => {
  const orbitStart = vi.fn();
  const fixture = createFixture({
    createOrbitControls: (camera, domElement) => {
      const controls = new OrbitControls(camera, domElement);
      controls.addEventListener("start", orbitStart);
      return controls;
    },
    pickHandle: () => "translate",
  });
  const { camera, domElement, gizmo, orbitControls } = fixture;
  const cameraBefore = camera.position.clone();

  pointer(domElement, "pointerdown");

  expect(orbitStart).not.toHaveBeenCalled();
  expect(orbitControls.enabled).toBe(false);
  expectOnlyHandleThickened(gizmo, "translate");

  window.dispatchEvent(new Event("blur"));
  document.dispatchEvent(new PointerEvent("pointermove", {
    pointerId: 7,
    pointerType: "mouse",
    clientX: 160,
    clientY: 140,
    buttons: 1,
    bubbles: true,
  }));

  expect(orbitControls.enabled).toBe(true);
  expect(camera.position.toArray()).toEqual(cameraBefore.toArray());
});

test("a gizmo miss still reaches earlier-registered OrbitControls", () => {
  const orbitStart = vi.fn();
  const { domElement, orbitControls } = createFixture({
    createOrbitControls: (camera, element) => {
      const controls = new OrbitControls(camera, element);
      controls.addEventListener("start", orbitStart);
      return controls;
    },
    pickHandle: () => null,
  });

  pointer(domElement, "pointerdown");

  expect(orbitStart).toHaveBeenCalledOnce();
  expect(orbitControls.enabled).toBe(true);
  pointer(domElement, "pointerup");
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

test("off-center translation stays useful with the production camera-facing pose", () => {
  const fixture = createFixture({ pickHandle: () => "translate" });
  const { domElement, onPoseChange } = fixture;
  const pose = setProductionPose(fixture);
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(pose.quaternion);

  pointer(domElement, "pointerdown", { x: 112, y: 100 });
  pointer(domElement, "pointermove", { x: 112, y: 80 });

  expect(onPoseChange).toHaveBeenCalledOnce();
  const movement = onPoseChange.mock.calls[0][0].position
    .clone()
    .sub(pose.position)
    .dot(normal);
  expect(Number.isFinite(movement)).toBe(true);
  expect(Math.abs(movement)).toBeGreaterThan(0.01);
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

test.each([
  ["rotate-x", { x: 100, y: 75 }, { x: 100, y: 115 }],
  ["rotate-y", { x: 125, y: 100 }, { x: 85, y: 100 }],
])("%s rotates from the production camera-facing pose", (handle, down, move) => {
  const fixture = createFixture({ pickHandle: () => handle });
  const { domElement, onPoseChange } = fixture;
  const pose = setProductionPose(fixture);

  pointer(domElement, "pointerdown", down);
  pointer(domElement, "pointermove", move);

  expect(onPoseChange).toHaveBeenCalledOnce();
  const quaternion = onPoseChange.mock.calls[0][0].quaternion;
  expect(quaternion.toArray().every(Number.isFinite)).toBe(true);
  expect(quaternion.length()).toBeCloseTo(1);
  expect(Math.abs(quaternion.dot(pose.quaternion))).toBeLessThan(0.999_999);
});

test("real center hit prioritizes production-pose translation over edge-on rings", () => {
  const fixture = createFixture();
  const { domElement, onPoseChange, gizmo } = fixture;
  const pose = setProductionPose(fixture);
  gizmo.updateForCamera();
  const center = clientPoint(fixture, pose.position);

  pointer(domElement, "pointerdown", center);
  pointer(domElement, "pointermove", { x: center.x, y: center.y - 20 });

  expect(onPoseChange).toHaveBeenCalledOnce();
  const changed = onPoseChange.mock.calls[0][0];
  expect(changed.position.distanceTo(pose.position)).toBeGreaterThan(0.01);
  expect(Math.abs(changed.quaternion.dot(pose.quaternion))).toBeCloseTo(1);
});

test("center outside the camera clip volume cannot claim semantic translation", () => {
  const { domElement, onPoseChange, orbitControls, gizmo } = createFixture();
  gizmo.setPose({
    position: new THREE.Vector3(0, 0, 30),
    quaternion: new THREE.Quaternion(),
    size: 10,
  });

  pointer(domElement, "pointerdown", { x: 100, y: 100 });
  pointer(domElement, "pointermove", { x: 100, y: 80 });

  expect(onPoseChange).not.toHaveBeenCalled();
  expect(orbitControls.enabled).toBe(true);
  expect(domElement.setPointerCapture).not.toHaveBeenCalled();
});

test("real vertical ring-arm hit rotates local X in the production pose", () => {
  const fixture = createFixture();
  const { domElement, onPoseChange, gizmo } = fixture;
  const pose = setProductionPose(fixture);
  gizmo.updateForCamera();
  const center = clientPoint(fixture, pose.position);

  pointer(domElement, "pointerdown", { x: center.x, y: center.y - 30 });
  pointer(domElement, "pointermove", { x: center.x, y: center.y - 10 });

  expect(onPoseChange).toHaveBeenCalledOnce();
  const changed = onPoseChange.mock.calls[0][0];
  expect(Math.abs(changed.quaternion.dot(pose.quaternion))).toBeLessThan(0.999_999);
  expect(changed.position.distanceTo(pose.position)).toBeCloseTo(0);
});

test("real horizontal ring-arm hit rotates local Y in the production pose", () => {
  const fixture = createFixture();
  const { domElement, onPoseChange, gizmo } = fixture;
  const pose = setProductionPose(fixture);
  gizmo.updateForCamera();
  const center = clientPoint(fixture, pose.position);

  pointer(domElement, "pointerdown", { x: center.x + 30, y: center.y });
  pointer(domElement, "pointermove", { x: center.x + 10, y: center.y });

  expect(onPoseChange).toHaveBeenCalledOnce();
  const changed = onPoseChange.mock.calls[0][0];
  expect(Math.abs(changed.quaternion.dot(pose.quaternion))).toBeLessThan(0.999_999);
  expect(changed.position.distanceTo(pose.position)).toBeCloseTo(0);
});

test("ring proxy provides a touch-friendly band at the intended apparent scale", () => {
  const fixture = createFixture();
  const { camera, domElement, gizmo } = fixture;
  setProductionPose(fixture);
  gizmo.updateForCamera();
  const rect = domElement.getBoundingClientRect();
  const distance = camera.position.distanceTo(gizmo.group.position);
  const worldUnitsPerPixel = 2 * distance
    * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
    / rect.height;
  const bandCssPixels = 2 * gizmo.handles.rotateX.geometry.parameters.tube
    * gizmo.handleRoot.scale.x
    / worldUnitsPerPixel;

  expect(bandCssPixels).toBeGreaterThanOrEqual(16);
  expect(bandCssPixels).toBeLessThanOrEqual(18);
});

test("dispose completes cleanup when the final hover callback throws", () => {
  const pickHandle = vi.fn(() => "translate");
  let gizmo;
  const fixture = createFixture({
    pickHandle,
    onHandleHoverChange: (handle) => {
      if (handle === null) throw new Error("hover cleanup failed");
    },
  });
  ({ gizmo } = fixture);
  const geometryDispose = vi.spyOn(gizmo.fill.geometry, "dispose");
  pointer(fixture.domElement, "pointermove");

  expect(() => gizmo.dispose()).toThrow("hover cleanup failed");

  expect(gizmo.group.parent).toBeNull();
  expect(gizmo.handleRoot.parent).toBeNull();
  expect(geometryDispose).toHaveBeenCalledOnce();
  pointer(fixture.domElement, "pointerdown");
  expect(pickHandle).toHaveBeenCalledOnce();
});

test("a reentrant final hover callback cannot dispose resources twice", () => {
  let gizmo;
  const fixture = createFixture({
    pickHandle: () => "translate",
    onHandleHoverChange: (handle) => {
      if (handle === null) gizmo.dispose();
    },
  });
  ({ gizmo } = fixture);
  const geometryDispose = vi.spyOn(gizmo.fill.geometry, "dispose");
  pointer(fixture.domElement, "pointermove");

  gizmo.dispose();

  expect(geometryDispose).toHaveBeenCalledOnce();
  expect(gizmo.group.parent).toBeNull();
  expect(gizmo.handleRoot.parent).toBeNull();
});

test("dispose ends a drag, removes listeners and scene objects, and disposes owned resources once", () => {
  const pickHandle = vi.fn(() => "translate");
  const { domElement, orbitControls, gizmo } = createFixture({ pickHandle });
  const geometries = new Set();
  const materials = new Set();
  for (const root of [gizmo.group, gizmo.handleRoot]) {
    root.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      if (object.material) materials.add(object.material);
    });
  }
  const geometryDisposals = [...geometries].map((resource) => vi.spyOn(resource, "dispose"));
  const materialDisposals = [...materials].map((resource) => vi.spyOn(resource, "dispose"));

  pointer(domElement, "pointerdown");
  expect(orbitControls.enabled).toBe(false);
  gizmo.dispose();
  gizmo.dispose();

  expect(gizmo.group.parent).toBeNull();
  expect(gizmo.handleRoot.parent).toBeNull();
  expect(orbitControls.enabled).toBe(true);
  expect(domElement.releasePointerCapture).toHaveBeenCalledWith(7);
  for (const dispose of [...geometryDisposals, ...materialDisposals]) {
    expect(dispose).toHaveBeenCalledOnce();
  }

  pointer(domElement, "pointerdown");
  expect(pickHandle).toHaveBeenCalledOnce();
});
