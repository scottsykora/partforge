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

  it("the band interior stays clean between corners; the mitre seams draw at them", () => {
    // the box's 90° rim corners keep the honest mitre (see mesh-fillet-corners.
    // test.js) — the seam at each corner is a real crease and its line is wanted,
    // so the clean-interior assertion excludes a neighborhood of each corner
    const W = 40, D = 30, H = 16, r = 3;
    const out = k.box({ min: [0, 0, 0], max: [W, D, H] }).fillet(r, { inPlane: "XY", at: H });
    const { edges } = out.toMesh();
    const corners = [[0, 0], [W, 0], [W, D], [0, D]];
    let away = 0, atCorners = 0;
    const zLo = H - r + 0.05 * r, zHi = H - 0.05 * r; // strict interior, clear of both rings
    const clear = (x, y) => corners.every(([cx, cy]) => Math.hypot(x - cx, y - cy) > 2.5 * r);
    for (let i = 0; i + 5 < edges.length; i += 6) {
      const w = (z) => z > zLo && z < zHi;
      if (!w(edges[i + 2]) || !w(edges[i + 5])) continue;
      if (clear(edges[i], edges[i + 1]) && clear(edges[i + 3], edges[i + 4])) away++;
      else atCorners++;
    }
    expect(away).toBeLessThan(10);
    expect(atCorners).toBeGreaterThan(0); // the corner seams are hard edges and draw
  });
});
