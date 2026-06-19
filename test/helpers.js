// test/helpers.js — shared test utilities (mesh volume + bbox from a flat mesh)
export function meshVolume(positions, indices) {
  let V = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
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
