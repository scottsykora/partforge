import part from "./parts/hull-sweep.js";
import { mount } from "./framework/index.js";

// Dev example app for the hull-sweep demo (src/parts/hull-sweep.js). The
// `new Worker(new URL(...))` call must stay inline here so Vite bundles the worker.
mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./hull-sweep-worker.js", import.meta.url), { type: "module", name }),
});
