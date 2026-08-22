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

// SIGNED distance from a point to the surface a completed fit describes:
// positive outside the surface (further from the solid than the fit claims),
// negative inside, ~0 on it. Every fit below computes exactly this arithmetic
// once, inline, over its own residual loop, to produce rms/maxDev — this is
// that arithmetic factored out into the one place it belongs, rather than a
// sixth private copy. Two callers outside this file need the identical
// definition and must never be allowed to drift apart on it: segment.js's
// region-growing predicate (a candidate face joins a patch only if its
// deviation from the STANDING fit is small) and Task 4's RANSAC consensus
// test (a point counts as an inlier under the identical rule). Takes a
// completed fit's parameters (type plus whatever fields that type carries —
// normal/offset, center/radius, axis/origin/radius, apex/direction/halfAngle,
// or center/axis/majorRadius/minorRadius); rms/maxDev are not read.
export function deviationOf(fit, point) {
  switch (fit.type) {
    case "plane":
      return dot(fit.normal, point) - fit.offset;
    case "sphere": {
      const d = sub(point, fit.center);
      return Math.hypot(d[0], d[1], d[2]) - fit.radius;
    }
    case "cylinder": {
      const d = sub(point, fit.axis.origin), dir = fit.axis.direction;
      const ax = dot(d, dir);
      return Math.hypot(d[0]-ax*dir[0], d[1]-ax*dir[1], d[2]-ax*dir[2]) - fit.radius;
    }
    case "cone": {
      const d = sub(point, fit.apex), dir = fit.direction;
      const ax = dot(d, dir);
      const rad = Math.hypot(d[0]-ax*dir[0], d[1]-ax*dir[1], d[2]-ax*dir[2]);
      // Perpendicular (not radial) distance to the cone's slanted surface: the
      // radial gap at this height, projected onto the surface normal via
      // cos(halfAngle) — same derivation fitCone's own residual used below,
      // recomputing tan/cos of halfAngle rather than threading a precomputed
      // tanA through, since a fit's stored parameters are its only contract.
      return (rad - ax * Math.tan(fit.halfAngle)) * Math.cos(fit.halfAngle);
    }
    case "torus": {
      const d = sub(point, fit.center), dir = fit.axis;
      const ax = dot(d, dir);
      const rad = Math.hypot(d[0]-ax*dir[0], d[1]-ax*dir[1], d[2]-ax*dir[2]);
      return Math.hypot(rad - fit.majorRadius, ax) - fit.minorRadius;
    }
    default:
      throw new Error(`deviationOf: unknown fit type "${fit.type}"`);
  }
}

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
  const fit = { type: "plane", normal, offset };
  return { ...fit, ...errors(pts.map((p) => deviationOf(fit, p))) };
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
  const fit = { type: "sphere", center, radius };
  return { ...fit, ...errors(pts.map((p) => deviationOf(fit, p))) };
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

// Recover a RULED SURFACE's (a cylinder's) axis from its normal field's
// covariance. Every normal of a cylinder is exactly perpendicular to the axis,
// so the axis component of the normal has EXACTLY ZERO variance — an algebraic
// fact, not a consequence of sampling a full sweep, so it holds at any arc
// width down to a sliver (verified to 0.5°) and survives real tessellation
// facet noise (a cylinder's facet normals still average to exactly
// perpendicular-to-axis, since faceting only perturbs direction WITHIN that
// perpendicular plane). The axis is therefore always the smallest eigenvalue's
// eigenvector, unconditionally — no fallback needed, because this function is
// only ever called for a ruled surface. (A torus does NOT have this property —
// its normal is only perpendicular to the axis at the crown/root of the tube —
// so fitTorus recovers its axis a different way entirely: see the comment
// there. Two earlier fix rounds tried to extend this same normals-only
// covariance trick to the torus case via gap-comparison and half-trace rules;
// both were provably wrong on some combination of partial main-sweep and
// partial tube-sweep coverage, which is why fitTorus no longer calls this.)
function ruledSurfaceAxis(normals) {
  const cov = [[0,0,0],[0,0,0],[0,0,0]];
  for (const n of normals) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += n[i]*n[j];
  return unit(jacobiEigen(cov).vectors[0]);
}

export function fitCylinder(pts, normals) {
  if (pts.length < 6 || !normals || normals.length !== pts.length) return null;
  // Every normal of a cylinder is perpendicular to its axis, so the normals span a
  // plane whose own normal IS the axis. Recovering direction from the normal field
  // rather than from the points is what makes this robust on a partial arc, where
  // the points alone barely constrain it.
  const direction = ruledSurfaceAxis(normals);
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
  const fit = { type: "cylinder", axis: { origin, direction }, radius: circle.radius,
    extent: [Math.min(...axials), Math.max(...axials)] };
  return { ...fit, ...errors(pts.map((p) => deviationOf(fit, p))) };
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
  const fit = { type: "cone", apex, direction: axis, halfAngle };
  return { ...fit, ...errors(pts.map((p) => deviationOf(fit, p))) };
}

