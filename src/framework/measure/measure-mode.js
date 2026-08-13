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
import { createDragTracker } from "../selection/drag-tracker.js";
import { subPartReadKeys, RELEVANT_ALL } from "../param-deps.js";
import { classifyFeature, bboxSpec, unionBounds } from "./feature-dims.js";
import { linkParam } from "./param-link.js";
import { createPinStore, occurrenceOf } from "./pins.js";
import { layout } from "./dim-layout.js";
import { createDimOverlay } from "./dim-overlay.js";

const _v = new THREE.Vector3();

export function createMeasureMode(viewer, { part, getContext, revealParam, getParamsVersion, schedule = (cb) => requestAnimationFrame(cb) }) {
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
  // WeakMap: identity lookup only, and old geometries (with their typed
  // arrays) drop out on their own once no mesh references them anymore —
  // nothing here needs to clear it on detach.
  const specCache = new WeakMap(); // geometry -> Map(featureId -> spec|null)
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
  // `node` may be a sub-part mesh (for per-feature/pin specs, in the mesh's
  // own local frame) or the meshes' shared parent group (for the overall
  // spec, already composed with each mesh's local `.matrix`); either way we
  // apply its matrixWorld before projecting. `rect` is the canvas's client
  // rect for this pass: buildItems' callers measure it ONCE (not once per
  // projected point across every item) and thread it through; the fallback
  // keeps any stray caller (or a projector used outside a buildItems pass)
  // working.
  function projectorFor(node, rect) {
    return (p) => {
      _v.set(p[0], p[1], p[2]);
      if (node) _v.applyMatrix4(node.matrixWorld);
      _v.project(viewer.camera);
      const r = rect ?? viewer.domElement.getBoundingClientRect();
      return {
        x: ((_v.x + 1) / 2) * r.width,
        y: ((1 - _v.y) / 2) * r.height,
        behind: _v.z > 1,
      };
    };
  }

  const visibleMeshes = () => Object.entries(viewer._subMeshes)
    .filter(([, m]) => m.visible && m.geometry.getAttribute("position")?.count);

  // ---- param linking (scoped like selection/resolve.js scopeParams) --------
  // Memoize the per-sub-part read-key map: subPartReadKeys runs probe builds
  // (see mesh-cache.js's readsFor), so it must run once per (view, params)
  // change, not once per pinned item per frame. mount's getContext() returns
  // the SAME live params object every call (mutated in place on every edit),
  // so identity is stable across edits and can't key the memo the way
  // mesh-cache.js's paramsVersion getter does. mount hands in the SAME
  // late-bound version thunk it gives createMeshCache/createPoseFastPath
  // (`() => loop.version()`) so this keys on the cheap integer instead of
  // hashing the whole params object every call; a caller that omits it (or a
  // direct test) falls back to the content hash.
  let readsKey = null, readsMap = null;
  function readsFor(view, params) {
    const key = `${view}|${getParamsVersion ? getParamsVersion() : JSON.stringify(params)}`;
    if (readsKey !== key) {
      readsKey = key;
      try { readsMap = subPartReadKeys(part, view, params); } catch { readsMap = null; }
    }
    return readsMap;
  }
  function readKeysFor(subPart) {
    const { view, params } = getContext();
    const reads = readsFor(view, params);
    if (!reads) return Object.keys(params);
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

  // `rect` is the canvas's client rect for this pass, measured ONCE by the
  // caller (renderNow / onChipClick) rather than once per projected point
  // across every item — projectorFor falls back to measuring it itself when
  // omitted, so a stray caller still works.
  function buildItems(rect) {
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
    // Overall anchors are in the meshes' PARENT frame (bounds composed with
    // mesh.matrix above), so project through the parent's world transform —
    // in the live viewer that carries the pivot rotation + recentring.
    const parent = meshes[0][1].parent ?? null;
    items.push({ id: "overall", tier: "static", spec: bboxSpec(u.min, u.max), project: projectorFor(parent, rect) });
    const { view } = getContext();
    pins.list(view).forEach((key, i) => {
      const live = resolvePin(key, i);
      if (!live) return; // dormant
      const id = `pin:${key.subPart}:${key.featureLabel ?? "bbox"}:${key.occurrence}`;
      items.push({
        id, tier: "pinned", pinned: true, spec: live.spec, project: projectorFor(live.mesh, rect),
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
    prevLayout = layout(buildItems(rect), viewport, prevLayout);
    overlay.render(prevLayout, viewport);
  }

  // ---- frame dirty check ---------------------------------------------------
  let lastSig = "";
  // The parent (partsGroup) transform is deliberately NOT hashed here: every
  // frameTo call site also changes the camera or a mesh's visibility/geometry
  // (both already hashed below), so a parent-only transform change can't
  // currently happen unobserved. A future decoupling of those must add it.
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
    // geometry identity is part of the signature, so a regenerate lands here;
    // visibility (e.g. a cutaway/view toggle hiding the sub-part) is hashed
    // too but changes NOTHING else about the mesh, so the frameSig alone
    // can't tell "regenerated" from "still the same geometry, just hidden" —
    // check both explicitly. Either way the hovered mesh is no longer a
    // valid target: drop the stale hover (and its highlight) and re-render.
    const m = viewer._subMeshes[hover?.subPart];
    if (hover && (!m || !m.visible || hover.geometry !== m.geometry)) {
      hover = null;
      highlight.clear();
    }
    renderNow();
  });

  // ---- pointer handling (drag threshold: the click-picker idiom) -----------
  const drag = createDragTracker(); // same shared threshold as selection/pick.js
  let pendingMove = null;
  let moveScheduled = false;
  let suppressed = false; // cutaway gizmo drag in progress

  // Mirrors hover.js's own subscription: a cutaway handle drag takes over the
  // pointer, so drop any pending hover and stop reacting to moves until it lets go.
  const unsubscribeHandleHover = viewer.onCutawayHandleHover?.((handle) => {
    suppressed = handle != null;
    if (!suppressed) return;
    pendingMove = null;
    hover = null;
    highlight?.clear();
    renderNow();
  }) ?? (() => {});

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
    if (!enabled || ev.pointerType === "touch" || suppressed) return;
    drag.onMove(ev);
    pendingMove = { x: ev.clientX, y: ev.clientY };
    if (moveScheduled) return;
    moveScheduled = true;
    schedule(() => {
      moveScheduled = false;
      const p = pendingMove;
      pendingMove = null;
      if (!enabled || detached || !p || suppressed) return;
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
  const onLeave = (ev) => {
    if (overlay?.element.contains(ev.relatedTarget)) return; // into the overlay ≠ leaving
    hover = null; highlight?.clear(); renderNow();
  };

  function togglePin(key, paramName) {
    const { view } = getContext();
    const added = pins.toggle(view, key);
    if (added && paramName) revealParam?.(paramName);
    notifyPins();
    renderNow();
  }

  function onClick(ev) {
    const wasDragged = drag.consumeClick();
    if (!enabled || wasDragged) return;
    const hit = raycastViewer(viewer, ev.clientX, ev.clientY);
    if (!hit) return;
    const h = hitToHover(hit);
    togglePin(h.key, h.item.paramName);
  }

  // Chip click: the overlay hands back the STRUCTURED item id (never the
  // primitive's own dim id, which may itself contain colons if a
  // Solid.label() does — parsing that back into an item id would collide).
  // Pinned chips resolve by exact item-id equality; the hover chip pins
  // itself. buildItems() here measures its own rect once (same contract as
  // renderNow), independent of whatever pass last rendered.
  function onChipClick(itemId) {
    if (itemId === "hover") {
      if (hover) togglePin(hover.key, hover.item.paramName);
      return;
    }
    const rect = viewer.domElement.getBoundingClientRect();
    const pinItem = prevLayout && buildItems(rect).find((i) => i.id === itemId);
    if (pinItem?._key) togglePin(pinItem._key, null); // toggling off: no reveal
  }

  const dom = viewer.domElement;
  dom.addEventListener("pointermove", onMove);
  dom.addEventListener("pointerdown", drag.onDown);
  dom.addEventListener("pointerup", drag.onUp);
  dom.addEventListener("pointercancel", drag.onCancel);
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
      unsubscribeHandleHover();
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerdown", drag.onDown);
      dom.removeEventListener("pointerup", drag.onUp);
      dom.removeEventListener("pointercancel", drag.onCancel);
      dom.removeEventListener("pointerleave", onLeave);
      dom.removeEventListener("click", onClick);
      highlight?.dispose();
      overlay?.dispose();
      pinListeners.clear();
      modeListeners.clear();
    },
  };
}
