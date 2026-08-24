import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { loftMesh } from "../src/framework/geometry/loft.js";
import { creasedNormals } from "../src/framework/geometry/creased-normals.js";
import { roundedProfile } from "../src/framework/geometry/polygon.js";

// Provenance-based loft shading: loftMesh partitions curve/resample lofts into
// per-sector, per-band-group runs (reserved original IDs + policies via the
// runPolicies out-param), so creasedNormals hard-shades and line-draws abrupt
// features the old whole-solid SMOOTH policy smoothed away (bends < 35°).
let wasm;
beforeAll(async () => { wasm = await Module(); wasm.setup(); });

const SQ = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
const rsq = roundedProfile(SQ, 3);

// The lofted-bottle body shape: one rounded square, belly-scaled mid ring. The
// silhouette kinks ~9.9° at z=31.5 — well under the SMOOTH 35° crease, so only
// run partitioning can make it flat-shade and draw its ring line.
const bellyRings = [
  { polygon: rsq, z: 0 },
  { polygon: rsq, z: 31.5, scale: 1.15 },
  { polygon: rsq, z: 70 },
];

// A profile with one SHALLOW sharp corner (28° at (0,5.5)) plus a smooth arc
// bulge: the corner is under the 35° crease bar but far over the 11.25° sector
// bar, so only sector runs can crease it and draw its column line.
const bluntWedge = { start: [-6, -4], segments: [
  { to: [6, -4], via: [0, -5.5] },   // smooth arc bulge (bottom)
  { to: [6, 4] },
  { to: [0, 5.5] },                  // 28° joint here
  { to: [-6, 4] },
  { to: [-6, -4] },
] };

const shade = (rings, opts = {}) => {
  const pol = new Map();
  const m = loftMesh(wasm, rings, opts, pol);
  const g = m.getMesh();
  const out = creasedNormals(g, { policies: pol });
  const oids = new Set(g.runOriginalID);
  return { out, pol, oids };
};

// edge segments lying flat at height z (both endpoints, within eps)
const edgesAtZ = (edges, z, eps = 1e-3) => {
  let n = 0;
  for (let i = 0; i < edges.length; i += 6)
    if (Math.abs(edges[i + 2] - z) < eps && Math.abs(edges[i + 5] - z) < eps) n++;
  return n;
};
// vertical edge segments (z changes) whose endpoints both sit at xy (within eps)
const verticalEdgesNear = (edges, x, y, eps = 1e-3) => {
  let n = 0;
  for (let i = 0; i < edges.length; i += 6) {
    const dz = Math.abs(edges[i + 2] - edges[i + 5]);
    if (dz < eps) continue;
    if (Math.abs(edges[i] - x) < eps && Math.abs(edges[i + 1] - y) < eps &&
        Math.abs(edges[i + 3] - x) < eps && Math.abs(edges[i + 4] - y) < eps) n++;
  }
  return n;
};

test("a belly kink (~10°, under the 35° crease) draws a dividing ring line at the kink z", () => {
  const { out, pol, oids } = shade(bellyRings);
  expect(pol.size).toBeGreaterThanOrEqual(2);        // at least two band-group runs registered
  expect(oids.size).toBeGreaterThanOrEqual(2);       // the mesh genuinely carries multiple runs
  expect(edgesAtZ(out.edges, 31.5)).toBeGreaterThan(0);
});

test("a smooth ring stack (linear scale ramp, ~0° bends) draws no interior ring lines", () => {
  const rings = [0, 1, 2, 3].map((i) => ({ polygon: rsq, z: i * 20, scale: 1 + 0.02 * i }));
  const { out } = shade(rings);
  expect(edgesAtZ(out.edges, 20)).toBe(0);
  expect(edgesAtZ(out.edges, 40)).toBe(0);
});

test("a shallow sharp corner (28°, under the 35° crease) draws its vertical column line", () => {
  const { out, pol } = shade([{ polygon: bluntWedge, z: 0 }, { polygon: bluntWedge, z: 8 }]);
  expect(pol.size).toBeGreaterThanOrEqual(5);        // 5 sectors (1 arc + 4 line spans) + caps
  expect(verticalEdgesNear(out.edges, 0, 5.5)).toBeGreaterThan(0);
});

test("a tangent-only contour (rounded square) stays one smooth wall — no vertical wall lines", () => {
  const { out } = shade([{ polygon: rsq, z: 0 }, { polygon: rsq, z: 8, scale: 0.6 }]);
  let vertical = 0;
  for (let i = 0; i < out.edges.length; i += 6)
    if (Math.abs(out.edges[i + 2] - out.edges[i + 5]) > 1e-3) vertical++;
  expect(vertical).toBe(0);
});

test("a resample morph (square → circleProfile) carries one run per corner sector plus caps", () => {
  const circle = []; // 48-gon circle as a point list, matching circleProfile's LOD
  for (let i = 0; i < 48; i++) circle.push([4 * Math.cos((2 * Math.PI * i) / 48), 4 * Math.sin((2 * Math.PI * i) / 48)]);
  const { pol, oids } = shade([{ polygon: SQ, z: 0 }, { polygon: circle, z: 10 }]);
  expect(pol.size).toBe(6);                          // 4 corner sectors × 1 band group + 2 caps
  expect(oids.size).toBe(6);
});

test("poly-exact point-ring lofts keep the legacy single surface (no runs registered)", () => {
  const { pol, oids } = shade([{ polygon: SQ, z: 0 }, { polygon: SQ, z: 10 }]);
  expect(pol.size).toBe(0);
  expect(oids.size).toBe(1);
});

test("an explicit shading hint bypasses sectoring entirely", () => {
  const { pol, oids } = shade(bellyRings, { shading: "smooth" });
  expect(pol.size).toBe(0);
  expect(oids.size).toBe(1);
});
