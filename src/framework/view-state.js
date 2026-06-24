// Persist a little viewer UI state across browser reloads (notably Vite dev
// auto-refresh) in localStorage. All keys are global. Reads/writes are guarded:
// if localStorage is unavailable (private mode, disabled) or a value is corrupt,
// reads return the documented default and writes are no-ops — persistence never
// throws. Theme is persisted separately (in mount.js) and is not handled here.

const KEY = {
  rotating: "partforge:rotating",
  camera: "partforge:camera",
  view: "partforge:view",
};

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable — no-op */ }
}

const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));

export function loadRotating() {
  const raw = read(KEY.rotating);
  if (raw === "false") return false;
  if (raw === "true") return true;
  return true; // default: auto-rotate on (matches the viewer's default)
}

export function saveRotating(on) {
  write(KEY.rotating, on ? "true" : "false");
}

export function loadCamera() {
  const raw = read(KEY.camera);
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (parsed && isVec3(parsed.pos) && isVec3(parsed.target)) {
    return { pos: parsed.pos, target: parsed.target };
  }
  return null;
}

export function saveCamera(state) {
  if (!state || !isVec3(state.pos) || !isVec3(state.target)) return;
  write(KEY.camera, JSON.stringify({ pos: state.pos, target: state.target }));
}

export function loadView() {
  return read(KEY.view); // raw string or null; caller validates against available tabs
}

export function saveView(name) {
  if (typeof name === "string" && name) write(KEY.view, name);
}
