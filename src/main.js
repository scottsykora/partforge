import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

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
let lastSTL = null;
let kernelReady = false;

function setStatus(msg, isErr = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("err", isErr);
}

worker.onmessage = ({ data }) => {
  if (data.type === "ready") {
    kernelReady = true;
    genBtn.disabled = false;
    generate(); // first paint
  } else if (data.type === "mesh") {
    setGeometry(data);
    lastSTL = data.stl || null;
    dlBtn.disabled = !lastSTL;
    setStatus(`${data.triangles.toLocaleString()} triangles · ${data.ms} ms`);
    genBtn.disabled = false;
  } else if (data.type === "error") {
    setStatus(`generation failed: ${data.message}`, true);
    genBtn.disabled = false;
  }
};

function readParams() {
  return {
    turns: +document.getElementById("turns").value,
    blankD: +document.getElementById("blankD").value,
    pitch: +document.getElementById("pitch").value,
    grooveW: +document.getElementById("grooveW").value,
  };
}

function generate() {
  if (!kernelReady) return;
  genBtn.disabled = true;
  setStatus("generating…");
  worker.postMessage({ type: "generate", params: readParams() });
}

genBtn.addEventListener("click", generate);

// live-update the slider value readouts
for (const id of ["turns", "blankD", "pitch", "grooveW"]) {
  const input = document.getElementById(id);
  const out = document.getElementById(`${id}-v`);
  input.addEventListener("input", () => (out.value = input.value));
}

dlBtn.addEventListener("click", () => {
  if (!lastSTL) return;
  const url = URL.createObjectURL(new Blob([lastSTL], { type: "model/stl" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "drum.stl";
  a.click();
  URL.revokeObjectURL(url);
});
