// Measurement-mode orchestrator: the one measure module that touches both
// three.js and the DOM. Owns mode state and drives the pipeline
//   raycast hit -> feature-dims spec -> param-link -> dim3-place -> dim3-scene
// with a per-frame dirty check. Dimensions are real scene objects parented
// under the meshes' shared group, so they ride the pivot rotation, the pose
// fast path and animations for free; the frame loop only has to notice mesh
// regenerates/visibility flips (rebuild) and camera moves that flip a side
// choice (re-score, rebuild only if a choice actually changed). Pins live in
// the pure pin store, per view, and survive mode toggles; `Clear` (chrome) is
// the only thing that empties them.
import * as THREE from "three";
import { raycastViewer } from "../selection/raycast.js";
import { createFeatureHighlight } from "../selection/feature-highlight.js";
import { createDragTracker } from "../selection/drag-tracker.js";
import { subPartReadKeys, RELEVANT_ALL } from "../param-deps.js";
import { classifyFeature, bboxSpec, unionBounds } from "./feature-dims.js";
import { linkParam } from "./param-link.js";
import { createPinStore, occurrenceOf } from "./pins.js";
import { evaluateChoices, choicesEqual, placeDims } from "./dim3-place.js";
import { createDimScene } from "./dim3-scene.js";

