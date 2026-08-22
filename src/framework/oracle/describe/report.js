// The two report shapes, defined together on purpose.
//
// FULL is the archive: everything measured, written to disk by `partforge describe
// --json`. COMPACT is what a model reads: features, patterns, symmetry, score,
// residual, and the suggestion, with surfaces and edges elided to counts.
//
// Both live here rather than compact being invented by each consumer. A 24k-triangle
// part yields hundreds of surfaces, and every consumer that trims them independently
// trims them differently — cloud's model-facing view and the CLI's summary would drift
// apart within a release. mountManager.js's compactReport is the precedent for the
// principle (a full oracle report is not a model-facing artefact) and the warning: it
// lives downstream, and its field renames have to be kept in sync by hand.
//
// Pure leaf. See spec §3.

import { DESCRIBE_LIMITS } from "./limits.js";

// Below this explained-area fraction the feature list is not trustworthy as a
// description of the part, and saying so quietly is worse than saying nothing: an agent
// will build against a confident-looking list that covers 61% of the geometry.
export const LOW_COVERAGE = 0.85;

// Caps are CEILINGS, not targets: slicing an oversized array is not a failure, it is
// the report doing its job. `flags[name]` records whether THIS array actually hit its
// ceiling, so `buildReport`'s `truncated` block only ever claims what really happened.
const cap = (arr, max, flags, name) => {
  const a = arr ?? [];
  flags[name] = a.length > max;
  return a.slice(0, max);
};

export function buildReport(input) {
  const truncated = {};
  return {
    source: {
      name: input.source?.name ?? null,
      digest: input.source?.digest ?? null,
      triangles: input.source?.triangles ?? 0,
      watertight: input.source?.watertight ?? null,
      units: "mm",
    },
    // Stated explicitly, every time. Z-up/Y-up confusion is a documented LLM failure
    // mode (research doc §5) and one line defuses it. "as-imported" is the honest
    // claim: describe never realigns, so the frame is whatever the file carried.
    frame: { up: "+Z", note: "as-imported; no realignment applied" },
    bounds: {
      min: input.bounds.min,
      max: input.bounds.max,
      size: [0, 1, 2].map((i) => input.bounds.max[i] - input.bounds.min[i]),
    },
    surfaces: cap(input.surfaces, DESCRIBE_LIMITS.MAX_SURFACES, truncated, "surfaces"),
    // input.arcs are the fitted edges between surface pairs (Tasks 6-7); reported here
    // as "edges" since that is what a reader of the report calls them. Each carries a
    // `convexity` of "convex" or "concave" — settled empirically to mean whether the
    // edge rounds an outside or an inside corner of the PART, nothing about how a
    // torus's own tube radius is parametrised. Easy to misread as the latter; it isn't.
    edges: cap(input.arcs, DESCRIBE_LIMITS.MAX_EDGES, truncated, "edges"),
    features: cap(input.features, DESCRIBE_LIMITS.MAX_FEATURES, truncated, "features"),
    patterns: cap(input.patterns, DESCRIBE_LIMITS.MAX_PATTERNS, truncated, "patterns"),
    symmetry: input.symmetry ?? [],
    residual: {
      areaFraction: input.residual?.areaFraction ?? 0,
      regions: cap(input.residual?.regions, DESCRIBE_LIMITS.MAX_RESIDUAL_REGIONS, truncated, "residualRegions"),
    },
    score: input.score,
    suggestion: input.suggestion
      ? { ...input.suggestion,
          steps: cap(input.suggestion.steps, DESCRIBE_LIMITS.MAX_SUGGESTION_STEPS, truncated, "suggestionSteps") }
      : null,
    truncated,
  };
}

export function compactDescribe(full) {
  const out = {
    source: full.source,
    frame: full.frame,
    bounds: full.bounds,
    counts: { surfaces: full.surfaces.length, edges: full.edges.length },
    features: full.features,
    patterns: full.patterns,
    symmetry: full.symmetry,
    residual: full.residual,
    score: full.score,
    suggestion: full.suggestion,
    truncated: full.truncated,
  };
  // A banner, not a field: it is the first key a reader hits, ahead of `features`, and
  // it says outright that the list below is not to be trusted as complete. This is the
  // single most important honesty property of the report — a confident-looking feature
  // list covering 61% of a part is worse than no report at all, because an agent will
  // build against it rather than notice what's missing.
  if ((full.score?.explainedArea ?? 0) < LOW_COVERAGE) {
    out.warning =
      `LOW COVERAGE: only ${(100 * (full.score?.explainedArea ?? 0)).toFixed(1)}% of this mesh's ` +
      `surface area is explained by the features below. Treat the feature list as incomplete — ` +
      `do not assume a feature is absent because it is not listed. See residual.regions for where ` +
      `the unexplained geometry is.`;
  }
  return out;
}
