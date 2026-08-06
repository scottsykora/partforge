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

// Regression: the faceted-vase hollows itself with loft().intersect(box).label(...)
// — label() runs on the INTERSECT's result, not directly on the loft, so the
// solid's own originalID() is "mixed" (-1) at that point (it now spans the
// loft's surface plus the box's). The naive carry-forward only checked a single
// prior id and silently dropped the policy whenever it was -1, so the labeled
// solid fell back to the SMOOTH default and its own facet creases (very much
// bent, by construction) all drew lines — a spiral wireframe.
test("label() after an intermediate boolean still recovers the loft's policy (vase hollowing)", () => {
  const tool = k.box({ min: [-30, -30, 2], max: [30, 30, 15] }); // no policy of its own
  const m = k.loft({ rings: RINGS }).intersect(tool).label("Faceted wall").toMesh();
  const w = wallTris(m);
  expect(w.total).toBeGreaterThan(0);
  expect(w.flat).toBe(w.total);
  expect(m.edges.length).toBe(0); // faceted policy still wins — no same-surface lines
  expect(m.features).toEqual(["Faceted wall"]); // labeled compound reports the label as its feature
});

// Regression: union() of two lofts with DIFFERENT inferred policies also collapses to
// -1 ("mixed") originalID under label(), same as the intersect-hollowing case above —
// but here there's no unambiguous single policy to inherit (unlike a plain box tool,
// both surfaces are policy-bearing). Majority-by-triangle-count breaks the tie: a 2-ring
// loft has 2*sides wall+cap triangles regardless of size (a geometric fact, not a size
// one), so a 12-sided 2-ring loft (48 tris, faceted) is smaller than a 64-sided 2-ring
// loft (256 tris, smooth) — SMOOTH would win a naive vote. Give the 12-sided loft many
// more RINGS (not more sides — that would also just increase facet count fairly) so its
// wall-quad count dominates: 16 rings = 15 gaps, 15 gaps * 12 sides * 2 = 360 wall tris +
// 24 cap tris = 384 total, comfortably ahead of the 64-sided loft's 256.
//
// The deciding observable is `edges` rather than `wallTris().flat`: after label()
// every surviving triangle shares ONE originalID, so `sameSurfaceLines` is either on
// for the WHOLE mesh or off for the WHOLE mesh — FACETED (sameSurfaceLines:false)
// winning means zero edges anywhere, including the 90°-bend cap rims that a SMOOTH
// win would always draw. (`wallTris().flat` alone doesn't discriminate here: even
// FACETED's 10° creaseAngle is wide enough to still smooth the 64-gon's ~5.6°
// between-facet corners, so some triangles read "flat" under either policy.)
test("label() on a union of differently-shaded lofts inherits the majority policy by triangle count", () => {
  const manyRingsFaceted = [];
  for (let i = 0; i < 16; i++) manyRingsFaceted.push({ sides: 12, radius: 20, z: i * 2 });
  const facetedLoft = k.loft({ rings: manyRingsFaceted }); // 15 gaps * 12 sides * 2 = 360 wall tris + 24 cap = 384 tris, FACETED (< 32 sides)
  const smoothLoft = k
    .loft({ rings: [{ sides: 64, radius: 20, z: 0 }, { sides: 64, radius: 20, z: 10 }] }) // 256 tris, SMOOTH (>= 32 sides)
    .translate([100, 0, 0]); // keep the two solids disjoint so union() doesn't reshape either
  const m = facetedLoft.union(smoothLoft).label("Body").toMesh();
  const w = wallTris(m);
  expect(w.total).toBeGreaterThan(0);
  expect(m.edges.length).toBe(0); // FACETED's majority weight wins — same-surface lines fully suppressed
  expect(m.features).toEqual(["Body"]);
});
