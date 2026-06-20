import { helixTube } from "./helix-tube.js";

const PLANE_NORMAL = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };
const SEGS = { preview: 64, print: 220 };       // circular segments
const TUBE = { preview: { stationsPerTurn: 24, ringSegs: 16 }, print: { stationsPerTurn: 64, ringSegs: 24 } };

export function createManifoldKernel(wasm, { quality = "preview" } = {}) {
  const { Manifold, CrossSection } = wasm;
  const segs = SEGS[quality], tube = TUBE[quality];

  const wrap = (m) => ({
    _m: m,
    cut: (t) => wrap(m.subtract(t._m)),
    cutAll: (tools) => wrap(m.subtract(tools.map((t) => t._m).reduce((a, b) => a.add(b)))),
    translate: (v) => wrap(m.translate(v)),
    rotate: (deg, center, axis) => {
      const euler = [axis[0] * deg, axis[1] * deg, axis[2] * deg];
      const moved = m.translate([-center[0], -center[1], -center[2]]).rotate(euler).translate(center);
      return wrap(moved);
    },
    mirror: (plane) => wrap(m.mirror(PLANE_NORMAL[plane])),
    toMesh: () => {
      const g = m.getMesh();
      return {
        positions: g.numProp === 3 ? g.vertProperties : Float32Array.from(stridePos(g)),
        normals: new Float32Array(0),       // main thread computes vertex normals
        indices: g.triVerts,
        triangles: g.triVerts.length / 3,
      };
    },
    toSTL: ({ quality } = {}) => Promise.resolve(stlFromMesh(m.getMesh())),
  });

  return {
    cylinder: (rb, rt, h, { center = false } = {}) => wrap(Manifold.cylinder(h, rb, rt, segs, center)),
    box: (min, max) => wrap(Manifold.cube([max[0]-min[0], max[1]-min[1], max[2]-min[2]]).translate(min)),
    prism: (pts, h) => wrap(CrossSection.ofPolygons([pts]).extrude(h)),
    helixSweptTube: (o) => wrap(helixTube(wasm, { ...o, ...tube })),
    union: (solids) => wrap(solids.map((s) => s._m).reduce((a, b) => a.add(b))),
    toSTEP: () => { throw new Error("STEP export not supported by the Manifold backend"); },
  };
}

function stridePos(g) {
  const out = [];
  for (let v = 0; v < g.vertProperties.length; v += g.numProp)
    out.push(g.vertProperties[v], g.vertProperties[v + 1], g.vertProperties[v + 2]);
  return out;
}

function stlFromMesh(g) {
  const tris = g.triVerts, vp = g.vertProperties, np = g.numProp, n = tris.length / 3;
  const ab = new ArrayBuffer(84 + n * 50); const dv = new DataView(ab); dv.setUint32(80, n, true);
  let o = 84; const P = (i) => [vp[i*np], vp[i*np+1], vp[i*np+2]];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) { dv.setFloat32(o, 0, true); o += 4; } // normal (slicers recompute)
    for (const idx of [tris[i*3], tris[i*3+1], tris[i*3+2]]) { const p = P(idx); for (const x of p) { dv.setFloat32(o, x, true); o += 4; } }
    dv.setUint16(o, 0, true); o += 2;
  }
  return ab;
}
