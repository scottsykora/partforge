import { expect, test } from "vitest";
import { fitPlane, fitSphere, fitCylinder, fitCone, fitTorus } from "../src/framework/oracle/describe/fit.js";

const grid = (f, n = 12) => {
  const out = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out.push(f(i / (n - 1), j / (n - 1)));
  return out;
};

test("fitPlane recovers a tilted plane exactly", () => {
  // z = 2x + 3y + 5  ->  normal proportional to (-2,-3,1)
  const pts = grid((u, v) => [u * 10, v * 10, 2 * (u * 10) + 3 * (v * 10) + 5]);
  const f = fitPlane(pts);
  const k = 1 / Math.hypot(2, 3, 1);
  expect(Math.abs(f.normal[0])).toBeCloseTo(2 * k, 6);
  expect(Math.abs(f.normal[1])).toBeCloseTo(3 * k, 6);
  expect(f.rms).toBeLessThan(1e-9);
});

test("fitPlane reports real error on a deliberately non-planar set", () => {
  const pts = grid((u, v) => [u * 10, v * 10, u * v * 4]);
  expect(fitPlane(pts).rms).toBeGreaterThan(0.1);
});

test("fitSphere recovers centre and radius", () => {
  const pts = [];
  for (let i = 0; i < 200; i++) {
    const th = (i * 2.399963), z = -1 + 2 * (i + 0.5) / 200, r = Math.sqrt(1 - z * z);
    pts.push([3 + 7 * r * Math.cos(th), -2 + 7 * r * Math.sin(th), 5 + 7 * z]);
  }
  const f = fitSphere(pts);
  expect(f.center[0]).toBeCloseTo(3, 4);
  expect(f.center[1]).toBeCloseTo(-2, 4);
  expect(f.center[2]).toBeCloseTo(5, 4);
  expect(f.radius).toBeCloseTo(7, 4);
});

test("fitCylinder recovers axis direction, radius, and axial extent", () => {
  const pts = [], normals = [];
  for (let i = 0; i < 64; i++) for (const z of [0, 2, 4, 6]) {
    const a = 2 * Math.PI * i / 64;
    const n = [Math.cos(a), Math.sin(a), 0];
    normals.push(n);
    pts.push([1 + 2.5 * n[0], 4 + 2.5 * n[1], z]);
  }
  const f = fitCylinder(pts, normals);
  expect(Math.abs(f.axis.direction[2])).toBeCloseTo(1, 6);
  expect(f.radius).toBeCloseTo(2.5, 5);
  expect(f.extent[1] - f.extent[0]).toBeCloseTo(6, 5);
});

test("fitCone recovers half-angle", () => {
  const pts = [], normals = [];
  const halfAngle = Math.PI / 6;                   // 30 degrees
  for (let i = 0; i < 64; i++) for (const z of [1, 2, 3, 4]) {
    const a = 2 * Math.PI * i / 64;
    const r = z * Math.tan(halfAngle);
    pts.push([r * Math.cos(a), r * Math.sin(a), z]);
    // outward normal of a +Z-opening cone
    const n = [Math.cos(halfAngle) * Math.cos(a), Math.cos(halfAngle) * Math.sin(a), -Math.sin(halfAngle)];
    normals.push(n);
  }
  const f = fitCone(pts, normals);
  expect(f.halfAngle).toBeCloseTo(halfAngle, 3);
});

test("a fit with too few points returns null rather than a garbage fit", () => {
  expect(fitPlane([[0,0,0],[1,0,0]])).toBeNull();
  expect(fitSphere([[0,0,0],[1,0,0],[0,1,0]])).toBeNull();
});

