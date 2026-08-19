// Pure stroke model: thinning, undo/clear, closed-stroke detection, anchors.
import { expect, test } from "vitest";
import {
  createInkStore, diagDistance, pointAt, isClosedStroke, strokeCentroid,
  anchorSpecs, DEFAULT_STROKE_WIDTH,
} from "../../../src/framework/annotate/ink.js";

test("diagDistance measures in viewport-diagonal units", () => {
  // square viewport: corner to corner is exactly 1 diagonal
  expect(diagDistance([0, 0], [1, 1], 1)).toBeCloseTo(1);
  // wide viewport (aspect 2): a full horizontal run is 2/sqrt(5) of the diagonal
  expect(diagDistance([0, 0], [1, 0], 2)).toBeCloseTo(2 / Math.hypot(2, 1));
});

test("extend thins points closer than minDistance", () => {
  const ink = createInkStore({ minDistance: 0.01 });
  ink.begin(0.5, 0.5, { aspect: 1 });
  ink.extend(0.5005, 0.5);   // sub-threshold: dropped
  ink.extend(0.52, 0.5);     // kept
  ink.end();
  expect(ink.strokes()[0].points).toEqual([[0.5, 0.5], [0.52, 0.5]]);
});

test("a click without movement keeps a one-point stroke (a dot)", () => {
  const ink = createInkStore();
  ink.begin(0.3, 0.3, {});
  ink.end();
  expect(ink.strokeCount()).toBe(1);
  expect(ink.strokes()[0].points).toEqual([[0.3, 0.3]]);
  expect(ink.strokes()[0].width).toBe(DEFAULT_STROKE_WIDTH);
});

test("undo removes the last stroke; clear removes all; both notify", () => {
  const ink = createInkStore();
  let calls = 0;
  const off = ink.onChange(() => { calls += 1; });
  ink.begin(0.1, 0.1, {}); ink.end();
  ink.begin(0.2, 0.2, {}); ink.end();
  expect(ink.strokeCount()).toBe(2);
  ink.undo();
  expect(ink.strokeCount()).toBe(1);
  ink.clear();
  expect(ink.isEmpty()).toBe(true);
  expect(calls).toBe(6); // begin, end, begin, end, undo, clear
  off();
  ink.begin(0.5, 0.5, {});
  expect(calls).toBe(6); // unsubscribed: no further notifications
});

test("strokes() returns copies — mutating them cannot corrupt the store", () => {
  const ink = createInkStore();
  ink.begin(0.1, 0.1, {}); ink.end();
  const out = ink.strokes();
  out[0].points[0][0] = 99;
  expect(ink.strokes()[0].points[0][0]).toBe(0.1);
});

test("pointAt walks arc length, not index", () => {
  // Three points, but the first segment is 9× longer than the second:
  // the halfway point by arc length sits inside the first segment.
  const points = [[0, 0], [0.9, 0], [1.0, 0]];
  expect(pointAt(points, 0.5, 1)[0]).toBeCloseTo(0.5);
  expect(pointAt(points, 0, 1)).toEqual([0, 0]);
  expect(pointAt(points, 1, 1)).toEqual([1.0, 0]);
});

test("isClosedStroke: endpoints within 5% of the diagonal close the stroke", () => {
  const closed = [[0.5, 0.3], [0.7, 0.5], [0.5, 0.7], [0.3, 0.5], [0.51, 0.31]];
  const open = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9]];
  expect(isClosedStroke(closed, 1)).toBe(true);
  expect(isClosedStroke(open, 1)).toBe(false);
  expect(isClosedStroke([[0.1, 0.1], [0.1, 0.1]], 1)).toBe(false); // <3 points never closes
});

test("strokeCentroid: area-weighted for loops, point-average for degenerate", () => {
  const square = [[0, 0], [1, 0], [1, 1], [0, 1]];
  expect(strokeCentroid(square)[0]).toBeCloseTo(0.5);
  expect(strokeCentroid(square)[1]).toBeCloseTo(0.5);
  const line = [[0, 0], [1, 0]]; // zero area
  expect(strokeCentroid(line)).toEqual([0.5, 0]);
});

test("anchorSpecs: start/mid/end for open strokes, + centroid for closed", () => {
  const open = [[0.1, 0.1], [0.5, 0.1], [0.9, 0.1]];
  const specs = anchorSpecs(open, 1);
  expect(specs.map((s) => s.t)).toEqual([0, 0.5, 1]);
  const closed = [[0.5, 0.3], [0.7, 0.5], [0.5, 0.7], [0.3, 0.5], [0.5, 0.3]];
  const closedSpecs = anchorSpecs(closed, 1);
  expect(closedSpecs).toHaveLength(4);
  expect(closedSpecs[3].kind).toBe("centroid");
  expect(closedSpecs[3].screen[0]).toBeCloseTo(0.5);
  // a dot gets exactly one anchor
  expect(anchorSpecs([[0.2, 0.2]], 1)).toEqual([{ t: 0, screen: [0.2, 0.2] }]);
});