export function createMeasureMode(viewer, { part, getContext, revealParam, getParamsVersion, schedule = (cb) => requestAnimationFrame(cb) }) {
  const pins = createPinStore();
  const pinListeners = new Set();
  const notifyPins = () => { for (const cb of [...pinListeners]) cb(); };
  const modeListeners = new Set();
  const notifyMode = () => { for (const cb of [...modeListeners]) cb(); };

  let enabled = false;
  let scene = null;            // created on first enable, kept across toggles
  let highlight = null;
  let hover = null;            // { item, key } for the currently hovered spec
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

  // ---- spec frames ---------------------------------------------------------
  // Feature/bbox specs come out of classifyFeature in the MESH's own geometry
  // frame; dim3-place works entirely in the PARTS frame (the meshes' shared
  // parent), so compose the mesh's local matrix — which carries the viewer's
  // fast-path pose — into every anchor before handing a spec over.
  const _m3 = new THREE.Matrix3();
  const _tv = new THREE.Vector3();
  function transformSpec(spec, matrix) {
    // identity fast path: poses are identity outside animations
    if (matrix.determinant() === 1 && matrix.elements[12] === 0 && matrix.elements[13] === 0
        && matrix.elements[14] === 0 && matrix.elements[0] === 1 && matrix.elements[5] === 1
        && matrix.elements[10] === 1) return spec;
    const pt = (p) => _tv.set(p[0], p[1], p[2]).applyMatrix4(matrix).toArray();
    const dir = (d) => _tv.set(d[0], d[1], d[2]).applyMatrix3(_m3.setFromMatrix4(matrix)).normalize().toArray();
    if (spec.kind === "plane") {
      return { ...spec, anchors: {
        width: { a: pt(spec.anchors.width.a), b: pt(spec.anchors.width.b) },
        height: { a: pt(spec.anchors.height.a), b: pt(spec.anchors.height.b) },
        normal: dir(spec.anchors.normal),
      } };
    }
    if (spec.kind === "cylinder") {
      return { ...spec, anchors: {
        center: pt(spec.anchors.center), axis: dir(spec.anchors.axis),
        top: pt(spec.anchors.top), bottom: pt(spec.anchors.bottom),
        rimDir: spec.anchors.rimDir ? dir(spec.anchors.rimDir) : undefined,
      } };
    }
    if (spec.kind === "bbox") {
      const b = new THREE.Box3(
        new THREE.Vector3(...spec.anchors.min), new THREE.Vector3(...spec.anchors.max),
      ).applyMatrix4(matrix); // AABB of the posed box, same as viewer.frameTo
      return bboxSpec(b.min.toArray(), b.max.toArray());
    }
    return spec;
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

  // ---- pin resolution: stable key -> a live spec + its mesh ----------------
  function resolvePin(key) {
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

  // Items handed to dim3-place: every spec already in the parts frame, and
  // `meshes` indexing into the meshData built alongside (so a feature dim
  // scans only its own sub-part). `_key` rides along for un-pinning by label
  // pick; dim3-place ignores unknown fields.
  function buildItems() {
    const items = [];
    const meshes = visibleMeshes();
    if (meshes.length === 0) return { items, meshes };
    // always-on overall bounds (posed, like viewer.frameTo)
    const boundsList = meshes.map(([, m]) => {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox.clone().applyMatrix4(m.matrix);
      return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
    });
    const u = unionBounds(boundsList);
    items.push({
      id: "overall", tier: "static", spec: bboxSpec(u.min, u.max),
      meshes: meshes.map((_, i) => i),
    });
    const { view } = getContext();
    pins.list(view).forEach((key) => {
      const live = resolvePin(key);
      if (!live) return; // dormant
      const meshIndex = meshes.findIndex(([n]) => n === key.subPart);
      items.push({
        id: `pin:${key.subPart}:${key.featureLabel ?? "bbox"}:${key.occurrence}`,
        tier: "pinned", pinned: true,
        spec: transformSpec(live.spec, live.mesh.matrix),
        meshes: meshIndex >= 0 ? [meshIndex] : [],
        paramName: linkFor(key.subPart, live.spec), _key: key,
      });
    });
    if (hover) {
      const meshIndex = meshes.findIndex(([n]) => n === hover.subPart);
      items.push({
        ...hover.item,
        spec: transformSpec(hover.item.spec, hover.mesh.matrix),
        meshes: meshIndex >= 0 ? [meshIndex] : [],
      });
    }
    return { items, meshes, bounds: u };
  }

  // ---- placement environment + rebuild -------------------------------------
  let choices = {};
  let lastItems = [];          // for label-pick resolution + cheap re-scoring
  let lastBounds = null;
  const _rc = new THREE.Raycaster();
  const _origin = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _camLocal = new THREE.Vector3();

  function partsParent(meshes) { return meshes[0]?.[1].parent ?? null; }

  // Everything dim3-place needs from the live scene, expressed in the parts
  // frame: raw vertex arrays + their pose matrices, a surface raycast (parts
  // frame in, parts frame out) and the camera position.
  function buildEnv(meshes) {
    const parent = partsParent(meshes);
    parent?.updateWorldMatrix(true, false);
    const meshData = meshes.map(([, m]) => ({
      positions: m.geometry.getAttribute("position").array,
      matrix: m.matrix,
    }));
    const hittable = meshes.map(([, m]) => m);
    for (const m of hittable) m.updateWorldMatrix(true, false);
    const surfaceHit = (origin, dir) => {
      if (!parent) return null;
      _origin.copy(origin).applyMatrix4(parent.matrixWorld);
      _dir.copy(dir).transformDirection(parent.matrixWorld);
      _rc.set(_origin, _dir);
      const hit = _rc.intersectObjects(hittable, false)[0];
      return hit ? parent.worldToLocal(hit.point.clone()) : null;
    };
    const camPos = parent
      ? _camLocal.copy(viewer.camera.position).applyMatrix4(parent.matrixWorld.clone().invert()).toArray()
      : viewer.camera.position.toArray();
    return { meshData, surfaceHit, camPos };
  }

  const centerOf = (bounds) => [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];

  function rebuild() {
    if (!enabled || !scene) return;
    const { items, meshes, bounds } = buildItems();
    lastItems = items;
    lastBounds = bounds ?? null;
    if (!items.length || !bounds) { scene.clear(); return; }
    const env = buildEnv(meshes);
    choices = evaluateChoices(items, { camPos: env.camPos, center: centerOf(bounds), prev: choices });
    scene.update(placeDims(items, { meshData: env.meshData, surfaceHit: env.surfaceHit, bounds }, choices));
  }

  // ---- frame dirty check ---------------------------------------------------
  // The camera is deliberately NOT part of the signature: the dims live in the
  // scene, so an orbit re-renders them for free. All a camera move can change
  // is WHICH side each dim is drawn on — cheap to re-score every frame
  // (dot products + hysteresis), and only a genuine flip costs a rebuild.
  let lastSig = "";
  function meshSig() {
    let sig = "";
    for (const [name, m] of Object.entries(viewer._subMeshes)) {
      sig += `|${name}:${m.visible ? 1 : 0}:${m.geometry.id}:${m.matrix.elements[12]},${m.matrix.elements[13]},${m.matrix.elements[14]},${m.matrix.elements[0]},${m.matrix.elements[5]}`;
    }
    return sig;
  }
  const offFrame = viewer.onFrame(() => {
    if (!enabled || !scene) return;
    const sig = meshSig();
    if (sig !== lastSig) {
      lastSig = sig;
      // geometry identity is part of the signature, so a regenerate lands here;
      // visibility (e.g. a cutaway/view toggle hiding the sub-part) is hashed
      // too but changes NOTHING else about the mesh, so the signature alone
      // can't tell "regenerated" from "still the same geometry, just hidden" —
      // check both explicitly. Either way the hovered mesh is no longer a
      // valid target: drop the stale hover (and its highlight) and re-render.
      const m = viewer._subMeshes[hover?.subPart];
      if (hover && (!m || !m.visible || hover.geometry !== m.geometry)) {
        hover = null;
        highlight?.clear();
      }
      rebuild();
    } else if (lastItems.length) {
      // cheap per-frame: has a side choice flipped?
      const meshes = visibleMeshes();
      const parent = partsParent(meshes);
      if (parent && lastBounds) {
        parent.updateWorldMatrix(true, false);
        const camPos = viewer.camera.position.clone()
          .applyMatrix4(parent.matrixWorld.clone().invert()).toArray();
        const next = evaluateChoices(lastItems, { camPos, center: centerOf(lastBounds), prev: choices });
        if (!choicesEqual(next, choices)) { choices = next; rebuild(); }
      }
    }
    scene.tick();
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
    rebuild();
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
      mesh: hit.mesh,
      // spec stays in the mesh's own frame here; buildItems poses it.
      item: { id: "hover", tier: "hover", spec, paramName: linkFor(hit.subPart, spec) },
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
      rebuild();
    });
  }
  const onLeave = () => { hover = null; highlight?.clear(); rebuild(); };

  function togglePin(key, paramName) {
    const { view } = getContext();
    const added = pins.toggle(view, key);
    if (added && paramName) revealParam?.(paramName);
    notifyPins();
    rebuild();
  }

  // Label pick first, then geometry: a dimension's text plane is a real object
  // in the scene, so clicking it must un-pin (or pin the hovered dim) rather
  // than fall through to whatever surface sits behind it.
  function onClick(ev) {
    const wasDragged = drag.consumeClick();
    if (!enabled || wasDragged) return;
    const labelId = scene?.pickLabel(ev.clientX, ev.clientY);
    if (labelId) {
      if (labelId === "hover") {
        if (hover) togglePin(hover.key, hover.item.paramName);
        return;
      }
      const item = lastItems.find((i) => i.id === labelId);
      if (item?._key) togglePin(item._key, null); // toggling off: no reveal
      return;
    }
    const hit = raycastViewer(viewer, ev.clientX, ev.clientY);
    if (!hit) return;
    const h = hitToHover(hit);
    togglePin(h.key, h.item.paramName);
  }

  const dom = viewer.domElement;
  dom.addEventListener("pointermove", onMove);
  dom.addEventListener("pointerdown", drag.onDown);
  dom.addEventListener("pointerup", drag.onUp);
  dom.addEventListener("pointercancel", drag.onCancel);
  dom.addEventListener("pointerleave", onLeave);
  dom.addEventListener("click", onClick);

  const offTheme = viewer.onThemeChange?.((mode) => { scene?.setTheme(mode); rebuild(); }) ?? (() => {});

  function setEnabled(on) {
    if (detached || on === enabled) return;
    enabled = !!on;
    if (enabled) {
      scene ??= createDimScene(viewer);
      highlight ??= createFeatureHighlight(viewer);
      lastSig = "";
      rebuild();
    } else {
      hover = null;
      highlight?.clear();
      scene?.clear();
      lastItems = [];
      lastBounds = null;
    }
    notifyMode();
  }

  return {
    setEnabled,
    isEnabled: () => enabled,
    clearPins() {
      pins.clear(getContext().view);
      notifyPins();
      rebuild();
    },
    pinCount: () => pins.count(getContext().view),
    onPinsChange: (cb) => { pinListeners.add(cb); return () => pinListeners.delete(cb); },
    onModeChange: (cb) => { modeListeners.add(cb); return () => modeListeners.delete(cb); },
    detach() {
      if (detached) return;
      detached = true;
      enabled = false;
      offFrame();
      unsubscribeHandleHover();
      offTheme();
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerdown", drag.onDown);
      dom.removeEventListener("pointerup", drag.onUp);
      dom.removeEventListener("pointercancel", drag.onCancel);
      dom.removeEventListener("pointerleave", onLeave);
      dom.removeEventListener("click", onClick);
      highlight?.dispose();
      scene?.dispose();
      pinListeners.clear();
      modeListeners.clear();
    },
  };
}
