import { buildView } from "./build.js";
import { buildBVH } from "./bvh.js";

// A measured pair distance at or below this (mm) counts as touching — absorbs
// posing float error while staying far below any real print clearance.
export const CONTACT_EPS = 1e-3;

// Minimum surface-to-surface distance for every sub-part pair of pre-built posed
// meshes ([{ name, mesh }] — buildView output). Distance 0 = touching or
// interpenetrating surfaces; callers filter. Pairs involving an empty mesh are
// skipped (the watertight gate owns that failure). Pure mesh math — both backends.
//   → [{ a, b, distance, at: [x,y,z] }]
export function meshGaps(built) {
  const bvhs = built
    .filter(({ mesh }) => mesh.positions.length > 0)
    .map(({ name, mesh }) => ({ name, bvh: buildBVH(mesh) }));
  const out = [];
  for (let i = 0; i < bvhs.length; i++) {
    for (let j = i + 1; j < bvhs.length; j++) {
      const { distance, at } = bvhs[i].bvh.distanceTo(bvhs[j].bvh);
      out.push({ a: bvhs[i].name, b: bvhs[j].name, distance, at });
    }
  }
  return out;
}

// Near-miss check for an assembled view — the complement of assemblyOverlaps:
// sub-part pairs that *almost* touch (0 < distance < threshold mm) in the display
// pose. Same posing path as assemblyOverlaps; no kernel booleans, so it runs on
// Manifold and OCCT alike.
//   → [{ a, b, distance, at }] (empty = no near misses)
export function assemblyGaps(kernel, part, view, params = {}, { threshold = 0.5 } = {}) {
  const gaps = meshGaps(buildView(kernel, part, view, params));
  kernel.cleanup?.(); // free the per-check WASM objects (meshes are JS-owned copies)
  return gaps.filter((g) => g.distance > CONTACT_EPS && g.distance < threshold);
}
