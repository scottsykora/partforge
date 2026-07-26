// Self-hosted Geist + Geist Mono for the dev demos, so a standalone forge looks
// like the product. Dev-only: --pf-sans/--pf-mono fall back to system stacks for
// any consumer that doesn't load them (spec §2.2).
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import planterPart from "./parts/planter.js";
import { mount } from "./framework/index.js";

// Dev-only example app for the faceted planter part. Identical wiring to app-demo.js —
// only the imported definition and the worker entry differ per part. `npm run dev`,
// then open /planter.html.
mount(planterPart, {
  createWorker: (name) =>
    new Worker(new URL("./planter-worker.js", import.meta.url), { type: "module", name }),
});
