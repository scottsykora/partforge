import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { zipSync } from "fflate";
import { DEFAULTS } from "./params.js";
import { buildControls } from "./controls.js";
import { viewParts } from "./geometry-jobs.js";

// --- three.js scene --------------------------------------------------------
const app = document.getElementById("app");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15181d);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
camera.position.set(18, 12, 18);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 1.6;

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202024, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(8, 14, 10);
scene.add(key);
// 1 cm grid (mm units): 200 mm wide, 20 divisions -> 10 mm squares.
scene.add(new THREE.GridHelper(200, 20, 0x2c333d, 0x222831));

const material = new THREE.MeshStandardMaterial({
  color: 0x9fb4cc,
  metalness: 0.25,
  roughness: 0.55,
  flatShading: false,
});
// Sub-parts (small drum / big drum / block) are meshed independently in a shared
// frame and cached, so any view is composed from cached pieces. `pivot` orients
// the drum axis vertical; `partsGroup` is recentred per view so the visible
// assembly sits at the origin.
const pivot = new THREE.Group();
pivot.rotation.x = -Math.PI / 2; // drum axis -> vertical
scene.add(pivot);
const partsGroup = new THREE.Group();
pivot.add(partsGroup);

const subMesh = {
  small: new THREE.Mesh(new THREE.BufferGeometry(), material),
  big: new THREE.Mesh(new THREE.BufferGeometry(), material),
  block: new THREE.Mesh(new THREE.BufferGeometry(), material),
};
for (const m of Object.values(subMesh)) {
  m.visible = false;
  partsGroup.add(m);
}

// Smooth shading within CREASE_ANGLE of a shared edge, hard edge past it — so the
// round body and helical groove read smooth while bore rims, drum faces, and
// groove walls stay crisp. Lower = more hard edges; raise toward Math.PI/3 for
// softer. (Worker normals are ignored; we recompute per the crease threshold.)
const CREASE_ANGLE = Math.PI / 6; // 30°

// BufferGeometry from a worker mesh payload — kept in its shared-frame coords
// (NOT recentred) so the pieces assemble in the right relative positions.
function buildGeometry({ positions, normals, indices, triangles }) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (indices?.length) geo.setIndex(new THREE.BufferAttribute(indices, 1)); // Manifold is non-indexed
  const triCount = triangles ?? (indices ? indices.length : positions.length / 3) / 3;
  if (normals?.length) {
    // kernel-computed normals (Manifold) — smooth within a surface, hard at cut seams
    geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geo.computeBoundingBox();
    geo.userData.triangles = triCount;
    return geo;
  }
  // fallback (no kernel normals, e.g. OCCT): crease from the triangle soup
  const creased = toCreasedNormals(geo, CREASE_ANGLE);
  creased.computeBoundingBox();
  creased.userData.triangles = triCount;
  return creased;
}

