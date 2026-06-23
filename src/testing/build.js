import { viewSubParts } from "../framework/jobs.js";

// Build every sub-part of a view in its display (assembly) pose with the given
// Manifold kernel, returning live solids + copied-out meshes. Mirrors the
// `generate` path in jobs.js, but keeps solids LIVE (does NOT call
// kernel.cleanup()) so callers can read exact solid facts (volume/genus/empty)
// before they free the kernel. Meshes are JS-owned arrays and survive cleanup.
export function buildView(kernel, part, view, params = {}) {
  const p = { ...part.defaults, ...params };
  const d = part.derive ? part.derive(p) : {};
  return viewSubParts(part, view, p).map((name) => {
    const sp = part.parts[name];
    let solid = sp.build(kernel, p, d);
    if (sp.place) solid = sp.place(solid, { view, purpose: "display", p, d });
    return { name, solid, mesh: solid.toMesh() };
  });
}
