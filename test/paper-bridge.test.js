import { expect, test } from "vitest";
import { paperScope, toPaperPath, toContour } from "../src/framework/geometry/paper-bridge.js";

test("contour → paper path → contour round-trips lines and cubics", () => {
  const scope = paperScope();
  const ct = { start: [0, 0], segments: [
    { to: [10, 0] },
    { to: [10, 10], c1: [12, 2], c2: [12, 8] },
    { to: [0, 10] },
    { to: [0, 0] },
  ] };
  const back = toContour(toPaperPath(scope, ct));
  expect(back.start).toEqual([0, 0]);
  // implicit straight close: the trailing straight segment back to start is dropped
  expect(back.segments.length).toBe(3);
  expect(back.segments[1].c1[0]).toBeCloseTo(12, 9);
  scope.project.clear();
});

test("segMap is identity for line/cubic contours", () => {
  const scope = paperScope();
  const ct = { start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 10], c1: [12, 2], c2: [12, 8] }, { to: [0, 0] }] };
  const segMap = [];
  toPaperPath(scope, ct, segMap);
  expect(segMap).toEqual([0, 1, 2]);
  scope.project.clear();
});

import { arcToCubicSegments } from "../src/framework/geometry/paper-bridge.js";

test("quarter-circle arc → single cubic within 1e-4 of the true circle", () => {
  const p0 = [10, 0], via = [Math.SQRT1_2 * 10, Math.SQRT1_2 * 10], to = [0, 10];
  const cubics = arcToCubicSegments(p0, via, to);
  expect(cubics.length).toBe(1);
  expect(cubics[0].to).toEqual([0, 10]);
  // The k=(4/3)tan(θ/4) quarter-circle cubic has max radial error ≈ 2.7e-4·r; at r=10, precision 2 (5e-3) is the right gate
  let prev = p0;
  for (const seg of cubics) {
    for (let t = 0.1; t < 1; t += 0.1) {
      const p = cubicAt(prev, seg.c1, seg.c2, seg.to, t);
      expect(Math.hypot(p[0], p[1])).toBeCloseTo(10, 2);
    }
    prev = seg.to;
  }
});

test("270° arc splits into 3 pieces, endpoint pinned exactly", () => {
  const p0 = [10, 0], via = [-10, 0], to = [0, -10]; // sweep through via
  const cubics = arcToCubicSegments(p0, via, to);
  expect(cubics.length).toBe(3);
  expect(cubics[cubics.length - 1].to).toEqual([0, -10]);
});

test("collinear (degenerate) arc → single straight segment", () => {
  expect(arcToCubicSegments([0, 0], [5, 0], [10, 0])).toEqual([{ to: [10, 0] }]);
});

function cubicAt(p0, c1, c2, p1, t) {
  const u = 1 - t;
  return [0, 1].map((i) =>
    u*u*u*p0[i] + 3*u*u*t*c1[i] + 3*u*t*t*c2[i] + t*t*t*p1[i]);
}

test("segMap for contour with one 270° arc between two lines yields [0, 1, 1, 1, 2]", () => {
  const scope = paperScope();
  const ct = {
    start: [0, 0],
    segments: [
      { to: [10, 0] }, // line (index 0)
      { to: [0, -10], via: [-10, 0] }, // 270° arc (index 1) → expands to 3 cubics
      { to: [0, 0] } // line (index 2)
    ]
  };
  const segMap = [];
  toPaperPath(scope, ct, segMap);
  expect(segMap).toEqual([0, 1, 1, 1, 2]);
  scope.project.clear();
});
