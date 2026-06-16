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
scene.add(new THREE.GridHelper(40, 20, 0x2c333d, 0x222831));

const material = new THREE.MeshStandardMaterial({
  color: 0x9fb4cc,
  metalness: 0.25,
  roughness: 0.55,
  flatShading: false,
});
let drumMesh = null;

function setGeometry({ positions, normals, indices }) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (normals?.length) geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  if (!normals?.length) geo.computeVertexNormals();
  geo.computeBoundingBox();
  const c = new THREE.Vector3();
  geo.boundingBox.getCenter(c);
  geo.translate(-c.x, -c.y, -c.z); // centre on the origin

  if (drumMesh) {
    drumMesh.geometry.dispose();
    scene.remove(drumMesh);
  }
  drumMesh = new THREE.Mesh(geo, material);
  drumMesh.rotation.x = -Math.PI / 2; // drum axis -> vertical
  scene.add(drumMesh);

  // frame the camera to the part size
  const size = new THREE.Vector3();
  geo.boundingBox.getSize(size);
  const r = Math.max(size.x, size.y, size.z) || 12;
  const dist = r * 2.6 + 6;
  camera.position.setLength(dist);
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

showBusy("booting kernel"); // visible from first paint until the first drum

worker.onmessage = ({ data }) => {
  switch (data.type) {
    case "ready":
      kernelReady = true;
      generate(); // first paint
      break;
    case "progress":
      showBusy(data.phase);
      setStatus(`${data.phase}…`);
      break;
    case "mesh":
      setGeometry(data);
      hideBusy();
      dlBtn.disabled = false;
      dlStepBtn.disabled = false;
      genBtn.disabled = false;
      setStatus(
        `${data.triangles.toLocaleString()} triangles · ${(data.ms / 1000).toFixed(1)} s`
      );
      break;
    case "stl":
      hideBusy();
      triggerDownload(data.stl, "drum.stl", "model/stl");
      setStatus("STL downloaded");
      break;
    case "step":
      hideBusy();
      triggerDownload(data.step, "drum.step", "application/step");
      setStatus("STEP downloaded");
      break;
    case "error":
      hideBusy();
      genBtn.disabled = false;
      setStatus(`failed: ${data.message}`, true);
      break;
  }
};

// shared param state + sectioned controls
const params = { ...DEFAULTS };
let part = "small";

buildControls(document.getElementById("controls"), params, () => {});

const partSeg = document.getElementById("part");
partSeg.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-part]");
  if (!btn) return;
  part = btn.dataset.part;
  for (const b of partSeg.children) b.classList.toggle("on", b === btn);
});

function generate() {
  if (!kernelReady) return;
  genBtn.disabled = true;
  showBusy("generating");
  worker.postMessage({ type: "generate", part, params });
}

genBtn.addEventListener("click", generate);

dlBtn.addEventListener("click", () => {
  showBusy("exporting STL");
  worker.postMessage({ type: "export-stl" });
});

dlStepBtn.addEventListener("click", () => {
  showBusy("exporting STEP");
  worker.postMessage({ type: "export-step" });
});

function triggerDownload(arrayBuffer, filename, mime) {
  const url = URL.createObjectURL(new Blob([arrayBuffer], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