// Search the minor radius r that makes {p_i - r*n_i} as coplanar as possible
// (see fitTorus for why that particular objective picks out the true r), using
// a golden-section minimisation. FIXED iteration counts throughout — no
// data-dependent stopping criterion — because this module's whole contract is
// pure, reproducible fits (a later stage memoizes by content hash, so a search
// that iterated a variable number of times depending on floating-point noise
// would poison that cache even for byte-identical input).
//
// The objective, `fitPlane({p_i - r*n_i}).rms`, is not guaranteed unimodal
// over its whole domain (it can wobble before settling near the true r), so a
// blind golden-section search over the full range risks converging to a local
// dip instead of the global minimum. A coarse, evenly-spaced scan finds a
// bracket around whichever sample is smallest — cheap, and robust to a
// non-unimodal objective, because it evaluates the entire range rather than
// trusting a local descent — and golden-section then refines within that
// bracket, where the objective is well-behaved (essentially quadratic near a
// true minimum for exact or near-exact data).
//
// SIGNED r, searched over BOTH signs (round-2 review, controller ruling — this
// plan's Task 6 flagged it after finding `fitTorus` silently mis-measured a
// concave-corner fillet). The coplanarity identity `t = p - r*n` assumes the
// outward normal `n` points AWAY from the tube cross-section's own centre —
// true for a torus's convex half (a full closed torus; a fillet rounding a
// CONVEX corner, e.g. a shaft's top rim). On the CONCAVE half (a fillet
// rounding an inside corner — a pocket floor, a boss's base) the true outward
// normal points TOWARD that centre instead, and the correct r for the SAME
// identity to collapse onto the main circle is NEGATIVE. A positive-only
// search cannot represent that r at all: it was converging on whichever
// spurious positive value happened to look locally best and returning it with
// no null and no elevated residual — a silent wrong answer, not a failure.
// Searching both signs and keeping the globally better one fixes this without
// changing anything about the convex case, which already found its optimum on
// the positive side and still does.
const TORUS_R_COARSE_STEPS = 48;   // scan resolution: bracket-finding, not final precision
const TORUS_R_REFINE_ITERS = 40;   // golden-section iterations inside the bracket
// A thin band around r=0 is excluded from the search on both sides: at r=0 the
// "derived" set is just the input points themselves, whose planarity reflects
// the raw patch's own flatness rather than anything about a candidate radius —
// it can look spuriously good by coincidence and pull the coarse scan's
// bracket onto a meaningless near-zero radius. A physical tube's true minor
// radius is never a sliver of the whole patch's own bounding-box diagonal, so
// excluding a sliver of `rMax` around zero from both signs costs no real
// coverage.
const TORUS_R_DEADZONE_FRAC = 1 / (TORUS_R_COARSE_STEPS * 4);

function torusMinorRadius(pts, normals) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let i = 0; i < 3; i++) { if (p[i] < lo[i]) lo[i] = p[i]; if (p[i] > hi[i]) hi[i] = p[i]; }
  // No candidate minor radius can exceed half the bounding-box diagonal: every
  // point of {p_i - r*n_i} would already have to reach outside the box the
  // input itself lives in.
  const rMax = Math.hypot(hi[0]-lo[0], hi[1]-lo[1], hi[2]-lo[2]) / 2;
  if (!(rMax > 0)) return 0;
  const planarity = (r) => {
    const derived = pts.map((p, i) => sub(p, scale(normals[i], r)));
    const pf = fitPlane(derived);
    return pf ? pf.rms : Infinity;   // a degenerate derived set is an infinitely bad r, not a crash
  };
  const deadzone = rMax * TORUS_R_DEADZONE_FRAC;
  const GOLDEN = (Math.sqrt(5) - 1) / 2;

  // Coarse-scan-then-golden-section-refine over the magnitude, on one given
  // sign, exactly as the original single-sided search did — just parameterised
  // on `sign` so it runs identically for +1 and -1 below.
  const searchSide = (sign) => {
    const samples = [];
    for (let i = 0; i < TORUS_R_COARSE_STEPS; i++) {
      samples.push(deadzone + ((rMax - deadzone) * (i + 1)) / TORUS_R_COARSE_STEPS);
    }
    let bestI = 0, bestVal = Infinity;
    for (let i = 0; i < TORUS_R_COARSE_STEPS; i++) {
      const val = planarity(sign * samples[i]);
      if (val < bestVal) { bestVal = val; bestI = i; }
    }
    let a = bestI > 0 ? samples[bestI - 1] : deadzone;
    let b = bestI < TORUS_R_COARSE_STEPS - 1 ? samples[bestI + 1] : Math.min(rMax, samples[bestI] * 1.5);
    let c = b - GOLDEN*(b-a), d = a + GOLDEN*(b-a);
    let fc = planarity(sign*c), fd = planarity(sign*d);
    for (let k = 0; k < TORUS_R_REFINE_ITERS; k++) {
      if (fc < fd) { b = d; d = c; fd = fc; c = b - GOLDEN*(b-a); fc = planarity(sign*c); }
      else { a = c; c = d; fc = fd; d = a + GOLDEN*(b-a); fd = planarity(sign*d); }
    }
    const r = sign * (a + b) / 2;
    return { r, val: planarity(r) };
  };

  const positive = searchSide(1);
  const negative = searchSide(-1);
  return positive.val <= negative.val ? positive.r : negative.r;
}

