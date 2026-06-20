import { helixTube } from "./helix-tube.js";

const PLANE_NORMAL = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };
const SEGS = { preview: 116, print: 220 };       // circular segments
const TUBE = { preview: { stationsPerTurn: 38, ringSegs: 24 }, print: { stationsPerTurn: 64, ringSegs: 24 } };

export function createManifoldKernel(wasm, { quality = "preview" } = {}) {
  const { Manifold, CrossSection } = wasm;
  const segs = SEGS[quality], tube = TUBE[quality];

  // Manifold/CrossSection are WASM objects with no garbage collection — every
  // primitive and boolean op allocates a new one. Track them all and free them
  // per job via cleanup(); otherwise repeated generates exhaust the WASM heap
  // (manifests as "Out of bounds memory access").
  const tracked = [];
  const T = (obj) => { tracked.push(obj); return obj; };
  const unionRaw = (ms) => ms.reduce((a, b) => T(a.add(b))); // track each reduce step

  // Copy the mesh out into JS-owned arrays so it survives cleanup(); free the
  // transient mesh handle.
  function meshOut(m, asStl) {
    const g = m.getMesh();
    const result = asStl
      ? stlFromMesh(g)
      : {
          positions: g.numProp === 3 ? Float32Array.from(g.vertProperties) : Float32Array.from(stridePos(g)),
          normals: new Float32Array(0), // main thread computes creased normals
          indices: Uint32Array.from(g.triVerts),
          triangles: g.triVerts.length / 3,
        };
    g.delete?.();
    return result;
  }

  const wrap = (m) => ({
    _m: m,
    cut: (t) => wrap(T(m.subtract(t._m))),
    cutAll: (tools) => wrap(T(m.subtract(unionRaw(tools.map((t) => t._m))))),
    translate: (v) => wrap(T(m.translate(v))),
    rotate: (deg, center, axis) => {
      const euler = [axis[0] * deg, axis[1] * deg, axis[2] * deg];
      const a = T(m.translate([-center[0], -center[1], -center[2]]));
      const b = T(a.rotate(euler));
      return wrap(T(b.translate(center)));
    },
    mirror: (plane) => wrap(T(m.mirror(PLANE_NORMAL[plane]))),
    toMesh: () => meshOut(m, false),
    toSTL: () => Promise.resolve(meshOut(m, true)),
  });

  return {
    cylinder: (rb, rt, h, { center = false } = {}) => wrap(T(Manifold.cylinder(h, rb, rt, segs, center))),
    box: (min, max) => {
      const cube = T(Manifold.cube([max[0] - min[0], max[1] - min[1], max[2] - min[2]]));
      return wrap(T(cube.translate(min)));
    },
    prism: (pts, h) => {
      const cs = T(CrossSection.ofPolygons([pts]));
      return wrap(T(cs.extrude(h)));
    },
    helixSweptTube: (o) => wrap(T(helixTube(wasm, { ...o, ...tube }))),
    union: (solids) => wrap(unionRaw(solids.map((s) => s._m))), // unionRaw already tracks its result
    toSTEP: () => { throw new Error("STEP export not supported by the Manifold backend"); },
    // Free every WASM object created since the last cleanup. Call after each job
    // once its meshes/buffers have been copied out (meshOut already did).
    cleanup: () => { for (const o of tracked) o.delete?.(); tracked.length = 0; },
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
