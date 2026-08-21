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

test("fitTorus recovers major and minor radii", () => {
  const pts = [], normals = [];
  const R = 10, r = 2;
  for (let i = 0; i < 32; i++) for (let j = 0; j < 16; j++) {
    const u = 2 * Math.PI * i / 32, v = 2 * Math.PI * j / 16;
    const radial = [Math.cos(u), Math.sin(u), 0];
    normals.push([radial[0] * Math.cos(v), radial[1] * Math.cos(v), Math.sin(v)]);
    pts.push([(R + r * Math.cos(v)) * radial[0], (R + r * Math.cos(v)) * radial[1], r * Math.sin(v)]);
  }
  const f = fitTorus(pts, normals);
  expect(f.majorRadius).toBeCloseTo(R, 3);
  expect(f.minorRadius).toBeCloseTo(r, 3);
});

test("a fit with too few points returns null rather than a garbage fit", () => {
  expect(fitPlane([[0,0,0],[1,0,0]])).toBeNull();
  expect(fitSphere([[0,0,0],[1,0,0],[0,1,0]])).toBeNull();
});

// Regression: a first pass at axisFromNormals took the smallest-eigenvalue
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

// Regression: on a torus, the axis is never the smallest eigenvalue (a torus
// normal is only perpendicular to the axis at the crown/root of the tube) — it
// is whichever eigenvalue sits at half the covariance's trace, given the tube
// is fully revolved. This must hold even when the MAIN sweep (u) is only a half
// turn; a naive point-centroid centring (which only lands on the axis for a
// full main sweep) was also found, during review, to corrupt the downstream
// radius even once the axis itself was fixed.
test("fitTorus recovers major radius on a half main-sweep with the tube fully revolved", () => {
  const pts = [], normals = [];
  const R = 10, r = 2;
  for (let i = 0; i < 32; i++) for (let j = 0; j < 16; j++) {
    const u = (Math.PI * i) / 32, v = (2 * Math.PI * j) / 16;   // u spans only 180 degrees
    const radial = [Math.cos(u), Math.sin(u), 0];
    normals.push([radial[0] * Math.cos(v), radial[1] * Math.cos(v), Math.sin(v)]);
    pts.push([(R + r * Math.cos(v)) * radial[0], (R + r * Math.cos(v)) * radial[1], r * Math.sin(v)]);
  }
  const f = fitTorus(pts, normals);
  expect(f).not.toBeNull();
  expect(f.majorRadius).toBeCloseTo(R, 3);
  expect(f.minorRadius).toBeCloseTo(r, 3);
});

// fitCone recovers its axis via fitPlane(normals), a different mechanism from
// axisFromNormals — confirm the fitPlane rank check added alongside the axis fix
// (see below) doesn't start rejecting a cone's normal field, which spans a
// genuine 2-D plane even on a narrow arc.
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
