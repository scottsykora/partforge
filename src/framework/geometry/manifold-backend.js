import { helixTube } from "./helix-tube.js";
import { KernelCapabilityError } from "./errors.js";
import { OCCT_ONLY_OPS } from "./kernel.js";
import { h } from "./solid-hash.js";
import { createSolidCache } from "./solid-cache.js";
import { addSugar } from "./solid-sugar.js";

// One throwing stub per OCCT-only op, generated from the contract's single list —
// so a new OCCT-only op gets its NEEDS_OCCT reroute (and probe routing) for free.
const occtOnlyStubs = Object.fromEntries(OCCT_ONLY_OPS.map((op) => [
  op, () => { throw new KernelCapabilityError(`${op} requires the OCCT backend`); },
]));

const PLANE_NORMAL = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };
// 'preview' = interactive view (fast); 'print' = STL export (high-res, used only
// by the export path — Manifold meshing is cheap, so we tessellate generously).
const SEGS = { preview: 116, print: 480 };       // circular segments
const TUBE = { preview: { stationsPerTurn: 38, ringSegs: 24 }, print: { stationsPerTurn: 160, ringSegs: 40 } };
const SHARP_ANGLE = 35; // deg — same-surface edges sharper than this shade hard (cut seams are always hard)
const COPLANAR_COS = Math.cos((5 * Math.PI) / 180); // edge lines: skip cut seams that bend less than 5° (coplanar)
const MIN_EDGE2 = 0.01 * 0.01; // edge lines: drop sub-0.01mm segments (degenerate boolean slivers, not real features)

