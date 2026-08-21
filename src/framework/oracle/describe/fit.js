// Least-squares fits for the five analytic surfaces the describe vocabulary uses.
//
// EVERY fit returns its own error (`rms`, `maxDev`) and no fit is ever returned
// without one. That is not decoration: the report's entire claim to honesty is
// that a surface carries the residual of the primitive it was called, so a caller
// can tell a real cylinder from a lightly-curved freeform patch that a fitter was
// willing to call one. A fit function that returned only parameters would make the
// report unfalsifiable.
//
// The algebraic (rather than geometric/iterative) formulations are deliberate.
// They are exact for exact data — which is the v1 input class, CAD-exported
// tessellation — closed-form, dependency-free, and fast enough to run inside a
// region-growing refit loop. They bias slightly under heavy noise; that is the
// known cost to revisit if real scans become a target (spec §9).
//
// Pure leaf. See spec §2.2.

const MIN_PTS = { plane: 3, sphere: 4, circle: 3 };

const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const scale = (a, s) => [a[0]*s, a[1]*s, a[2]*s];
const unit = (a) => { const n = Math.hypot(a[0], a[1], a[2]); return n > 0 ? scale(a, 1/n) : [0,0,0]; };
const mean = (pts) => {
  const c = [0,0,0];
  for (const p of pts) { c[0]+=p[0]; c[1]+=p[1]; c[2]+=p[2]; }
  return scale(c, 1/pts.length);
};
// Deviations → {rms, maxDev}. One place, so no fit can invent its own error metric.
const errors = (devs) => {
  let s = 0, m = 0;
  for (const d of devs) { s += d*d; if (Math.abs(d) > m) m = Math.abs(d); }
  return { rms: Math.sqrt(s / devs.length), maxDev: m };
};

// Cyclic Jacobi eigendecomposition of a symmetric 3x3, returned smallest-first.
// Chosen over the analytic cubic because the cubic loses precision badly on nearly
// degenerate spectra — which is exactly the case here, since a well-fit plane's
// covariance HAS a near-zero eigenvalue and that eigenvector is the answer.
export function jacobiEigen(m) {
  const a = [[m[0][0], m[0][1], m[0][2]], [m[1][0], m[1][1], m[1][2]], [m[2][0], m[2][1], m[2][2]]];
  let v = [[1,0,0],[0,1,0],[0,0,1]];
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = 0;
    for (const [p, q] of [[0,1],[0,2],[1,2]]) off += a[p][q] * a[p][q];
    if (off < 1e-30) break;
    for (const [p, q] of [[0,1],[0,2],[1,2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta*theta + 1));
      const c = 1 / Math.sqrt(t*t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c*akp - s*akq; a[k][q] = s*akp + c*akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c*apk - s*aqk; a[q][k] = s*apk + c*aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c*vkp - s*vkq; v[k][q] = s*vkp + c*vkq;
      }
    }
  }
  const order = [0,1,2].sort((i, j) => a[i][i] - a[j][j]);
  return {
    values: order.map((i) => a[i][i]),
    vectors: order.map((i) => [v[0][i], v[1][i], v[2][i]]),
  };
}

// Dense Gaussian elimination with partial pivoting. n is 3 or 4 here, so the naive
// implementation is the right one; returns null on a singular system rather than
// producing Infinities that would look like a successful fit.
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function fitPlane(pts) {
  if (pts.length < MIN_PTS.plane) return null;
  const c = mean(pts);
  const cov = [[0,0,0],[0,0,0],[0,0,0]];
  for (const p of pts) {
    const d = sub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += d[i] * d[j];
  }
  // The smallest-eigenvalue eigenvector of the covariance is the direction of least
  // spread — the plane normal. Its eigenvalue is the summed squared deviation.
  const normal = unit(jacobiEigen(cov).vectors[0]);
  if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) return null;
  const offset = dot(normal, c);
  return { type: "plane", normal, offset, ...errors(pts.map((p) => dot(normal, p) - offset)) };
}

