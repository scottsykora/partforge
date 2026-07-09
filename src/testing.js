// partforge/testing — utilities for testing parts headlessly (Manifold kernel, the
// job loop, the assembly collision check, an OCCT kernel, and mesh measures).
// See docs/AUTHORING-PARTS.md "Testing a part".
export { createManifoldKernel } from "./framework/geometry/manifold-backend.js";
export { bootManifoldKernel } from "./testing/manifold.js";
export { handle, viewSubParts } from "./framework/jobs.js";
export { resolveDerived } from "./framework/derive.js";
export { relevantParamKeys, RELEVANT_ALL } from "./framework/param-deps.js";
export { assemblyOverlaps } from "./framework/assembly.js";
export { assemblyGaps, meshGaps } from "./testing/gaps.js";
export { bootOcctKernel } from "./testing/occt.js";
export { meshVolume, bboxSize } from "./testing/mesh.js";
export { buildView } from "./testing/build.js";
export { measure } from "./testing/measure.js";
export { renderViews } from "./testing/render.js";
export { verify } from "./testing/verify.js";
export { buildBVH } from "./testing/bvh.js";
export { minWall } from "./testing/min-wall.js";
