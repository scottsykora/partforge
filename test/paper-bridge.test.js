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
