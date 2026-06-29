import planterPart from "./parts/planter.js";
import { mount } from "./framework/index.js";

// Dev-only example app for the faceted planter part. Identical wiring to app-demo.js —
// only the imported definition and the worker entry differ per part. `npm run dev`,
// then open /planter.html.
mount(planterPart, {
  createWorker: (name) =>
    new Worker(new URL("./planter-worker.js", import.meta.url), { type: "module", name }),
});
