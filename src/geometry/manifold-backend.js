import { helixTube } from "./helix-tube.js";

const PLANE_NORMAL = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };
const SEGS = { preview: 116, print: 220 };       // circular segments
const TUBE = { preview: { stationsPerTurn: 38, ringSegs: 24 }, print: { stationsPerTurn: 64, ringSegs: 24 } };
const SHARP_ANGLE = 40; // deg — edges sharper than this shade hard; gentler are smooth

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
  // transient mesh handle. For display, compute normals from the EXACT CSG
  // topology (Manifold.calculateNormals) rather than re-welding triangle soup on
  // the main thread — that re-weld smears shading at fine boolean seams.
  function meshOut(m, asStl) {
    if (asStl) {
      const g = m.getMesh();
      const r = stlFromMesh(g);
      g.delete?.();
      return r;
    }
    const withN = T(m.calculateNormals(0, SHARP_ANGLE)); // normals into the first extra slot = channels 3-5 (numProp 6)
    const g = withN.getMesh();
    const np = g.numProp, vp = g.vertProperties, nv = (vp.length / np) | 0;
    const positions = new Float32Array(nv * 3);
    const normals = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) {
      positions[i * 3] = vp[i * np]; positions[i * 3 + 1] = vp[i * np + 1]; positions[i * 3 + 2] = vp[i * np + 2];
      normals[i * 3] = vp[i * np + 3]; normals[i * 3 + 1] = vp[i * np + 4]; normals[i * 3 + 2] = vp[i * np + 5];
    }
    const indices = Uint32Array.from(g.triVerts);
    const triangles = g.triVerts.length / 3;
    g.delete?.();
    return { positions, normals, indices, triangles };
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
