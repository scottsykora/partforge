// Self-hosted Geist + Geist Mono for the dev demos, so a standalone forge looks
// like the product. Dev-only: --pf-sans/--pf-mono fall back to system stacks for
// any consumer that doesn't load them (spec §2.2).
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import part from "./parts/text-smoke.js";
import { mount } from "./framework/index.js";

// Dev-only example app for the text-smoke part (src/parts/text-smoke.js). Identical
// wiring to app-demo.js — this fixture exists to run the resolved-text build through
// the real Vite Web Worker path (see scripts/check-app.mjs text-smoke.html).
mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./text-smoke-worker.js", import.meta.url), { type: "module", name }),
});
