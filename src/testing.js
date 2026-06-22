// partforge/testing — utilities for testing parts headlessly (Manifold kernel, the
// job loop, the assembly collision check, an OCCT kernel, and mesh measures).
// See docs/AUTHORING-PARTS.md "Testing a part".
export { createManifoldKernel } from "./framework/geometry/manifold-backend.js";
export { handle, viewSubParts } from "./framework/jobs.js";
export { assemblyOverlaps } from "./framework/assembly.js";
export { bootOcctKernel } from "./testing/occt.js";
export { meshVolume, bboxSize } from "./testing/mesh.js";
