// Self-hosted Geist + Geist Mono for the dev demos, so a standalone forge looks
// like the product. Dev-only: --pf-sans/--pf-mono fall back to system stacks for
// any consumer that doesn't load them (spec §2.2).
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import screwPart from "./parts/screw.js";
import { mount } from "./framework/index.js";

// Dev-only example app for the screw reference part. `npm run dev`, then open /screw.html.
// The `new Worker(new URL(...))` call must stay inline here or Vite will not bundle it.
// Dev-only: the handle is stashed on window so scripts/check-app.mjs can drive
// the embedding contract (runtime.captureCurrent) the way an embedder would.
window.__pfRuntime = mount(screwPart, {
  createWorker: (name) =>
    new Worker(new URL("./screw-worker.js", import.meta.url), { type: "module", name }),
});
