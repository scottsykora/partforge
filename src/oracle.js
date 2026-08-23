// partforge/oracle — the geometric oracle as its own published entry.
//
// This is the SEAM between the oracle and everything that consumes it. The same
// modules serve three callers: the geometry worker lazy-loads them per job family
// (see jobs.js — an `inspect` pulls measure/verify/build, a `describe` pulls the
// describe stack, and the generate/export hot path pulls none), the CLI and Node
// harnesses import them here directly, and partforge/testing re-exports this whole
// surface so an existing downstream import keeps working. Everything below is
// DOM-free, three-free and node:-free — test/oracle-entry.test.js walks the closure
// and holds that, so the entry stays importable from a worker, a browser, or Node
// alike. If the oracle ever moves to its own package, this file is the boundary
// consumers are already importing through.
export { assemblyGaps, meshGaps } from "./framework/oracle/gaps.js";
export { meshVolume, bboxSize } from "./framework/oracle/mesh.js";
export { buildView } from "./framework/oracle/build.js";
export { measure } from "./framework/oracle/measure.js";
export { verify } from "./framework/oracle/verify.js";
export { buildBVH } from "./framework/oracle/bvh.js";
export { minWall } from "./framework/oracle/min-wall.js";
// Silhouette match scoring — the `inspect` job scores `matchTargets` with exactly
// these, re-exported so a downstream harness can reproduce a score outside the job loop.
export { MATCH_VIEWS, rasterizeMeshMask, rasterizeRingsMask } from "./framework/oracle/silhouette.js";
export { matchMasks, matchViews } from "./framework/oracle/match.js";
// The semantic mesh oracle — what the `describe` job runs.
export { describe, describeMemo, DESCRIBE_ERRORS } from "./framework/oracle/describe.js";
export { compactDescribe, LOW_COVERAGE } from "./framework/oracle/describe/report.js";
export { DESCRIBE_LIMITS } from "./framework/oracle/describe/limits.js";
