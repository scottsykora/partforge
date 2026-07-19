import part from "./parts/nameplate.js";
import { mount } from "./framework/index.js";

// Dev example app for the nameplate demo (src/parts/nameplate.js). The
// `new Worker(new URL(...))` call must stay inline here so Vite bundles the worker.
mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./nameplate-worker.js", import.meta.url), { type: "module", name }),
});
