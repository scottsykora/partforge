import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import emblemPart from "./parts/emblem.js";
import { mount } from "./framework/index.js";

// Dev-only example app for the emblem part (the k.svg2d reference).
// `npm run dev`, then open /emblem.html.
window.__pfRuntime = mount(emblemPart, {
  createWorker: (name) =>
    new Worker(new URL("./emblem-worker.js", import.meta.url), { type: "module", name }),
  onAnnotationSend: (payload) => {
    window.__pfLastAnnotation = payload;
    console.log("annotation payload", payload);
  },
});
