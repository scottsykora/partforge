// Backend-shared loft support: resolveLoftRings (loft-rings.js) validates and
// tessellates the declarative ring specs; loftMesh() is the Manifold path — stacked
// rings stitched with side quads and closed with TRIANGULATED caps (wasm.triangulate),
// so non-convex Shape2D rings cap correctly (the old centroid fan was star-convex-only).
//
// Curve/resample lofts additionally partition their triangles into RUNS carrying
// reserved original IDs (mesh-fillet's blend-band mechanism): one run per contour
// sector per band group, plus each cap. Sector boundaries (sharp joints, snapped
// corners) and band-group boundaries (silhouette kinks bending more than
// TANGENT_ANGLE — the same bar the B-rep backend draws real edges at) then shade
// hard and draw dividing lines through creased-normals' existing cross-surface
// rules, while each smooth sector keeps gentle crease behavior inside. Provenance
// decides the shading; angle inference alone could not (a 10° belly kink sits far
// below SMOOTH's 35° crease). Point-ring (poly-exact) lofts and hinted lofts keep
// the legacy single-surface path bit-for-bit.
import { resolveLoftRings } from "./loft-rings.js";
import { sideQuads, manifoldFromMesh, manifoldFromMeshRuns, reverseWinding } from "./mesh-build.js";
import { TANGENT_ANGLE, LOFT_SECTOR_SMOOTH, LOFT_SECTOR_FACETED, cosDeg } from "./shading-policy.js";

const shoelace = (ring) => ring.reduce((a, [x, y], i) => {
  const [nx, ny] = ring[(i + 1) % ring.length];
  return a + x * ny - nx * y;
}, 0) / 2;

// Triangulated end cap. Winding must stay CONSISTENT with the side walls: a CCW ring's
// top cap faces +Z and its bottom cap −Z; a CW ring (legacy point lists — walls come
// out inverted and the whole-mesh volume check below flips everything at once) gets
// both caps inverted too, so the mesh is orientable either way.
function triCap(wasm, Tr, ringStart, pts2d, bottom) {
  const ccw = shoelace(pts2d) >= 0;
  const ring = ccw ? pts2d : [...pts2d].reverse();
  const tris = wasm.triangulate([ring], 1e-9);
  const remap = (i) => ringStart + (ccw ? i : pts2d.length - 1 - i);
  const flip = bottom !== !ccw; // XOR: see winding table in the test file
  for (const t of tris) {
    const a = remap(t[0]), b = remap(t[1]), c = remap(t[2]);
    if (flip) Tr.push(a, c, b); else Tr.push(a, b, c);
  }
}

// Interior rings where the wall direction bends more than TANGENT_ANGLE at any
// vertex column — author-placed silhouette features, not tessellation of a smooth
// sweep. Matches the bar at which the B-rep backend's real loft edges draw lines,
// so the Manifold preview and an OCCT export agree on which rings read as features.
function kinkRingsOf(resolved, closed = false) {
  const R = resolved.length, N = resolved[0].pts2d.length;
  const cosKink = cosDeg(TANGENT_ANGLE);
  const kinks = new Set();
  // open lofts bend only at interior rings; a closed loop also bends across the
  // wrap, so rings 0 and R-1 are checked there too (their neighbors wrap modulo R)
  for (let k = closed ? 0 : 1; k < (closed ? R : R - 1); k++) {
    const A = resolved[(k - 1 + R) % R], B = resolved[k], C = resolved[(k + 1) % R];
    for (let i = 0; i < N; i++) {
      const ux = B.pts2d[i][0] - A.pts2d[i][0], uy = B.pts2d[i][1] - A.pts2d[i][1], uz = B.z - A.z;
      const vx = C.pts2d[i][0] - B.pts2d[i][0], vy = C.pts2d[i][1] - B.pts2d[i][1], vz = C.z - B.z;
      const lu = Math.hypot(ux, uy, uz), lv = Math.hypot(vx, vy, vz);
      // a zero-length band (duplicated ring) has no direction — it cannot bend;
      // without this skip the 0-dot always reads as a >5° kink and splits runs
      if (lu < 1e-9 || lv < 1e-9) continue;
      if ((ux * vx + uy * vy + uz * vz) / (lu * lv) < cosKink) { kinks.add(k); break; }
    }
  }
  return kinks;
}

