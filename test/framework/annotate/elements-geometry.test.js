// Per-type outline sampling, gap-aware visible runs, rotation, centers.
import { expect, test } from "vitest";
import {
  sample, visibleRuns, centerOf, rot2, invRot2, DEFAULT_STROKE_WIDTH,
} from "../../../src/framework/annotate/elements.js";

const el = (type, params, gaps = []) =>
  ({ type, color: "red", width: DEFAULT_STROKE_WIDTH, params, gaps });

test("rot2/invRot2 round-trip", () => {
  const [x, y] = rot2(1, 0, Math.PI / 2);
  expect(x).toBeCloseTo(0); expect(y).toBeCloseTo(1);
  const [bx, by] = invRot2(x, y, Math.PI / 2);
  expect(bx).toBeCloseTo(1); expect(by).toBeCloseTo(0);
});

test("line samples run endpoint to endpoint with t = normalized length", () => {
  const { pts, closed } = sample(el("line", { x1: 0, y1: 0, x2: 1, y2: 0 }));
  expect(closed).toBe(false);
  expect(pts[0]).toMatchObject({ x: 0, y: 0, t: 0 });
  expect(pts[pts.length - 1]).toMatchObject({ x: 1, y: 0, t: 1 });
  const mid = pts[Math.round((pts.length - 1) / 2)];
  expect(mid.x).toBeCloseTo(0.5, 1);
});

test("rect perimeter walk starts top-left, goes clockwise, honors rot", () => {
  const flat = sample(el("rect", { cx: 0.5, cy: 0.5, w: 0.4, h: 0.2, rot: 0 }));
  expect(flat.closed).toBe(true);
  expect(flat.pts[0].x).toBeCloseTo(0.3); // top-left corner
  expect(flat.pts[0].y).toBeCloseTo(0.4);
  // t = w/perimeter lands exactly on the top-right corner
  const per = 2 * (0.4 + 0.2);
  const corner = flat.pts.reduce((best, p) =>
    Math.abs(p.t - 0.4 / per) < Math.abs(best.t - 0.4 / per) ? p : best);
  expect(corner.x).toBeCloseTo(0.7, 2);
  expect(corner.y).toBeCloseTo(0.4, 2);
  // 90° rotation maps the top-left corner accordingly
  const rot = sample(el("rect", { cx: 0.5, cy: 0.5, w: 0.4, h: 0.2, rot: Math.PI / 2 }));
  expect(rot.pts[0].x).toBeCloseTo(0.5 + 0.1); // (-w/2,-h/2) rotated 90° = (h/2, -w/2)
  expect(rot.pts[0].y).toBeCloseTo(0.5 - 0.2);
});

test("ellipse samples lie on the ellipse; a circle stays round", () => {
  const { pts, closed } = sample(el("ellipse", { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2, rot: 0 }));
  expect(closed).toBe(true);
  for (const p of [pts[0], pts[80], pts[160]]) {
    expect(Math.hypot(p.x - 0.5, p.y - 0.5)).toBeCloseTo(0.2, 3);
  }
});

test("visibleRuns splits at gaps and drops erased samples", () => {
  const gapped = el("line", { x1: 0, y1: 0, x2: 1, y2: 0 }, [[0.4, 0.6]]);
  const runs = visibleRuns(gapped);
  expect(runs.length).toBe(2);
  expect(runs[0][0].t).toBe(0);
  expect(runs[0][runs[0].length - 1].t).toBeLessThan(0.4);
  expect(runs[1][0].t).toBeGreaterThan(0.6);
  // fully erased → no runs
  expect(visibleRuns(el("line", { x1: 0, y1: 0, x2: 1, y2: 0 }, [[0, 1]]))).toEqual([]);
});

test("centerOf per type", () => {
  expect(centerOf(el("rect", { cx: 0.3, cy: 0.4, w: 0.1, h: 0.1, rot: 0 }))).toEqual([0.3, 0.4]);
  expect(centerOf(el("line", { x1: 0, y1: 0, x2: 1, y2: 1 }))).toEqual([0.5, 0.5]);
  expect(centerOf(el("freehand", { points: [[0, 0], [0.2, 0.6], [0.4, 0.2]] })))
    .toEqual([0.2, 0.3]);
});

test("a one-point freehand samples as a single dot", () => {
  const { pts } = sample(el("freehand", { points: [[0.5, 0.5]] }));
  expect(pts).toEqual([{ x: 0.5, y: 0.5, t: 0 }]);
});
