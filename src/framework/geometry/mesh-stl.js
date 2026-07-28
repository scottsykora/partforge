// Pure-JS binary STL writer, shared by both geometry backends. Takes a flat
// vertex-position array (x,y,z per vertex) and triangle indices, and returns a
// binary STL ArrayBuffer. STL is a triangle-mesh format, so this is the one and
// only STL path — OCCT and Manifold both feed it a mesh. It deliberately does
// NOT touch Blobs: the sandbox worker on Safari cannot read a Blob, so every
// export must hand back a raw ArrayBuffer.
export function meshToStl(positions, indices) {
  const n = (indices.length / 3) | 0;
  const ab = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(ab);
  dv.setUint32(80, n, true); // triangle count (80-byte header left zero)
  let o = 84;
  const P = (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  for (let i = 0; i < n; i++) {
    const a = P(indices[i * 3]), b = P(indices[i * 3 + 1]), c = P(indices[i * 3 + 2]);
    // Per-facet flat normal from the winding. Slicers recompute this, but some
    // viewers (macOS Preview/Quick Look) render unlit if it's left zero.
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / L, true); dv.setFloat32(o + 4, ny / L, true); dv.setFloat32(o + 8, nz / L, true); o += 12;
    for (const p of [a, b, c]) for (const x of p) { dv.setFloat32(o, x, true); o += 4; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return ab;
}