// Regression: a first pass at this axis recovery took the smallest-eigenvalue
// eigenvector as the axis unconditionally, which is only correct for a FULL
// sweep. On a partial arc the isotropy that makes "smallest" meaningful breaks,
// and the fitted axis silently flips to a wrong-but-plausible answer (verified
// during review: 90° gave axis [1,0,0] instead of [0,0,1], radius 2.02 instead
// of 2.5). A cylinder's axis eigenvalue is exactly zero at ANY arc width, so
// this must hold from a full sweep down to a sliver.
test("fitCylinder recovers axis/radius/rms on a partial arc (90°, 45°, 20°)", () => {
  for (const arcDeg of [90, 45, 20]) {
    const arc = (arcDeg * Math.PI) / 180;
    const pts = [], normals = [];
    for (let i = 0; i < 64; i++) for (const z of [0, 2, 4, 6]) {
      const a = (arc * i) / 64;
      const n = [Math.cos(a), Math.sin(a), 0];
      normals.push(n);
      pts.push([1 + 2.5 * n[0], 4 + 2.5 * n[1], z]);
    }
    const f = fitCylinder(pts, normals);
    expect(f).not.toBeNull();
    expect(Math.abs(f.axis.direction[2])).toBeCloseTo(1, 6);
    expect(f.radius).toBeCloseTo(2.5, 5);
    expect(f.rms).toBeLessThan(1e-6);
  }
});

// Regression, table-driven over the 8 sweep-coverage combinations that broke
// two earlier attempts to recover a torus axis from its NORMAL FIELD ALONE (a
// gap-comparison rule, then a half-trace rule — see git history and the task-2
// report's fix-round log): a full torus; a partial main sweep (u=180/90/45°)
// with the tube fully revolved; and a full main sweep with a partial tube
// sweep (a=90/60/45/30°, a fillet/round). The CURRENT implementation instead
// searches positions and normals jointly for the minor radius that makes
// {p_i - r*n_i} coplanar (see fitTorus/torusMinorRadius) — a single mechanism
// with no regime split, so this table is now an EXACTNESS check on idealized
// analytic data rather than a test of which branch fires. It is still worth
// keeping for that reason, but — per review — analytic normals cannot be the
// only coverage: every one of the three fix rounds against this same table
// passed while the fitted axis was wrong under real per-face tessellation
// normals, which is why the test below this one rebuilds these same 8 cases
// from an actual triangulated, jittered mesh.
test("fitTorus recovers axis and both radii across partial main-sweep and partial tube-sweep coverage (analytic)", () => {
  const R = 10, r = 2;
  const torusCase = (uDeg, vDeg) => {
    const uRad = (uDeg * Math.PI) / 180, vRad = (vDeg * Math.PI) / 180;
    const pts = [], normals = [];
    for (let i = 0; i < 32; i++) for (let j = 0; j < 16; j++) {
      const u = (uRad * i) / 32, v = (vRad * j) / 16;
      const radial = [Math.cos(u), Math.sin(u), 0];
      normals.push([radial[0] * Math.cos(v), radial[1] * Math.cos(v), Math.sin(v)]);
      pts.push([(R + r * Math.cos(v)) * radial[0], (R + r * Math.cos(v)) * radial[1], r * Math.sin(v)]);
    }
    return fitTorus(pts, normals);
  };
  const cases = [
    ["full torus", 360, 360],
    ["u=180°, tube full", 180, 360],
    ["u=90°, tube full", 90, 360],
    ["u=45°, tube full", 45, 360],
    ["main full, tube a=90°", 360, 90],
    ["main full, tube a=60°", 360, 60],
    ["main full, tube a=45°", 360, 45],
    ["main full, tube a=30°", 360, 30],
  ];
  for (const [label, uDeg, vDeg] of cases) {
    const f = torusCase(uDeg, vDeg);
    expect(f, label).not.toBeNull();
    expect(Math.abs(f.axis[2]), label).toBeCloseTo(1, 6);
    expect(f.majorRadius, label).toBeCloseTo(R, 3);
    expect(f.minorRadius, label).toBeCloseTo(r, 3);
    expect(f.rms, label).toBeLessThan(1e-6);
  }
});

// Local vector helpers for building a tessellated mesh fixture below — fit.js
// keeps its own copies private, so tests that need real triangle geometry
// (not fit.js's analytic parametrizations) supply their own.
const vsub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const vdot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const vcross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const vunit = (a) => { const n = Math.hypot(a[0], a[1], a[2]); return n > 0 ? [a[0]/n, a[1]/n, a[2]/n] : [0,0,0]; };

