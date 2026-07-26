// Public entry for `partforge/lint`. Deliberately separate from `partforge/testing`,
// whose entry pulls in the WASM kernels and cannot load in a browser sandbox.
export { lintPart, RULES } from "./framework/lint/index.js";
