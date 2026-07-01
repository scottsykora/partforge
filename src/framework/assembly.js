import { viewSubParts, resolveParams, buildPosed } from "./jobs.js";

// Collision check for an assembled view: build each sub-part in its display
// (assembly) pose and return the pairs whose solid-intersection volume exceeds
// `tolerance` (mm³) — i.e. parts that interpenetrate rather than merely touch.
// Parts meant to fit together (e.g. a block seated in a pocket void) read ~0 and
// don't trip it. Manifold-only (needs Solid.intersect + Solid.volume); meant for
// part tests so an author/LLM editing a part sees collisions fail.
//   → [{ a, b, volume }] for each offending pair (empty = no collisions)
export function assemblyOverlaps(kernel, part, view, params = {}, { tolerance = 1 } = {}) {
  const { p, d } = resolveParams(part, params);
  const posed = viewSubParts(part, view, p).map((name) => ({
    name,
    solid: buildPosed(kernel, part, name, { purpose: "display", view, p, d }),
  }));

  const overlaps = [];
  for (let i = 0; i < posed.length; i++) {
    for (let j = i + 1; j < posed.length; j++) {
      const volume = posed[i].solid.intersect(posed[j].solid).volume();
      if (volume > tolerance) overlaps.push({ a: posed[i].name, b: posed[j].name, volume });
    }
  }
  kernel.cleanup?.(); // free the per-check WASM objects
  return overlaps;
}
