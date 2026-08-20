// Whole-word offset of ITALIC-SHEARED text — the "Scott Layered Label" backing with
// the italic checkbox on (feedback 746c4ac2): the part shears each glyph region's
// polygon points, re-unions them through shape2d, and offsets the styled word by the
// backing border. The shear turns every glyph into a dense polygon whose round-join
// offset walls fold back on themselves near concave features, and one glyph's raw
// offset used to defeat the winding resolver AND every rung of the fallback ladder:
//
// At a fold apex the two antiparallel branches of the hairpin are the projected
// edge's IMMEDIATE NEIGHBOURS in ring order, and scanArrangement's clearance
// measurement blanket-excluded edge±1 as "incident geometry". Clearance then read
// ~0.05 where the true room was ~0.003, the classifier's winding probe stepped
// straight across the fold into a face not adjacent to the piece at all, and the
// wRight = wLeft − mult arithmetic fabricated a w=0 outside face for an interior
// piece. The kept set gained a dangling open chain and _chain threw
// CHAIN_INCOMPLETE — for the raw arrangement and for every polyline rung alike,
// since the fold survives retessellation. The fix counts a neighbour edge that
// FOLDS BACK (direction dot < 0 against the projected edge) as an obstruction, so
// the probe shops for a roomier sample or shrinks eps below the fold width.
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// The part's own slant helper: shear every region's points, rebuild, union.
const slantProfile = (profile, shear) => {
  const regions = profile.toRegions();
  let combined = null;
  for (const region of regions) {
    const outer = region.outer.map((pt) => [pt[0] + shear * pt[1], pt[1]]);
    const holes = region.holes.map((h) => h.map((pt) => [pt[0] + shear * pt[1], pt[1]]));
    const slanted = k.shape2d({ outer, holes });
    combined = combined ? combined.union(slanted) : slanted;
  }
  return combined;
};

const styledWord = () => {
  const raw = k.text2d("Scott", { size: 40, align: "center", valign: "middle" });
  return slantProfile(raw, 0.2126).scale(1.035); // italic + the part's bold path
};

describe("offset of italic-sheared whole-word text", () => {
  it("offsets the styled word at the part's 8.5 mm border without throwing", () => {
    const word = styledWord();
    const offset = word.offset(8.5, { corners: "round", segs: 32 });
    const base = word.extrude({ h: 1 }).volume();
    const grown = offset.extrude({ h: 1 }).volume();
    expect(grown).toBeGreaterThan(base); // dilation is extensive
  }, 60_000);

  it("offsets the single hostile glyph region alone (the minimal reproduction)", () => {
    const raw = k.text2d("Scott", { size: 40, align: "center", valign: "middle" });
    const sheared = slantProfile(raw, 0.2126);
    // every region must offset — the failure was region-dependent, so pin them all
    for (const region of sheared.regions()) {
      const offset = region.offset(8.5, { corners: "round", segs: 32 });
      expect(offset.extrude({ h: 1 }).volume()).toBeGreaterThan(0);
    }
  }, 120_000);

  it("offsets at the smaller 5 mm border too (failed across the delta band)", () => {
    const offset = styledWord().offset(5, { corners: "round", segs: 32 });
    expect(offset.extrude({ h: 1 }).volume()).toBeGreaterThan(0);
  }, 60_000);
});
