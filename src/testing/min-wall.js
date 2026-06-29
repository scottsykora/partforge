// src/testing/min-wall.js
// Min wall thickness by ray/shot on a triangle BVH (see the spec's spike: this beat the
// voxel/SDF approach on both accuracy and speed). For each surface triangle, cast a ray
// inward (reverse of its outward normal) from the centroid; the nearest hit is the local
// material thickness. The minimum across samples is the reported min wall.
import { buildBVH } from "./bvh.js";

export function minWall(mesh, { maxThickness } = {}) {
  const pos = mesh.positions;
  const n = pos.length / 9;
  if (n === 0) return null;

  // bbox diagonal as the default cap (a ray exiting into open air gets no hit anyway).
  if (maxThickness == null) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) { if (pos[i + a] < min[a]) min[a] = pos[i + a]; if (pos[i + a] > max[a]) max[a] = pos[i + a]; }
    maxThickness = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) + 1;
  }

  const bvh = buildBVH(mesh);
  let best = Infinity, loc = null;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const v0 = [pos[o], pos[o + 1], pos[o + 2]];
    const v1 = [pos[o + 3], pos[o + 4], pos[o + 5]];
    const v2 = [pos[o + 6], pos[o + 7], pos[o + 8]];
    const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;                       // degenerate triangle
    nx /= len; ny /= len; nz /= len;                // outward normal (manifold winding)
    const c = [(v0[0] + v1[0] + v2[0]) / 3, (v0[1] + v1[1] + v2[1]) / 3, (v0[2] + v1[2] + v2[2]) / 3];
    const dir = [-nx, -ny, -nz];                    // inward
    const origin = [c[0] + dir[0] * 1e-4, c[1] + dir[1] * 1e-4, c[2] + dir[2] * 1e-4];
    const hit = bvh.raycast(origin, dir, { tMax: maxThickness, skipTri: t });
    if (hit && hit.t < best) { best = hit.t; loc = c; }
  }
  return best === Infinity ? null : { value: best, location: loc };
}
