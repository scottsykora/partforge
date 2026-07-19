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

const TRANSLATION_SCREEN_ALIGNMENT = 0.9;
const ROTATION_SCREEN_ALIGNMENT = 0.15;
// A 120 px perpendicular drag rotates the plane by 90 degrees.
const SCREEN_ROTATION_RADIANS_PER_PIXEL = Math.PI / 240;
const SCREEN_AXIS_EPSILON_SQ = 1e-8;
// Reserve the visually shared center for the end-on translation handle.
const TRANSLATE_CENTER_RADIUS_PX = 22;
const GIZMO_RENDER_ORDER = 3_000_000;

export function createCutawayGizmo({
  scene,
  camera,
  domElement,
  orbitControls,
  onPoseChange = () => {},
  onActivity = () => {},
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
      depthTest: true,
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
    depthTest: false,
    depthWrite: false,
  });
  const border = new THREE.LineLoop(borderGeometry, borderMaterial);
  border.renderOrder = GIZMO_RENDER_ORDER;
  geometries.add(borderGeometry);
  materials.add(borderMaterial);

  const handleRoot = new THREE.Group();
  const translateMaterial = new THREE.MeshBasicMaterial({
    color: 0x36d399,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const rotateXMaterial = new THREE.MeshBasicMaterial({
    color: 0xff6b7a,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const rotateYMaterial = new THREE.MeshBasicMaterial({
    color: 0x5aa9ff,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  materials.add(translateMaterial);
  materials.add(rotateXMaterial);
  materials.add(rotateYMaterial);

  const shaftGeometry = new THREE.CylinderGeometry(0.025, 0.025, 0.58, 12);
  const shaft = new THREE.Mesh(shaftGeometry, translateMaterial);
  shaft.renderOrder = GIZMO_RENDER_ORDER;
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = 0.29;
  const coneGeometry = new THREE.ConeGeometry(0.075, 0.2, 16);
  const cone = new THREE.Mesh(coneGeometry, translateMaterial);
  cone.renderOrder = GIZMO_RENDER_ORDER;
  cone.rotation.x = Math.PI / 2;
  cone.position.z = 0.68;
  geometries.add(shaftGeometry);
  geometries.add(coneGeometry);

  const ringXGeometry = new THREE.TorusGeometry(0.42, 0.015, 8, 64);
  const ringX = new THREE.Mesh(ringXGeometry, rotateXMaterial);
  ringX.renderOrder = GIZMO_RENDER_ORDER;
  ringX.rotation.y = Math.PI / 2;
  const ringYGeometry = new THREE.TorusGeometry(0.42, 0.015, 8, 64);
  const ringY = new THREE.Mesh(ringYGeometry, rotateYMaterial);
  ringY.renderOrder = GIZMO_RENDER_ORDER;
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
  const rotateXHitGeometry = new THREE.TorusGeometry(0.42, 0.12, 8, 48);
  const rotateXHit = new THREE.Mesh(rotateXHitGeometry, hitMaterial);
  rotateXHit.rotation.y = Math.PI / 2;
  rotateXHit.userData.cutawayHandle = "rotate-x";
  const rotateYHitGeometry = new THREE.TorusGeometry(0.42, 0.12, 8, 48);
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
    const center = projectToClient(group.position);
    if (center) {
      const dx = event.clientX - center.x;
      const dy = event.clientY - center.y;
      if (Number.isFinite(dx) && Number.isFinite(dy)
        && Math.hypot(dx, dy) <= TRANSLATE_CENTER_RADIUS_PX) {
        return "translate";
      }
    }
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

  function viewDirectionAt(position) {
    if (camera.isPerspectiveCamera) {
      const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
      const direction = position.clone().sub(cameraPosition);
      if (direction.lengthSq() > 1e-12) return direction.normalize();
    }
    return camera.getWorldDirection(new THREE.Vector3()).normalize();
  }

  function projectToClient(point) {
    const rect = domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const projected = point.clone().project(camera);
    if (![projected.x, projected.y, projected.z].every(Number.isFinite)) return null;
    if (projected.z < -1 || projected.z > 1) return null;
    const client = new THREE.Vector2(
      rect.left + (projected.x + 1) * 0.5 * rect.width,
      rect.top + (1 - projected.y) * 0.5 * rect.height,
    );
    return Number.isFinite(client.x) && Number.isFinite(client.y) ? client : null;
  }

  function screenRotationDirection(center, axis) {
    const centerClient = projectToClient(center);
    const axisClient = projectToClient(center.clone().add(axis));
    if (!centerClient || !axisClient) return null;
    const screenAxis = axisClient.sub(centerClient);
    if (screenAxis.lengthSq() < SCREEN_AXIS_EPSILON_SQ) return null;
    screenAxis.normalize();
    return new THREE.Vector2(-screenAxis.y, screenAxis.x);
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
    const viewDirection = viewDirectionAt(startPosition);
    const alignment = Math.abs(axis.dot(viewDirection));
    const nextDrag = {
      pointerId: event.pointerId,
      handle,
      orbitEnabled: orbitControls?.enabled,
      startPosition,
      startQuaternion,
      startClientX: event.clientX,
      startClientY: event.clientY,
      unitsPerPixel: worldUnitsPerPixelAt(startPosition),
      axis,
      mode: null,
      startParameter: null,
      rotationPlane: null,
      startRadial: null,
      screenRotationDirection: null,
    };

    if (handle === "translate") {
      nextDrag.startParameter = axisParameterFromRay(ray, startPosition, axis);
      nextDrag.mode = alignment > TRANSLATION_SCREEN_ALIGNMENT
        || nextDrag.startParameter == null
        ? "screen-translate"
        : "axis-translate";
    } else {
      const useScreenRotation = alignment < ROTATION_SCREEN_ALIGNMENT;
      if (!useScreenRotation) {
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis, startPosition);
        const point = ray.intersectPlane(plane, new THREE.Vector3());
        const radial = point?.sub(startPosition);
        if (radial && radial.lengthSq() >= 1e-12) {
          nextDrag.mode = "plane-rotate";
          nextDrag.rotationPlane = plane;
          nextDrag.startRadial = radial.normalize();
        }
      }
      if (nextDrag.mode !== "plane-rotate") {
        nextDrag.screenRotationDirection = screenRotationDirection(startPosition, axis);
        if (!nextDrag.screenRotationDirection) return;
        nextDrag.mode = "screen-rotate";
      }
    }

    onActivity();
    drag = nextDrag;
    if (orbitControls) orbitControls.enabled = false;
    safeCapture(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!disposed && group.visible) onActivity();
    if (!drag || event.pointerId !== drag.pointerId) return;
    const ray = rayFromEvent(event);
    if (!ray) return;

    if (drag.handle === "translate") {
      let delta;
      if (drag.mode === "screen-translate") {
        delta = (drag.startClientY - event.clientY) * drag.unitsPerPixel;
      } else {
        const parameter = axisParameterFromRay(ray, drag.startPosition, drag.axis);
        if (parameter == null) return;
        delta = parameter - drag.startParameter;
      }
      if (!Number.isFinite(delta)) return;
      group.position.copy(drag.startPosition).addScaledVector(drag.axis, delta);
      group.quaternion.copy(drag.startQuaternion);
      notifyPose();
      return;
    }

    if (drag.mode === "screen-rotate") {
      const pointerDelta = new THREE.Vector2(
        event.clientX - drag.startClientX,
        event.clientY - drag.startClientY,
      );
      const angle = pointerDelta.dot(drag.screenRotationDirection)
        * SCREEN_ROTATION_RADIANS_PER_PIXEL;
      if (!Number.isFinite(angle)) return;
      const delta = new THREE.Quaternion().setFromAxisAngle(drag.axis, angle);
      group.quaternion.copy(delta.multiply(drag.startQuaternion)).normalize();
      group.position.copy(drag.startPosition);
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

  function onPassiveActivity() {
    if (!disposed && group.visible) onActivity();
  }

  const listeners = [
    [domElement, "pointerdown", onPointerDown],
    [domElement, "pointermove", onPointerMove],
    [domElement, "pointerenter", onPassiveActivity],
    [domElement, "focus", onPassiveActivity],
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
    const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
    const depth = Math.max(
      Math.abs(position.clone().sub(cameraPosition).dot(forward)),
      camera.near || 1e-3,
    );
    const effectiveFov = camera.getEffectiveFOV();
    return 2 * depth
      * Math.tan(THREE.MathUtils.degToRad(effectiveFov) / 2)
      / height;
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