export function fitTorus(pts, normals) {
  if (pts.length < 8 || !normals || normals.length !== pts.length) return null;
  // A torus's tube cross-section is ITSELF a circle, so the outward normal at
  // any surface point p points directly away from that cross-section's own
  // centre: for the TRUE minor radius r, `t = p - r*n` collapses every point
  // back onto the MAIN circle (radius R, centred on the axis) — regardless of
  // how little of the main sweep OR the tube is covered. Equivalently: `t` is
  // COPLANAR (all points lie in the plane through the centre, perpendicular to
  // the axis) exactly when r is correct, and increasingly scattered out of any
  // plane the more r is wrong in either direction. That gives a single scalar
  // objective — the planarity residual of {p_i - r*n_i} — whose minimiser IS
  // the minor radius, and whose minimising plane's normal IS the axis.
  //
  // This replaces two earlier, and both wrong, attempts to recover the axis
  // from the NORMAL FIELD ALONE (a gap-comparison rule, then a half-trace
  // rule): each was exact in one of {full main sweep, full tube sweep} and
  // silently wrong in the other, because normals alone don't carry a single
  // invariant that survives an arbitrary combination of partial main-sweep and
  // partial tube-sweep coverage. Using POSITIONS AND NORMALS TOGETHER removes
  // the ambiguity entirely: coplanarity of the derived point set is a property
  // of the actual 3-D shape, not of how the sweep happened to be sampled.
  //
  // `torusMinorRadius` now returns a SIGNED r (see its own comment): positive
  // for the convex-corner/full-torus case its formula was originally derived
  // for, negative for the concave-corner case, where the true outward normal
  // points toward the tube's own centre rather than away from it. The signed
  // value is what the `derived = p - r*n` identity actually needs to collapse
  // onto the main circle in EITHER case; `minorRadius` itself is reported
  // positive, as every other radius in this module is, with the sign carried
  // separately in `concaveTube` — cheap to keep (the sign is already computed;
  // discarding it would just be throwing away a fact the fit already knows),
  // and it independently corroborates the `curvature` surface-graph.js derives
  // from the mesh's own face normals rather than from this fit's parameters.
  const signedR = torusMinorRadius(pts, normals);
  const minorRadius = Math.abs(signedR);
  if (!(minorRadius > 0)) return null;
  const derived = pts.map((p, i) => sub(p, scale(normals[i], signedR)));
  const pf = fitPlane(derived);
  if (!pf) return null;
  const axis = pf.normal;
  const [u, v] = basis(axis);
  // `pf.normal`/`pf.offset` give the axis and the plane's distance from the
  // origin; the plane's IN-PLANE position (the centre's u,v coordinates) still
  // needs a 2-D circle fit, same as fitCylinder's origin recovery.
  const uv = derived.map((t) => [dot(t, u), dot(t, v)]);
  const circle = fitCircle2D(uv);
  if (!circle || !(circle.radius > minorRadius)) return null;   // degenerate / self-intersecting
  const center = [
    circle.cu*u[0] + circle.cv*v[0] + pf.offset*axis[0],
    circle.cu*u[1] + circle.cv*v[1] + pf.offset*axis[1],
    circle.cu*u[2] + circle.cv*v[2] + pf.offset*axis[2],
  ];
  const fit = { type: "torus", center, axis, majorRadius: circle.radius, minorRadius, concaveTube: signedR < 0 };
  return { ...fit, ...errors(pts.map((p) => deviationOf(fit, p))) };
}