// Run-partitioned mesh: wall triangles grouped by (band group × sector), caps as
// their own runs, every run stamped with a freshly reserved original ID and its
// policy recorded in `runPolicies` for the backend to register.
function sectoredMesh(wasm, resolvedLoft, kinks, { closed = false } = {}, runPolicies) {
  const { resolved, shading } = resolvedLoft;
  const N = resolved[0].pts2d.length, R = resolved.length;
  const V = [];
  for (const { pts2d, z } of resolved) for (const [x, y] of pts2d) V.push(x, y, z);

  const bands = closed ? R : R - 1;
  const groupOf = new Array(bands);
  let g = 0;
  for (let b = 0; b < bands; b++) { if (b > 0 && kinks.has(b)) g++; groupOf[b] = g; }
  // closed loop: unless ring 0 itself kinks, the last group continues into the first
  if (closed && g > 0 && !kinks.has(0)) for (let b = bands - 1; b >= 0 && groupOf[b] === g; b--) groupOf[b] = 0;

  const K = Math.max(...shading.sectorOf) + 1;
  const runTris = new Map(); // (group * K + sector) -> flat tri indices
  for (let b = 0; b < bands; b++) {
    const i0 = b * N, i1 = ((b + 1) % R) * N;
    for (let j = 0; j < N; j++) {
      const key = groupOf[b] * K + shading.sectorOf[j];
      let arr = runTris.get(key);
      if (!arr) runTris.set(key, (arr = []));
      const a = i0 + j, b2 = i0 + (j + 1) % N, cc = i1 + j, dd = i1 + (j + 1) % N;
      arr.push(a, dd, cc, a, b2, dd); // same winding as sideQuads
    }
  }
  const capBottom = [], capTop = [];
  if (!closed) {
    triCap(wasm, capBottom, 0, resolved[0].pts2d, true);
    triCap(wasm, capTop, (R - 1) * N, resolved[R - 1].pts2d, false);
  }

  const wallKeys = [...runTris.keys()].sort((a, b) => a - b);
  const totalRuns = wallKeys.length + (closed ? 0 : 2);
  const base = wasm.Manifold.reserveIDs(totalRuns);
  const Tr = [], runIndex = [0], runOriginalID = [];
  let next = base;
  for (const key of wallKeys) {
    for (const t of runTris.get(key)) Tr.push(t);
    runIndex.push(Tr.length);
    runOriginalID.push(next);
    runPolicies?.set(next, shading.sectorSmooth[key % K] ? LOFT_SECTOR_SMOOTH : LOFT_SECTOR_FACETED);
    next++;
  }
  for (const cap of closed ? [] : [capBottom, capTop]) {
    for (const t of cap) Tr.push(t);
    runIndex.push(Tr.length);
    runOriginalID.push(next);
    runPolicies?.set(next, LOFT_SECTOR_FACETED); // caps are planar
    next++;
  }

  let out = manifoldFromMeshRuns(wasm, V, Tr, runIndex, runOriginalID);
  if (out.volume() < 0) {          // descending-z stacks: rebuild outward, runs unchanged
    out.delete?.();
    reverseWinding(Tr);
    out = manifoldFromMeshRuns(wasm, V, Tr, runIndex, runOriginalID);
  }
  return out;
}

export function loftMesh(wasm, rings, opts = {}, runPolicies = null) {
  const rl = Array.isArray(rings) ? resolveLoftRings(rings) : rings;
  const { resolved, shading } = rl;
  const { closed = false, shading: hint } = opts;
  if (shading && hint == null) {
    const kinks = kinkRingsOf(resolved, closed);
    const K = Math.max(...shading.sectorOf) + 1;
    // Partition only when there is a boundary to express; a single smooth sector
    // with no kinks keeps the legacy single-surface path (and its policy inference).
    if (K > 1 || kinks.size > 0) return sectoredMesh(wasm, rl, kinks, opts, runPolicies);
  }
  const N = resolved[0].pts2d.length;
  const V = [];
  for (const { pts2d, z } of resolved) for (const [x, y] of pts2d) V.push(x, y, z);
  const Tr = [];
  sideQuads(Tr, resolved.length, N, closed);
  if (!closed) {
    triCap(wasm, Tr, 0, resolved[0].pts2d, true);
    triCap(wasm, Tr, (resolved.length - 1) * N, resolved[resolved.length - 1].pts2d, false);
  }
  let out = manifoldFromMesh(wasm, V, Tr);
  if (out.volume() < 0) {          // CW rings / descending z: rebuild outward (unchanged)
    out.delete?.();
    reverseWinding(Tr);
    out = manifoldFromMesh(wasm, V, Tr);
  }
  return out;
}