// true axis-angle rotation as a column-major 4x4 (manifold Mat4), translation 0
function axisAngleMat4(axis, deg) {
  const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const x = axis[0] / len, y = axis[1] / len, z = axis[2] / len;
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), C = 1 - c;
  const R00 = c + x*x*C,   R01 = x*y*C - z*s, R02 = x*z*C + y*s;
  const R10 = y*x*C + z*s, R11 = c + y*y*C,   R12 = y*z*C - x*s;
  const R20 = z*x*C - y*s, R21 = z*y*C + x*s, R22 = c + z*z*C;
  // column-major: columns are images of the basis vectors; 4th column = translation (0)
  return [R00, R10, R20, 0,  R01, R11, R21, 0,  R02, R12, R22, 0,  0, 0, 0, 1];
}

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

  const cache = createSolidCache();
  const featureLabels = new Map(); // originalID -> label string (grows per label(); tiny)
  // Boundary ops route through cache.lookup; on a miss `make` runs the WASM op,
  // tracks the result, and returns the triple the cache needs to pin/dispose it.
  const cached = (hash, computeM) => cache.lookup(hash, () => {
    const m = computeM();                 // already T()-tracked by the op
    return { value: wrap(m, hash), pin: m, dispose: () => m.delete?.() };
  });

  // Copy the mesh out into JS-owned arrays (so it survives cleanup) and free the
  // transient mesh handle.
  function meshOut(m, asStl) {
    const g = m.getMesh();
    const r = asStl ? stlFromMesh(g) : creasedNormals(g, Math.cos((SHARP_ANGLE * Math.PI) / 180), featureLabels);
    g.delete?.();
    return r;
  }

  // Raw indexed mesh (positions x,y,z per vertex + triangle indices) for 3MF.
  function indexedMeshOut(m) {
    const g = m.getMesh();
    const np = g.numProp, vp = g.vertProperties;
    const nVert = (vp.length / np) | 0;
    let positions;
    if (np === 3) {
      positions = Float32Array.from(vp);
    } else {
      positions = new Float32Array(nVert * 3);
      for (let i = 0; i < nVert; i++) { positions[i * 3] = vp[i * np]; positions[i * 3 + 1] = vp[i * np + 1]; positions[i * 3 + 2] = vp[i * np + 2]; }
    }
    const indices = Uint32Array.from(g.triVerts);
    g.delete?.();
    return { positions, indices };
  }

  const wrap = (m, hash) => addSugar({
    _m: m,
    _hash: hash,
    cut: (t) => cached(h("cut", hash, t._hash), () => T(m.subtract(t._m))),
    cutAll: (tools) => cached(h("cutAll", hash, tools.map((t) => t._hash)),
      () => T(m.subtract(unionRaw(tools.map((t) => t._m))))),
    intersect: (t) => cached(h("intersect", hash, t._hash), () => T(m.intersect(t._m))),
    clone: () => wrap(m, hash),
    // Name this solid's surface for hover/pick feature attribution. asOriginal()
    // stamps a fresh originalID that survives transforms and booleans, so every
    // surviving triangle of this surface can be traced back to the label.
    label: (name) => cached(h("label", hash, name), () => {
      const o = T(m.asOriginal());
      featureLabels.set(o.originalID(), name);
      return o;
    }),
    boundingBox: () => {
      const b = m.boundingBox();           // { min: Vec3, max: Vec3 }
      const min = [...b.min], max = [...b.max];
      return {
        min, max,
        center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
        size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      };
    },
    volume: () => m.volume(),
    genus: () => m.genus(),
    isEmpty: () => m.isEmpty(),
    translate: (v) => wrap(T(m.translate(v)), h("translate", hash, v)),
    rotate: (deg, center, axis) => {
      const nz = (axis[0] !== 0) + (axis[1] !== 0) + (axis[2] !== 0);
      const a = T(m.translate([-center[0], -center[1], -center[2]]));
      const b = nz <= 1
        ? T(a.rotate([axis[0] * deg, axis[1] * deg, axis[2] * deg]))   // basis axis — euler is exact; unchanged
        : T(a.transform(axisAngleMat4(axis, deg)));                    // general axis-angle
      return wrap(T(b.translate(center)), h("rotate", hash, deg, center, axis));
    },
    mirror: (plane) => wrap(T(m.mirror(PLANE_NORMAL[plane])), h("mirror", hash, plane)),
    scale: (factor, center = [0, 0, 0]) => {
      if (!(factor > 0)) throw new Error("scale: factor must be > 0");
      const a = T(m.translate([-center[0], -center[1], -center[2]]));
      const b = T(a.scale([factor, factor, factor]));
      return wrap(T(b.translate(center)), h("scale", hash, factor, center));
    },
    toMesh: () => meshOut(m, false),
    toSTL: () => Promise.resolve(meshOut(m, true)),
    toIndexedMesh: () => indexedMeshOut(m),
    ...occtOnlyStubs,
  });

  return {
    cylinder: (rb, rt, h2, { center = false } = {}) =>
      wrap(T(Manifold.cylinder(h2, rb, rt, segs, center)), h("cylinder", rb, rt, h2, center, segs)),
    // Compound op: hashed ATOMICALLY from its own args, so it is a single cache
    // node — its internal cylinders/cut are never retained. The template for
    // future compounds: build internals with T(), return the final tracked solid.
    boredCylinder: ({ od, h: height, bore }) => cached(h("boredCylinder", od, height, bore, segs), () => {
      const body = T(Manifold.cylinder(height, od / 2, od / 2, segs, false));
      const tool0 = T(Manifold.cylinder(height + 4, bore / 2, bore / 2, segs, false));
      const tool = T(tool0.translate([0, 0, -2])); // raw ops: track each result
      return T(body.subtract(tool));
    }),
    sphere: (r) => wrap(T(Manifold.sphere(r, segs)), h("sphere", r, segs)),
    box: (min, max) => {
      const cube = T(Manifold.cube([max[0] - min[0], max[1] - min[1], max[2] - min[2]]));
      return wrap(T(cube.translate(min)), h("box", min, max));
    },
    prism: (pts, height, { twist = 0, scaleTop = 1 } = {}) =>
      cached(h("prism", pts, height, twist, scaleTop, segs), () => {
        if (scaleTop < 0) throw new Error("prism: scaleTop must be ≥ 0");
        const cs = T(CrossSection.ofPolygons([pts]));
        if (twist === 0 && scaleTop === 1) return T(cs.extrude(height));
        const nDiv = Math.max(1, Math.ceil(Math.abs(twist) / 5));
        // Manifold's extrude scaleTop is a Vec2 — a scalar is NOT broadcast (it scales
        // X and drives Y to 0, squishing the top to a line). Broadcast for a uniform taper.
        return T(cs.extrude(height, nDiv, twist, [scaleTop, scaleTop]));
      }),
    helixSweptTube: (o) => cached(h("helixSweptTube", o, tube), () => T(helixTube(wasm, { ...o, ...tube }))),
    revolve: (pts, { degrees = 360 } = {}) =>
      cached(h("revolve", pts, degrees, segs), () => {
        for (const [r] of pts) if (r < 0) throw new Error("revolve: profile radius must be ≥ 0");
        return T(Manifold.revolve([pts], segs, degrees));
      }),
    union: (solids) => cached(h("union", solids.map((s) => s._hash)), () => unionRaw(solids.map((s) => s._m))),
    toSTEP: () => { throw new KernelCapabilityError("toSTEP requires the OCCT backend"); },
    beginSubPart: (name) => cache.begin(name),
    endSubPart: () => cache.end(),
    cacheStats: () => cache.stats(),
    resetCacheStats: () => cache.resetStats(),
    // Free every WASM object created since the last cleanup EXCEPT solids the cache
    // still pins (they must survive for the next build to resume from them).
    cleanup: () => { for (const o of tracked) if (!cache.isPinned(o)) o.delete?.(); tracked.length = 0; },
  };
}

