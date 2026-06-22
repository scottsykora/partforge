import drumPart from "./parts/drum.js";
import { mount } from "./framework/index.js";

// The `new Worker(new URL(...))` must stay inline here so Vite bundles the worker
// (and its backend chunks); the framework receives this factory, not a bare URL.
mount(drumPart, {
  createWorker: (name) =>
    new Worker(new URL("./part-worker.js", import.meta.url), { type: "module", name }),
});
