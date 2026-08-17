// Policy-aware crease pass for Manifold meshes — moved out of the backend so it
// is unit-testable on plain arrays without booting WASM. Builds a non-indexed
// mesh with normals that are smooth within a single original surface but HARD
// across boolean-cut seams. Manifold's runOriginalID tells us which input solid
// each triangle came from; we average a corner's face normals only over
// incident triangles of the SAME original surface that also meet within that
// surface's policy creaseAngle — so cut seams stay crisp at any angle (even
// near-tangent), and a surface's own sharp edges stay crisp too. Each original
// surface may carry a shading policy (shading-policy.js); surfaces without one
// use SMOOTH, which reproduces the pre-policy behavior exactly.
import { SMOOTH, COPLANAR_ANGLE, MIN_EDGE, cosDeg } from "./shading-policy.js";

const COPLANAR_COS = cosDeg(COPLANAR_ANGLE);
const MIN_EDGE2 = MIN_EDGE * MIN_EDGE;

export function creasedNormals(g, { policies = null, featureLabels = null } = {}) {
  const np = g.numProp, vp = g.vertProperties, tris = g.triVerts;
  const nTri = (tris.length / 3) | 0, nVert = (vp.length / np) | 0;

  // per-OID policy lookup with a cached cosine per OID
  const polFor = (oid) => (policies && policies.get(oid)) || SMOOTH;
  const cosCache = new Map();
  const cosFor = (oid) => {
    let c = cosCache.get(oid);
    if (c === undefined) { c = cosDeg(polFor(oid).creaseAngle); cosCache.set(oid, c); }
    return c;
  };

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

  // per-triangle face normals, plus each triangle's minimum height (2·area /
  // longest edge) — the "thinness" the feature-edge pass gates on below
  const fn = new Float32Array(nTri * 3);
  const thin = new Float32Array(nTri);
  for (let t = 0; t < nTri; t++) {
    const a = tris[t * 3] * np, b = tris[t * 3 + 1] * np, c = tris[t * 3 + 2] * np;
    const ux = vp[b] - vp[a], uy = vp[b + 1] - vp[a + 1], uz = vp[b + 2] - vp[a + 2];
    const vx = vp[c] - vp[a], vy = vp[c + 1] - vp[a + 1], vz = vp[c + 2] - vp[a + 2];
    const wx = vp[c] - vp[b], wy = vp[c + 1] - vp[b + 1], wz = vp[c + 2] - vp[b + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L0 = Math.hypot(nx, ny, nz), L = L0 || 1; // the || 1 is for the normal divide ONLY
    fn[t * 3] = nx / L; fn[t * 3 + 1] = ny / L; fn[t * 3 + 2] = nz / L;
    const longest = Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, wx * wx + wy * wy + wz * wz);
    // |cross| / maxEdge = min height — from the RAW cross magnitude, never the
    // guarded L: a zero-area triangle (two float32-coincident vertices — the
    // render-precision collapse of a sub-micron boolean seam sliver) must report
    // thin 0 so the feature-edge gate drops it. With L it reported 1/maxEdge and
    // sailed past the gate, and its garbage (0,0,0) normal reads as a 90° crease
    // against every neighbor — a full-weight line down an otherwise smooth wall
    // at whatever seam produced it.
    thin[t] = longest > 0 ? L0 / Math.sqrt(longest) : 0;
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
    const sharpCos = cosFor(oid); // per-surface crease threshold
    for (let k = 0; k < 3; k++) {
      const v = tris[t * 3 + k];
      let nx = 0, ny = 0, nz = 0;
      for (const t2 of incident.get(remap[v])) {
        // different cut surface → hard, EXCEPT two blend surfaces (boundaryLines on
        // both): one band is many tool surfaces continuing each other tangentially,
        // and hard normals at their handovers would put lighting seams along a band
        // that used to shade as one re-originaled surface
        if (triOID[t2] !== oid &&
          !(polFor(triOID[t2]).boundaryLines && polFor(oid).boundaryLines)) continue;
        if (fn[t2 * 3] * fx + fn[t2 * 3 + 1] * fy + fn[t2 * 3 + 2] * fz < sharpCos) continue; // sharp same-surface edge → hard
        nx += fn[t2 * 3]; ny += fn[t2 * 3 + 1]; nz += fn[t2 * 3 + 2];
      }
      const L = Math.hypot(nx, ny, nz) || 1;
      const o = (t * 3 + k) * 3, vv = v * np;
      positions[o] = vp[vv]; positions[o + 1] = vp[vv + 1]; positions[o + 2] = vp[vv + 2];
      normals[o] = nx / L; normals[o + 1] = ny / L; normals[o + 2] = nz / L;
    }
  }

  // Feature edge segments for CAD-style edge lines: draw a line where the
  // surface actually BENDS. Same-surface edges draw per the surface's policy
  // (sharper than creaseAngle, and only if the policy wants same-surface lines
  // at all — intentional facets shade flat with no wireframe). Cut seams
  // (different original surface) draw when they bend more than COPLANAR_ANGLE;
  // coplanar seams get no line, and curved-surface facets are skipped.
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
      // Sub-visible slivers never emit feature lines: a CSG junction between two
      // independently tessellated tangent surfaces (e.g. a corner sphere meeting
      // its edge-fillet cylinders) can leave micron-wide wall strips whose FACES
      // are invisible but whose long boundary edges would otherwise draw at full
      // line weight. A triangle thinner than MIN_EDGE cannot be seen, so its
      // edges are noise by definition — same threshold the segment filter uses.
      const sameOID = triOID[prev] === triOID[t];
      // Blend boundary: a cross-surface seam with a BLEND policy on EXACTLY one side
      // is the start/end of a fillet band — draw it even when tangent (the band's
      // extent must be readable). It also bypasses the thin-triangle gate below:
      // simplify() cannot collapse the boolean's slivers ACROSS the blend/base run
      // boundary, so half the seam's edges border a sliver, and gating them dashed
      // the ring — those slivers ride within microns OF the seam curve, so their
      // long edges redraw it rather than add noise (the MIN_EDGE segment-length
      // filter still drops the short ones).
      const boundary = !sameOID &&
        !!polFor(triOID[prev]).boundaryLines !== !!polFor(triOID[t]).boundaryLines;
      if (!boundary && (thin[prev] < MIN_EDGE || thin[t] < MIN_EDGE)) continue;
      const dot = fn[prev * 3] * fn[t * 3] + fn[prev * 3 + 1] * fn[t * 3 + 1] + fn[prev * 3 + 2] * fn[t * 3 + 2];
      // A multi-hole cap triangulation can contain an opposite-wound bridge:
      // its two normals disagree by 180 degrees even though both triangles lie
      // in the same plane. Gate on the unoriented supporting-plane angle first
      // so that triangulation seam never becomes a feature line.
      const bends = Math.abs(dot) < COPLANAR_COS;
      // Two blend surfaces (a handover along one band) line-draw like ONE surface:
      // the 35° same-surface bar, not the 5° cut-seam bar — a band is many tool
      // surfaces whose overshoot crossings bend a few degrees by construction.
      const bothBlend = !sameOID &&
        !!polFor(triOID[prev]).boundaryLines && !!polFor(triOID[t]).boundaryLines;
      const hard = boundary || (bends && (sameOID || bothBlend
        ? polFor(triOID[t]).sameSurfaceLines && dot < cosFor(triOID[t])
        : true));
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
