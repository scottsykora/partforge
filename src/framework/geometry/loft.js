// Backend-shared loft support: resolveLoftRings (loft-rings.js) validates and
// tessellates the declarative ring specs; loftMesh() is the Manifold path — stacked
// rings stitched with side quads and closed with TRIANGULATED caps (wasm.triangulate),
// so non-convex Shape2D rings cap correctly (the old centroid fan was star-convex-only).
import { resolveLoftRings } from "./loft-rings.js";
import { sideQuads, manifoldFromMesh, reverseWinding } from "./mesh-build.js";

const shoelace = (ring) => ring.reduce((a, [x, y], i) => {
  const [nx, ny] = ring[(i + 1) % ring.length];
  return a + x * ny - nx * y;
}, 0) / 2;

// Triangulated end cap. Winding must stay CONSISTENT with the side walls: a CCW ring's
// top cap faces +Z and its bottom cap −Z; a CW ring (legacy point lists — walls come
// out inverted and the whole-mesh volume check below flips everything at once) gets
// both caps inverted too, so the mesh is orientable either way.
function triCap(wasm, Tr, ringStart, pts2d, bottom) {
  const ccw = shoelace(pts2d) >= 0;
  const ring = ccw ? pts2d : [...pts2d].reverse();
  const tris = wasm.triangulate([ring], 1e-9);
  const remap = (i) => ringStart + (ccw ? i : pts2d.length - 1 - i);
  const flip = bottom !== !ccw; // XOR: see winding table in the test file
  for (const t of tris) {
    const a = remap(t[0]), b = remap(t[1]), c = remap(t[2]);
    if (flip) Tr.push(a, c, b); else Tr.push(a, b, c);
  }
}

export function loftMesh(wasm, rings, { closed = false } = {}) {
  const { resolved } = Array.isArray(rings) ? resolveLoftRings(rings) : rings;
  const N = resolved[0].pts2d.length;
  const V = [];
  for (const { pts2d, z } of resolved) for (const [x, y] of pts2d) V.push(x, y, z);
  const Tr = [];
  sideQuads(Tr, resolved.length, N, closed);
  if (!closed) {
    triCap(wasm, Tr, 0, resolved[0].pts2d, true);
    triCap(wasm, Tr, (resolved.length - 1) * N, resolved[resolved.length - 1].pts2d, false);
  }
  let out = manifoldFromMesh(wasm, V, Tr);
  if (out.volume() < 0) {          // CW rings / descending z: rebuild outward (unchanged)
    out.delete?.();
    reverseWinding(Tr);
    out = manifoldFromMesh(wasm, V, Tr);
  }
  return out;
}
