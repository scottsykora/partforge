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
