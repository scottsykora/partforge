import part from "./parts/filleted-box.js";
import { mount } from "./framework/index.js";

mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./filleted-box-worker.js", import.meta.url), { type: "module", name }),
});
