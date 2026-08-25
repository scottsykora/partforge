// SPIKE — THROWAWAY glue for the loftSmooth propeller spike (see parts/propeller-spike.js).
// Dev-only: `npm run dev`, then open /propeller-spike.html.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import part from "./parts/propeller-spike.js";
import { mount } from "./framework/index.js";

window.__pfRuntime = mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./propeller-spike-worker.js", import.meta.url), { type: "module", name }),
});
