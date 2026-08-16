import part from "./parts/mixed-smoke.js";
import { mount } from "./framework/index.js";

// Dev/CI-only app for the mixed-backend smoke fixture — see parts/mixed-smoke.js.
// Handle stashed for scripts/check-app.mjs, same as the other smoke apps.
window.__pfRuntime = mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./mixed-smoke-worker.js", import.meta.url), { type: "module", name }),
});
