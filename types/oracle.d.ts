// partforge/oracle — types for the oracle's own entry (src/oracle.js).
//
// The declarations themselves live in testing.d.ts, where this surface was first
// published; this file re-exports exactly the names src/oracle.js exports, plus the
// report/mask/gap types a caller needs to annotate results. If the oracle ever moves
// to its own package, the declarations migrate here and testing.d.ts re-exports
// instead — the direction flips, the names don't.
export type { GeometryKernel, Mesh, PartDefinition, ResolvedParams, Solid } from "./testing.js";
export {
  // measurement + verification
  measure, verify, buildView,
  type MeasureReport, type SubPartFacts, type AggregateFacts, type BuiltSubPart,
  type VerifyReport, type VerifyCaseResult, type VerifyCheck, type CheckStatus,
  // mesh facts, gaps, BVH, min wall
  meshVolume, bboxSize, assemblyGaps, meshGaps, buildBVH, minWall,
  type Gap, type BVH,
  // silhouette match scoring
  MATCH_VIEWS, rasterizeMeshMask, rasterizeRingsMask, matchMasks, matchViews,
  type SilhouetteMask, type MatchScores, type MatchDelta,
  // the semantic mesh oracle
  describe, describeMemo, compactDescribe,
  DESCRIBE_ERRORS, DESCRIBE_LIMITS, LOW_COVERAGE,
  type DescribeReport, type DescribeCompactReport, type DescribeFailure,
  type DescribeSurface, type DescribeArc, type DescribeFeature, type DescribePattern,
  type DescribeResidualRegion, type DescribeSuggestion, type DescribeSuggestionStep,
  type DescribeScore, type DescribeTruncated, type Snapped,
} from "./testing.js";
