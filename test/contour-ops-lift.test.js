import { expect, test } from "vitest";
import { liftProfile, restoreProfile, reverseContour, contourIsCCW, ensureRegionWinding }
  from "../src/framework/geometry/contour-ops.js";

const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];

test("lifts a point list to one region and restores it", () => {
  const { kind, regions } = liftProfile(sq);
  expect(kind).toBe("points");
  expect(regions.length).toBe(1);
  expect(regions[0].outer.segments.every((s) => !s.c1 && !s.via)).toBe(true);
  expect(restoreProfile(kind, regions)).toEqual(sq);
});

test("lifts contour / region / region-array, preserving container kind", () => {
  const ct = { start: [0, 0], segments: [{ to: [10, 0] }, { to: [5, 8], c1: [10, 4], c2: [8, 8] }, { to: [0, 0] }] };
  expect(liftProfile(ct).kind).toBe("contour");
  expect(liftProfile({ outer: sq, holes: [] }).kind).toBe("region");
  expect(liftProfile([{ outer: sq, holes: [] }]).kind).toBe("regions");
});

test("reverseContour reverses traversal, swaps c1/c2, keeps via; double-reverse is identity", () => {
  const ct = { start: [0, 0], segments: [
    { to: [10, 0] },
    { to: [10, 10], via: [12, 5] },
    { to: [0, 10], c1: [8, 12], c2: [2, 12] },
    { to: [0, 0] },
  ] };
  const rev = reverseContour(ct);
  expect(rev.start).toEqual([0, 0]);              // closed contour: same start point set, walked backwards
  expect(contourIsCCW(rev)).toBe(!contourIsCCW(ct));
  expect(reverseContour(rev)).toEqual(ct);
});

test("ensureRegionWinding forces outer CCW and holes CW", () => {
  const cwSq = { start: [0, 0], segments: [{ to: [0, 10] }, { to: [10, 10] }, { to: [10, 0] }, { to: [0, 0] }] };
  const ccwHole = { start: [2, 2], segments: [{ to: [8, 2] }, { to: [8, 8] }, { to: [2, 8] }, { to: [2, 2] }] };
  const fixed = ensureRegionWinding({ outer: cwSq, holes: [ccwHole] });
  expect(contourIsCCW(fixed.outer)).toBe(true);
  expect(contourIsCCW(fixed.holes[0])).toBe(false);
});
