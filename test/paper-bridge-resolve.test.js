// resolveSelfRegions: the offset cleanup stage — paper.js self-union, no WASM.
import { expect, test } from "vitest";
import { resolveSelfRegions } from "../src/framework/geometry/paper-bridge.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const ring = (pts) => ({ start: pts[0], segments: [...pts.slice(1), pts[0]].map((p) => ({ to: p })) });

test("a clean square passes through unchanged", () => {
  const out = resolveSelfRegions([{ outer: ring([[0, 0], [10, 0], [10, 10], [0, 10]]), holes: [] }]);
  expect(out.length).toBe(1);
  expect(Math.abs(regionsAreaOf(out))).toBeCloseTo(100, 6);
});

test("a butterfly ring resolves to simple positive lobes", () => {
  // bowtie: edges cross at (5,5); self-union must return simple geometry with the
  // positive lobe area (two triangles of 25 each)
  const out = resolveSelfRegions([{ outer: ring([[0, 0], [10, 10], [10, 0], [0, 10]]), holes: [] }]);
  expect(out.length).toBeGreaterThanOrEqual(1);
  expect(Math.abs(regionsAreaOf(out))).toBeCloseTo(50, 4);
});

test("overlapping regions merge", () => {
  const out = resolveSelfRegions([
    { outer: ring([[0, 0], [10, 0], [10, 10], [0, 10]]), holes: [] },
    { outer: ring([[5, 0], [15, 0], [15, 10], [5, 10]]), holes: [] },
  ]);
  expect(out.length).toBe(1);
  expect(Math.abs(regionsAreaOf(out))).toBeCloseTo(150, 6);
});

test("a fully inverted ring cancels to nothing", () => {
  // CW-only ring (a raw inward offset that flipped): nonzero union drops it
  const out = resolveSelfRegions([{ outer: ring([[0, 0], [0, 10], [10, 10], [10, 0]]), holes: [] }]);
  expect(out).toEqual([]);
});

function regionsAreaOf(regions) {
  let a = 0;
  for (const rg of regions) {
    a += ringArea(tessellateContour(rg.outer, 64));
    for (const h of rg.holes) a += ringArea(tessellateContour(h, 64));
  }
  return a;
}
