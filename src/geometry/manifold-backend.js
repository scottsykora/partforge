import { helixTube } from "./helix-tube.js";

const PLANE_NORMAL = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };
const SEGS = { preview: 116, print: 220 };       // circular segments
const TUBE = { preview: { stationsPerTurn: 38, ringSegs: 24 }, print: { stationsPerTurn: 64, ringSegs: 24 } };
const SHARP_ANGLE = 35; // deg — same-surface edges sharper than this shade hard (cut seams are always hard)

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

  // Copy the mesh out into JS-owned arrays (so it survives cleanup) and free the
  // transient mesh handle.
  function meshOut(m, asStl) {
    const g = m.getMesh();
    const r = asStl ? stlFromMesh(g) : creasedNormals(g, Math.cos((SHARP_ANGLE * Math.PI) / 180));
    g.delete?.();
    return r;
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

// Build a non-indexed mesh with normals that are smooth within a single original
// surface but HARD across boolean-cut seams. Manifold's runOriginalID tells us
// which input solid each triangle came from; we average a corner's face normals
// only over incident triangles of the SAME original surface that also meet within
// `sharpCos` — so cut seams stay crisp at any angle (even near-tangent), and a
// surface's own sharp edges (e.g. a face meeting a side) stay crisp too.
function creasedNormals(g, sharpCos) {
  const np = g.numProp, vp = g.vertProperties, tris = g.triVerts;
  const nTri = (tris.length / 3) | 0, nVert = (vp.length / np) | 0;

  // unify any coincident vertices Manifold kept separate, for adjacency
  const remap = new Uint32Array(nVert);
  for (let i = 0; i < nVert; i++) remap[i] = i;
  const mf = g.mergeFromVert, mt = g.mergeToVert;
  if (mf && mt) for (let i = 0; i < mf.length; i++) remap[mf[i]] = mt[i];

  // per-triangle original-surface id, from the run table
  const triOID = new Uint32Array(nTri);
  const ri = g.runIndex, roid = g.runOriginalID;
  for (let r = 0; r < roid.length; r++)
    for (let t = ri[r] / 3; t < ri[r + 1] / 3; t++) triOID[t] = roid[r];

  // per-triangle face normals
  const fn = new Float32Array(nTri * 3);
  for (let t = 0; t < nTri; t++) {
    const a = tris[t * 3] * np, b = tris[t * 3 + 1] * np, c = tris[t * 3 + 2] * np;
    const ux = vp[b] - vp[a], uy = vp[b + 1] - vp[a + 1], uz = vp[b + 2] - vp[a + 2];
    const vx = vp[c] - vp[a], vy = vp[c + 1] - vp[a + 1], vz = vp[c + 2] - vp[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    fn[t * 3] = nx / L; fn[t * 3 + 1] = ny / L; fn[t * 3 + 2] = nz / L;
  }

  // canonical vertex → incident triangles
  const incident = new Map();
  for (let t = 0; t < nTri; t++)
    for (let k = 0; k < 3; k++) {
      const cv = remap[tris[t * 3 + k]];
      const arr = incident.get(cv);
      if (arr) arr.push(t); else incident.set(cv, [t]);
    }

  const positions = new Float32Array(nTri * 9);
  const normals = new Float32Array(nTri * 9);
  for (let t = 0; t < nTri; t++) {
    const fx = fn[t * 3], fy = fn[t * 3 + 1], fz = fn[t * 3 + 2], oid = triOID[t];
    for (let k = 0; k < 3; k++) {
      const v = tris[t * 3 + k];
      let nx = 0, ny = 0, nz = 0;
      for (const t2 of incident.get(remap[v])) {
        if (triOID[t2] !== oid) continue; // different cut surface → hard
        if (fn[t2 * 3] * fx + fn[t2 * 3 + 1] * fy + fn[t2 * 3 + 2] * fz < sharpCos) continue; // sharp same-surface edge → hard
        nx += fn[t2 * 3]; ny += fn[t2 * 3 + 1]; nz += fn[t2 * 3 + 2];
      }
      const L = Math.hypot(nx, ny, nz) || 1;
      const o = (t * 3 + k) * 3, vv = v * np;
      positions[o] = vp[vv]; positions[o + 1] = vp[vv + 1]; positions[o + 2] = vp[vv + 2];
      normals[o] = nx / L; normals[o + 1] = ny / L; normals[o + 2] = nz / L;
    }
  }
  return { positions, normals, triangles: nTri }; // non-indexed (no `indices`)
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
