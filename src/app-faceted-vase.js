import vasePart from "./parts/faceted-vase.js";
import { mount } from "./framework/index.js";

// Dev-only example app for the faceted vase part. Identical wiring to app-planter.js —
// only the imported definition and the worker entry differ per part. `npm run dev`,
// then open /faceted-vase.html.
mount(vasePart, {
  createWorker: (name) =>
    new Worker(new URL("./faceted-vase-worker.js", import.meta.url), { type: "module", name }),
});
