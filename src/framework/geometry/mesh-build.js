// Shared triangle-mesh assembly for ring-based Manifold primitives. Both helix-tube
// (a circular profile swept up a helix) and loft (stacked polygon cross-sections)
// build the same way: N-vertex rings stacked in order, stitched with side quads and
// closed with fan caps, then imported via Manifold.ofMesh. The winding convention is
// CCW = outward (getting it wrong makes ofMesh throw or import an inverted solid), so
// these helpers own the winding once for every ring-mesh primitive.

// Stitch side walls between consecutive rings. `V` already holds ringCount rings of
// ringSegs vertices each, ring i occupying indices [i*ringSegs, (i+1)*ringSegs). When
// `closed` also stitches the last ring back to the first (a tube/loop with no caps).
// Winding assumes each ring is CCW viewed from +Z and rings are ordered along +Z.
export function sideQuads(Tr, ringCount, ringSegs, closed = false) {
  const last = closed ? ringCount : ringCount - 1;
  for (let i = 0; i < last; i++) {
    const i0 = i * ringSegs, i1 = ((i + 1) % ringCount) * ringSegs;
    for (let j = 0; j < ringSegs; j++) {
      const a = i0 + j, b = i0 + (j + 1) % ringSegs;
      const cc = i1 + j, dd = i1 + (j + 1) % ringSegs;
      Tr.push(a, dd, cc, a, b, dd);
    }
  }
}

// Add a triangle fan closing one ring around a center point (pushed as a new vertex).
// `flip` reverses the winding: use flip=true for a bottom cap (faces −Z) and flip=false
// for a top cap (faces +Z), so both caps point outward. The center should lie inside the
// ring's polygon (its centroid), so the fan is valid for convex / star-convex rings.
export function fanCap(V, Tr, ringStart, ringSegs, center, flip) {
  const c = V.length / 3;
  V.push(center[0], center[1], center[2]);
  for (let j = 0; j < ringSegs; j++) {
    const a = ringStart + j, b = ringStart + (j + 1) % ringSegs;
    if (flip) Tr.push(c, b, a); else Tr.push(c, a, b);
  }
}

// Reverse the winding of every triangle in `Tr` in place (swap the 2nd and 3rd index of
// each tri). Flips which way all faces point, i.e. turns an inward-facing (negative-volume)
// mesh into an outward-facing one. Used to make loft winding/z-order agnostic.
export function reverseWinding(Tr) {
  for (let t = 0; t < Tr.length; t += 3) { const tmp = Tr[t + 1]; Tr[t + 1] = Tr[t + 2]; Tr[t + 2] = tmp; }
}

// Import a flat vertex array + triangle indices as a watertight Manifold. merge() welds
// coincident vertices so ofMesh sees a closed manifold; ofMesh consumes the mesh handle,
// so free it here and let the caller track the returned Manifold.
export function manifoldFromMesh(wasm, V, Tr) {
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(V), triVerts: Uint32Array.from(Tr) });
  mesh.merge();
  const out = wasm.Manifold.ofMesh(mesh);
  mesh.delete?.(); // input mesh is consumed by ofMesh; free it (caller tracks `out`)
  return out;
}
