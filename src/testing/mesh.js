// test/helpers.js — shared test utilities (mesh volume + bbox from a flat mesh).
// `indices` is optional: when omitted the positions are treated as a flat,
// non-indexed triangle soup (3 vertices per triangle).
export function meshVolume(positions, indices) {
  const n = indices ? indices.length : positions.length / 3;
  let V = 0;
  for (let i = 0; i < n; i += 3) {
    const a = (indices ? indices[i] : i) * 3, b = (indices ? indices[i + 1] : i + 1) * 3, c = (indices ? indices[i + 2] : i + 2) * 3;
    V += (positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
        - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
        + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])) / 6;
  }
  return Math.abs(V);
}
// Volume-weighted centroid (uniform-density center of mass) of a triangle mesh,
// via the same signed-tetrahedron decomposition as meshVolume. `indices` is
// optional: omit for a flat soup (3 verts/triangle). Returns [x,y,z], or null when
// the mesh encloses ~no volume (open/degenerate), where a centroid is undefined.
// Signed V (not abs) is used so the winding sign cancels in C/V.
export function meshCentroid(positions, indices) {
  const n = indices ? indices.length : positions.length / 3;
  let V = 0, cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i += 3) {
    const a = (indices ? indices[i] : i) * 3, b = (indices ? indices[i + 1] : i + 1) * 3, c = (indices ? indices[i + 2] : i + 2) * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const dx = positions[c], dy = positions[c + 1], dz = positions[c + 2];
    // signed volume of tetra (origin, a, b, c) = a · (b × c) / 6
    const v = (ax * (by * dz - bz * dy) - ay * (bx * dz - bz * dx) + az * (bx * dy - by * dx)) / 6;
    V += v;
    // tetra centroid = (0 + a + b + c) / 4, weighted by its signed volume
    cx += v * (ax + bx + dx) / 4;
    cy += v * (ay + by + dy) / 4;
    cz += v * (az + bz + dz) / 4;
  }
  if (Math.abs(V) < 1e-9) return null;
  return [cx / V, cy / V, cz / V];
}

export function bboxSize(positions) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let a = 0; a < 3; a++) {
    lo[a] = Math.min(lo[a], positions[i + a]); hi[a] = Math.max(hi[a], positions[i + a]);
  }
  return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
}

// Axis-aligned bounds of a flat position array (x,y,z per vertex).
export function bounds(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let a = 0; a < 3; a++) {
    const v = positions[i + a];
    if (v < min[a]) min[a] = v;
    if (v > max[a]) max[a] = v;
  }
  return { min, max };
}

// Surface area (mm²) of a triangle mesh. `indices` is optional: when omitted the
// positions are a non-indexed soup (3 consecutive verts per triangle, Manifold);
// when given, positions is a vertex array indexed by triangle (OCCT/replicad).
export function meshArea(positions, indices) {
  let area = 0;
  const n = indices ? indices.length : positions.length / 3;
  for (let i = 0; i < n; i += 3) {
    const a = (indices ? indices[i] : i) * 3, b = (indices ? indices[i + 1] : i + 1) * 3, c = (indices ? indices[i + 2] : i + 2) * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    area += Math.hypot(nx, ny, nz) / 2;
  }
  return area;
}
