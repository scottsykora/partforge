// Always-on hover inspection: a cursor-following tooltip naming the feature +
// sub-part under the pointer, and an overlay mesh highlighting the feature's
// surface. Feature names come from Solid.label() in the part's build, carried
// per-triangle in the mesh payload (geometry.userData.featureIds/features).
import * as THREE from "three";
import { CUTAWAY_OVERLAY_RENDER_ORDER } from "../cutaway-render.js";
import { raycastViewer } from "./raycast.js";

const HIGHLIGHT = 0x4da3ff;

// Extract the subset of a non-indexed geometry belonging to one feature id.
function featureSubset(geometry, featureId) {
  const { featureIds } = geometry.userData;
  const pos = geometry.getAttribute("position");
  let count = 0;
  for (let t = 0; t < featureIds.length; t++) if (featureIds[t] === featureId) count++;
  const out = new Float32Array(count * 9);
  let o = 0;
  for (let t = 0; t < featureIds.length; t++) {
    if (featureIds[t] !== featureId) continue;
    for (let v = 0; v < 3; v++) {
      out[o++] = pos.getX(t * 3 + v); out[o++] = pos.getY(t * 3 + v); out[o++] = pos.getZ(t * 3 + v);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(out, 3));
  return g;
}

export function attachHoverLabels(viewer, { part, schedule = (cb) => requestAnimationFrame(cb) }) {
  // Hover is a mouse idiom — skip entirely on touch-only devices.
  if (globalThis.matchMedia && !matchMedia("(hover: hover)").matches) return { detach: () => {} };

  const tip = document.createElement("div");
  tip.id = "pf-hover-tip";
  const feat = document.createElement("b");
  const sub = document.createElement("span");
  sub.className = "pf-hover-sub";
  tip.append(feat, sub);
  document.body.appendChild(tip);

  const material = new THREE.MeshBasicMaterial({
    color: HIGHLIGHT, transparent: true, opacity: 0.35,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const unregisterCutaway = viewer.registerCutawayMaterial?.(material) ?? (() => {});
  let emptyOverlayGeometry = new THREE.BufferGeometry();
  const overlay = new THREE.Mesh(emptyOverlayGeometry, material);
  overlay.visible = false;
  overlay.renderOrder = CUTAWAY_OVERLAY_RENDER_ORDER;
  let overlayParent = null;
  // Subset cache per sub-part: rebuilt when the sub-part's geometry object changes
  // (i.e. after a regenerate) — keyed on the geometry instance.
  const subsets = new Map(); // subPart -> { geo, byId: Map(featureId -> BufferGeometry) }

  const subLabel = (name) => part.parts[name]?.label ?? name;

  function clearHighlight() {
    overlay.visible = false;
  }

  function hide() {
    tip.classList.remove("show");
    clearHighlight();
  }

  function show(hit, x, y) {
    if (hit.feature) {
      feat.textContent = hit.feature.label;
      sub.textContent = subLabel(hit.subPart);
      const cached = subsets.get(hit.subPart);
      let byId = cached?.geo === hit.mesh.geometry ? cached.byId : null;
      if (!byId) {
        for (const g of cached?.byId.values() ?? []) g.dispose();
        byId = new Map();
        subsets.set(hit.subPart, { geo: hit.mesh.geometry, byId });
      }
      let g = byId.get(hit.feature.id);
      if (!g) { g = featureSubset(hit.mesh.geometry, hit.feature.id); byId.set(hit.feature.id, g); }
      emptyOverlayGeometry?.dispose();
      emptyOverlayGeometry = null;
      overlay.geometry = g;
      if (overlayParent !== hit.mesh.parent) { hit.mesh.parent.add(overlay); overlayParent = hit.mesh.parent; }
      overlay.visible = true;
    } else {
      feat.textContent = subLabel(hit.subPart);
      sub.textContent = "";
      clearHighlight();
    }
    tip.style.left = `${x + 14}px`;
    tip.style.top = `${y + 14}px`;
    tip.classList.add("show");
  }

  let pending = null; // latest pointer position; one raycast per scheduled frame
  let frameScheduled = false;
  let down = false;
  let detached = false;

  function onMove(ev) {
    if (detached) return;
    if (ev.pointerType === "touch") return;
    if (down) return;
    pending = { x: ev.clientX, y: ev.clientY };
    if (frameScheduled) return;
    frameScheduled = true;
    schedule(() => {
      frameScheduled = false;
      const p = pending;
      pending = null;
      if (detached || !p || down) return;
      const hit = raycastViewer(viewer, p.x, p.y);
      if (hit) show(hit, p.x, p.y); else hide();
    });
  }
  const onDown = () => { down = true; pending = null; hide(); };
  const onUp = () => { down = false; };
  const onLeave = () => { pending = null; hide(); };

  viewer.domElement.addEventListener("pointermove", onMove);
  viewer.domElement.addEventListener("pointerdown", onDown);
  viewer.domElement.addEventListener("pointerup", onUp);
  viewer.domElement.addEventListener("pointerleave", onLeave);

  return {
    detach: () => {
      if (detached) return;
      detached = true;
      pending = null;
      viewer.domElement.removeEventListener("pointermove", onMove);
      viewer.domElement.removeEventListener("pointerdown", onDown);
      viewer.domElement.removeEventListener("pointerup", onUp);
      viewer.domElement.removeEventListener("pointerleave", onLeave);
      tip.remove();
      overlayParent?.remove(overlay);
      for (const { byId } of subsets.values()) for (const g of byId.values()) g.dispose();
      subsets.clear();
      emptyOverlayGeometry?.dispose();
      emptyOverlayGeometry = null;
      unregisterCutaway();
      material.dispose();
    },
  };
}
