// partforge — app entry (DOM). Apps call mount(); viewSubParts is handy for app-side
// view logic. This entry pulls in the viewer/controls (which use `document`), so it
// must NOT be imported from a part's build functions — those run in a Web Worker.
// Part build functions import geometry helpers from "partforge/geometry" instead.
export { mount } from "./framework/index.js";
export { viewSubParts } from "./framework/jobs.js";
export { resolveDerived } from "./framework/derive.js";