// A deterministic (non-Math.random) pseudo-jitter, so a failing case reruns
// with the exact same fixture rather than a new random one each time.
const hash01 = (i, j, salt) => {
  const h = Math.sin(i*12.9898 + j*78.233 + salt*37.719) * 43758.5453123;
  return h - Math.floor(h);
};

// Triangulates a torus patch and returns one (centroid, face-normal) pair per
// triangle — the actual per-face normals a real mesh oracle would compute from
// triangle cross products, not the smooth analytic normal field every other
// test in this file uses. `jitter` perturbs each grid vertex's (u,v) parameter
// by up to `jitter` of one grid step, so the tessellation is irregular rather
// than a perfectly uniform grid (real CAD tessellation isn't uniform either).
function tessellatedTorus({ R, r, ni, nj, uArc, vArc, jitter }) {
  const uWrap = uArc >= 2*Math.PI - 1e-9, vWrap = vArc >= 2*Math.PI - 1e-9;
  const vertex = (i, j) => {
    const uj = jitter ? (hash01(i, j, 1) - 0.5) * 2 * jitter * (uArc/ni) : 0;
    const vj = jitter ? (hash01(i, j, 2) - 0.5) * 2 * jitter * (vArc/nj) : 0;
    const u = (uArc*i)/ni + uj, v = (vArc*j)/nj + vj;
    const radial = [Math.cos(u), Math.sin(u), 0];
    // The analytic outward normal at this vertex is kept only to ORIENT each
    // triangle's cross-product normal consistently outward (a real mesh gets
    // this from consistent winding, which this synthetic fixture doesn't have
    // without also modelling face indices) — the fitted normal actually used
    // below is the triangle's own cross product, not this one.
    const n = [radial[0]*Math.cos(v), radial[1]*Math.cos(v), Math.sin(v)];
    return { p: [(R + r*Math.cos(v))*radial[0], (R + r*Math.cos(v))*radial[1], r*Math.sin(v)], n };
  };
  const iMax = uWrap ? ni : ni - 1, jMax = vWrap ? nj : nj - 1;
  const pts = [], normals = [];
  for (let i = 0; i < iMax; i++) for (let j = 0; j < jMax; j++) {
    const i1 = uWrap ? (i+1) % ni : i+1, j1 = vWrap ? (j+1) % nj : j+1;
    const A = vertex(i, j), B = vertex(i1, j), C = vertex(i, j1), D = vertex(i1, j1);
    for (const [P0, P1, P2] of [[A, B, C], [B, D, C]]) {
      const centroid = [(P0.p[0]+P1.p[0]+P2.p[0])/3, (P0.p[1]+P1.p[1]+P2.p[1])/3, (P0.p[2]+P1.p[2]+P2.p[2])/3];
      let n = vunit(vcross(vsub(P1.p, P0.p), vsub(P2.p, P0.p)));
      const analyticN = vunit([P0.n[0]+P1.n[0]+P2.n[0], P0.n[1]+P1.n[1]+P2.n[1], P0.n[2]+P1.n[2]+P2.n[2]]);
      if (vdot(n, analyticN) < 0) n = [-n[0], -n[1], -n[2]];
      pts.push(centroid);
      normals.push(n);
    }
  }
  return { pts, normals };
}