// Show exactly the named sub-parts (from the cache), recentre the assembly on
// the origin, and frame the camera to it.
const _box = new THREE.Box3();
function showAssembly(names) {
  for (const [name, mesh] of Object.entries(subMesh)) {
    const on = names.includes(name);
    if (on) mesh.geometry = subCache[name]; // cached geometries reused, not disposed
    mesh.visible = on;
  }
  _box.makeEmpty();
  for (const name of names) _box.union(subCache[name].boundingBox);
  const center = _box.getCenter(new THREE.Vector3());
  partsGroup.position.copy(center).multiplyScalar(-1); // centre assembly on the pivot
  const size = _box.getSize(new THREE.Vector3());
  const r = Math.max(size.x, size.y, size.z) || 12;
  camera.position.setLength(r * 2.6 + 6);
  controls.target.set(0, 0, 0);
}
function hideAssembly() {
  for (const m of Object.values(subMesh)) m.visible = false;
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

// --- workers (geometry) ----------------------------------------------------
// Dev toggle: ?backend=occt routes preview generate through the OCCT worker.
const useOcctPreview = new URLSearchParams(location.search).get("backend") === "occt";

const previewWorker = new Worker(new URL("./preview-worker.js", import.meta.url), { type: "module" });
const exportWorker = new Worker(new URL("./export-worker.js", import.meta.url), { type: "module" });

// preview defaults to Manifold; ?backend=occt routes preview generate to the OCCT worker
const genWorker = useOcctPreview ? exportWorker : previewWorker;

const statusEl = document.getElementById("status");
const dlBtn = document.getElementById("download");
const dlStepBtn = document.getElementById("download-step");
const busyEl = document.getElementById("busy");
const phaseEl = document.getElementById("phase");
let kernelReady = false;

function setStatus(msg, isErr = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("err", isErr);
}
function showBusy(phase) {
  phaseEl.textContent = `${phase}…`;
  busyEl.classList.add("show");
}
function hideBusy() {
  busyEl.classList.remove("show");
}

// --- per-sub-part mesh cache + auto-regenerating view composition -----------
const params = { ...DEFAULTS };
let part = "both"; // active tab (view)
let generating = false;
let paramsVersion = 0; // bumped on every settings edit
let genVersion = -1; // the params version the in-flight generate is building
let genTimer = null; // debounce timer for auto-regenerate
const subCache = { small: null, big: null, block: null }; // geometry per sub-part
const cacheVersion = { small: -1, big: -1, block: -1 }; // params version each was built at

// A cached sub-part is current only if it was built at the latest params version.
const isCurrent = (n) => subCache[n] && cacheVersion[n] === paramsVersion;
const missingParts = () => viewParts(part, params).filter((n) => !isCurrent(n));

// Reflect the active view. If every needed part is current, show it and enable
// export. If they're stale (a regenerate is in flight), keep showing the old
// mesh so the view doesn't flicker. If nothing's been built yet, show nothing.
function refreshView() {
  const needed = viewParts(part, params);
  if (needed.every(isCurrent)) {
    showAssembly(needed);
    dlBtn.disabled = false;
    dlStepBtn.disabled = false;
    const tris = needed.reduce((s, n) => s + subCache[n].userData.triangles, 0);
    setStatus(`${tris.toLocaleString()} triangles`);
  } else if (needed.every((n) => subCache[n])) {
    showAssembly(needed); // stale but present — keep it visible during regenerate
    dlBtn.disabled = true;
    dlStepBtn.disabled = true;
  } else {
    hideAssembly();
    dlBtn.disabled = true;
    dlStepBtn.disabled = true;
  }
}

showBusy("booting kernel"); // visible from first paint until the kernel is ready

// --- download helpers -------------------------------------------------------
function triggerDownload(arrayBuffer, filename, mime) {
  const url = URL.createObjectURL(new Blob([arrayBuffer], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function onDownloadParts({ parts, ext, mime }) {
  if (parts.length === 1) return triggerDownload(parts[0].data, `${parts[0].name}.${ext}`, mime);
  const entries = {};
  for (const p of parts) entries[`${p.name}.${ext}`] = new Uint8Array(p.data);
  triggerDownload(zipSync(entries, { level: 0 }), "drums.zip", "application/zip");
}

// --- shared message handler -------------------------------------------------
function onWorkerMessage({ data }) {
  switch (data.type) {
    case "ready":
      kernelReady = true;
      maybeGenerate(); // auto-build the default view (keeps the busy spinner up)
      break;
    case "progress":
      showBusy(data.phase);
      setStatus(`${data.phase}…`);
      break;
    case "meshes": {
      generating = false;
      if (genVersion !== paramsVersion) { maybeGenerate(); break; } // changed mid-build → redo
      for (const m of data.meshes) {
        if (subCache[m.name]) subCache[m.name].dispose();
        subCache[m.name] = buildGeometry(m);
        cacheVersion[m.name] = genVersion;
      }
      hideBusy();
      refreshView();
      if (data.ms && missingParts().length === 0) {
        setStatus(`${statusEl.textContent} · ${(data.ms / 1000).toFixed(1)} s`);
      }
      maybeGenerate(); // active view may still need parts (tab switched during build)
      break;
    }
    case "download-parts":
      hideBusy();
      onDownloadParts(data);
      setStatus(`${data.parts.length} part(s) downloaded`);
      break;
    case "download":
      hideBusy();
      triggerDownload(data.data, data.filename, data.mime);
      setStatus(`${data.filename} downloaded`);
      break;
    case "error":
      generating = false;
      hideBusy();
      setStatus(`failed: ${data.message}`, true);
      refreshView();
      break;
  }
}

previewWorker.onmessage = onWorkerMessage;
exportWorker.onmessage = onWorkerMessage;

buildControls(document.getElementById("controls"), params, onParamChange);

function onParamChange() {
  paramsVersion++; // every edit invalidates the caches (by version)
  refreshView(); // keep showing the now-stale mesh (no flicker); disable export
  scheduleGenerate(); // debounced auto-regenerate
}

// Debounce auto-regeneration so dragging a slider doesn't queue a build per pixel.
function scheduleGenerate() {
  clearTimeout(genTimer);
  genTimer = setTimeout(maybeGenerate, 180);
}

// Build whatever the active view is missing — automatic, no Generate button.
function maybeGenerate() {
  if (!kernelReady || generating) return; // retried when the current build finishes
  const missing = missingParts();
  if (missing.length === 0) return;
  generating = true;
  genVersion = paramsVersion;
  showBusy("generating");
  genWorker.postMessage({ type: "generate", subparts: missing, params });
}

const partSeg = document.getElementById("part");
partSeg.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-part]");
  if (!btn) return;
  part = btn.dataset.part;
  for (const b of partSeg.children) b.classList.toggle("on", b === btn);
  refreshView(); // instant if the view's parts are cached + current
  maybeGenerate(); // else auto-build the missing pieces
});

dlBtn.addEventListener("click", () => {
  showBusy("exporting STL");
  previewWorker.postMessage({ type: "export-stl", part, params });
});

dlStepBtn.addEventListener("click", () => {
  showBusy("exporting STEP");
  exportWorker.postMessage({ type: "export-step", part, params });
});
