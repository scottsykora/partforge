// Public surface for the click-to-select module. The future agent harness depends
// only on attachPicker's onPick callback + the Selection contract — nothing else.
export { resolveSelection, quantizePoint, snapNormal } from "./resolve.js";
export { formatSelection } from "./format.js";
export { attachPicker, worldToSubPartLocal } from "./pick.js";
export { attachPickToggle } from "./pick-toggle.js";
export { raycastViewer, featureAt } from "./raycast.js";
