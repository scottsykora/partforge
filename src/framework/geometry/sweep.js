// Backend-shared sweep support. resolveSweepStations() walks a 3-D polyline path with a
// rotation-minimizing frame (parallel transport, specialised to piecewise-linear paths:
// the frame only ever rotates ACROSS a vertex, by the minimal rotation carrying the
// incoming tangent onto the outgoing one) and places the 2-D profile at a fixed, shared
// set of 3-D cross-section stations. BOTH backends build from that SAME station list —
// Manifold hand-meshes it (sweepMesh below, the loft/helix-tube recipe via mesh-build.js),
// OCCT lofts the same rings ruled (occt-backend.js). So the elbow shape agrees BY
// CONSTRUCTION, not by tolerance — the same parity mechanism loft's resolveRings uses.
//
// Corners: cornerRadius==0 → a SHARP MITER (one station per vertex, in the bisecting
// plane, stretched by 1/cos(turn/2) so straight walls meet flush). cornerRadius>0 →
// a tangent circular ARC FAN (setback clamped like filletPolygon). Fold conditions
// (profile too wide for a bend; 180° reversal) throw up front — the volume+bbox oracle
// would ship a fold silently otherwise.
import { sideQuads, fanCap, manifoldFromMesh, reverseWinding } from "./mesh-build.js";

const EPS = 1e-9;
const Z = [0, 0, 1], X = [1, 0, 0];
// Corner-arc station density, in degrees of turn per station. A shared CONSTANT (not a
// backend/quality value) so both backends subdivide a cornerRadius arc identically →
// identical stations → parity by construction.
const ARC_STEP_DEG = 12;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const m = vlen(a) || 1; return [a[0] / m, a[1] / m, a[2] / m]; };
// Rotate vector v about unit axis k by angle ang (Rodrigues) — same math as
// manifold-backend.js axisAngleMat4, applied to a vector.
const rodrigues = (v, k, ang) => {
  const c = Math.cos(ang), s = Math.sin(ang), kd = dot(k, v), kv = cross(k, v);
  return [
    v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
    v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
    v[2] * c + kv[2] * s + k[2] * kd * (1 - c),
  ];
};

// Place the 2-D profile into 3-D at `center` using frame axes (N=profile-x, B=profile-y).
const placeRing = (profile2D, center, N, B) =>
  profile2D.map(([x, y]) => add(center, add(scl(N, x), scl(B, y))));

