// Self-hosted Geist + Geist Mono for the dev demos, so a standalone forge looks
// like the product. Dev-only: --pf-sans/--pf-mono fall back to system stacks for
// any consumer that doesn't load them (spec §2.2).
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import part from "./parts/nameplate.js";
import { mount } from "./framework/index.js";

// Dev example app for the nameplate demo (src/parts/nameplate.js). The
// `new Worker(new URL(...))` call must stay inline here so Vite bundles the worker.
mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./nameplate-worker.js", import.meta.url), { type: "module", name }),
});
