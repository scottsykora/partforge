// Pure classification math for OCCT feature labels. The OCCT backend meshes each
// labeled solid snapshot into a triangle soup; a face of the RESULT mesh belongs to
// a label when its sampled triangle centroids all lie on that soup's surface (a cut
// face lies exactly on its tool's surface, up to the two meshes' tolerances).
// No OCCT, no three.js — unit-testable with hand-built soups.

// Result mesh (preview) tolerance 0.1 + snapshot mesh tolerance 0.1 + slack.
const DEFAULT_TOL = 0.35; // mm — surfaces closer than this to another labeled surface can misattribute
const SAMPLES_PER_FACE = 4;

// Distance from point p to triangle (a,b,c) — the classic region-based projection.
export function pointTriDist(p, a, b, c) {
  const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return Math.hypot(...ap);                 // vertex a
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return Math.hypot(...bp);                // vertex b
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {                              // edge ab
    const t = d1 / (d1 - d3);
    return Math.hypot(...sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]));
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return Math.hypot(...cp);                // vertex c
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {                              // edge ac
    const t = d2 / (d2 - d6);
    return Math.hypot(...sub(p, [a[0] + ac[0] * t, a[1] + ac[1] * t, a[2] + ac[2] * t]));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {                    // edge bc
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const bc = sub(c, b);
    return Math.hypot(...sub(p, [b[0] + bc[0] * t, b[1] + bc[1] * t, b[2] + bc[2] * t]));
  }
  const denom = 1 / (va + vb + vc);                                  // interior
  const v = vb * denom, w = vc * denom;
  return Math.hypot(...sub(p, [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]));
}

const centroid = (V, T, t) => {
  const i = T[t * 3] * 3, j = T[t * 3 + 1] * 3, k = T[t * 3 + 2] * 3;
  return [(V[i] + V[j] + V[k]) / 3, (V[i + 1] + V[j + 1] + V[k + 1]) / 3, (V[i + 2] + V[j + 2] + V[k + 2]) / 3];
};

function distToSoup(p, soup) {
  const V = soup.vertices, T = soup.triangles;
  let best = Infinity;
  for (let t = 0; t < T.length / 3; t++) {
    const a = [V[T[t * 3] * 3], V[T[t * 3] * 3 + 1], V[T[t * 3] * 3 + 2]];
    const b = [V[T[t * 3 + 1] * 3], V[T[t * 3 + 1] * 3 + 1], V[T[t * 3 + 1] * 3 + 2]];
    const c = [V[T[t * 3 + 2] * 3], V[T[t * 3 + 2] * 3 + 1], V[T[t * 3 + 2] * 3 + 2]];
    const d = pointTriDist(p, a, b, c);
    if (d < best) best = d;
  }
  return best;
}

// resultMesh: replicad ShapeMesh {vertices, triangles, faceGroups}; soups: labeled
// snapshots meshed by the caller. Returns {} when attribution isn't possible.
export function classifyFaceGroups(resultMesh, soups, tol = DEFAULT_TOL) {
  const groups = resultMesh.faceGroups;
  const nTri = resultMesh.triangles.length / 3;
  if (!groups?.length || !soups.length) return {};

  // faceGroups start/count units differ across replicad versions: triangle counts
  // sum to nTri, index counts to nTri*3. Detect which this is.
  const total = groups.reduce((s, g) => s + g.count, 0);
  const div = total === nTri * 3 ? 3 : 1;

  const indexOf = new Map(); // label -> 1-based feature index (same-label merge)
  const features = [];
  const featureIds = new Uint16Array(nTri);

  for (const g of groups) {
    const start = g.start / div, count = g.count / div;
    // sample a few spread triangles of the face
    const picks = [];
    for (let s = 0; s < Math.min(SAMPLES_PER_FACE, count); s++) {
      picks.push(start + Math.floor((s * (count - 1)) / Math.max(1, SAMPLES_PER_FACE - 1)));
    }
    // last matching soup wins (most recently applied label)
    let winner = null;
    for (const soup of soups) {
      const onSurface = picks.every(
        (t) => distToSoup(centroid(resultMesh.vertices, resultMesh.triangles, t), soup) <= tol
      );
      if (onSurface) winner = soup.label;
    }
    if (winner == null) continue;
    let fi = indexOf.get(winner);
    if (fi === undefined) { features.push(winner); fi = features.length; indexOf.set(winner, fi); }
    for (let t = start; t < start + count; t++) featureIds[t] = fi;
  }
  return features.length ? { featureIds, features } : {};
}
