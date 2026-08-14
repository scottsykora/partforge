import { test, expect } from "vitest";
import { simplifyProfile, profileCorners, profileArea } from "../src/framework/geometry/contour-ops.js";
import { pathProfile } from "../src/framework/geometry/polygon.js";

test("collinear line chains merge; corners survive exactly", () => {
  const stair = [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [0, 10]];   // two collinear pairs
  const out = simplifyProfile(stair, 0.1);
  expect(out).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
});

test("an over-segmented smooth curve refits to fewer cubics without moving corners", () => {
  // A ring of two straight edges plus a 256-chord half-circle arc (r=10, angle 0 -> 180,
  // centered at the origin). The edges meet the arc at a genuine angle (not tangent to the
  // circle there), so [10, 0] and the arc's other end are real corners; the 256 chords
  // subtend 180/256 ~= 0.7 deg each — below SMOOTH_JOINT_DEG (1deg) — so the arc reads as
  // one smooth run internally and can be refit as a handful of cubics.
  const ring = [[5, -10], [10, 0]];
  for (let i = 1; i <= 256; i++) {
    const a = (Math.PI * i) / 256;
    ring.push([10 * Math.cos(a), 10 * Math.sin(a)]);
  }
  ring.push([-5, -10]);
  const before = ring.length;

  const out = simplifyProfile(ring, 0.05);
  const segCount = out.segments.length;
  expect(segCount).toBeLessThan(before / 10);
  expect(out.segments.some((s) => s.c1)).toBe(true);            // refit as cubics

  const corners = profileCorners(out).map((c) => c.point);
  expect(corners).toContainEqual([10, 0]);                       // the line->curve corner survived
});

test("a run authored as a single real arc segment keeps its curvature, not its chord", () => {
  // paper's Path#simplify() fits only through a path's existing anchor points — handed a
  // sparse, already-curved path (here: one arcTo segment, two anchors) it would degenerate
  // toward the straight chord unless the run is flattened into a dense polyline first.
  const wedge = pathProfile([10, 0])
    .arcTo([0, 10], [10 * Math.SQRT1_2, 10 * Math.SQRT1_2])   // quarter circle, r=10
    .lineTo([0, 0])
    .lineTo([10, 0])
    .close();
  const before = profileArea(wedge);         // quarter-disc: (pi * 10^2) / 4 ~= 78.54
  const out = simplifyProfile(wedge, 0.05);
  expect(profileArea(out)).toBeGreaterThan(before - 1);   // stayed close to the true arc...
  expect(profileArea(out)).toBeLessThan(before + 1);
  expect(out.segments[0].c1).toBeDefined();               // ...as a cubic, not a flattened line
});
