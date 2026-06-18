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
// One persistent mesh whose geometry we swap. Generated geometries are cached
// per tab (see meshCache) so switching tabs is instant and never re-meshes.
const drumMesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
drumMesh.rotation.x = -Math.PI / 2; // drum axis -> vertical
drumMesh.visible = false;
scene.add(drumMesh);

// Build a centred BufferGeometry from a worker mesh payload.
function buildGeometry({ positions, normals, indices, triangles }) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (normals?.length) geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  if (!normals?.length) geo.computeVertexNormals();
  geo.computeBoundingBox();
  const c = new THREE.Vector3();
  geo.boundingBox.getCenter(c);
  geo.translate(-c.x, -c.y, -c.z); // centre on the origin
  geo.userData.triangles = triangles ?? indices.length / 3;
  return geo;
}

// Show a cached geometry and frame the camera to it.
function showGeometry(geo) {
  drumMesh.geometry = geo; // cached geometries are reused, not disposed here
  drumMesh.visible = true;
  const size = new THREE.Vector3();
  geo.boundingBox.getSize(size);
  const r = Math.max(size.x, size.y, size.z) || 12;
  camera.position.setLength(r * 2.6 + 6);
  controls.target.set(0, 0, 0);
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

// --- part state + per-tab mesh cache ---------------------------------------
const params = { ...DEFAULTS };
let part = "both"; // default tab
let generating = false;
const meshCache = { small: null, big: null, both: null }; // centred geometry per tab
const PART_LABEL = { small: "Small", big: "Big", both: "Both" };

// Geometry depends on params, so any edit makes every cached mesh stale.
function invalidateCaches() {
  for (const k in meshCache) {
    if (meshCache[k]) meshCache[k].dispose();
    meshCache[k] = null;
  }
}

// Reflect the current tab: show its cached mesh instantly, or prompt to Generate.
function refreshView() {
  const geo = meshCache[part];
  if (geo) {
    showGeometry(geo);
    centerGenBtn.classList.remove("show");
    genBtn.disabled = true; // already shown — nothing to regenerate
    dlBtn.disabled = false;
    dlStepBtn.disabled = false;
    setStatus(`${geo.userData.triangles.toLocaleString()} triangles`);
  } else {
    drumMesh.visible = false; // remove any mesh that isn't this tab's
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
    case "mesh":
      generating = false;
      genBtn.disabled = false;
      meshCache[data.part] = buildGeometry(data); // cache for instant tab switches
      hideBusy();
      setStatus(`${data.triangles.toLocaleString()} triangles · ${(data.ms / 1000).toFixed(1)} s`);
      refreshView(); // shows it if it's the active tab, else the active tab's prompt
      break;
    case "download":
      hideBusy();
      triggerDownload(data.data, data.filename, data.mime);
      setStatus(`${data.filename} downloaded`);
      break;
    case "error":
      generating = false;
      hideBusy();
      genBtn.disabled = false;
      setStatus(`failed: ${data.message}`, true);
      refreshView();
      break;
  }
};

buildControls(document.getElementById("controls"), params, onParamChange);

function onParamChange() {
  invalidateCaches(); // edits invalidate every tab's mesh
  refreshView(); // current tab now needs (re)generation
}

const partSeg = document.getElementById("part");
partSeg.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-part]");
  if (!btn) return;
  part = btn.dataset.part;
  for (const b of partSeg.children) b.classList.toggle("on", b === btn);
  refreshView(); // instant if cached, else prompts Generate
});

function generate() {
  if (!kernelReady || generating || meshCache[part]) return;
  generating = true;
  genBtn.disabled = true;
  centerGenBtn.classList.remove("show");
  showBusy("generating");
  worker.postMessage({ type: "generate", part, params });
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