export function fitSphere(pts) {
  if (pts.length < MIN_PTS.sphere) return null;
  // Algebraic form: |p|^2 = 2c·p + k, linear in (c, k). Four unknowns, one row per
  // point, solved through the 4x4 normal equations.
  const A = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]], b = [0,0,0,0];
  for (const p of pts) {
    const row = [2*p[0], 2*p[1], 2*p[2], 1], rhs = dot(p, p);
    for (let i = 0; i < 4; i++) { for (let j = 0; j < 4; j++) A[i][j] += row[i]*row[j]; b[i] += row[i]*rhs; }
  }
  const x = solve(A, b);
  if (!x) return null;
  const center = [x[0], x[1], x[2]];
  const r2 = x[3] + dot(center, center);
  if (!(r2 > 0)) return null;
  const radius = Math.sqrt(r2);
  return { type: "sphere", center, radius,
    ...errors(pts.map((p) => Math.hypot(p[0]-center[0], p[1]-center[1], p[2]-center[2]) - radius)) };
}

// 2D algebraic circle fit — the planar twin of fitSphere, used by the cylinder and
// torus fits after they project into a plane perpendicular to their axis.
function fitCircle2D(uv) {
  if (uv.length < MIN_PTS.circle) return null;
  const A = [[0,0,0],[0,0,0],[0,0,0]], b = [0,0,0];
  for (const [u, v] of uv) {
    const row = [2*u, 2*v, 1], rhs = u*u + v*v;
    for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) A[i][j] += row[i]*row[j]; b[i] += row[i]*rhs; }
  }
  const x = solve(A, b);
  if (!x) return null;
  const r2 = x[2] + x[0]*x[0] + x[1]*x[1];
  if (!(r2 > 0)) return null;
  return { cu: x[0], cv: x[1], radius: Math.sqrt(r2) };
}

// An orthonormal basis with `w` as its third axis. Picking the seed axis as the one
// `w` is LEAST aligned with keeps the cross product well-conditioned.
function basis(w) {
  const seed = Math.abs(w[0]) < 0.9 ? [1,0,0] : [0,1,0];
  const u = unit(cross(w, seed));
  return [u, cross(w, u), w];
}

// Recover a surface-of-revolution axis from its normal field's covariance. A full
// sweep around the axis makes the plane PERPENDICULAR to the axis isotropic (its
// two eigenvalues coincide), so the axis is always the ODD EIGENVALUE OUT — not
// always the smallest, and not always the largest:
//
//   - Cylinder: every normal is exactly perpendicular to the axis, so the axis
//     component has exactly zero variance while the isotropic pair is positive.
//     The axis is the odd one out AND the smallest.
//   - Torus (revolved through a full tube turn, v over 2π): the axis component's
//     variance is E[sin^2 v] = 1/2, while the isotropic pair splits the remaining
//     E[cos^2 v] = 1/2 in half between them (1/4 each) — verified numerically
//     across R/r ratios and sample densities, not a fixture artefact. The axis
//     variance (1/2) is exactly DOUBLE the paired eigenvalue (1/4), so here the
//     axis is the odd one out AND THE LARGEST. Picking "smallest" unconditionally
//     (as a plane or cylinder normal covariance would suggest) instead lands on an
//     arbitrary vector inside the degenerate perpendicular pair.
//
// So: sort ascending (jacobiEigen already does), and take whichever end sits
// farther from its neighbour — the end NOT part of the close pair.
function axisFromNormals(normals) {
  const cov = [[0,0,0],[0,0,0],[0,0,0]];
  for (const n of normals) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += n[i]*n[j];
  const { values, vectors } = jacobiEigen(cov);
  const gapLow = values[1] - values[0], gapHigh = values[2] - values[1];
  return unit(gapLow < gapHigh ? vectors[2] : vectors[0]);
}

