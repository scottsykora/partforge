// Backend-shared loft support. resolveRings() validates the declarative ring specs and
// applies each ring's in-plane transform ONCE, so both backends build the identical set
// of placed cross-sections (Manifold hand-meshes them; OCCT turns each into a wire and
// calls native loft). loftMesh() is the Manifold path — the helix-tube ring recipe
// generalized to arbitrary polygon rings via the mesh-build.js helpers.
import { regularPolygon } from "./polygon.js";
import { sideQuads, fanCap, manifoldFromMesh } from "./mesh-build.js";

// A ring: { polygon:[[x,y],…] | (sides,radius), z, rotate?:deg, scale?:number|[sx,sy] }.
// Returns [{ pts2d:[[x,y],…], z }] with scale-then-rotate(Z) baked into pts2d. Throws
// on malformed input and on rings whose vertex counts differ (straight quad stitching
// needs a shared N — no re-sampling), so an LLM gets a loud, specific error.
export function resolveRings(rings) {
  if (!Array.isArray(rings) || rings.length < 2)
    throw new Error("loft: rings must be an array of at least 2 rings");
  const out = rings.map((r, i) => {
    if (!r || typeof r !== "object") throw new Error(`loft: ring ${i} must be an object { polygon|sides+radius, z }`);
    if (!Number.isFinite(r.z)) throw new Error(`loft: ring ${i} needs a finite z`);
    let pts = r.polygon;
    if (!pts && Number.isFinite(r.sides) && Number.isFinite(r.radius)) pts = regularPolygon(r.sides, r.radius);
    if (!Array.isArray(pts) || pts.length < 3)
      throw new Error(`loft: ring ${i} needs polygon:[[x,y],…] (≥3 points) or sides+radius shorthand`);
    const s = r.scale ?? 1;
    const [sx, sy] = Array.isArray(s) ? s : [s, s];
    const rot = ((r.rotate ?? 0) * Math.PI) / 180, cos = Math.cos(rot), sin = Math.sin(rot);
    const pts2d = pts.map(([x, y]) => {
      const X = x * sx, Y = y * sy;                 // scale in-plane, then rotate about Z
      return [X * cos - Y * sin, X * sin + Y * cos];
    });
    return { pts2d, z: r.z };
  });
  const N = out[0].pts2d.length;
  for (const r of out) if (r.pts2d.length !== N)
    throw new Error("loft: every ring must have the same number of points (straight quad stitching, no re-sampling)");
  return out;
}

const centroid = (pts2d, z) => {
  let cx = 0, cy = 0;
  for (const [x, y] of pts2d) { cx += x; cy += y; }
  return [cx / pts2d.length, cy / pts2d.length, z];
};

// Manifold path: stack the resolved rings, stitch side quads, and (unless closed) fan a
// cap over each end from its centroid. Caps assume star-convex-from-centroid rings, which
// covers regular n-gons and every polygon.js helper. Returns a raw Manifold (caller T()s).
export function loftMesh(wasm, rings, { closed = false } = {}) {
  const resolved = resolveRings(rings);
  const N = resolved[0].pts2d.length;
  const V = [];
  for (const { pts2d, z } of resolved) for (const [x, y] of pts2d) V.push(x, y, z);
  const Tr = [];
  sideQuads(Tr, resolved.length, N, closed);
  if (!closed) {
    const first = resolved[0], lastR = resolved[resolved.length - 1];
    fanCap(V, Tr, 0, N, centroid(first.pts2d, first.z), true);                    // bottom faces −Z
    fanCap(V, Tr, (resolved.length - 1) * N, N, centroid(lastR.pts2d, lastR.z), false); // top faces +Z
  }
  return manifoldFromMesh(wasm, V, Tr);
}
