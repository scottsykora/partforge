// Glue for the loftSmooth propeller reference part (see parts/propeller.js).
// Dev-only: `npm run dev`, then open /propeller.html.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import part from "./parts/propeller.js";
import { mount } from "./framework/index.js";

window.__pfRuntime = mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./propeller-worker.js", import.meta.url), { type: "module", name }),
});
