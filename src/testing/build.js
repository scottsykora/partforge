import { viewSubParts, resolveParams, buildPosed } from "../framework/jobs.js";

// Build every sub-part of a view in its display (assembly) pose with the given
// Manifold kernel, returning live solids + copied-out meshes. Mirrors the
// `generate` path in jobs.js, but keeps solids LIVE (does NOT call
// kernel.cleanup()) so callers can read exact solid facts (volume/genus/empty)
// before they free the kernel. Meshes are JS-owned arrays and survive cleanup.
export function buildView(kernel, part, view, params = {}) {
  const { p, d } = resolveParams(part, params);
  return viewSubParts(part, view, p).map((name) => {
    const solid = buildPosed(kernel, part, name, { purpose: "display", view, p, d });
    return { name, solid, mesh: solid.toMesh() };
  });
}
