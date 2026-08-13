// THROWAWAY SPIKE — do not ship, do not review as production code.
//
// Question under test: do in-scene 3D dimension objects (world-space extension
// lines + dimension line + arrowheads, riding the parts group so they rotate
// and foreshorten with the model) read better under orbit than the shipped
// screen-space SVG overlay?
//
// Current look (per review rounds): in-plane canvas-texture text placed on the
// OUTSIDE of the dimension line, flat triangle arrowheads lying in the dim
// plane, and extension lines anchored on the actual mesh surface (the extreme
// vertices realizing each extent, tie-broken toward the dim line) rather than
// floating bounding-box corners. Press T to compare against DOM chip labels.
//
// Wired behind `?dim3spike` in mount.js. Hardcoded to overall bbox width +
// height; no hover, no pins, no theming, no teardown polish.
import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

const DIM_COLOR = 0x7aa2ff;

export function attachDim3Spike(viewer, container) {
  const meshes = Object.values(viewer._subMeshes);
  const partsGroup = meshes[0]?.parent;
  if (!partsGroup) return { dispose() {} };

  const group = new THREE.Group();
  partsGroup.add(group);

  const lineMat = new LineMaterial({ color: DIM_COLOR, linewidth: 1.5 });
  lineMat.depthTest = false;
  lineMat.transparent = true; // depthTest:false needs the transparent pass to draw late
  const arrowMat = new THREE.MeshBasicMaterial({
    color: DIM_COLOR, depthTest: false, transparent: true, side: THREE.DoubleSide,
  });

  // --- DOM chip labels ------------------------------------------------------
  const chips = [];
  function makeChip(text) {
    const el = document.createElement("div");
    el.style.cssText = [
      "position:absolute", "left:0", "top:0", "pointer-events:none",
      "font:600 11px/1.4 var(--pf-mono, ui-monospace, monospace)",
      "padding:1px 6px", "border-radius:4px", "white-space:nowrap",
      "background:rgba(26,30,36,0.88)", "color:#dfe6ee",
      "border:1px solid rgba(122,162,255,0.55)", "z-index:30", "display:none",
    ].join(";");
    el.textContent = text;
    container.appendChild(el);
    chips.push(el);
    return el;
  }

  // --- in-plane canvas-texture text labels ----------------------------------
  // The quad lies in the dimension's plane (x = reading direction along the dim
  // line, y = toward the part / "above" the line for orientation). Canvas
  // painted at high px density; readability flips applied per frame below.
  const texLabels = []; // { mesh, baseQuat, mirrored, flipped }
  function makeTextPlane(text, center, xDir, yDir, heightMm) {
    const font = "700 96px ui-monospace, Menlo, monospace";
    const c = document.createElement("canvas");
    let ctx = c.getContext("2d");
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width);
    const PAD = 20;
    c.width = w + PAD * 2;
    c.height = 128;
    ctx = c.getContext("2d");
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(10, 14, 20, 0.9)"; // dark halo so it reads on the part body
    ctx.lineWidth = 10;
    ctx.strokeText(text, c.width / 2, c.height / 2);
    ctx.fillStyle = "#c9d9ff";
    ctx.fillText(text, c.width / 2, c.height / 2);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8; // keep glancing-angle text legible
    const planeH = heightMm;
    const planeW = planeH * (c.width / c.height);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(planeW, planeH),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, side: THREE.DoubleSide }),
    );
    mesh.renderOrder = 999;
    const z = new THREE.Vector3().crossVectors(xDir, yDir).normalize();
    const basis = new THREE.Matrix4().makeBasis(xDir, yDir, z);
    const baseQuat = new THREE.Quaternion().setFromRotationMatrix(basis);
    mesh.quaternion.copy(baseQuat);
    mesh.position.copy(center);
    group.add(mesh);
    texLabels.push({ mesh, baseQuat, mirrored: false, flipped: false });
    return mesh;
  }

  // Flat triangle arrowhead lying in the dim plane: tip on the dim-line
  // endpoint, base toward the line's centre, spread along the in-plane perp.
  // Both a filled mesh and a stroked outline are built; press A to compare
  // (no drafting-standard meaning attaches to hollow vs filled — ISO 129
  // allows both; the rule is only consistency within a drawing).
  const arrowObjs = { filled: [], hollow: [] };
  function makeTriangle(tip, inward, perp, len) {
    const base = tip.clone().addScaledVector(inward, len);
    const halfW = len * 0.25; // narrow drafting arrow: width = half its length
    const p1 = base.clone().addScaledVector(perp, halfW);
    const p2 = base.clone().addScaledVector(perp, -halfW);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
      tip.x, tip.y, tip.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z,
    ]), 3));
    const fill = new THREE.Mesh(g, arrowMat);
    fill.renderOrder = 998;
    group.add(fill);
    arrowObjs.filled.push(fill);

    const og = new LineSegmentsGeometry();
    og.setPositions([
      tip.x, tip.y, tip.z, p1.x, p1.y, p1.z,
      p1.x, p1.y, p1.z, p2.x, p2.y, p2.z,
      p2.x, p2.y, p2.z, tip.x, tip.y, tip.z,
    ]);
    const outline = new LineSegments2(og, lineMat);
    outline.renderOrder = 998;
    group.add(outline);
    arrowObjs.hollow.push(outline);
  }

  let arrowMode = "filled";
  function applyArrowMode() {
    for (const o of arrowObjs.filled) o.visible = arrowMode === "filled";
    for (const o of arrowObjs.hollow) o.visible = arrowMode === "hollow";
  }

  // One engineering dimension in the parts-group (delivered geometry) frame.
  // pA/pB: real surface anchor points; da/db: dim-line endpoints; ext: unit
  // direction from the part out to the dim line (in-plane perpendicular).
  //
  // The whole dimension is coplanar: `planeAxis` is the plane's normal, and the
  // plane slides along it to pass through whichever extreme anchor sits closer
  // to `planeRef` (the side of the model the dim is drawn toward). The other
  // anchor projects into the plane, so its extension line stays in-plane even
  // when the true vertex is elsewhere along the normal.
  const chipPoints = []; // { el, p: Vector3 (group-local) }
  function addDim(pA, pB, da, db, ext, text, modelSize, planeAxis, planeRef) {
    const cA = pA.getComponent(planeAxis), cB = pB.getComponent(planeAxis);
    const c = Math.abs(cA - planeRef) <= Math.abs(cB - planeRef) ? cA : cB;
    for (const p of [pA, pB, da, db]) p.setComponent(planeAxis, c);
    const GAP = 1.0, OVERSHOOT = 1.5;
    const dir = db.clone().sub(da).normalize();
    const len = db.distanceTo(da);
    const arrowLen = 0.7 * Math.min(3, Math.max(1.2, len * 0.04));

    // Where the extension line should touch the part, staying in the dim
    // plane: raycast from the dim-line endpoint back toward the (projected)
    // anchor and take the first surface hit. The ray is nudged slightly
    // inside the extreme plane (along `inward`) so a ray grazing the extreme
    // face exactly still registers. Falls back to the projected anchor when
    // the plane misses the model entirely.
    const rc = new THREE.Raycaster();
    const hittable = meshes.filter((m) => m.visible && m.geometry?.attributes?.position);
    for (const m of hittable) m.updateWorldMatrix(true, false);
    function surfaceStart(p, d, inward) {
      const u = d.clone().sub(p).normalize(); // anchor -> dim line
      const originW = d.clone().addScaledVector(inward, 0.05).applyMatrix4(partsGroup.matrixWorld);
      const dirW = u.clone().negate().transformDirection(partsGroup.matrixWorld);
      rc.set(originW, dirW);
      const hit = rc.intersectObjects(hittable, false)[0];
      if (!hit) return p;
      const local = partsGroup.worldToLocal(hit.point.clone());
      local.setComponent(planeAxis, c); // stay exactly coplanar
      return local;
    }

    // extension lines: from just off the model surface, through the dim-line
    // endpoint, overshooting slightly past it
    partsGroup.updateWorldMatrix(true, false);
    const segs = [];
    for (const [p, d, inward] of [[pA, da, dir], [pB, db, dir.clone().negate()]]) {
      const start = surfaceStart(p, d, inward);
      const u = d.clone().sub(start).normalize();
      const s = start.clone().addScaledVector(u, GAP);
      const e = d.clone().addScaledVector(u, OVERSHOOT);
      segs.push(s.x, s.y, s.z, e.x, e.y, e.z);
    }
    // dim line shortened so it doesn't poke through the arrowheads
    const dA = da.clone().addScaledVector(dir, arrowLen);
    const dB = db.clone().addScaledVector(dir, -arrowLen);
    segs.push(dA.x, dA.y, dA.z, dB.x, dB.y, dB.z);

    const geo = new LineSegmentsGeometry();
    geo.setPositions(segs);
    const lines = new LineSegments2(geo, lineMat);
    lines.renderOrder = 998;
    group.add(lines);

    makeTriangle(da, dir, ext, arrowLen);
    makeTriangle(db, dir.clone().negate(), ext, arrowLen);

    const mid = da.clone().add(db).multiplyScalar(0.5);
    chipPoints.push({ el: makeChip(text), p: mid });
    // text OUTSIDE the dim line (away from the part), oriented so "up" still
    // points at the line — reads like text set below a line
    const planeH = Math.max(3.2, modelSize * 0.05);
    const center = mid.clone().addScaledVector(ext, planeH * 0.85);
    makeTextPlane(text, center, dir.clone(), ext.clone().negate(), planeH);
  }

  // --- label style toggle (press T) -----------------------------------------
  let labelMode = "plane";
  function applyLabelMode() {
    for (const { el } of chipPoints) el.style.display = labelMode === "chip" ? "" : "none";
    for (const L of texLabels) L.mesh.visible = labelMode === "plane";
  }
  function onKey(e) {
    if (/^(input|textarea|select)$/i.test(e.target?.tagName ?? "")) return;
    if (e.key === "t" || e.key === "T") {
      labelMode = labelMode === "plane" ? "chip" : "plane";
      applyLabelMode();
    } else if (e.key === "a" || e.key === "A") {
      arrowMode = arrowMode === "hollow" ? "filled" : "hollow";
      applyArrowMode();
    }
  }
  window.addEventListener("keydown", onKey);

  // The vertex that realizes the extreme along `axis` (0/1/2, posed model
  // coords, sign +1 max / -1 min). Ties within tolerance (a flat base is all
  // "the minimum") break toward `near`, so the extension line lands on the
  // side of the part the dimension is drawn on.
  const _v = new THREE.Vector3();
  function extremeVertex(axis, sign, near) {
    let bestVal = sign > 0 ? -Infinity : Infinity;
    for (const m of meshes) {
      if (!m.visible || !m.geometry?.attributes?.position) continue;
      const pos = m.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const val = _v.fromBufferAttribute(pos, i).applyMatrix4(m.matrix).getComponent(axis);
        if (sign > 0 ? val > bestVal : val < bestVal) bestVal = val;
      }
    }
    if (!Number.isFinite(bestVal)) return null;
    let best = null, bestD = Infinity;
    for (const m of meshes) {
      if (!m.visible || !m.geometry?.attributes?.position) continue;
      const pos = m.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        _v.fromBufferAttribute(pos, i).applyMatrix4(m.matrix);
        if (Math.abs(_v.getComponent(axis) - bestVal) > 1e-3) continue;
        const d = _v.distanceToSquared(near);
        if (d < bestD) { bestD = d; best = _v.clone(); }
      }
    }
    return best;
  }

  // Lazy build: geometry arrives async from the worker; wait for bounding boxes.
  let built = false;
  const _box = new THREE.Box3();
  const _posed = new THREE.Box3();
  function tryBuild() {
    _box.makeEmpty();
    for (const m of meshes) {
      if (!m.visible || !m.geometry?.boundingBox) continue;
      _posed.copy(m.geometry.boundingBox).applyMatrix4(m.matrix);
      _box.union(_posed);
    }
    if (_box.isEmpty()) return false;
    const { min, max } = _box;
    const size = _box.getSize(new THREE.Vector3());
    const modelSize = Math.max(size.x, size.y, size.z);
    const offset = Math.max(6, modelSize * 0.10);

    // width (X extent) — floor-plan style dim in front of the part, at its base
    {
      const da = new THREE.Vector3(min.x, min.y - offset, min.z);
      const db = new THREE.Vector3(max.x, min.y - offset, min.z);
      const pA = extremeVertex(0, -1, da) ?? new THREE.Vector3(min.x, min.y, min.z);
      const pB = extremeVertex(0, +1, db) ?? new THREE.Vector3(max.x, min.y, min.z);
      addDim(pA, pB, da, db, new THREE.Vector3(0, -1, 0), `${size.x.toFixed(2)} mm`, modelSize, 2, min.z);
    }
    // height (Z extent, model up) — vertical dim beside the part
    {
      const da = new THREE.Vector3(max.x + offset, min.y, min.z);
      const db = new THREE.Vector3(max.x + offset, min.y, max.z);
      const pA = extremeVertex(2, -1, da) ?? new THREE.Vector3(max.x, min.y, min.z);
      const pB = extremeVertex(2, +1, db) ?? new THREE.Vector3(max.x, min.y, max.z);
      addDim(pA, pB, da, db, new THREE.Vector3(1, 0, 0), `${size.z.toFixed(2)} mm`, modelSize, 1, min.y);
    }
    applyLabelMode();
    applyArrowMode();
    return true;
  }

  // Readability corrections for in-plane text, chosen among four in-plane
  // states so it never renders mirrored or upside down: Ry(π) fixes viewing
  // the plane from behind (mirror), Rz(π) fixes reading direction. Deadbands
  // keep edge-on angles from flickering between states.
  const QY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  const QZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
  const _gq = new THREE.Quaternion();
  const _wq = new THREE.Quaternion();
  const _n = new THREE.Vector3();
  const _xAxis = new THREE.Vector3();
  const _toCam = new THREE.Vector3();
  const _wp = new THREE.Vector3();
  function orientLabels() {
    group.getWorldQuaternion(_gq);
    for (const L of texLabels) {
      // current world orientation with the stored corrections applied
      _wq.copy(_gq).multiply(L.baseQuat);
      if (L.mirrored) _wq.multiply(QY);
      if (L.flipped) _wq.multiply(QZ);

      L.mesh.getWorldPosition(_wp);
      _toCam.copy(viewer.camera.position).sub(_wp).normalize();
      _n.set(0, 0, 1).applyQuaternion(_wq);
      const facing = _n.dot(_toCam);
      if (Math.abs(facing) > 0.08 && facing < 0) {
        L.mirrored = !L.mirrored;
        _wq.multiply(QY);
      }
      // reading direction: world x-axis of the label, in camera space
      _xAxis.set(1, 0, 0).applyQuaternion(_wq);
      _xAxis.applyQuaternion(viewer.camera.quaternion.clone().invert());
      if (Math.abs(_xAxis.x) > 0.08 && _xAxis.x < 0) L.flipped = !L.flipped;

      L.mesh.quaternion.copy(L.baseQuat);
      if (L.mirrored) L.mesh.quaternion.multiply(QY);
      if (L.flipped) L.mesh.quaternion.multiply(QZ);
    }
  }

  const _world = new THREE.Vector3();
  const _cam = new THREE.Vector3();
  const offFrame = viewer.onFrame(() => {
    if (!built) built = tryBuild();
    if (!built) return;
    const canvas = viewer.domElement;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    lineMat.resolution.set(w, h); // fat lines need viewport px for constant width
    group.updateWorldMatrix(true, false);
    if (labelMode === "plane") {
      orientLabels();
      return;
    }
    for (const { el, p } of chipPoints) {
      _world.copy(p).applyMatrix4(group.matrixWorld);
      _cam.copy(_world).applyMatrix4(viewer.camera.matrixWorldInverse);
      if (_cam.z > -0.1) { el.style.display = "none"; continue; } // behind camera
      _world.project(viewer.camera);
      el.style.display = "";
      const x = (_world.x * 0.5 + 0.5) * w;
      const y = (1 - (_world.y * 0.5 + 0.5)) * h;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -145%)`;
    }
  });

  return {
    dispose() {
      offFrame();
      window.removeEventListener("keydown", onKey);
      partsGroup.remove(group);
      group.traverse((o) => {
        o.geometry?.dispose?.();
        o.material?.map?.dispose?.();
        if (o.material && o.material !== lineMat && o.material !== arrowMat) o.material.dispose?.();
      });
      lineMat.dispose();
      arrowMat.dispose();
      for (const el of chips) el.remove();
    },
  };
}
