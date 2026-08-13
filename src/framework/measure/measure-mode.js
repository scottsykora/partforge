// Measurement-mode orchestrator: the one measure module that touches both
// three.js and the DOM. Owns mode state and drives the pipeline
//   raycast hit -> feature-dims spec -> param-link -> dim-layout -> dim-overlay
// per frame with a dirty check (camera, mesh matrices, geometry identity), so
// dims ride orbits, the pose fast path, and animations, and re-anchor across
// regenerates. Pins live in the pure pin store, per view, and survive mode
// toggles; `Clear` (chrome) is the only thing that empties them.
import * as THREE from "three";
import { raycastViewer } from "../selection/raycast.js";
import { createFeatureHighlight } from "../selection/feature-highlight.js";
import { subPartReadKeys, RELEVANT_ALL } from "../param-deps.js";
import { classifyFeature, bboxSpec, unionBounds } from "./feature-dims.js";
import { linkParam } from "./param-link.js";
import { createPinStore, occurrenceOf } from "./pins.js";
import { layout } from "./dim-layout.js";
import { createDimOverlay } from "./dim-overlay.js";

const DRAG_THRESHOLD_SQUARED = 5 ** 2; // px of pointer travel that means "orbit"
const _v = new THREE.Vector3();

export function createMeasureMode(viewer, { part, getContext, revealParam, schedule = (cb) => requestAnimationFrame(cb) }) {
  const pins = createPinStore();
  const pinListeners = new Set();
  const notifyPins = () => { for (const cb of [...pinListeners]) cb(); };
  const modeListeners = new Set();
  const notifyMode = () => { for (const cb of [...modeListeners]) cb(); };

  let enabled = false;
  let overlay = null;          // created on first enable, kept across toggles
  let highlight = null;
  let hover = null;            // { item, key } for the currently hovered spec
  let prevLayout = null;
  let detached = false;

  // ---- spec cache: (geometry instance, featureId) -> core spec -------------
  const specCache = new Map(); // geometry -> Map(featureId -> spec|null)
  function featureSpec(mesh, featureId) {
    let byId = specCache.get(mesh.geometry);
    if (!byId) { byId = new Map(); specCache.set(mesh.geometry, byId); }
    if (!byId.has(featureId)) {
      const { featureIds } = mesh.geometry.userData;
      const positions = mesh.geometry.getAttribute("position").array;
      const indices = mesh.geometry.getIndex()?.array;
      byId.set(featureId, featureIds
        ? classifyFeature({ positions, indices, featureIds }, featureId)
        : null);
    }
    return byId.get(featureId);
  }

  // ---- projection: geometry-frame point -> CSS px in the canvas ------------
  function projectorFor(mesh) {
    return (p) => {
      _v.set(p[0], p[1], p[2]);
      if (mesh) _v.applyMatrix4(mesh.matrixWorld);
      _v.project(viewer.camera);
      const rect = viewer.domElement.getBoundingClientRect();
      return {
        x: ((_v.x + 1) / 2) * rect.width,
        y: ((1 - _v.y) / 2) * rect.height,
        behind: _v.z > 1,
      };
    };
  }

  const visibleMeshes = () => Object.entries(viewer._subMeshes)
    .filter(([, m]) => m.visible && m.geometry.getAttribute("position")?.count);

  // ---- param linking (scoped like selection/resolve.js scopeParams) --------
  function readKeysFor(subPart) {
    const { view, params } = getContext();
    let reads;
    try { reads = subPartReadKeys(part, view, params); } catch { return Object.keys(getContext().params); }
    return reads === RELEVANT_ALL
      ? Object.keys(params)
      : [...(reads.get(subPart) ?? Object.keys(params))];
  }
  const linkFor = (subPart, spec) =>
    spec ? linkParam(readKeysFor(subPart), getContext().params, spec.values) : null;

  // ---- pin resolution: stable key -> a live layout item --------------------
  function resolvePin(key, index) {
    const mesh = viewer._subMeshes[key.subPart];
    if (!mesh || !mesh.visible) return null;
    if (key.featureLabel == null) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const { min, max } = mesh.geometry.boundingBox;
      return { spec: bboxSpec([min.x, min.y, min.z], [max.x, max.y, max.z]), mesh };
    }
    const { features = [], featureIds } = mesh.geometry.userData;
    if (!featureIds) return null;
    // find the (occurrence+1)-th feature id carrying this label — dormant when gone
    let seen = 0;
    for (let i = 0; i < features.length; i++) {
      if (features[i] !== key.featureLabel) continue;
      if (seen === key.occurrence) {
        const spec = featureSpec(mesh, i + 1);
        return spec ? { spec, mesh } : null;
      }
      seen++;
    }
    return null;
  }

  function buildItems() {
    const items = [];
    const meshes = visibleMeshes();
    if (meshes.length === 0) return items;
    // always-on overall bounds (posed, like viewer.frameTo)
    const boundsList = meshes.map(([, m]) => {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox.clone().applyMatrix4(m.matrix);
      return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
    });
    const u = unionBounds(boundsList);
    // overall anchors are in the shared (posed-mesh-local == parent) frame;
    // project through the first mesh's PARENT transform via a null-mesh projector
    items.push({ id: "overall", tier: "static", spec: bboxSpec(u.min, u.max), project: projectorFor(null) });
    const { view } = getContext();
    pins.list(view).forEach((key, i) => {
      const live = resolvePin(key, i);
      if (!live) return; // dormant
      const id = `pin:${key.subPart}:${key.featureLabel ?? "bbox"}:${key.occurrence}`;
      items.push({
        id, tier: "pinned", pinned: true, spec: live.spec, project: projectorFor(live.mesh),
        paramName: linkFor(key.subPart, live.spec), _key: key,
      });
    });
    if (hover) items.push(hover.item);
    return items;
  }

  function renderNow() {
    if (!enabled || !overlay) return;
    const rect = viewer.domElement.getBoundingClientRect();
    const viewport = { width: rect.width, height: rect.height };
    prevLayout = layout(buildItems(), viewport, prevLayout);
    overlay.render(prevLayout, viewport);
  }

  // ---- frame dirty check ---------------------------------------------------
  let lastSig = "";
  function frameSig() {
    const e = viewer.camera.matrixWorld.elements;
    let sig = `${e[0]},${e[5]},${e[10]},${e[12]},${e[13]},${e[14]},${viewer.camera.projectionMatrix.elements[0]}`;
    for (const [name, m] of Object.entries(viewer._subMeshes)) {
      sig += `|${name}:${m.visible ? 1 : 0}:${m.geometry.id}:${m.matrix.elements[12]},${m.matrix.elements[13]},${m.matrix.elements[14]},${m.matrix.elements[0]},${m.matrix.elements[5]}`;
    }
    return sig;
  }
  const offFrame = viewer.onFrame(() => {
    if (!enabled) return;
    const sig = frameSig();
    if (sig === lastSig) return;
    lastSig = sig;
    // geometry identity is part of the signature, so a regenerate lands here:
    // drop stale hover (its mesh geometry may be gone) and re-render
    if (hover && hover.geometry !== viewer._subMeshes[hover.subPart]?.geometry) hover = null;
    renderNow();
  });

  // ---- pointer handling (drag threshold: the click-picker idiom) -----------
  const pointerStarts = new Map();
  let dragged = false;
  let pendingMove = null;
  let moveScheduled = false;

  function hitToHover(hit) {
    let spec, key;
    if (hit.feature) {
      spec = featureSpec(hit.mesh, hit.feature.id);
      const { features } = hit.mesh.geometry.userData;
      key = { subPart: hit.subPart, featureLabel: hit.feature.label,
        occurrence: occurrenceOf(features, hit.feature.id) };
    }
    if (!spec) {
      if (!hit.mesh.geometry.boundingBox) hit.mesh.geometry.computeBoundingBox();
      const { min, max } = hit.mesh.geometry.boundingBox;
      spec = bboxSpec([min.x, min.y, min.z], [max.x, max.y, max.z]);
      key = { subPart: hit.subPart, featureLabel: null, occurrence: 0 };
    }
    return {
      key,
      geometry: hit.mesh.geometry,
      subPart: hit.subPart,
      item: {
        id: "hover", tier: "hover", spec, project: projectorFor(hit.mesh),
        paramName: linkFor(hit.subPart, spec),
      },
    };
  }

  function onMove(ev) {
    if (!enabled || ev.pointerType === "touch") return;
    const start = pointerStarts.get(ev.pointerId);
    if (start && !dragged) {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      dragged = dx * dx + dy * dy > DRAG_THRESHOLD_SQUARED;
    }
    pendingMove = { x: ev.clientX, y: ev.clientY };
    if (moveScheduled) return;
    moveScheduled = true;
    schedule(() => {
      moveScheduled = false;
      const p = pendingMove;
      pendingMove = null;
      if (!enabled || detached || !p) return;
      const hit = raycastViewer(viewer, p.x, p.y);
      if (hit) {
        hover = hitToHover(hit);
        highlight.show(hit);
      } else {
        hover = null;
        highlight.clear();
      }
      renderNow();
    });
  }
  const onDown = (ev) => {
    if (pointerStarts.size === 0) dragged = false;
    pointerStarts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  };
  const onUp = (ev) => pointerStarts.delete(ev.pointerId);
  const onCancel = (ev) => { pointerStarts.delete(ev.pointerId); if (pointerStarts.size === 0) dragged = false; };
  const onLeave = () => { hover = null; highlight?.clear(); renderNow(); };

  function togglePin(key, paramName) {
    const { view } = getContext();
    const added = pins.toggle(view, key);
    if (added && paramName) revealParam?.(paramName);
    notifyPins();
    renderNow();
  }

  function onClick(ev) {
    const wasDragged = dragged;
    pointerStarts.clear();
    dragged = false;
    if (!enabled || wasDragged) return;
    const hit = raycastViewer(viewer, ev.clientX, ev.clientY);
    if (!hit) return;
    const h = hitToHover(hit);
    togglePin(h.key, h.item.paramName);
  }

  // chip click: pinned chips carry their stable key; the hover chip pins itself
  function onChipClick(labelId) {
    if (labelId.startsWith("hover")) {
      if (hover) togglePin(hover.key, hover.item.paramName);
      return;
    }
    const pinItem = prevLayout && buildItems().find((i) => labelId.startsWith(i.id));
    if (pinItem?._key) togglePin(pinItem._key, null); // toggling off: no reveal
  }

  const dom = viewer.domElement;
  dom.addEventListener("pointermove", onMove);
  dom.addEventListener("pointerdown", onDown);
  dom.addEventListener("pointerup", onUp);
  dom.addEventListener("pointercancel", onCancel);
  dom.addEventListener("pointerleave", onLeave);
  dom.addEventListener("click", onClick);

  function setEnabled(on) {
    if (detached || on === enabled) return;
    enabled = !!on;
    if (enabled) {
      // overlay lives in the canvas's positioned ancestor (the stage)
      overlay ??= createDimOverlay(viewer.stageElement ?? dom.parentElement, { onChipClick });
      highlight ??= createFeatureHighlight(viewer);
      overlay.setVisible(true);
      lastSig = "";
      renderNow();
    } else {
      hover = null;
      highlight?.clear();
      overlay?.setVisible(false);
      overlay?.clear();
      prevLayout = null;
    }
    notifyMode();
  }

  return {
    setEnabled,
    isEnabled: () => enabled,
    clearPins() {
      pins.clear(getContext().view);
      notifyPins();
      renderNow();
    },
    pinCount: () => pins.count(getContext().view),
    onPinsChange: (cb) => { pinListeners.add(cb); return () => pinListeners.delete(cb); },
    onModeChange: (cb) => { modeListeners.add(cb); return () => modeListeners.delete(cb); },
    getOverlaySvg: () => (enabled && overlay ? overlay.element : null),
    detach() {
      if (detached) return;
      detached = true;
      enabled = false;
      offFrame();
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointerup", onUp);
      dom.removeEventListener("pointercancel", onCancel);
      dom.removeEventListener("pointerleave", onLeave);
      dom.removeEventListener("click", onClick);
      highlight?.dispose();
      overlay?.dispose();
      specCache.clear();
      pinListeners.clear();
      modeListeners.clear();
    },
  };
}
