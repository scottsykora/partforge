// A stand-in for the closed oracle package, for CLI tests of `describe`'s OUTPUT
// PLUMBING (which shape goes where) without the real segmentation. Returns shapes a
// test can tell apart, nothing more. Pointed at via PARTFORGE_ORACLE.
export const describe = (kernel, solid, opts) => ({
  source: { name: opts.name, digest: opts.digest ?? null },
  surfaces: [{ id: "s0", type: "plane" }],
  edges: [],
  features: [{ id: "f0", type: "extrusion" }],
  truncated: { surfaces: false },
});
export const describeMemo = () => new Map();
export const compactDescribe = (full) => ({ source: full.source, features: full.features, compacted: true });
export const regionDescribe = (full, region) => ({ source: full.source, region, surfaces: full.surfaces });
