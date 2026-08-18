// Degenerate-debris cleanup across the 2-D pipeline, pinned on the case that found it:
// offset(6, round) of "Scotty" size 24. The winding resolver's crossing clustering snaps
// both ends of a tiny curve run onto one pool vertex, leaving zero-chord "loop-back"
// cubics in the resolved output (measured extents 0.010–0.028 mm — beyond the
// 2*CLUSTER_TOL radius dropSubresolutionPositiveLoops swept before this change). Those
// loops then (a) break a SECOND offset's crossing chaining ("could not chain offset
// boundary"), (b) explode into coincident tessellation samples via sampleBezier's
// depth-capped subdivision, and (c) survive simplify(), whose corner pass pins them as
// if they were real corners. One test per layer, plus the end-to-end regression.
// Pure JS + paper.js only — no WASM boot, safe to share a process.
import { beforeAll, expect, test } from "vitest";
import { offsetRegions } from "../src/framework/geometry/contour-offset.js";
import { sampleBezier, tessellateContour } from "../src/framework/geometry/profile.js";
import { simplifyProfile, profileArea } from "../src/framework/geometry/contour-ops.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";
import { loadDefaultFont } from "./helpers/offset-corpus.js";

let glyphs;
beforeAll(async () => {
  const font = await loadDefaultFont();
  const { textGlyphs } = await import("../src/framework/geometry/text2d.js");
  glyphs = textGlyphs(font, "Scotty", { size: 24 });
});

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Count zero-chord segments whose whole extent (controls included) stays within `radius`
// of their own start — the splice-loop signature. A genuine full-circle arc has a far-away
// `via`, so the extent bound keeps this census from ever matching real geometry.
function spliceLoops(regions, radius = 0.05) {
  let n = 0;
  for (const rg of regions) {
    for (const contour of [rg.outer, ...rg.holes]) {
      let prev = contour.start;
      for (const seg of contour.segments) {
        const controls = [seg.via, seg.c1, seg.c2].filter(Boolean);
        if (dist(prev, seg.to) <= 1e-9 && controls.length &&
            controls.every((p) => dist(prev, p) <= radius)) n++;
        prev = seg.to;
      }
    }
  }
  return n;
}

// ── layer 1: the offset engine sweeps its own splice debris ─────────────────────────

test("offset of text emits no zero-chord splice loops", () => {
  const out = offsetRegions(glyphs, 6, { corners: "round" });
  expect(spliceLoops(out)).toBe(0);
});

test("offset of an offset builds (splice loops used to break the second chaining)", () => {
  const first = offsetRegions(glyphs, 6, { corners: "round" });
  const second = offsetRegions(first, -0.6, { corners: "round" });   // must not throw
  expect(profileArea(second)).toBeGreaterThan(0);
  expect(profileArea(second)).toBeLessThan(profileArea(first));
});

// The multi-segment sibling of the splice loops: whole junk RINGS below the corpus
// oracle's sliver bar (1e-3 mm²). Measured on offset(5, round) of "Scott" size 28
// (feedback 0f3c799d, the "Scott Layered Label" backing): 14 of 16 emitted holes
// were resolver debris of 1e-8..1e-5 mm² beside two real ~6-8 mm² counters, and
// each junk ring extrudes into a degenerate fin or sliver face that broke the
// planar rim fillet downstream (zero-length sweep segments, knife-edge profiles).
// dropSubSliverRings sweeps them for positive deltas; the two real counters and
// the outer must survive untouched.
test("offset of text emits no sub-sliver junk rings", async () => {
  const font = await loadDefaultFont();
  const { textGlyphs } = await import("../src/framework/geometry/text2d.js");
  const scott = textGlyphs(font, "Scott", { size: 28 });
  const out = offsetRegions(scott, 5, { corners: "round" });
  expect(out.length).toBe(1);
  expect(out[0].holes.length).toBe(2);      // the two real counters, nothing else
  const area = (ring) => Math.abs(ringArea(tessellateContour(ring, 64)));
  for (const rg of out) {
    expect(area(rg.outer)).toBeGreaterThan(1e-3);
    for (const h of rg.holes) expect(area(h)).toBeGreaterThan(1e-3);
  }
});

