// partforge/testing — utilities for testing parts headlessly (Manifold kernel, the
// job loop, the assembly collision check, an OCCT kernel, and mesh measures).
// See docs/AUTHORING-PARTS.md "Testing a part".
//
// Most of what this re-exports is NOT test-only code: the oracle (measure/verify/
// buildView/gaps/BVH/min-wall) also runs inside the browser geometry worker, so it
// lives in src/framework/oracle/. Only the Node-bound harness — the two kernel
// booters, the PNG renderer — lives in src/testing/. This barrel is the published
// entry point and hides that split from downstream consumers.
export { createManifoldKernel } from "./framework/geometry/manifold-backend.js";
export { bootManifoldKernel } from "./testing/manifold.js";
export { handle } from "./framework/jobs.js";
export { viewSubParts } from "./framework/part-model.js";
export { resolveDerived } from "./framework/derive.js";
export { relevantParamKeys, RELEVANT_ALL } from "./framework/param-deps.js";
export { assemblyOverlaps } from "./framework/assembly.js";
export { assemblyGaps, meshGaps } from "./framework/oracle/gaps.js";
export { bootOcctKernel } from "./testing/occt.js";
export { meshVolume, bboxSize } from "./framework/oracle/mesh.js";
export { buildView } from "./framework/oracle/build.js";
export { measure } from "./framework/oracle/measure.js";
export { renderViews, RENDER_VIEWS } from "./testing/render.js";
export { verify } from "./framework/oracle/verify.js";
export { buildBVH } from "./framework/oracle/bvh.js";
export { minWall } from "./framework/oracle/min-wall.js";
// Silhouette match scoring — also worker-reachable (the `inspect` job scores
// `matchTargets` with exactly these), re-exported so a downstream harness can build
// the same masks and reproduce a score outside the job loop.
export { MATCH_VIEWS, rasterizeMeshMask, rasterizeRingsMask } from "./framework/oracle/silhouette.js";
export { matchMasks, matchViews } from "./framework/oracle/match.js";
