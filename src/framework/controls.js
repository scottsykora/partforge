// The control panel's public entry point. The implementation lives in panel/:
//
//   panel/legacy.js       the original advanced/toggles/features shapes
//   panel/model.js        canonical nodes -> render tree, plus conditions
//   panel/widget-specs.js the control-type registry (shared with partforge/lint)
//   panel/panel-state.js  one pure pass for visibility/disabling/dimming
//   panel/widgets/        one DOM factory per type
//   panel/render.js       the DOM binder
//
// This file stays at its path because animation-controls.js imports the popover
// helpers from it, and because it is the documented import site.
export { buildControls } from "./panel/render.js";
export { popoverTop, createInfoPopover, attachInfo } from "./panel/info.js";
export { clampToRange } from "./panel/widgets/numeric.js";
export { visibleAdvanced, visibleFeatures, visibleToggles, sectionRenders } from "./panel/legacy.js";
