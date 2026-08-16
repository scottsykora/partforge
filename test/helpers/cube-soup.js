// A minimal axis-aligned cube as triangle soup (12 tris, outward CCW winding),
// base corner at the origin — the smallest fixture that exercises the
// import-mesh path (ensureOutward / openEdgeCount / manifoldFromMesh) without
// depending on any real STL/3MF parser.
export function cubeSoup(edge) {
  const e = edge;
  // 8 corners of the box [0,e]^3.
  const positions = new Float32Array([
    0, 0, 0,  e, 0, 0,  e, e, 0,  0, e, 0, // bottom (z=0): 0,1,2,3
    0, 0, e,  e, 0, e,  e, e, e,  0, e, e, // top (z=e):    4,5,6,7
  ]);
  // Two triangles per face, wound so each face normal points outward.
  const indices = new Uint32Array([
    // bottom (z=0), normal -Z
    0, 2, 1,  0, 3, 2,
    // top (z=e), normal +Z
    4, 5, 6,  4, 6, 7,
    // front (y=0), normal -Y
    0, 1, 5,  0, 5, 4,
    // back (y=e), normal +Y
    3, 7, 6,  3, 6, 2,
    // left (x=0), normal -X
    0, 4, 7,  0, 7, 3,
    // right (x=e), normal +X
    1, 2, 6,  1, 6, 5,
  ]);
  return { positions, indices };
}
