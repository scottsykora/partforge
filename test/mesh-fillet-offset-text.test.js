// Planar rim fillet on an OFFSET TEXT outline — the "Scott Layered Label" backing
// (feedback 0f3c799d): text2d("Scott").offset(5, round).extrude(2.5).fillet(0.3 top rim).
// The winding resolver's splice noise makes this the hostile case for the planar chain
// machinery, and it used to fail three separate ways, each masked by the previous:
//   1. collapseTightCorners landed a virtual corner ON its flanking chain point
//      (micro-spike outlines double back through the same vertex), and the coincident
//      pair became a zero-length sweep path segment — weldChainPoints now sweeps them;
//   2. the pre-split fold guard's wall-normal reflex heuristic passed a vertex the
//      sweep's direction-aware measure refuses (noise facets carry noise normals) —
//      buildStretch now splits at the sweep's own foldVertex and retries;
//   3. zero-thickness fins and flipped sliver facets present anti-parallel flanks —
//      knife-edge chains and stretches are now SKIPPED (no wedge to blend) instead of
//      failing every other edge of the selection with them.
// This file pins the end-to-end outcome: the fillet builds and removes a plausible
// convex-rim volume. Volume truth is the analytic (1 − π/4)·r² per unit rim length,
// asserted loosely — the rim length itself is noise-dependent.
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const offsetTextProfile = (scale) => {
  let p = k.text2d("Scott", { size: 28, align: "center", valign: "middle" });
  if (scale) p = p.scale(scale);
  return p.offset(5, { corners: "round", segs: 32 });
};

const filletRegions = (profile, h, r) => {
  const regions = profile.regions();
  const out = regions.map((region) =>
    region.extrude({ h }).fillet({ r, edges: { inPlane: "XY", at: h } }));
  return out.length === 1 ? out[0] : k.union(out);
};

describe("planar top fillet on an offset text outline", () => {
  it("builds per-region (the Scott Layered Label recipe) and removes rim volume", () => {
    const profile = offsetTextProfile(1.035);          // the part's bold path
    const base = profile.extrude({ h: 2.5 });
    const filleted = filletRegions(profile, 2.5, 0.3); // must not throw
    const removed = base.volume() - filleted.volume();
    expect(removed).toBeGreaterThan(0);
    // (1 − π/4)·0.3² ≈ 0.0193 mm³ per mm of convex rim; the outline runs a few
    // hundred mm, so anything past ~20 mm³ means a tool gouged the part
    expect(removed).toBeLessThan(20);
  }, 120_000);   // the noisy outline sweeps hundreds of stretch tools — well past the 30s default

  it("builds unscaled too (the non-bold path)", () => {
    const profile = offsetTextProfile(0);
    const base = profile.extrude({ h: 2.5 });
    const filleted = filletRegions(profile, 2.5, 0.3); // must not throw
    const removed = base.volume() - filleted.volume();
    expect(removed).toBeGreaterThan(0);
    expect(removed).toBeLessThan(20);
  }, 120_000);

  // The italic variant (feedback 746c4ac2): the part shears every glyph region's
  // points, re-unions them, and offsets the styled word by a wider 8.5 mm border,
  // then fillets the top rim at 1.15 mm. The offset half of this is pinned in
  // offset-text-italic.test.js (the fold-clearance fix); this pins the fillet on
  // top of it — the user's actual saved defaults, end to end.
  it("builds the italic-sheared variant at the part's saved defaults", () => {
    let p = k.text2d("Scott", { size: 40, align: "center", valign: "middle" });
    const regions = p.toRegions();
    let sheared = null;
    for (const region of regions) {
      const outer = region.outer.map((pt) => [pt[0] + 0.2126 * pt[1], pt[1]]);
      const holes = region.holes.map((h) => h.map((pt) => [pt[0] + 0.2126 * pt[1], pt[1]]));
      const s = k.shape2d({ outer, holes });
      sheared = sheared ? sheared.union(s) : s;
    }
    const profile = sheared.scale(1.035).offset(8.5, { corners: "round", segs: 32 });
    const base = profile.extrude({ h: 2.5 });
    const filleted = filletRegions(profile, 2.5, 1.15); // must not throw
    const removed = base.volume() - filleted.volume();
    expect(removed).toBeGreaterThan(0);
    // (1 − π/4)·1.15² ≈ 0.284 mm³ per mm of convex rim over a few hundred mm of
    // outline — anything past ~200 mm³ means a tool gouged the part
    expect(removed).toBeLessThan(200);
  }, 120_000);
});