// Regression: every fitTorus test above this one feeds ANALYTIC normals, which
// is exactly why three successive review rounds each passed this file's own
// tests while the real (mesh) behaviour stayed broken — analytic normals are
// exactly perpendicular to the true surface and exactly reproduce whatever
// invariant a given fix leaned on, which is precisely what a real tessellated
// mesh's per-face normals do NOT do. This test rebuilds the same 8 coverage
// combinations from actual triangle cross-product normals over an irregularly
// (jittered) sampled grid, at two jitter levels, and requires the SAME
// scenario-by-scenario pass/fail as the analytic table above — not merely a
// non-null result, which is what let a plausible-but-wrong fit through twice.
//
// Tolerances are wider than the analytic table's, and deliberately not
// uniform: real per-face normals are a flat average over a finite facet, a
// systematic (not random) bias that the joint position+normal search cannot
// fully undo, and it does not average out around a PARTIAL main sweep the way
// it does around a full one. Measured at this fixture's resolution
// (96x48 grid, ~9000-9200 triangles per case): majorRadius error tops out at
// ~1.8% (the u=45° partial-main-sweep case — verified this is a tessellation-
// density artefact, not an algorithm defect, by re-running that case alone at
// 2x and 4x the grid resolution: error drops from ~7% (48x24) to ~1.8% (96x48)
// to ~0.4% (192x96), consistent with facet-normal error shrinking with facet
// size); minorRadius error stays under 0.4%; rms stays under 0.003. The bounds
// below (3% / 1.5% / 0.01) keep roughly 1.5-2x headroom over every measured
// case rather than being tuned to exactly clear them.
test("fitTorus recovers axis and both radii from a tessellated, jittered mesh (realistic normals)", () => {
  const R = 10, r = 2, ni = 96, nj = 48;
  const cases = [
    ["full torus", 2*Math.PI, 2*Math.PI],
    ["main full, tube a=90°", 2*Math.PI, Math.PI/2],
    ["main full, tube a=60°", 2*Math.PI, Math.PI/3],
    ["main full, tube a=45°", 2*Math.PI, Math.PI/4],
    ["main full, tube a=30°", 2*Math.PI, Math.PI/6],
    ["u=180°, tube full", Math.PI, 2*Math.PI],
    ["u=90°, tube full", Math.PI/2, 2*Math.PI],
    ["u=45°, tube full", Math.PI/4, 2*Math.PI],
  ];
  for (const jitter of [1e-4, 1e-2]) {
    for (const [label, uArc, vArc] of cases) {
      const tag = `${label} (jitter ${jitter})`;
      const { pts, normals } = tessellatedTorus({ R, r, ni, nj, uArc, vArc, jitter });
      const f = fitTorus(pts, normals);
      expect(f, tag).not.toBeNull();
      expect(Math.abs(f.axis[2]), tag).toBeCloseTo(1, 3);
      expect(Math.abs(f.majorRadius - R) / R, tag).toBeLessThan(0.03);
      expect(Math.abs(f.minorRadius - r) / r, tag).toBeLessThan(0.015);
      expect(f.rms, tag).toBeLessThan(0.01);
    }
  }
});

// fitCone recovers its axis via fitPlane(normals), a different mechanism from
// both fitCylinder's ruledSurfaceAxis and fitTorus's position+normal search —
// confirm the fitPlane rank check (added in an earlier review round) doesn't
// start rejecting a cone's normal field, which spans a genuine 2-D plane even
// on a narrow arc.
test("fitCone recovers half-angle on a narrow arc", () => {
  const pts = [], normals = [];
  const halfAngle = Math.PI / 6;
  const arc = (10 * Math.PI) / 180;   // 10 degrees
  for (let i = 0; i < 64; i++) for (const z of [1, 2, 3, 4]) {
    const a = (arc * i) / 64;
    const r = z * Math.tan(halfAngle);
    pts.push([r * Math.cos(a), r * Math.sin(a), z]);
    const n = [Math.cos(halfAngle) * Math.cos(a), Math.cos(halfAngle) * Math.sin(a), -Math.sin(halfAngle)];
    normals.push(n);
  }
  const f = fitCone(pts, normals);
  expect(f).not.toBeNull();
  expect(f.halfAngle).toBeCloseTo(halfAngle, 3);
});

// Regression: fitPlane's covariance is rank <= 1 for collinear or coincident
// points, so its null space is 2-D or 3-D and the smallest-eigenvalue
// eigenvector the solver happens to land on gets reported as "the" normal, with
// a false near-zero rms — garbage parameters paired with a claim of a perfect
// fit, the worst combination this module exists to prevent.
test("fitPlane returns null on collinear and on coincident points", () => {
  expect(fitPlane([[0,0,0],[1,0,0],[2,0,0],[3,0,0]])).toBeNull();
  expect(fitPlane([[1,2,3],[1,2,3],[1,2,3]])).toBeNull();
});
