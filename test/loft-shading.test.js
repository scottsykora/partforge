import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const RINGS = [{ sides: 12, radius: 20, z: 0 }, { sides: 12, radius: 20, z: 10 }];

// Classify wall triangles (face normal horizontal; caps are ±Z and skipped) as
// flat (all 3 corner normals ≈ the face normal) or smoothed. Non-indexed mesh:
// tri t occupies positions/normals [t*9, t*9+9).
function wallTris(m) {
  let flat = 0, total = 0;
  const P = m.positions, N = m.normals;
  for (let t = 0; t * 9 < P.length; t++) {
    const o = t * 9;
    const ux = P[o + 3] - P[o], uy = P[o + 4] - P[o + 1], uz = P[o + 5] - P[o + 2];
    const vx = P[o + 6] - P[o], vy = P[o + 7] - P[o + 1], vz = P[o + 8] - P[o + 2];
    let fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const L = Math.hypot(fx, fy, fz) || 1;
    fx /= L; fy /= L; fz /= L;
    if (Math.abs(fz) > 1e-3) continue; // cap or cap-fan triangle — not a wall
    total++;
    let allFlat = true;
    for (let c = 0; c < 3; c++) {
      const n = o + c * 3;
      if (N[n] * fx + N[n + 1] * fy + N[n + 2] * fz < 0.9999) allFlat = false;
    }
    if (allFlat) flat++;
  }
  return { flat, total };
}

test("12-sided loft defaults to faceted: every wall triangle flat, zero edge lines", () => {
  const m = k.loft({ rings: RINGS }).toMesh();
  const w = wallTris(m);
  expect(w.total).toBeGreaterThan(0);
  expect(w.flat).toBe(w.total);
  expect(m.edges.length).toBe(0); // no same-surface lines — not even the 90° cap rims
});

test("smooth:true overrides inference: corners averaged, cap-rim lines return", () => {
  const m = k.loft({ rings: RINGS, smooth: true }).toMesh();
  const w = wallTris(m);
  expect(w.total).toBeGreaterThan(0);
  expect(w.flat).toBe(0); // every wall vertex is a facet corner — all averaged at 30° < 35°
  expect(m.edges.length).toBeGreaterThan(0); // 90° cap rims draw under SMOOTH
});

test("high-side-count lofts infer smooth (cap-rim lines present without any hint)", () => {
  const many = [{ sides: 64, radius: 20, z: 0 }, { sides: 64, radius: 20, z: 10 }];
  expect(k.loft({ rings: many }).toMesh().edges.length).toBeGreaterThan(0);
});

test("label() preserves the loft's shading policy (the vase labels its walls)", () => {
  const m = k.loft({ rings: RINGS }).label("Faceted wall").toMesh();
  const w = wallTris(m);
  expect(w.total).toBeGreaterThan(0);
  expect(w.flat).toBe(w.total);
  expect(m.edges.length).toBe(0);
  expect(m.features).toEqual(["Faceted wall"]);
});

test("booleans keep per-surface policy: faceted loft cut by a box stays flat, seam draws", () => {
  const tool = k.box({ min: [0, -30, 5], max: [30, 30, 15] });
  const m = k.loft({ rings: RINGS }).cut(tool).toMesh();
  // Surviving loft walls stay flat; the tool's cut faces are planes (flat too);
  // seams between the two OIDs shade hard — so every wall-class triangle is flat.
  const w = wallTris(m);
  expect(w.total).toBeGreaterThan(0);
  expect(w.flat).toBe(w.total);
  expect(m.edges.length).toBeGreaterThan(0); // the cut seam draws lines
});

test("smooth is rejected on other ops (option list is per-op)", () => {
  expect(() => k.sphere({ r: 5, smooth: true })).toThrow(/unknown option/);
});