test("erosion keeps every ring (sub-sliver sweep is dilation-only)", async () => {
  const font = await loadDefaultFont();
  const { textGlyphs } = await import("../src/framework/geometry/text2d.js");
  const scott = textGlyphs(font, "Scott", { size: 28 });
  // erode lightly: tiny surviving islands are real geometry, not resolver debris,
  // so nothing may be silently dropped on this side (the dropSubresolutionPositiveLoops rule)
  const out = offsetRegions(scott, -0.2, { corners: "round" });
  expect(out.length).toBeGreaterThan(0);
});

// ── layer 2: tessellation never hands consumers coincident points ────────────────────

test("sampleBezier emits no coincident consecutive samples on a degenerate loop-back", () => {
  // a real splice-debris cubic from the "Scotty" offset: start === end, near-parallel
  // controls ~0.013 mm out. Depth-capped subdivision clusters samples spatially where
  // the curve's speed collapses — measured min gap 2e-9 before the fix.
  const pts = sampleBezier([0, 0], [0.01296, 0.00082], [0.01317, 0.00083], [0, 0], 96);
  let prev = [0, 0];                       // the ring already holds the start point
  for (const p of pts.slice(0, -1)) {
    expect(dist(prev, p)).toBeGreaterThan(1e-7);
    prev = p;
  }
  const last = pts[pts.length - 1];
  expect(last).toEqual([0, 0]);            // exact endpoint stays pinned
});

test("sampleBezier still pins the endpoint and excludes the start on a clean curve", () => {
  const k = 0.551915 * 5;
  const pts = sampleBezier([5, 0], [5, k], [k, 5], [0, 5], 32);
  expect(pts[pts.length - 1]).toEqual([0, 5]);
  expect(dist(pts[0], [5, 0])).toBeGreaterThan(1e-7);
  let prev = [5, 0];
  for (const p of pts) { expect(dist(prev, p)).toBeGreaterThan(1e-7); prev = p; }
});

test("tessellateContour drops coincident consecutive ring points", () => {
  // a zero-length line segment mid-contour used to land verbatim in the ring
  const contour = {
    start: [0, 0],
    segments: [{ to: [1, 0] }, { to: [1, 0] }, { to: [1, 1] }, { to: [0, 0] }],
  };
  const ring = tessellateContour(contour, 32);
  for (let i = 1; i < ring.length; i++) {
    expect(dist(ring[i - 1], ring[i])).toBeGreaterThan(1e-9);
  }
  // the explicit-closure convention is untouched: last point still lands on start
  expect(dist(ring[ring.length - 1], [0, 0])).toBeLessThanOrEqual(1e-9);
});

// ── layer 3: simplify() sweeps degenerate loops at the caller's tolerance ────────────

// A 10×10 square with a 0.02 mm loop-back cubic parked mid-edge at [5,0] — the same
// debris shape, hand-planted. maxBulge measures how far the tessellated result strays
// from the bottom edge near x=5: the loop's signature, robust to how paper refits.
const squareWithLoop = () => [{
  outer: {
    start: [0, 0],
    segments: [
      { to: [5, 0] },
      { c1: [5.02, 0.01], c2: [5.02, -0.01], to: [5, 0] },
      { to: [10, 0] }, { to: [10, 10] }, { to: [0, 10] }, { to: [0, 0] },
    ],
  },
  holes: [],
}];
const maxBulge = (regions) => {
  let bulge = 0;
  for (const p of tessellateContour(regions[0].outer, 64)) {
    if (p[0] > 4 && p[0] < 6 && p[1] < 5) bulge = Math.max(bulge, Math.abs(p[1]));
  }
  return bulge;
};

test("simplify sweeps a sub-tolerance loop-back segment", () => {
  const out = simplifyProfile(squareWithLoop(), 0.05);
  expect(spliceLoops(out)).toBe(0);
  expect(maxBulge(out)).toBeLessThanOrEqual(1e-9);
  expect(Math.abs(profileArea(out) - 100)).toBeLessThan(0.1);
});

test("simplify keeps a loop larger than the tolerance", () => {
  const out = simplifyProfile(squareWithLoop(), 0.001);   // 0.001 < 0.02 extent: not authorized
  expect(maxBulge(out)).toBeGreaterThan(0.001);
});
