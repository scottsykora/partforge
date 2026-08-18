// The user-reported case that motivated the whole winding-resolver effort, pinned as
// TOPOLOGY, not just area: "Scott" size 10, round corners, across the delta sweep. The
// truth column is Clipper2's (the pre-0.59.0 route), recorded in the 2026-08-15 handoff
// and re-derivable via the corpus oracle. Shipped 0.59.0 got the areas right and the
// topology wrong (12 phantom holes at delta 3); the pre-fix resolver threw at
// 0.8 / 1.5 / 2.0 / 3.0 — the deltas the user actually reported. Every row here must
// build and match. Pure JS + paper.js only — no WASM boot, safe to share a process.
import { beforeAll, expect, test } from "vitest";
import { offsetRegions } from "../src/framework/geometry/contour-offset.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";
import { loadDefaultFont } from "./helpers/offset-corpus.js";

let regions, font, textGlyphs;
beforeAll(async () => {
  font = await loadDefaultFont();
  ({ textGlyphs } = await import("../src/framework/geometry/text2d.js"));
  regions = textGlyphs(font, "Scott", { size: 10 });
});

// Sub-sliver rings are resolver artifacts, not features — same convention as the fuzz
// suite and the glyph block of test/offset-oracle-manifold.test.js.
const SLIVER = 1e-3;
const topo = (out) => {
  let r = 0, h = 0, area = 0;
  for (const rg of out) {
    const a = Math.abs(ringArea(tessellateContour(rg.outer, 64)));
    if (a < SLIVER) continue;
    r++; area += a;
    for (const hole of rg.holes) {
      const ha = Math.abs(ringArea(tessellateContour(hole, 64)));
      if (ha >= SLIVER) { h++; area -= ha; }
    }
  }
  return { r, h, area };
};

// delta → [regions, holes, area]; the truth column of the 2026-08-15 handoff (§1 and §5),
// asserted at 0.5 % relative — the raw offset's cubic tolerance dominates the gap.
const TRUTH = [
  [0.2, 5, 1, 140.068],
  [0.5, 4, 1, 196.816],
  [0.8, 1, 2, 252.996],
  [1.0, 1, 3, 288.531],
  [1.5, 1, 5, 362.105],
  [2.0, 1, 2, 419.571],
  [3.0, 1, 0, 522.349],
  // delta 3.5 is past the sweep the original handoff recorded, and it was NOT resolved by the
  // adaptive classifier — the merged whole-word arrangement still threw chain-incomplete here
  // (feedback 86970b00, "Scott Layered Label": the backing offset dies as the slider moves).
  // The per-region-union fallback rung (contour-offset.js) closes it, exactly, because for a
  // positive delta dilation distributes over the glyph union: (⋃glyph) ⊕ D = ⋃(glyph ⊕ D).
  [3.5, 1, 0, 574.951],
];
for (const [d, R, H, A] of TRUTH) {
  test(`"Scott" size 10 round, delta ${d}: ${R} region(s), ${H} hole(s)`, () => {
    const out = offsetRegions(regions, d, { corners: "round" });   // must not throw
    const t = topo(out);
    expect([t.r, t.h]).toEqual([R, H]);
    expect(Math.abs(t.area - A) / A).toBeLessThan(0.005);
  });
}

// The exact whole-word cases from feedback 86970b00 (part "Scott Layered Label"): a raised
// label on a backing offset OUT from the lettering by the user's "border" slider. Offsetting
// the merged word threw "could not chain offset boundary" across a wide band of ordinary
// slider values — every one of these threw before the per-region-union rung — so the part
// "couldn't offset the whole word" and died on almost every settings change. Truth is the
// Clipper2 route's, derived the same way the sweep above was (round join, 64 segs); at these
// deltas the border has closed every counter and merged every letter, so the answer is one
// solid backing (1 region, 0 holes). Round corners + curved glyphs, so area is checked at the
// same 0.5 % the sweep uses rather than to the bone.
const WHOLE_WORD = [
  ["Scott", 24, 7.5, 1, 0, 3083.922],
  ["Scotty", 10, 3.0, 1, 0, 621.408],
  ["Scotty", 24, 7.5, 1, 0, 3664.671],
  ["Scotty", 31, 10.0, 1, 0, 6229.412],
];
for (const [text, size, d, R, H, A] of WHOLE_WORD) {
  test(`"${text}" size ${size} round, delta ${d}: ${R} region(s), ${H} hole(s)`, () => {
    const rgs = textGlyphs(font, text, { size });
    const out = offsetRegions(rgs, d, { corners: "round" });        // must not throw
    const t = topo(out);
    expect([t.r, t.h]).toEqual([R, H]);
    expect(Math.abs(t.area - A) / A).toBeLessThan(0.005);
  });
}