// Build a non-indexed mesh with normals that are smooth within a single original
// surface but HARD across boolean-cut seams. Manifold's runOriginalID tells us
// which input solid each triangle came from; we average a corner's face normals
// only over incident triangles of the SAME original surface that also meet within
// `sharpCos` — so cut seams stay crisp at any angle (even near-tangent), and a
// surface's own sharp edges (e.g. a face meeting a side) stay crisp too.
function creasedNormals(g, sharpCos, featureLabels) {
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

  // Feature edge segments for CAD-style edge lines: draw a line where the surface
  // actually BENDS — a sharp same-surface edge (dihedral past sharpCos), or a cut
  // seam (different original surface) that bends more than COPLANAR_COS. Coplanar
  // faces — even across a cut seam — get no line, and curved-surface facets are skipped.
  const edges = [];
  const seenEdge = new Map(); // edge key → first incident triangle
  for (let t = 0; t < nTri; t++)
    for (let e = 0; e < 3; e++) {
      const i = remap[tris[t * 3 + e]], j = remap[tris[t * 3 + ((e + 1) % 3)]];
      if (i === j) continue;
      const key = i < j ? i * nVert + j : j * nVert + i;
      const prev = seenEdge.get(key);
      if (prev === undefined) { seenEdge.set(key, t); continue; }
      seenEdge.delete(key);
      const dot = fn[prev * 3] * fn[t * 3] + fn[prev * 3 + 1] * fn[t * 3 + 1] + fn[prev * 3 + 2] * fn[t * 3 + 2];
      const hard = dot < sharpCos || (triOID[prev] !== triOID[t] && dot < COPLANAR_COS);
      if (hard) {
        const ai = i * np, bj = j * np;
        const dx = vp[ai] - vp[bj], dy = vp[ai + 1] - vp[bj + 1], dz = vp[ai + 2] - vp[bj + 2];
        if (dx * dx + dy * dy + dz * dz >= MIN_EDGE2) // skip degenerate sliver segments (noise)
          edges.push(vp[ai], vp[ai + 1], vp[ai + 2], vp[bj], vp[bj + 1], vp[bj + 2]);
      }
    }

  // Per-triangle feature attribution: map each triangle's original-surface id
  // through the label registry. Same label string → same feature entry, so a
  // pattern of solids labeled alike reads as one feature.
  let featureIds = null, features = null;
  if (featureLabels?.size) {
    const indexOf = new Map(); // label string -> 1-based feature index
    features = [];
    featureIds = new Uint16Array(nTri);
    for (let t = 0; t < nTri; t++) {
      const label = featureLabels.get(triOID[t]);
      if (label === undefined) continue;
      let fi = indexOf.get(label);
      if (fi === undefined) { features.push(label); fi = features.length; indexOf.set(label, fi); }
      featureIds[t] = fi;
    }
    if (features.length === 0) { featureIds = features = null; } // labels exist in the kernel, none in THIS mesh
  }

  const out = { positions, normals, triangles: nTri, edges: Float32Array.from(edges) }; // mesh non-indexed
  if (featureIds) { out.featureIds = featureIds; out.features = features; }
  return out;
}

function stlFromMesh(g) {
  const tris = g.triVerts, vp = g.vertProperties, np = g.numProp, n = tris.length / 3;
  const ab = new ArrayBuffer(84 + n * 50); const dv = new DataView(ab); dv.setUint32(80, n, true);
  let o = 84; const P = (i) => [vp[i*np], vp[i*np+1], vp[i*np+2]];
  for (let i = 0; i < n; i++) {
    const a = P(tris[i*3]), b = P(tris[i*3+1]), c = P(tris[i*3+2]);
    // Per-facet flat normal from the winding (Manifold is CCW → outward). Slicers
    // recompute this, but viewers that light from the stored normal (macOS
    // Preview/Quick Look) render the mesh unlit if it's left as zero.
    const ux = b[0]-a[0], uy = b[1]-a[1], uz = b[2]-a[2];
    const vx = c[0]-a[0], vy = c[1]-a[1], vz = c[2]-a[2];
    const nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx/L, true); dv.setFloat32(o+4, ny/L, true); dv.setFloat32(o+8, nz/L, true); o += 12;
    for (const p of [a, b, c]) for (const x of p) { dv.setFloat32(o, x, true); o += 4; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return ab;
}
