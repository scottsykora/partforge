import demoPart from "./parts/demo.js";
import { mount } from "./framework/index.js";

// Dev-only example app for the demo part (a parametric spacer). Identical wiring to
// app.js — the only thing that differs per part is which definition you import and
// which worker entry you point at. `npm run dev`, then open /demo.html.
mount(demoPart, {
  createWorker: (name) =>
    new Worker(new URL("./demo-worker.js", import.meta.url), { type: "module", name }),
});
