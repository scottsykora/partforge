// Self-hosted Geist + Geist Mono for the dev demos, so a standalone forge looks
// like the product. Dev-only: --pf-sans/--pf-mono fall back to system stacks for
// any consumer that doesn't load them (spec §2.2).
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import part from "./parts/filleted-box.js";
import { mount } from "./framework/index.js";

mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./filleted-box-worker.js", import.meta.url), { type: "module", name }),
});
