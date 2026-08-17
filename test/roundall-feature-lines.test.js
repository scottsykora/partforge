// Feature-line parity for roundAll's prism fast path. The fast path builds its
// result through the mesh fillet, whose blend surfaces carry the BLEND shading
// policy — that is what draws the band's start/end boundary rings while keeping
// tool-handover seams invisible (mesh-fillet-corners.test.js). But the fast path
// then decoupled its result from the fillet cache with a blanket asOriginal(),
// folding blend and base into ONE fresh surface: every band boundary became a
// same-surface tangent edge and the whole roundAll rendered with no feature
// lines at all — the fillet's extent unreadable, unlike the identical geometry
// produced by fillet() itself.
//
// The fix re-stamps the result as TWO reserved ids (base and blend) instead —
// the same blend-aware re-stamp label() performs — so a roundAll'd prism draws
// exactly the feature lines a fillet of the same rim draws: boundary rings at
// the band's tangent edges, nothing across the band.
//
// The census runs the REAL render path (toMesh() → creased-normals + the
// shading-policy registry), same as mesh-fillet-corners.test.js.
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// Total drawn length in the horizontal ring at height z (both endpoints within
// tol of z) — the band-boundary rings the BLEND policy exists to draw. Length,
// not segment count: creased-normals merges collinear runs, so a box rim's
// straight stretch is one long segment.
function ringLength(solid, z, tol) {
  const { edges } = solid.toMesh();
  let len = 0;
  for (let i = 0; i + 5 < edges.length; i += 6) {
    if (Math.abs(edges[i + 2] - z) < tol && Math.abs(edges[i + 5] - z) < tol) {
      len += Math.hypot(edges[i + 3] - edges[i], edges[i + 4] - edges[i + 1]);
    }
  }
  return len;
}

// Line segments strictly INSIDE the top band window — unwanted lines across the
// blend (same census as mesh-fillet-corners.test.js).
function bandLines(solid, zTop, r) {
  const { edges } = solid.toMesh();
  const zLo = zTop - r + 0.05 * r, zHi = zTop - 0.05 * r;
  let n = 0;
  for (let i = 0; i + 5 < edges.length; i += 6) {
    const inBand = (z) => z > zLo && z < zHi;
    if (inBand(edges[i + 2]) && inBand(edges[i + 5])) n++;
  }
  return n;
}

describe("roundAll prism fast path draws the fillet's feature lines", () => {
  it("box: band boundary rings draw at both tangent edges, nothing across the band", () => {
    const H = 16, R = 3;
    const out = k.box({ min: [0, 0, 0], max: [40, 30, H] }).roundAll(R);
    // top rim band: tangent rings on the top face (z = H) and on the walls
    // (z = H − R). The straight stretches alone total 2·(40−2R) + 2·(30−2R) =
    // 116 mm; asserting > 100 proves the rings draw without pinning how the
    // corner arcs tessellate.
    expect(ringLength(out, H, 1e-3)).toBeGreaterThan(100);
    expect(ringLength(out, H - R, 1e-3)).toBeGreaterThan(100);
    // bottom rim band mirrors it
    expect(ringLength(out, 0, 1e-3)).toBeGreaterThan(100);
    expect(ringLength(out, R, 1e-3)).toBeGreaterThan(100);
    expect(bandLines(out, H, R)).toBeLessThan(10);
    expect(out.genus()).toBe(0);
  });

  it("L-prism: reflex corner included, the band still renders clean with its rings", () => {
    // Reflex vertical edge at (10,10) — the rim's reflex corner rides the
    // rolling-ball pivot, whose handovers are tangent and must not line-draw.
    const L = [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]];
    const H = 8, R = 1.5;
    const out = k.extrude({ profile: L, h: H }).roundAll(R);
    // outline perimeter is 80 mm; the rings' straight stretches alone clear 40
    expect(ringLength(out, H, 1e-3)).toBeGreaterThan(40);
    expect(ringLength(out, H - R, 1e-3)).toBeGreaterThan(40);
    expect(bandLines(out, H, R)).toBeLessThan(10);
    expect(out.genus()).toBe(0);
  });
});
