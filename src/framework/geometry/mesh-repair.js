// Repair + diagnostics for imported meshes (STL/3MF soup, or already-indexed). Files in the
// wild are inconsistently wound and sometimes non-manifold, so the import path runs these
// before handing a mesh to Manifold.ofMesh: orient it outward, then measure how far it is
// from watertight so the caller can decide whether to warn or refuse the import.

import { reverseWinding } from "./mesh-build.js";

// Read triangle `t`'s three vertex indices, working for both an indexed mesh (`indices` is
// the triangle-index array) and an unindexed soup (`indices` is null/undefined, so the
// triangle's own position offsets double as its "indices": 3t, 3t+1, 3t+2).
function triIndices(indices, t) {
  if (indices) return [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
  return [t * 3, t * 3 + 1, t * 3 + 2];
}

function triCount(positions, indices) {
  return indices ? indices.length / 3 : positions.length / 9;
}

function vertex(positions, i) {
  return [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
}

// Signed volume (mm^3) of a closed mesh: Sigma det(a,b,c)/6 over triangles, the standard
// divergence-theorem formula. Positive when triangles wind CCW-outward, negative when the
// whole mesh is inside-out. Works on soup (indices omitted) and indexed meshes alike, and
// doesn't require the mesh to actually be closed - an open mesh just gives a meaningless
// number, which is exactly the signal ensureOutward needs (sign, not validity).
export function signedVolume(positions, indices) {
  const n = triCount(positions, indices);
  let vol = 0;
  for (let t = 0; t < n; t++) {
    const [i0, i1, i2] = triIndices(indices, t);
    const [ax, ay, az] = vertex(positions, i0);
    const [bx, by, bz] = vertex(positions, i1);
    const [cx, cy, cz] = vertex(positions, i2);
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return vol / 6;
}

// Flip the whole mesh outward-facing if it's currently inside-out (negative signed volume),
// by reversing every triangle's winding in place. A no-op when already outward (or when the
// sign is ambiguous because the mesh isn't closed - nothing sensible to do there anyway).
export function ensureOutward(positions, indices) {
  if (signedVolume(positions, indices) < 0) reverseWinding(indices);
}

// Count boundary ("open") half-edges after welding vertices by exact position. A watertight
// mesh has every directed edge matched by an opposite-direction edge on the neighboring
// triangle; an edge whose reverse is missing borders a hole (or a non-manifold seam) and is
// the diagnostic for "this import isn't a solid". The weld key is built from the raw
// (Float32-precision) coordinate values - exact match is correct here because soup vertices
// straight out of one STL/3MF file that are meant to coincide already have identical float32
// bit patterns; no epsilon merge needed.
export function openEdgeCount(positions, indices) {
  const n = triCount(positions, indices);

  // Weld: coordinate key -> canonical vertex id.
  const weld = new Map();
  function weldedId(i) {
    const [x, y, z] = vertex(positions, i);
    const key = `${x},${y},${z}`;
    let id = weld.get(key);
    if (id === undefined) { id = weld.size; weld.set(key, id); }
    return id;
  }

  // Tally every directed edge (a -> b) across all triangles.
  const edges = new Map();
  for (let t = 0; t < n; t++) {
    const [i0, i1, i2] = triIndices(indices, t);
    const a = weldedId(i0), b = weldedId(i1), c = weldedId(i2);
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = `${u},${v}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }

  // An edge is open when its reverse direction never appears.
  let open = 0;
  for (const key of edges.keys()) {
    const [u, v] = key.split(",");
    if (!edges.has(`${v},${u}`)) open++;
  }
  return open;
}
