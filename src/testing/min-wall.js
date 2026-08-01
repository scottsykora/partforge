// src/testing/min-wall.js
// Min wall thickness by ray/shot on a triangle BVH (see the spec's spike: this beat the
// voxel/SDF approach on both accuracy and speed). For each surface triangle, cast a ray
// inward (reverse of its outward normal) from the centroid; the nearest hit is the local
// material thickness. The minimum across samples is the reported min wall.
// Works with both Manifold non-indexed meshes and OCCT indexed meshes (via the BVH's
// flat vertex store — never materialize a triangle-per-object list here, that is the
// allocation this pass exists to avoid).
//
// SAMPLING CONTRACT. One ray per triangle is unbounded work, and a dense mesh makes it
// the dominant cost of the inspect job: ~1.9 s and hundreds of megabytes of transient
// garbage at 400k triangles on a laptop, several times that on a phone. Past
// MAX_SAMPLES triangles the pass casts from a spread subset instead, and SAYS SO —
// the result always carries { sampled, sampledTriangles, totalTriangles }, so a
// report consumer can tell a guaranteed minimum from a lower-confidence one. A
// sampled reading is an upper bound on the true minimum: it can miss a thin spot,
// never invent one.
import { cachedBVH } from "./bvh.js";

// Triangle budget above which minWall samples. Chosen so the parts people actually
// author stay exact: everything in src/parts/ is 200–10,000 triangles, and a
// preview-quality mesh of a fairly ornate part lands in the low tens of thousands.
// 50,000 is comfortably above both while capping the pass at roughly a quarter
// second — dense enough meshes (a high-facet lathe, a big imported STEP tessellation)
// are the only ones that engage it. Override per call with `{ maxSamples }`.
const MAX_SAMPLES = 50_000;

const gcd = (a, b) => { while (b) { const t = a % b; a = b; b = t; } return a; };

// Stride for the sampling walk: near n/φ and coprime to n, so stepping by it visits
// a permutation of the triangle list — the first `budget` steps are distinct and, by
// the three-distance theorem, near-uniformly spread over the WHOLE mesh (measured
// max gap on a 480-triangle mesh sampled 100 times: 8). A contiguous slice would
// read one region of the surface, and a plain n/budget stride can beat against a
// mesh's own periodicity (a lathed part's segment count) and sample one side of it.
// No RNG anywhere, so the same mesh always reads the same wall.
function sampleStride(n) {
  let s = Math.max(1, Math.round(n * 0.6180339887498949)) % n || 1;
  while (gcd(s, n) !== 1) s = s + 1 < n ? s + 1 : 1;
  return s;
}

// `bvhCache` is an optional caller-owned Map (see cachedBVH): pass the one
// measure() shares with meshGaps to index each mesh once instead of twice. It
// does not interact with sampling — sampling picks WHICH rays to cast, not how
// the index is built, so a shared BVH is equally valid sampled or exact.
export function minWall(mesh, { maxThickness, maxSamples = MAX_SAMPLES, bvhCache } = {}) {
  const bvh = cachedBVH(mesh, bvhCache);
  const n = bvh.triangleCount;
  if (n === 0) return null;
  const V = bvh.vertices;

  // bbox diagonal as the default cap (a ray exiting into open air gets no hit anyway).
  if (maxThickness == null) {
    const pos = mesh.positions;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) { if (pos[i + a] < min[a]) min[a] = pos[i + a]; if (pos[i + a] > max[a]) max[a] = pos[i + a]; }
    maxThickness = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) + 1;
  }

  // `maxSamples: 0` (or any non-positive) is the explicit "no cap, cast everything"
  // escape hatch — the exact reading, however long it takes.
  const budget = maxSamples > 0 && n > maxSamples ? Math.floor(maxSamples) : n;
  const sampled = budget < n;
  const stride = sampled ? sampleStride(n) : 1;   // stride 1 = every triangle, in mesh order

  let best = Infinity, loc = null, t = 0;
  for (let s = 0; s < budget; s++, t = t + stride < n ? t + stride : t + stride - n) {
    const o = t * 9;
    const v0x = V[o], v0y = V[o + 1], v0z = V[o + 2];
    const e1x = V[o + 3] - v0x, e1y = V[o + 4] - v0y, e1z = V[o + 5] - v0z;
    const e2x = V[o + 6] - v0x, e2y = V[o + 7] - v0y, e2z = V[o + 8] - v0z;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;                       // degenerate triangle
    nx /= len; ny /= len; nz /= len;                // outward normal (manifold winding)
    const c = [(v0x + V[o + 3] + V[o + 6]) / 3, (v0y + V[o + 4] + V[o + 7]) / 3, (v0z + V[o + 5] + V[o + 8]) / 3];
    const dir = [-nx, -ny, -nz];                    // inward
    const origin = [c[0] + dir[0] * 1e-4, c[1] + dir[1] * 1e-4, c[2] + dir[2] * 1e-4];
    const hit = bvh.raycast(origin, dir, { tMax: maxThickness, skipTri: t });
    if (hit && hit.t < best) { best = hit.t; loc = c; }
  }
  return best === Infinity ? null
    : { value: best, location: loc, sampled, sampledTriangles: budget, totalTriangles: n };
}
