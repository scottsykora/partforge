import * as THREE from "three";
import {
  axisParameterFromRay,
  signedAngleAroundAxis,
} from "./cutaway-math.js";

const THEMES = {
  dark: {
    fill: 0x65bff5,
    border: 0xa8dcff,
    translate: 0x36d399,
    rotateX: 0xff6b7a,
    rotateY: 0x5aa9ff,
  },
  light: {
    fill: 0x1479b8,
    border: 0x075985,
    translate: 0x087f5b,
    rotateX: 0xc92a3b,
    rotateY: 0x1769aa,
  },
};

export function createCutawayGizmo({
  scene,
  camera,
  domElement,
  orbitControls,
  onPoseChange = () => {},
  pickHandle,
}) {
  const group = new THREE.Group();
  const geometries = new Set();
  const materials = new Set();

  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: 0x65bff5,
      opacity: 0.18,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  geometries.add(fill.geometry);
  materials.add(fill.material);

  const borderGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-0.5, -0.5, 0),
    new THREE.Vector3(0.5, -0.5, 0),
    new THREE.Vector3(0.5, 0.5, 0),
    new THREE.Vector3(-0.5, 0.5, 0),
  ]);
  const borderMaterial = new THREE.LineBasicMaterial({
    color: 0xa8dcff,
    opacity: 1,
    transparent: true,
  });
  const border = new THREE.LineLoop(borderGeometry, borderMaterial);
  geometries.add(borderGeometry);
  materials.add(borderMaterial);

  const handleRoot = new THREE.Group();
  const translateMaterial = new THREE.MeshBasicMaterial({ color: 0x36d399 });
  const rotateXMaterial = new THREE.MeshBasicMaterial({ color: 0xff6b7a });
  const rotateYMaterial = new THREE.MeshBasicMaterial({ color: 0x5aa9ff });
  materials.add(translateMaterial);
  materials.add(rotateXMaterial);
  materials.add(rotateYMaterial);

  const shaftGeometry = new THREE.CylinderGeometry(0.025, 0.025, 0.58, 12);
  const shaft = new THREE.Mesh(shaftGeometry, translateMaterial);
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = 0.29;
  const coneGeometry = new THREE.ConeGeometry(0.075, 0.2, 16);
  const cone = new THREE.Mesh(coneGeometry, translateMaterial);
  cone.rotation.x = Math.PI / 2;
  cone.position.z = 0.68;
  geometries.add(shaftGeometry);
  geometries.add(coneGeometry);

  const ringXGeometry = new THREE.TorusGeometry(0.42, 0.015, 8, 64);
  const ringX = new THREE.Mesh(ringXGeometry, rotateXMaterial);
  ringX.rotation.y = Math.PI / 2;
  const ringYGeometry = new THREE.TorusGeometry(0.42, 0.015, 8, 64);
  const ringY = new THREE.Mesh(ringYGeometry, rotateYMaterial);
  ringY.rotation.x = Math.PI / 2;
  geometries.add(ringXGeometry);
  geometries.add(ringYGeometry);

  const hitMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    opacity: 0,
    transparent: true,
    depthWrite: false,
  });
  materials.add(hitMaterial);
  const translateHitGeometry = new THREE.CylinderGeometry(0.1, 0.1, 0.95, 10);
  const translateHit = new THREE.Mesh(translateHitGeometry, hitMaterial);
  translateHit.rotation.x = Math.PI / 2;
  translateHit.position.z = 0.38;
  translateHit.userData.cutawayHandle = "translate";
  const rotateXHitGeometry = new THREE.TorusGeometry(0.42, 0.07, 8, 48);
  const rotateXHit = new THREE.Mesh(rotateXHitGeometry, hitMaterial);
  rotateXHit.rotation.y = Math.PI / 2;
  rotateXHit.userData.cutawayHandle = "rotate-x";
  const rotateYHitGeometry = new THREE.TorusGeometry(0.42, 0.07, 8, 48);
  const rotateYHit = new THREE.Mesh(rotateYHitGeometry, hitMaterial);
  rotateYHit.rotation.x = Math.PI / 2;
  rotateYHit.userData.cutawayHandle = "rotate-y";
  geometries.add(translateHitGeometry);
  geometries.add(rotateXHitGeometry);
  geometries.add(rotateYHitGeometry);

  handleRoot.add(
    shaft,
    cone,
    ringX,
    ringY,
    translateHit,
    rotateXHit,
    rotateYHit,
  );
  group.add(fill, border, handleRoot);
  scene.add(group);

  const handles = {
    translate: translateHit,
    rotateX: rotateXHit,
    rotateY: rotateYHit,
  };

  let disposed = false;
  let poseSize = 1;
  let drag = null;
  const raycaster = new THREE.Raycaster();
  const hitProxies = Object.values(handles);

  function rayFromEvent(event) {
    const rect = domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    raycaster.setFromCamera({
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
    }, camera);
    return raycaster.ray;
  }

  function resolveHandle(picked) {
    if (typeof picked === "string") return picked;
    const object = picked?.object ?? picked;
    return object?.userData?.cutawayHandle ?? null;
  }

  function pick(event, ray) {
    if (pickHandle) return resolveHandle(pickHandle(event, handles, ray));
    group.updateWorldMatrix(true, true);
    const intersection = raycaster.intersectObjects(hitProxies, false)[0];
    return resolveHandle(intersection);
  }

  function safeCapture(pointerId) {
    try {
      domElement.setPointerCapture?.(pointerId);
    } catch {
      // Capture can fail when the browser has already ended the pointer.
    }
  }

  function safeRelease(pointerId) {
    try {
      domElement.releasePointerCapture?.(pointerId);
    } catch {
      // Releasing a pointer that was already lost is harmless.
    }
  }

  function endDrag() {
    if (!drag) return;
    const ending = drag;
    drag = null;
    if (orbitControls) orbitControls.enabled = ending.orbitEnabled;
    safeRelease(ending.pointerId);
  }

  function notifyPose() {
    onPoseChange({
      position: group.position.clone(),
      quaternion: group.quaternion.clone(),
      size: poseSize,
    });
  }

  function onPointerDown(event) {
    if (disposed || drag || !group.visible || (event.button != null && event.button !== 0)) return;
    const ray = rayFromEvent(event);
    if (!ray) return;
    const handle = pick(event, ray);
    if (!handle) return;

    const startPosition = group.position.clone();
    const startQuaternion = group.quaternion.clone();
    const localAxis = handle === "rotate-x"
      ? new THREE.Vector3(1, 0, 0)
      : handle === "rotate-y"
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(0, 0, 1);
    const axis = localAxis.applyQuaternion(startQuaternion).normalize();
    const nextDrag = {
      pointerId: event.pointerId,
      handle,
      orbitEnabled: orbitControls?.enabled,
      startPosition,
      startQuaternion,
      startClientY: event.clientY,
      unitsPerPixel: worldUnitsPerPixelAt(startPosition),
      axis,
      startParameter: null,
      rotationPlane: null,
      startRadial: null,
    };

    if (handle === "translate") {
      nextDrag.startParameter = axisParameterFromRay(ray, startPosition, axis);
    } else {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis, startPosition);
      const point = ray.intersectPlane(plane, new THREE.Vector3());
      if (!point) return;
      const radial = point.sub(startPosition);
      if (radial.lengthSq() < 1e-12) return;
      nextDrag.rotationPlane = plane;
      nextDrag.startRadial = radial.normalize();
    }

    drag = nextDrag;
    if (orbitControls) orbitControls.enabled = false;
    safeCapture(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const ray = rayFromEvent(event);
    if (!ray) return;

    if (drag.handle === "translate") {
      const parameter = axisParameterFromRay(ray, drag.startPosition, drag.axis);
      const delta = drag.startParameter != null && parameter != null
        ? parameter - drag.startParameter
        : (drag.startClientY - event.clientY) * drag.unitsPerPixel;
      if (!Number.isFinite(delta)) return;
      group.position.copy(drag.startPosition).addScaledVector(drag.axis, delta);
      group.quaternion.copy(drag.startQuaternion);
      notifyPose();
      return;
    }

    const point = ray.intersectPlane(drag.rotationPlane, new THREE.Vector3());
    if (!point) return;
    const radial = point.sub(drag.startPosition);
    if (radial.lengthSq() < 1e-12) return;
    radial.normalize();
    const angle = signedAngleAroundAxis(drag.startRadial, radial, drag.axis);
    if (!Number.isFinite(angle)) return;
    const delta = new THREE.Quaternion().setFromAxisAngle(drag.axis, angle);
    group.quaternion.copy(delta.multiply(drag.startQuaternion)).normalize();
    group.position.copy(drag.startPosition);
    notifyPose();
  }

  function onPointerEnd(event) {
    if (!drag || (event.pointerId != null && event.pointerId !== drag.pointerId)) return;
    endDrag();
  }

  const listeners = [
    [domElement, "pointerdown", onPointerDown],
    [domElement, "pointermove", onPointerMove],
    [domElement, "pointerup", onPointerEnd],
    [domElement, "pointercancel", onPointerEnd],
    [domElement, "lostpointercapture", onPointerEnd],
    [domElement, "pointerleave", onPointerEnd],
    [window, "blur", onPointerEnd],
  ];
  for (const [target, type, listener] of listeners) {
    target.addEventListener(type, listener);
  }

  function setPose({ position, quaternion, size }) {
    group.position.copy(position);
    group.quaternion.copy(quaternion);
    poseSize = size;
    fill.scale.setScalar(size);
    border.scale.setScalar(size);
    handleRoot.scale.setScalar(size * 0.15);
  }

  function setVisible(on) {
    if (!on) endDrag();
    group.visible = Boolean(on);
  }

  function setActiveAppearance(active) {
    fill.material.opacity = active ? 0.18 : 0.055;
    borderMaterial.opacity = active ? 1 : 0.72;
    for (const material of [translateMaterial, rotateXMaterial, rotateYMaterial]) {
      material.transparent = true;
      material.opacity = active ? 1 : 0.48;
    }
  }

  function setTheme(mode) {
    const theme = THEMES[mode] ?? THEMES.dark;
    fill.material.color.set(theme.fill);
    borderMaterial.color.set(theme.border);
    translateMaterial.color.set(theme.translate);
    rotateXMaterial.color.set(theme.rotateX);
    rotateYMaterial.color.set(theme.rotateY);
  }

  function worldUnitsPerPixelAt(position) {
    const height = Math.max(domElement.getBoundingClientRect().height, 1);
    if (camera.isOrthographicCamera) {
      return Math.abs(camera.top - camera.bottom) / Math.max(camera.zoom, 1e-6) / height;
    }
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const depth = Math.max(
      Math.abs(position.clone().sub(camera.position).dot(forward)),
      camera.near || 1e-3,
    );
    return 2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / height;
  }

  function updateForCamera() {
    if (disposed) return;
    const screenScale = worldUnitsPerPixelAt(group.position) * 72;
    handleRoot.scale.setScalar(THREE.MathUtils.clamp(
      screenScale,
      poseSize * 0.06,
      poseSize * 0.55,
    ));
  }

  function dispose() {
    if (disposed) return;
    endDrag();
    disposed = true;
    for (const [target, type, listener] of listeners) {
      target.removeEventListener(type, listener);
    }
    scene.remove(group);
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  }

  return {
    group,
    fill,
    border,
    handles,
    handleRoot,
    setPose,
    setVisible,
    setActiveAppearance,
    setTheme,
    updateForCamera,
    dispose,
  };
}
