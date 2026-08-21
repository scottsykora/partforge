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

// Relative (not absolute) threshold for "this eigenvalue is effectively zero".
// These eigenvalues are raw sums of squared deviations/components over however
// many points or normals were handed in — an unnormalised quantity whose scale
// grows with the input count and with the size of the geometry in mm. An
// absolute cutoff would be tuned for one input and wrong for the next; comparing
// each eigenvalue against the largest one in the SAME decomposition is scale-free
// and works whether the caller passed 8 points or 8000.
const ZERO_EIGEN_REL = 1e-6;

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
  const { values, vectors } = jacobiEigen(cov);
  // Collinear (or coincident) points make the covariance rank <= 1: the null
  // space is 2-D or 3-D, so the SECOND-smallest eigenvalue is also ~0 and
  // whichever vector the eigensolver happens to land on in that null space gets
  // reported as "the" normal — with a false rms of ~0, the worst possible
  // combination (garbage parameters paired with a claim of a perfect fit).
  // A genuine plane's points span a real 2-D spread, so its SECOND eigenvalue is
  // NOT negligible next to the largest one; only the smallest (the true normal
  // direction) is. Checking values[1] here (not values[0], which is expected to
  // be small for any good planar fit) is what catches the degenerate rank-1 case
  // without rejecting legitimate flat data. Coincident points are the further
  // degenerate case where even the LARGEST eigenvalue is ~0 (no spread at all in
  // any direction) — guard that first, since "values[1] < values[2] * REL" is
  // vacuously false when values[2] itself is 0 (0 is not < 0) and would
  // otherwise let three identical points through as a "perfect" plane fit.
  if (!(values[2] > 0) || values[1] < values[2] * ZERO_EIGEN_REL) return null;
  const normal = unit(vectors[0]);
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

