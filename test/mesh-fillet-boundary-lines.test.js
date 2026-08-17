// The feature-line overlay draws the START and END of every fillet band — the tangent
// seams where the blend meets its flanks. Those seams bend ~0°, far under any crease
// threshold, so they only draw because the mesh op keeps the blend surfaces' identity
// (their originalIDs survive instead of being folded into one fresh original) and
// registers them with the BLEND policy: a seam between a blend and a NON-blend surface
// draws regardless of bend, while blend-blend handovers along one band keep the bend
// rule and stay invisible. This goes through toMesh() — the real render path, policies
// included — not the bare creasedNormals() the band-census tests call.
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// total length of overlay segments whose BOTH endpoints sit within tol of plane z=zp
function lengthAtZ(edges, zp, tol = 1e-3) {
  let L = 0;
  for (let i = 0; i + 5 < edges.length; i += 6) {
    if (Math.abs(edges[i + 2] - zp) > tol || Math.abs(edges[i + 5] - zp) > tol) continue;
    L += Math.hypot(edges[i + 3] - edges[i], edges[i + 4] - edges[i + 1], edges[i + 5] - edges[i + 2]);
  }
  return L;
}

describe("fillet band boundaries draw as feature lines", () => {
  it("box top rim: both tangent rings draw at roughly their full perimeter", () => {
    const W = 40, D = 30, H = 16, r = 3;
    const out = k.box({ min: [0, 0, 0], max: [W, D, H] }).fillet(r, { inPlane: "XY", at: H });
    const { edges } = out.toMesh();
    // top-face ring: rectangle inset by r with quarter-circle corners
    const topRing = 2 * (W - 2 * r) + 2 * (D - 2 * r) + 2 * Math.PI * (1.05 * r); // corner arcs at rho≈1.05-1.25r
    expect(lengthAtZ(edges, H)).toBeGreaterThan(0.7 * topRing);
    // wall-side ring at band bottom (the wall tangent, ext-shifted by microns)
    expect(lengthAtZ(edges, H - r, 0.05 * r)).toBeGreaterThan(0.7 * topRing);
  });

  it("a chamfered rim draws its boundary rings too", () => {
    const W = 40, D = 30, H = 16, d = 2;
    const out = k.box({ min: [0, 0, 0], max: [W, D, H] }).chamfer(d, { inPlane: "XY", at: H });
    const { edges } = out.toMesh();
    expect(lengthAtZ(edges, H)).toBeGreaterThan(0.5 * 2 * (W + D));
  });

  it("labeling a filleted solid keeps its boundary rings (label() must not fold them)", () => {
    // every real part labels its solids, and label() re-stamps originalIDs for
    // feature attribution — the re-stamp must preserve the blend/base split or
    // the rings vanish on exactly the parts users see
    const W = 40, D = 30, H = 16, r = 3;
    const out = k.box({ min: [0, 0, 0], max: [W, D, H] })
      .fillet(r, { inPlane: "XY", at: H })
      .label("plate");
    const { edges, features } = out.toMesh();
    const topRing = 2 * (W - 2 * r) + 2 * (D - 2 * r) + 2 * Math.PI * (1.05 * r);
    expect(lengthAtZ(edges, H)).toBeGreaterThan(0.7 * topRing);
    expect(features).toEqual(["plate"]); // the label still covers the whole solid
  });

  it("the band interior stays clean: boundary lines do not reintroduce cross-lines", () => {
    const W = 40, D = 30, H = 16, r = 3;
    const out = k.box({ min: [0, 0, 0], max: [W, D, H] }).fillet(r, { inPlane: "XY", at: H });
    const { edges } = out.toMesh();
    let inBand = 0;
    const zLo = H - r + 0.05 * r, zHi = H - 0.05 * r; // strict interior, clear of both rings
    for (let i = 0; i + 5 < edges.length; i += 6) {
      const w = (z) => z > zLo && z < zHi;
      if (w(edges[i + 2]) && w(edges[i + 5])) inBand++;
    }
    expect(inBand).toBeLessThan(10);
  });
});