export function resolveSweepStations(profile2D, path3D, { closed = false, cornerRadius = 0 } = {}) {
  if (!Array.isArray(profile2D) || profile2D.length < 3)
    throw new Error("sweep: profile2D must be an array of ≥3 [x,y] points");
  if (!Array.isArray(path3D) || path3D.length < 2)
    throw new Error("sweep: path3D must be an array of ≥2 [x,y,z] points");
  for (let i = 0; i < path3D.length; i++) {
    const p = path3D[i];
    if (!Array.isArray(p) || p.length < 3 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2]))
      throw new Error(`sweep: path3D[${i}] must be a finite [x,y,z]`);
  }
  const P = path3D, m = P.length;
  const segCount = closed ? m : m - 1;
  const dir = [], segLen = [];
  for (let k = 0; k < segCount; k++) {
    const d = sub(P[(k + 1) % m], P[k]), l = vlen(d);
    if (l < EPS) throw new Error(`sweep: path segment ${k} has zero length (coincident points ${k} and ${(k + 1) % m})`);
    dir.push(scl(d, 1 / l)); segLen.push(l);
  }
  // profile half-width = the farthest a profile vertex reaches from its own origin
  let maxReach = 0;
  for (const [x, y] of profile2D) maxReach = Math.max(maxReach, Math.hypot(x, y));

  // Seed the frame ⟂ the tangent coming INTO the first processed station (reference-vector
  // method; the ref pick avoids N collapsing when the path starts along Z).
  const seedT = closed ? dir[segCount - 1] : dir[0];
  const ref = Math.abs(dot(seedT, Z)) < 0.9 ? Z : X;
  let N = norm(sub(ref, scl(seedT, dot(ref, seedT))));
  let B = cross(seedT, N);

  const stations = [];

  // Emit station(s) for an interior vertex and advance (N,B) from ⟂tIn to ⟂tOut.
  const corner = (center, tIn, tOut, vtx, lenIn, lenOut) => {
    const axisRaw = cross(tIn, tOut), s = vlen(axisRaw);
    const cdot = Math.max(-1, Math.min(1, dot(tIn, tOut)));
    if (cdot < -1 + 1e-6)
      throw new Error(`sweep: 180° reversal at vertex ${vtx} is ambiguous — insert an intermediate point or use cornerRadius`);
    if (s < EPS) { stations.push(placeRing(profile2D, center, N, B)); return; } // collinear: no turn, frame unchanged
    const axis = scl(axisRaw, 1 / s);
    const theta = Math.atan2(s, cdot);                    // exterior turn angle
    if (cornerRadius > 0) {
      if (cornerRadius < maxReach)
        throw new Error(`sweep: cornerRadius ${cornerRadius} < profile half-width ${maxReach.toFixed(3)} at vertex ${vtx} — the inner wall would fold; increase cornerRadius`);
      const t = cornerRadius * Math.tan(theta / 2);       // tangent setback along each leg (= r/tan(interiorHalf))
      const tmax = Math.min(lenIn, lenOut) / 2;
      if (t > tmax)
        throw new Error(`sweep: cornerRadius too large for the bend at vertex ${vtx} (setback ${t.toFixed(3)} > half the shorter segment ${tmax.toFixed(3)}) — reduce cornerRadius or lengthen the segment`);
      const a = sub(center, scl(tIn, t));                 // arc start on the incoming leg
      const arcCenter = add(center, scl(norm(sub(tOut, tIn)), cornerRadius / Math.cos(theta / 2)));
      const va = sub(a, arcCenter);
      const steps = Math.max(2, Math.ceil(((theta * 180) / Math.PI) / ARC_STEP_DEG));
      for (let i = 0; i <= steps; i++) {                  // smooth arc: rotate frame with the tangent, no miter tilt
        const ang = (theta * i) / steps;
        stations.push(placeRing(profile2D, add(arcCenter, rodrigues(va, axis, ang)),
          rodrigues(N, axis, ang), rodrigues(B, axis, ang)));
      }
    } else {                                              // sharp miter: one station in the bisecting plane
      if (maxReach * Math.tan(theta / 2) > 0.5 * Math.min(lenIn, lenOut))
        throw new Error(`sweep: profile too wide for the bend at vertex ${vtx} (turn too sharp / segment too short) — increase cornerRadius or lengthen the segment`);
      const Nh = rodrigues(N, axis, theta / 2), Bh = rodrigues(B, axis, theta / 2);
      const mDir = rodrigues(tIn, axis, theta / 2);       // ring-plane normal (average travel dir)
      const u = norm(cross(axis, mDir));                  // in-plane bend direction (stretch axis)
      const cosh = Math.cos(theta / 2);
      stations.push(profile2D.map(([x, y]) => {
        const p = add(scl(Nh, x), scl(Bh, y));            // profile point in the miter plane (spanned by u, axis)
        return add(center, add(scl(axis, dot(p, axis)), scl(u, dot(p, u) / cosh))); // stretch the u component
      }));
    }
    N = rodrigues(N, axis, theta); B = rodrigues(B, axis, theta); // advance frame to ⟂ tOut
  };

  if (closed) {
    for (let k = 0; k < m; k++)
      corner(P[k], dir[(k - 1 + m) % m], dir[k], k, segLen[(k - 1 + m) % m], segLen[k]);
  } else {
    stations.push(placeRing(profile2D, P[0], N, B));      // start cap ring ⟂ dir[0]
    for (let k = 1; k <= m - 2; k++) corner(P[k], dir[k - 1], dir[k], k, segLen[k - 1], segLen[k]);
    stations.push(placeRing(profile2D, P[m - 1], N, B));  // end cap ring ⟂ dir[last]
  }
  return { stations, closed };
}

const centroid = (ring) => {
  let cx = 0, cy = 0, cz = 0;
  for (const [x, y, z] of ring) { cx += x; cy += y; cz += z; }
  return [cx / ring.length, cy / ring.length, cz / ring.length];
};

// Manifold path: stack the resolved stations, stitch side quads, and (unless closed) fan a
// cap over each end from its 3-D centroid. Winding self-heals via loft's signed-volume
// check so the sweep is winding/direction-agnostic. Returns a raw Manifold (caller T()s).
export function sweepMesh(wasm, profile2D, path3D, opts = {}) {
  const { stations, closed } = resolveSweepStations(profile2D, path3D, opts);
  const N = profile2D.length;
  const V = [];
  for (const ring of stations) for (const [x, y, z] of ring) V.push(x, y, z);
  const Tr = [];
  sideQuads(Tr, stations.length, N, closed);
  if (!closed) {
    fanCap(V, Tr, 0, N, centroid(stations[0]), true);                          // start cap faces backward
    fanCap(V, Tr, (stations.length - 1) * N, N, centroid(stations[stations.length - 1]), false); // end faces forward
  }
  let out = manifoldFromMesh(wasm, V, Tr);
  if (out.volume() < 0) { out.delete?.(); reverseWinding(Tr); out = manifoldFromMesh(wasm, V, Tr); }
  return out;
}
