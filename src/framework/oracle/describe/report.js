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

// Below this fraction the geometry is not trustworthy as a description of the part,
// and saying so quietly is worse than saying nothing: an agent will build against a
// confident-looking list that covers 61% of the geometry. See compactDescribe's own
// comment for what "this fraction" is measured against (fix round 1: it's the worse
// of two independent numbers, not just one of them).
export const LOW_COVERAGE = 0.85;

// Caps are CEILINGS, not targets: slicing an oversized array is not a failure, it is
// the report doing its job. `flags[name]` records whether THIS array actually hit its
// ceiling, so `buildReport`'s `truncated` block only ever claims what really happened.
const cap = (arr, max, flags, name) => {
  const a = arr ?? [];
  flags[name] = a.length > max;
  return a.slice(0, max);
};

// score is passed straight through except for one added field: a plain-language note
// distinguishing its two coverage numbers. `explainedArea` (segment.js/surface-graph.js
// territory) is how much of the mesh's SURFACE was fit by a surface type; it says
// nothing about whether that surface was ever turned into a reconstructable feature.
// `explainedVolumeFraction` (accept.js) is how much of the part's VOLUME the accepted
// candidates actually rebuild — the number that matters to an agent deciding whether it
// can trust the feature list to rebuild the part. They can diverge totally: a sphere
// segments at explainedArea ~1 (it fits a sphere surface cleanly) while contributing
// explainedVolumeFraction 0 (no detector treats a sphere as a candidate-eligible
// feature type, so accept.js never gets a candidate to build from it at all). Spelled
// out here, in the data, because the consumer is an LLM that cannot go read accept.js's
// comments to work out that these are different measurements (fix round 1, IMPORTANT 5).
const SCORE_NOTE =
  "explainedArea is surface coverage from segmentation (how much of the mesh's area " +
  "was fit by a surface); explainedVolumeFraction is shape coverage from " +
  "reconstruction (how much of the part's volume the accepted features actually " +
  "rebuild). These are different measurements and can diverge totally — a part can " +
  "be ~100% segmented and 0% reconstructed. The LOW COVERAGE banner, if present, " +
  "reflects whichever of the two is worse.";

function buildScore(score) {
  return { ...(score ?? {}), note: SCORE_NOTE };
}

export function buildReport(input) {
  // Every array this report might cap gets a flag here, initialised false, before any
  // capping happens — so the shape is TOTAL. A cap never hit, and an array the input
  // never supplied at all (e.g. no suggestion yet, before Task 12's orchestrator is
  // wired in), must both report `false`, not an absent key: a consumer that walks
  // `Object.values(truncated)` needs every flag present every time, or "nothing was
  // truncated" and "the flag is just missing" become indistinguishable (fix round 1,
  // IMPORTANT 4).
  const truncated = {
    surfaces: false,
    edges: false,
    features: false,
    patterns: false,
    residualRegions: false,
    suggestionSteps: false,
  };

  const surfaces = cap(input.surfaces, DESCRIBE_LIMITS.MAX_SURFACES, truncated, "surfaces");
  // input.arcs are the fitted edges between surface pairs (Tasks 6-7); reported here
  // as "edges" since that is what a reader of the report calls them. Each carries a
  // `convexity` of "convex" or "concave" — settled empirically to mean whether the
  // edge rounds an outside or an inside corner of the PART, nothing about how a
  // torus's own tube radius is parametrised. Easy to misread as the latter; it isn't.
  const edges = cap(input.arcs, DESCRIBE_LIMITS.MAX_EDGES, truncated, "edges");
  const features = cap(input.features, DESCRIBE_LIMITS.MAX_FEATURES, truncated, "features");
  const patterns = cap(input.patterns, DESCRIBE_LIMITS.MAX_PATTERNS, truncated, "patterns");
  const residualRegions = cap(
    input.residual?.regions, DESCRIBE_LIMITS.MAX_RESIDUAL_REGIONS, truncated, "residualRegions"
  );
  // Capped even when there is no suggestion yet (input.suggestion null/undefined) so
  // `truncated.suggestionSteps` is always `false` in that case, never absent — see the
  // flag block's own comment above.
  const suggestionSteps = cap(
    input.suggestion?.steps, DESCRIBE_LIMITS.MAX_SUGGESTION_STEPS, truncated, "suggestionSteps"
  );

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
    // Pre-cap magnitudes, computed from the INPUT, not from `surfaces`/`edges` below.
    // Those two arrays are what compactDescribe elides to counts, and a cap that fires
    // must not also erase how big the thing it capped really was: 500 input surfaces
    // against MAX_SURFACES=200 must still say 500 here, not silently report 200 as if
    // that were the whole part (fix round 1, IMPORTANT 3).
    counts: {
      surfaces: (input.surfaces ?? []).length,
      edges: (input.arcs ?? []).length,
    },
    surfaces,
    edges,
    features,
    patterns,
    symmetry: input.symmetry ?? [],
    residual: {
      areaFraction: input.residual?.areaFraction ?? 0,
      regions: residualRegions,
    },
    score: buildScore(input.score),
    suggestion: input.suggestion ? { ...input.suggestion, steps: suggestionSteps } : null,
    truncated,
  };
}