// Recover a surface-of-revolution axis from its normal field's covariance.
//
// THREE regimes are in play, and each has its own exact invariant — collapsing
// any two of them into a single rule is what made this function wrong twice
// before landing on this version (see fix-round history in the task-2 report):
//
//   1. Cylinder, a RULED surface (every normal exactly perpendicular to the
//      axis): the axis component has EXACTLY ZERO variance at ANY arc width,
//      even 1°. Algebraic fact, not a full-sweep consequence — always the
//      smallest eigenvalue, always negligible next to the largest.
//   2. A surface whose MAIN sweep (u, the revolution around the axis) is FULL —
//      a full torus, or a fillet/round of ANY tube angle swept all the way
//      around — symmetrizes the plane PERPENDICULAR to the axis into isotropy
//      (its two eigenvalues coincide) regardless of how little of the TUBE (v)
//      is covered, because averaging a direction-dependent quantity over a full
//      revolution erases that direction dependence. So the axis is the ODD
//      EIGENVALUE OUT of a near-degenerate pair — and it can be the smallest
//      member of that pair (e.g. a 30°-45° fillet, full main sweep) or the
//      largest (e.g. a full torus, tube fully revolved too), depending on
//      whether the tube's own axial variance ends up above or below its
//      perpendicular share. Either way, "closest pair, odd one out" is exact
//      here at any tube coverage.
//   3. A surface whose main sweep is PARTIAL but whose tube IS fully revolved
//      (a torus feature only partly swept around its main axis): now regime 2's
//      isotropy is gone (the perpendicular pair is no longer equal — verified
//      wrong on a 90°/45° main sweep, where gap-comparison mistakes one of a
//      genuinely non-degenerate triple for a "pair"), but a DIFFERENT exact
//      invariant survives: because every normal is unit length, the covariance
//      trace is exactly the point count regardless of sampling, and the axis
//      component's variance depends only on the (fully-swept) tube parameter,
//      never on the main-sweep angle. So the axis eigenvalue sits at exactly
//      HALF THE TRACE, independent of main-sweep width — verified numerically
//      from 360° down to 10° of main sweep.
//
// Regimes 2 and 3 are near-exact complements (a full main sweep satisfies both
// the pair test and, often only coincidentally, the half-trace test; a partial
// main sweep with a wide tube satisfies neither pair test but does satisfy
// half-trace) — so the pair check MUST run before the half-trace fallback, not
// the reverse, or a genuine fillet at an odd tube angle gets the wrong pick.
//
// Order: (1) ruled-surface zero, exact at any arc width; then (2) near-
// degenerate pair -> odd one out, exact whenever the main sweep is full at any
// tube coverage; then (3) half-trace, exact whenever the tube is full at any
// main-sweep coverage. The pair test uses the SAME relative scale as the zero
// test (not a separately-tuned constant): both are asking "is this gap
// negligible next to the largest eigenvalue", just between different pairs of
// eigenvalues, and these are unnormalised sums over an arbitrary point count so
// only a relative comparison is meaningful for either.
function axisFromNormals(normals) {
  const cov = [[0,0,0],[0,0,0],[0,0,0]];
  for (const n of normals) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += n[i]*n[j];
  const { values, vectors } = jacobiEigen(cov);
  if (values[0] < values[2] * ZERO_EIGEN_REL) return unit(vectors[0]);
  const gapLow = values[1] - values[0], gapHigh = values[2] - values[1];
  const pairEps = values[2] * ZERO_EIGEN_REL;
  if (gapLow < pairEps || gapHigh < pairEps) return unit(gapLow < gapHigh ? vectors[2] : vectors[0]);
  const halfTrace = (values[0] + values[1] + values[2]) / 2;
  const best = [0, 1, 2].reduce((a, b) => (Math.abs(values[b] - halfTrace) < Math.abs(values[a] - halfTrace) ? b : a));
  return unit(vectors[best]);
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
  // whichever eigenvalue sits at half the trace, not unconditionally the
  // smallest one; see axisFromNormals for the (verified) reasoning.
  const axis = axisFromNormals(normals);
  const [u, v] = basis(axis);
  // For a torus, the tube cross-section is ITSELF a circle, so the outward
  // normal at any surface point points directly away from that cross-section's
  // own centre — i.e. `p - r*n` (for the true minor radius r) collapses every
  // point back onto the MAIN circle (radius R, centred on the axis), regardless
  // of how little of the main sweep is covered. That main-circle point's AXIAL
  // coordinate is therefore CONSTANT (the tube-centre direction is perpendicular
  // to the axis by construction), which turns "solve for r and that constant"
  // into a plain 1-D linear regression: dot(p,axis) = centreAxial + r*dot(n,axis).
  //
  // This replaces centring on the raw point mean, which a first review round
  // caught giving the wrong answer on a partial main sweep: the point centroid
  // only lands ON the axis when the sweep is full, and any off-axis error in it
  // corrupts every downstream "distance from axis" magnitude (unlike fitCylinder,
  // whose circle fit works in full 2-D (u,v) coordinates and so self-corrects for
  // an off-centre pivot; collapsing to a 1-D radial magnitude first, as the
  // original torus fit did, throws that self-correcting information away).
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  const na = normals.map((n) => dot(n, axis)), pa = pts.map((p) => dot(p, axis));
  for (let i = 0; i < pts.length; i++) { sx += na[i]; sy += pa[i]; sxx += na[i]*na[i]; sxy += na[i]*pa[i]; }
  const N = pts.length; sx /= N; sy /= N; sxx /= N; sxy /= N;
  const denom = sxx - sx*sx;
  // Denominator is the variance of the normal's axial component — i.e. how much
  // of the tube is actually covered. Near zero means the tube sweep is too thin
  // to separate the minor radius from the centre's axial position at all (a
  // cylinder or a flat annulus in disguise), not something to divide by.
  if (!(Math.abs(denom) > 1e-9)) return null;
  const rSigned = (sxy - sx*sy) / denom;
  const centreAxial = sy - rSigned*sx;
  const minorRadius = Math.abs(rSigned);
  if (!(minorRadius > 0)) return null;
  const uv = pts.map((p, i) => {
    const q = sub(p, scale(normals[i], rSigned));
    return [dot(q, u), dot(q, v)];
  });
  const circle = fitCircle2D(uv);
  if (!circle || !(circle.radius > minorRadius)) return null;   // degenerate / self-intersecting
  const center = [
    circle.cu*u[0] + circle.cv*v[0] + centreAxial*axis[0],
    circle.cu*u[1] + circle.cv*v[1] + centreAxial*axis[1],
    circle.cu*u[2] + circle.cv*v[2] + centreAxial*axis[2],
  ];
  const devs = pts.map((p) => {
    const d = sub(p, center);
    const ax = dot(d, axis);
    const rad = Math.hypot(d[0]-ax*axis[0], d[1]-ax*axis[1], d[2]-ax*axis[2]);
    return Math.hypot(rad - circle.radius, ax) - minorRadius;
  });
  return { type: "torus", center, axis, majorRadius: circle.radius, minorRadius, ...errors(devs) };
}
