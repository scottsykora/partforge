// Builds a watertight triangle mesh of a circular profile swept along a helix in
// its frenet frame, then imports it as a Manifold solid. The profile stays
// perpendicular to the helix tangent (unlike twist-extrude), so it matches an
// exact frenet sweep. Winding is consistent-outward; getting it wrong makes
// Manifold.ofMesh throw or import an inverted solid.
const norm = (v) => { const m = Math.hypot(...v); return [v[0] / m, v[1] / m, v[2] / m]; };
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];

export function helixTube(wasm, opts) {
  const { pathR, profileR, pitch, turns, z0 = 0, lefthand = false,
          stationsPerTurn = 24, ringSegs = 16 } = opts;
  const sign = lefthand ? -1 : 1;
  const c = pitch / (2 * Math.PI);          // z-rise per radian
  const phiMax = 2 * Math.PI * turns;
  const n = Math.max(2, Math.ceil(turns * stationsPerTurn)) + 1;
  const V = [], Tr = [];

  for (let i = 0; i < n; i++) {
    const phi = (phiMax * i) / (n - 1);
    const ctr = [pathR * Math.cos(sign * phi), pathR * Math.sin(sign * phi), z0 + c * phi];
    const T = norm([-sign * pathR * Math.sin(sign * phi), sign * pathR * Math.cos(sign * phi), c]);
    const N = [Math.cos(sign * phi), Math.sin(sign * phi), 0]; // radial, ⟂ T
    const B = norm(cross(T, N));
    for (let j = 0; j < ringSegs; j++) {
      const a = (2 * Math.PI * j) / ringSegs;
      V.push(ctr[0] + profileR * (Math.cos(a) * N[0] + Math.sin(a) * B[0]),
             ctr[1] + profileR * (Math.cos(a) * N[1] + Math.sin(a) * B[1]),
             ctr[2] + profileR * (Math.cos(a) * N[2] + Math.sin(a) * B[2]));
    }
  }
  // side faces (outward winding)
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < ringSegs; j++) {
    const a = i*ringSegs + j, b = i*ringSegs + (j+1)%ringSegs;
    const cc = (i+1)*ringSegs + j, dd = (i+1)*ringSegs + (j+1)%ringSegs;
    Tr.push(a, dd, cc, a, b, dd);
  }
  // end caps
  const c0 = V.length / 3;
  V.push(pathR * Math.cos(0), pathR * Math.sin(0), z0);
  for (let j = 0; j < ringSegs; j++) Tr.push(c0, (j+1)%ringSegs, j);
  const base = (n - 1) * ringSegs, cz = V.length / 3;
  V.push(pathR * Math.cos(sign * phiMax), pathR * Math.sin(sign * phiMax), z0 + c * phiMax);
  for (let j = 0; j < ringSegs; j++) Tr.push(cz, base + j, base + (j+1)%ringSegs);

  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(V), triVerts: Uint32Array.from(Tr) });
  mesh.merge();
  return wasm.Manifold.ofMesh(mesh);
}
