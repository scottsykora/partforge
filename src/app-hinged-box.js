import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import hingedBox from "./parts/hinged-box.js";
import { mount } from "./framework/index.js";

// Dev-only example app for the hinged-box part (the animation reference part).
// `npm run dev`, then open /hinged-box.html. The worker URL must stay inline
// so Vite bundles it.
window.__pfRuntime = mount(hingedBox, {
  createWorker: (name) =>
    new Worker(new URL("./hinged-box-worker.js", import.meta.url), { type: "module", name }),
});
