import planterPart from "./parts/planter.js";
import { mount } from "./framework/index.js";

// Dev-only smoke harness for the 0.12.0 embedding contract (see embed-test.html).
// Exercises: explicit `elements` refs (no legacy IDs on the page), runtime.ready,
// runtime.dispose() (including dispose-before-first-build and rapid remount cycles),
// onBuild outcomes, and always-on onPick with the { selection, label, prompt, token }
// payload — i.e. exactly what partforge-cloud's chat chips will consume.

const logEl = document.getElementById("log");
function log(kind, msg) {
  const line = document.createElement("div");
  line.className = kind;
  line.textContent = `${new Date().toISOString().slice(11, 19)} ${msg}`;
  logEl.prepend(line);
}

const byId = (id) => document.getElementById(id);
const elements = {
  viewer: byId("pf-viewer"),
  controls: byId("pf-controls"),
  status: { status: byId("pf-status"), busy: byId("pf-busy"), phase: byId("pf-phase") },
  tabs: byId("pf-tabs"),
  exports: { stl: byId("pf-stl"), step: byId("pf-step") }, // no 3MF button on purpose (optional)
  chrome: { pause: byId("pf-pause"), reframe: byId("pf-reframe"), theme: byId("pf-theme") },
};

let runtime = null;

function doMount() {
  if (runtime) { log("life", "already mounted — dispose first"); return; }
  runtime = mount(planterPart, {
    createWorker: (name) =>
      new Worker(new URL("./planter-worker.js", import.meta.url), { type: "module", name }),
    elements,
    onBuild: (b) => log("build", `onBuild: ${b.status}${b.ms != null ? ` (${Math.round(b.ms)} ms)` : ""}${b.error ? ` — ${b.error}` : ""}`),
    onPick: ({ label, prompt, token, selection }) => {
      log("pick", `onPick label="${label}"`);
      log("pick", `  prompt: ${prompt}`);
      log("pick", `  token:  ${token}`);
      console.log("onPick payload", { label, prompt, token, selection });
    },
  });
  log("life", "mounted");
  runtime.ready.then(
    () => log("life", "ready ✓ (first build succeeded)"),
    (e) => log("life", `ready ✗ (${e.message})`),
  );
}

function doDispose() {
  if (!runtime) { log("life", "not mounted"); return; }
  runtime.dispose();
  runtime.dispose(); // idempotence check — must be a no-op
  runtime = null;
  log("life", "disposed (×2 — second call must be a no-op)");
}

document.getElementById("btn-mount").addEventListener("click", doMount);
document.getElementById("btn-dispose").addEventListener("click", doDispose);
// The React-unmount torture test: dispose immediately after mount, repeatedly.
// Expect five "ready ✗ (disposed before first build)" lines, then a final clean mount.
document.getElementById("btn-cycle").addEventListener("click", () => {
  for (let i = 0; i < 5; i++) { doDispose(); doMount(); doDispose(); }
  doMount();
});

doMount();
