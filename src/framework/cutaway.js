import * as THREE from "three";

import { createCutawayGizmo } from "./cutaway-gizmo.js";
import {
  initialCutawayPose,
  planeFromPose,
  pointSurvivesPlane,
} from "./cutaway-math.js";
import { createSectionRenderSet } from "./cutaway-render.js";

const IDLE_DELAY_MS = 800;

function defaultSchedule(callback, delay) {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
}

function validBounds(getBounds) {
  try {
    const bounds = getBounds?.();
    return bounds?.isBox3 && !bounds.isEmpty() ? bounds : null;
  } catch {
    return null;
  }
}

export function createCutaway({
  renderer,
  scene,
  camera,
  orbitControls,
  domElement,
  getBounds,
  edgeColor,
  schedule = defaultSchedule,
}) {
  let supported = false;
  try {
    supported = Boolean(
      renderer.getContext().getContextAttributes().stencil,
    );
  } catch {
    supported = false;
  }

  const plane = new THREE.Plane();
  const planeNormal = new THREE.Vector3();
  const capGeometry = new THREE.PlaneGeometry(1, 1);
  const overlayScene = new THREE.Scene();
  const renderSets = new Map();
  const auxiliaryMaterials = new Map();
  let selectedNames = null;
  let nextOrder = 0;
  let enabled = false;
  let flipped = false;
  let theme = "dark";
  let hatchInk = edgeColor;
  let pose = null;
  let viewportSize = null;
  let cancelIdle = null;
  let previousLocalClippingEnabled;
  let disposed = false;

  function selected(name) {
    return selectedNames == null || selectedNames.has(name);
  }

  function applyCapPose(renderSet) {
    if (!pose) return;
    renderSet.setCapPose({
      position: pose.position,
      quaternion: pose.quaternion,
      size: pose.size,
    });
  }

  function cancelIdleFade() {
    if (!cancelIdle) return;
    cancelIdle();
    cancelIdle = null;
  }

  function showActive() {
    cancelIdleFade();
    gizmo.setActiveAppearance(true);
    const scheduled = schedule(() => {
      cancelIdle = null;
      if (enabled && !disposed) gizmo.setActiveAppearance(false);
    }, IDLE_DELAY_MS);
    cancelIdle = typeof scheduled === "function"
      ? scheduled
      : () => clearTimeout(scheduled);
  }

  function setMaterialClippingPlanes(material, clippingPlanes) {
    if (material.clippingPlanes === clippingPlanes) return;
    material.clippingPlanes = clippingPlanes;
    material.needsUpdate = true;
  }

  function syncAuxiliaryMaterial(material, entry) {
    if (enabled) {
      if (
        !Array.isArray(material.clippingPlanes)
        || material.clippingPlanes.length !== 1
        || material.clippingPlanes[0] !== plane
      ) {
        setMaterialClippingPlanes(material, [plane]);
      }
    } else {
      setMaterialClippingPlanes(material, entry.originalClippingPlanes);
    }
  }

  function syncAuxiliaryMaterials() {
    for (const [material, entry] of auxiliaryMaterials) {
      syncAuxiliaryMaterial(material, entry);
    }
  }

  function applyPose(nextPose, { resetFlip = false, activeAppearance = false } = {}) {
    pose = {
      position: nextPose.position.clone(),
      quaternion: nextPose.quaternion.clone(),
      size: nextPose.size,
    };
    if (resetFlip) flipped = false;
    planeFromPose(plane, planeNormal, pose.position, pose.quaternion, flipped);
    for (const { renderSet } of renderSets.values()) applyCapPose(renderSet);
    gizmo.setFlipped(flipped);
    gizmo.setPose(pose);
    if (activeAppearance) showActive();
  }

  function onPoseChange(nextPose) {
    if (!enabled || disposed) return;
    applyPose(nextPose, { activeAppearance: true });
  }

  const gizmo = createCutawayGizmo({
    scene,
    overlayScene,
    camera,
    domElement,
    orbitControls,
    onPoseChange,
    onActivity: showActive,
  });
  gizmo.setVisible(false);
  gizmo.setTheme(theme);

  function setSubpart(name, mesh, edgeLines) {
    if (disposed) return false;
    const previous = renderSets.get(name);
    const order = previous?.order ?? nextOrder++;
    previous?.renderSet.dispose();

    const renderSet = createSectionRenderSet({
      scene,
      mesh,
      edgeLines,
      plane,
      capGeometry,
      order,
      inkColor: hatchInk,
    });
    renderSets.set(name, { renderSet, mesh, edgeLines, order });
    if (viewportSize) {
      renderSet.setViewportSize(
        viewportSize.width,
        viewportSize.height,
        viewportSize.pixelRatio,
      );
    }
    applyCapPose(renderSet);
    renderSet.setVisible(enabled && selected(name));
    renderSet.setEnabled(enabled);
    return true;
  }

  function updateGeometry(name, geometry) {
    const entry = renderSets.get(name);
    if (!entry || disposed) return false;
    entry.renderSet.setGeometry(geometry);
    return true;
  }

  function setVisible(names) {
    if (disposed) return false;
    selectedNames = new Set(typeof names === "string" ? [names] : names ?? []);
    for (const [name, { renderSet }] of renderSets) {
      renderSet.setVisible(enabled && selected(name));
    }
    return true;
  }

  function disable() {
    cancelIdleFade();
    if (!enabled) return true;
    enabled = false;
    gizmo.setVisible(false);
    for (const { renderSet } of renderSets.values()) {
      renderSet.setVisible(false);
      renderSet.setEnabled(false);
    }
    syncAuxiliaryMaterials();
    renderer.localClippingEnabled = previousLocalClippingEnabled;
    previousLocalClippingEnabled = undefined;
    return true;
  }

  function setEnabled(on) {
    if (disposed) return false;
    if (!on) return disable();
    if (enabled) return true;
    if (!supported) return false;
    const bounds = validBounds(getBounds);
    if (!bounds) return false;

    const initialPose = initialCutawayPose(bounds, camera);
    previousLocalClippingEnabled = renderer.localClippingEnabled;
    enabled = true;
    flipped = false;
    applyPose(initialPose);
    renderer.localClippingEnabled = true;
    for (const [name, { renderSet }] of renderSets) {
      renderSet.setVisible(selected(name));
      renderSet.setEnabled(true);
    }
    syncAuxiliaryMaterials();
    gizmo.setVisible(true);
    gizmo.updateForCamera();
    showActive();
    return true;
  }

  function reset() {
    if (!enabled || disposed) return false;
    const bounds = validBounds(getBounds);
    if (!bounds) return false;
    applyPose(initialCutawayPose(bounds, camera), {
      resetFlip: true,
      activeAppearance: true,
    });
    return true;
  }

  function flip() {
    if (!enabled || disposed || !pose) return false;
    flipped = !flipped;
    planeFromPose(plane, planeNormal, pose.position, pose.quaternion, flipped);
    gizmo.setFlipped(flipped);
    showActive();
    return true;
  }

  function setTheme(mode, edgeColor) {
    if (disposed) return false;
    theme = mode;
    if (edgeColor != null) hatchInk = edgeColor;
    gizmo.setTheme(mode);
    for (const { renderSet } of renderSets.values()) {
      renderSet.refreshSourceMaterial();
      renderSet.setHatchInk(hatchInk);
    }
    return true;
  }

  function setViewportSize(width, height, pixelRatio = 1) {
    if (disposed) return false;
    viewportSize = { width, height, pixelRatio };
    for (const { renderSet } of renderSets.values()) {
      renderSet.setViewportSize(width, height, pixelRatio);
    }
    return true;
  }

  function isPointVisible(point) {
    return !enabled || pointSurvivesPlane(plane, point);
  }

  function registerClippableMaterial(material) {
    if (disposed || !material) return () => {};
    let entry = auxiliaryMaterials.get(material);
    if (entry) {
      entry.count += 1;
    } else {
      entry = {
        count: 1,
        originalClippingPlanes: material.clippingPlanes,
      };
      auxiliaryMaterials.set(material, entry);
    }
    syncAuxiliaryMaterial(material, entry);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      const current = auxiliaryMaterials.get(material);
      if (!current) return;
      current.count -= 1;
      if (current.count > 0) {
        return;
      }
      auxiliaryMaterials.delete(material);
      setMaterialClippingPlanes(material, current.originalClippingPlanes);
    };
  }

  function updateForCamera() {
    if (enabled && !disposed) gizmo.updateForCamera();
  }

  function renderOverlay(targetRenderer, targetCamera) {
    if (!enabled || disposed) return false;
    const previousAutoClear = targetRenderer.autoClear;
    try {
      targetRenderer.autoClear = false;
      targetRenderer.clearDepth();
      targetRenderer.render(overlayScene, targetCamera);
    } finally {
      targetRenderer.autoClear = previousAutoClear;
    }
    return true;
  }

  function dispose() {
    if (disposed) return;
    disable();
    disposed = true;
    for (const { renderSet } of renderSets.values()) renderSet.dispose();
    renderSets.clear();
    auxiliaryMaterials.clear();
    gizmo.dispose();
    overlayScene.clear();
    capGeometry.dispose();
  }

  return {
    get isSupported() { return supported; },
    get isEnabled() { return enabled; },
    setSubpart,
    updateGeometry,
    setVisible,
    setEnabled,
    reset,
    flip,
    setTheme,
    setViewportSize,
    isPointVisible,
    registerClippableMaterial,
    updateForCamera,
    renderOverlay,
    dispose,
  };
}
