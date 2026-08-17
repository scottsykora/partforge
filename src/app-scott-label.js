// Local test harness for the "Scott Layered Label" cloud part (feedback report
// 41850ea2, part 0d47960f) — the reflex-rim-pivot fix's real-world fixture. The
// part source is a verbatim copy from the cloud part's part.js into
// src/parts/scott-label.js. `npm run dev`, then open /scott-label.html.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import part from "./parts/scott-label.js";
import { mount } from "./framework/index.js";

mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./scott-label-worker.js", import.meta.url), { type: "module", name }),
});