export function fitCylinder(pts, normals) {
  if (pts.length < 6 || !normals || normals.length !== pts.length) return null;
  // Every normal of a cylinder is perpendicular to its axis, so the normals span a
  // plane whose own normal IS the axis. Recovering direction from the normal field
  // rather than from the points is what makes this robust on a partial arc, where
  // the points alone barely constrain it.
  const direction = axisFromNormals(normals);
  const [u, v] = basis(direction);
  const c = mean(pts);
  const circle = fitCircle2D(pts.map((p) => { const d = sub(p, c); return [dot(d, u), dot(d, v)]; }));
  if (!circle) return null;
  const origin = [
    c[0] + circle.cu*u[0] + circle.cv*v[0],
    c[1] + circle.cu*u[1] + circle.cv*v[1],
    c[2] + circle.cu*u[2] + circle.cv*v[2],
  ];
  const axials = pts.map((p) => dot(sub(p, origin), direction));
  const devs = pts.map((p) => {
    const d = sub(p, origin);
    const ax = dot(d, direction);
    return Math.hypot(d[0]-ax*direction[0], d[1]-ax*direction[1], d[2]-ax*direction[2]) - circle.radius;
  });
  return { type: "cylinder", axis: { origin, direction }, radius: circle.radius,
    extent: [Math.min(...axials), Math.max(...axials)], ...errors(devs) };
}

export function fitCone(pts, normals) {
  if (pts.length < 6 || !normals || normals.length !== pts.length) return null;
  // On a cone of half-angle a, every outward normal satisfies n·axis = -sin(a) — a
  // constant. So the normals lie on a PLANE in normal space, and fitting that plane
  // gives the axis (its normal) and the half-angle (its offset) in one step.
  const pf = fitPlane(normals);
  if (!pf) return null;
  const direction = pf.normal;
  const sinA = -pf.offset;
  const halfAngle = Math.asin(Math.max(-1, Math.min(1, Math.abs(sinA))));
  if (!(halfAngle > 1e-4) || halfAngle > Math.PI/2 - 1e-4) return null;  // a plane or a cylinder, not a cone
  // Apex: the point minimising distance to every surface normal's plane. Each point
  // contributes n·x = n·p, and the least-squares intersection of those planes is the
  // apex, since every cone normal's plane passes through it.
  const A = [[0,0,0],[0,0,0],[0,0,0]], b = [0,0,0];
  for (let i = 0; i < pts.length; i++) {
    const n = normals[i], rhs = dot(n, pts[i]);
    for (let r = 0; r < 3; r++) { for (let cc = 0; cc < 3; cc++) A[r][cc] += n[r]*n[cc]; b[r] += n[r]*rhs; }
  }
  const apex = solve(A, b);
  if (!apex) return null;
  const axis = dot(sub(pts[0], apex), direction) < 0 ? scale(direction, -1) : direction;
  const tanA = Math.tan(halfAngle);
  const devs = pts.map((p) => {
    const d = sub(p, apex);
    const ax = dot(d, axis);
    const rad = Math.hypot(d[0]-ax*axis[0], d[1]-ax*axis[1], d[2]-ax*axis[2]);
    return (rad - ax * tanA) * Math.cos(halfAngle);   // perpendicular distance to the surface
  });
  return { type: "cone", apex, direction: axis, halfAngle, ...errors(devs) };
}

export function fitTorus(pts, normals) {
  if (pts.length < 8 || !normals || normals.length !== pts.length) return null;
  // A torus normal always lies in the plane containing the axis and the point, so
  // its covariance is degenerate the same way a cylinder's is — but the axis is
  // the odd-eigenvalue-out, not unconditionally the smallest one; see
  // axisFromNormals for the (verified) reasoning.
  const axis = axisFromNormals(normals);
  const c = mean(pts);
  // In the (radial, axial) half-plane a torus is a CIRCLE of the minor radius centred
  // at the major radius. Fitting that 2D circle recovers both radii at once.
  const rz = pts.map((p) => {
    const d = sub(p, c);
    const ax = dot(d, axis);
    return [Math.hypot(d[0]-ax*axis[0], d[1]-ax*axis[1], d[2]-ax*axis[2]), ax];
  });
  const circle = fitCircle2D(rz);
  if (!circle || !(circle.cu > circle.radius)) return null;   // degenerate / self-intersecting
  const center = [c[0] + circle.cv*axis[0], c[1] + circle.cv*axis[1], c[2] + circle.cv*axis[2]];
  const devs = rz.map(([r, z]) => Math.hypot(r - circle.cu, z - circle.cv) - circle.radius);
  return { type: "torus", center, axis, majorRadius: circle.cu, minorRadius: circle.radius, ...errors(devs) };
}
