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
});
