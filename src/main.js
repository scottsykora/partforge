import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DEFAULTS } from "./params.js";
import { buildControls } from "./controls.js";

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

// BufferGeometry from a worker mesh payload — kept in its shared-frame coords
// (NOT recentred) so the pieces assemble in the right relative positions.
function buildGeometry({ positions, normals, indices, triangles }) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (normals?.length) geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  if (!normals?.length) geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.userData.triangles = triangles ?? indices.length / 3;
  return geo;
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

// --- worker (OpenCASCADE geometry) -----------------------------------------
const worker = new Worker(new URL("./drum-worker.js", import.meta.url), {
  type: "module",
});

const statusEl = document.getElementById("status");
const genBtn = document.getElementById("generate");
const centerGenBtn = document.getElementById("center-generate");
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

// --- per-sub-part mesh cache + view composition ----------------------------
const params = { ...DEFAULTS };
let part = "both"; // active tab (view)
let generating = false;
const subCache = { small: null, big: null, block: null }; // geometry per sub-part
const PART_LABEL = { small: "Small", big: "Big", both: "Both" };

// Which sub-parts a view shows (the block only exists when pockets are enabled).
function viewParts(view) {
  const hasBlock = params.tensioner_pocket_depth > 0;
  if (view === "small") return ["small"];
  if (view === "big") return hasBlock ? ["big", "block"] : ["big"];
  return hasBlock ? ["small", "big", "block"] : ["small", "big"];
}
const missingParts = () => viewParts(part).filter((n) => !subCache[n]);

// Geometry depends on params, so any edit makes every cached sub-part stale.
function invalidateCaches() {
  for (const k in subCache) {
    if (subCache[k]) subCache[k].dispose();
    subCache[k] = null;
  }
}

// Reflect the active view: assemble it from cached sub-parts, or (if any are
// missing) clear the view and prompt to generate just the missing ones.
function refreshView() {
  if (missingParts().length === 0) {
    const needed = viewParts(part);
    showAssembly(needed);
    centerGenBtn.classList.remove("show");
    genBtn.disabled = true; // already shown — nothing to generate
    dlBtn.disabled = false;
    dlStepBtn.disabled = false;
    const tris = needed.reduce((s, n) => s + subCache[n].userData.triangles, 0);
    setStatus(`${tris.toLocaleString()} triangles`);
  } else {
    hideAssembly();
    dlBtn.disabled = true;
    dlStepBtn.disabled = true;
    if (kernelReady && !generating) {
      genBtn.disabled = false;
      centerGenBtn.textContent = `Generate ${PART_LABEL[part]}`;
      centerGenBtn.classList.add("show");
    }
  }
}

showBusy("booting kernel"); // visible from first paint until the kernel is ready

worker.onmessage = ({ data }) => {
  switch (data.type) {
    case "ready":
      kernelReady = true;
      hideBusy();
      setStatus("ready — adjust settings, then Generate");
      refreshView(); // nothing generated yet → shows the centre Generate prompt
      break;
    case "progress":
      showBusy(data.phase);
      setStatus(`${data.phase}…`);
      break;
    case "meshes": {
      generating = false;
      for (const m of data.meshes) subCache[m.name] = buildGeometry(m); // cache each
      hideBusy();
      refreshView(); // assemble the active view (now complete) or its prompt
      if (missingParts().length === 0 && data.ms) {
        setStatus(`${statusEl.textContent} · ${(data.ms / 1000).toFixed(1)} s`);
      }
      break;
    }
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
};

buildControls(document.getElementById("controls"), params, onParamChange);

function onParamChange() {
  invalidateCaches(); // edits invalidate every sub-part mesh
  refreshView(); // active view now needs (re)generation
}

const partSeg = document.getElementById("part");
partSeg.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-part]");
  if (!btn) return;
  part = btn.dataset.part;
  for (const b of partSeg.children) b.classList.toggle("on", b === btn);
  refreshView(); // instant if every sub-part is cached, else prompts Generate
});

function generate() {
  if (!kernelReady || generating) return;
  const missing = missingParts();
  if (missing.length === 0) return; // already have every sub-part for this view
  generating = true;
  genBtn.disabled = true;
  centerGenBtn.classList.remove("show");
  showBusy("generating");
  worker.postMessage({ type: "generate", subparts: missing, params });
}

genBtn.addEventListener("click", generate);
centerGenBtn.addEventListener("click", generate);

dlBtn.addEventListener("click", () => {
  showBusy("exporting STL");
  worker.postMessage({ type: "export-stl", part, params });
});

dlStepBtn.addEventListener("click", () => {
  showBusy("exporting STEP");
  worker.postMessage({ type: "export-step", part, params });
});

function triggerDownload(arrayBuffer, filename, mime) {
  const url = URL.createObjectURL(new Blob([arrayBuffer], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