export function compactDescribe(full) {
  // Gate on the WORSE of the two coverage numbers (see SCORE_NOTE above), not just
  // explainedArea. Reproduced directly against the real pipeline with a 2304-triangle
  // hemisphere: one sphere surface plus one flat base segment cleanly
  // (explainedArea 1.0, zero unassigned triangles) but sphere is not a
  // candidate-eligible type for any of the four feature detectors, so accept.js is
  // handed zero candidates and explainedVolumeFraction is 0.0. Gating on explainedArea
  // alone let a report that reconstructs NONE of the part's shape present as clean —
  // exactly backwards for a banner whose whole job is to catch that (fix round 1,
  // CRITICAL 1). `?? 0` on each side means a missing number reads as unexplained, not
  // as "fine" — the fail-safe direction for a report whose job is to not overclaim.
  const explainedArea = full.score?.explainedArea ?? 0;
  const explainedVolume = full.score?.explainedVolumeFraction ?? 0;
  const coverage = Math.min(explainedArea, explainedVolume);

  const out = {};
  // Assigned FIRST — and therefore serialized first, both by Object.keys() and by
  // JSON.stringify(), which both preserve insertion order for string keys — so an LLM
  // reading the raw JSON hits the banner before anything it might otherwise take at
  // face value. (Fix round 1, CRITICAL 2: this used to be assigned after the rest of
  // `out` was built, which put it last in both orders — exactly backwards for a banner
  // whose entire job is to be seen first.)
  if (coverage < LOW_COVERAGE) {
    out.warning =
      `LOW COVERAGE: only ${(100 * coverage).toFixed(1)}% of this part is explained ` +
      `(the worse of ${(100 * explainedArea).toFixed(1)}% surface area fit and ` +
      `${(100 * explainedVolume).toFixed(1)}% shape reconstructed). Treat the feature ` +
      `list as incomplete — do not assume a feature is absent because it is not ` +
      `listed. See residual.regions for where the unexplained geometry is.`;
  }
  out.source = full.source;
  out.frame = full.frame;
  out.bounds = full.bounds;
  // Pre-cap counts, straight from `full.counts` — see buildReport's own comment on why
  // these must not be derived from the (possibly-capped) `full.surfaces`/`full.edges`.
  out.counts = full.counts;
  out.features = full.features;
  out.patterns = full.patterns;
  out.symmetry = full.symmetry;
  out.residual = full.residual;
  out.score = full.score;
  out.suggestion = full.suggestion;
  out.truncated = full.truncated;
  return out;
}
