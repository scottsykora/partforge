// Metric registry: name → how to pull the value out of facts, whether a failure
// is a hard gate or a warning, and the diagnostics attached to a non-pass check:
// `hint` (required — the report contract promises one on every fail/warn),
// `pattern` (optional stable ERROR-PATTERNS.md#<id>), `locate` (optional
// [x,y,z] source), `note` (optional caveat about HOW the value was measured,
// attached whatever the status — a passing-but-sampled reading is exactly the
// case a reader needs told about). `manifoldOnly` facts are null on OCCT parts.
//
// This lives in framework/ rather than testing/ deliberately: the set of legal
// `verify.expect` metrics is part of the PartDefinition CONTRACT, which both the
// verify runner (testing) and the linter (partforge/lint) must agree on. Keeping
// it here lets the linter import the vocabulary without reaching measure.js or
// jobs.js, which pull in the geometry kernels. This module must stay import-free.
export const SUBPART_METRICS = {
  holes: { kind: "gate", manifoldOnly: true, extract: (s) => s.holes,
    hint: "genus is wrong — an unintended tunnel exists or an intended bore is blocked; make cut tools pierce fully (overcut past the faces)" },
  watertight: { kind: "gate", manifoldOnly: true, extract: (s) => s.watertight,
    hint: "a boolean produced an open shell — check for coplanar faces or a cut that exactly grazes a surface",
    pattern: "boolean-not-watertight" },
  volume: { kind: "gate", extract: (s) => s.volume,
    hint: "solid volume is out of range — a feature is missing, doubled, or a governing parameter is mis-scaled" },
  surfaceArea: { kind: "gate", extract: (s) => s.surfaceArea,
    hint: "surface area is out of range — detail features (facets, ribs, textures) are missing or doubled" },
  triangleCount: { kind: "gate", extract: (s) => s.triangleCount,
    hint: "triangle count is out of range — tessellation quality or feature count changed unexpectedly" },
  bbox: { kind: "gate", extract: (s) => s.bbox,
    hint: "bounding box is out of range — check the governing dimensions and the part's orientation" },
  centerOfMass: { kind: "gate", extract: (s) => s.centerOfMass,
    hint: "center of mass is outside the expected region — mass is distributed differently than intended; check feature placement or a mis-scaled sub-part" },
  boundsMin: { kind: "gate", extract: (s) => s.bounds?.min,
    hint: "the low corner is out of range — the part is positioned or oriented differently than expected" },
  boundsMax: { kind: "gate", extract: (s) => s.bounds?.max,
    hint: "the high corner is out of range — the part is positioned or oriented differently than expected" },
  minWall: { kind: "warn", extract: (s) => s.minWall,
    hint: "thinnest wall is at the reported location — increase the governing wall/thickness parameter or reduce the intersecting feature's depth",
    pattern: "minwall-sliver-triangles",
    locate: (s) => s.minWallAt,
    note: (s) => (s.minWallSampled && s.minWallSamples
      ? `sampled ${s.minWallSamples.sampled} of ${s.minWallSamples.total} triangles — an upper bound; a thinner spot may exist between samples`
      : null) },
};
export const VIEW_METRICS = {
  bbox: { kind: "gate", extract: (r) => r.aggregate.bbox,
    hint: "the assembled view exceeds its size limit — shrink the assembly or pick a process with a larger bed" },
  volume: { kind: "gate", extract: (r) => r.aggregate.volume,
    hint: "total assembly volume is out of range — a sub-part is missing, doubled, or mis-scaled" },
  overlaps: { kind: "gate", extract: (r) => r.overlaps.length,
    hint: "sub-parts interpenetrate near the reported location — adjust placement or add clearance in derive()",
    locate: (r) => r.overlaps[0]?.location ?? null },
  centerOfMass: { kind: "gate", extract: (r) => r.aggregate.centerOfMass,
    hint: "the assembly's center of mass is outside the expected region — a sub-part is mis-placed or mis-scaled" },
  boundsMin: { kind: "gate", extract: (r) => r.aggregate.bounds?.min,
    hint: "the assembly's low corner is out of range — check placement or orientation" },
  boundsMax: { kind: "gate", extract: (r) => r.aggregate.bounds?.max,
    hint: "the assembly's high corner is out of range — check placement or orientation" },
};
