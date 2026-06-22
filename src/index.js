// partforge — public API. Apps call mount(); part build functions use the polygon
// helpers; viewSubParts is handy for app-side view logic.
export { mount } from "./framework/index.js";
export { viewSubParts } from "./framework/jobs.js";
export { piePolygon, hexPolygon } from "./framework/geometry/polygon.js";
