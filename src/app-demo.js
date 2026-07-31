// Self-hosted Geist + Geist Mono for the dev demos, so a standalone forge looks
// like the product. Dev-only: --pf-sans/--pf-mono fall back to system stacks for
// any consumer that doesn't load them (spec §2.2).
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import demoPart from "./parts/demo.js";
import { mount } from "./framework/index.js";

// Dev-only example app for the demo part (a parametric spacer). Identical wiring to
// app.js — the only thing that differs per part is which definition you import and
// which worker entry you point at. `npm run dev`, then open /demo.html.
// Dev-only: the handle is stashed on window so scripts/check-app.mjs can drive
// the embedding contract (runtime.captureCurrent) the way an embedder would.
window.__pfRuntime = mount(demoPart, {
  createWorker: (name) =>
    new Worker(new URL("./demo-worker.js", import.meta.url), { type: "module", name }),
});
