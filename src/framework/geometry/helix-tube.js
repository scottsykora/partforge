// Builds a watertight triangle mesh of a circular profile swept along a helix in
// its frenet frame, then imports it as a Manifold solid. The profile stays
// perpendicular to the helix tangent (unlike twist-extrude), so it matches an
// exact frenet sweep. Winding is consistent-outward; the ring stitching + caps +
// ofMesh import are the shared ring-mesh helpers in mesh-build.js (also used by loft).
import { sideQuads, fanCap, manifoldFromMesh } from "./mesh-build.js";

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
  sideQuads(Tr, n, ringSegs, false); // side walls between the n stations
  // end caps fanned from each end's path-center (outward: bottom flipped, top not)
  fanCap(V, Tr, 0, ringSegs, [pathR, 0, z0], true);
  fanCap(V, Tr, (n - 1) * ringSegs, ringSegs,
         [pathR * Math.cos(sign * phiMax), pathR * Math.sin(sign * phiMax), z0 + c * phiMax], false);

  return manifoldFromMesh(wasm, V, Tr);
}
