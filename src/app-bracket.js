import part from "./parts/bracket.js";
import { mount } from "./framework/index.js";

// Dev example app for the bracket demo (src/parts/bracket.js). The
// `new Worker(new URL(...))` call must stay inline here so Vite bundles the worker.
mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./bracket-worker.js", import.meta.url), { type: "module", name }),
});
