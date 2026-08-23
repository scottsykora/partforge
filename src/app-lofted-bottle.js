// Self-hosted Geist + Geist Mono for the dev demos, so a standalone forge looks
// like the product. Dev-only: --pf-sans/--pf-mono fall back to system stacks for
// any consumer that doesn't load them (spec §2.2).
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import loftedBottlePart from "./parts/lofted-bottle.js";
import { mount } from "./framework/index.js";

// Dev-only example app for the lofted-bottle part (the Shape2D-loft reference part).
// Identical wiring to app.js — the only thing that differs per part is which definition
// you import and which worker entry you point at. `npm run dev`, then open
// /lofted-bottle.html.
// Dev-only: the handle is stashed on window so scripts/check-app.mjs can drive
// the embedding contract (runtime.captureCurrent) the way an embedder would.
window.__pfRuntime = mount(loftedBottlePart, {
  createWorker: (name) =>
    new Worker(new URL("./lofted-bottle-worker.js", import.meta.url), { type: "module", name }),
  onAnnotationSend: (payload) => {
    window.__pfLastAnnotation = payload;
    console.log("annotation payload", payload);
  },
});
