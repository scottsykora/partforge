// The interval eraser: spans in the parameter domain, params never touched.
import { expect, test } from "vitest";
import {
  eraseSegment, visibleFraction, translateElement, invalidateSample,
  DEFAULT_STROKE_WIDTH,
} from "../../../src/framework/annotate/elements.js";

const el = (type, params, gaps = []) =>
  ({ type, color: "red", width: DEFAULT_STROKE_WIDTH, params, gaps });

test("a brush pass over the middle of a line erases a middle span", () => {
  const line = el("line", { x1: 0, y1: 0.5, x2: 1, y2: 0.5 });
  const { changed, list } = eraseSegment([line], 0.5, 0.4, 0.5, 0.6, { radius: 0.03, halfWidth: 0.002 });
  expect(changed).toBe(true);
  expect(list).toHaveLength(1);
  expect(line.gaps).toHaveLength(1);
  const [a, b] = line.gaps[0];
  expect(a).toBeGreaterThan(0.4); expect(a).toBeLessThan(0.5);
  expect(b).toBeGreaterThan(0.5); expect(b).toBeLessThan(0.6);
  expect(line.params).toEqual({ x1: 0, y1: 0.5, x2: 1, y2: 0.5 }); // params survive
});

test("a miss changes nothing", () => {
  const line = el("line", { x1: 0, y1: 0.5, x2: 1, y2: 0.5 });
  const { changed } = eraseSegment([line], 0.5, 0.1, 0.6, 0.1, { radius: 0.03, halfWidth: 0.002 });
  expect(changed).toBe(false);
  expect(line.gaps).toEqual([]);
});

test("overlapping passes merge into one gap", () => {
  const line = el("line", { x1: 0, y1: 0.5, x2: 1, y2: 0.5 });
  eraseSegment([line], 0.3, 0.5, 0.3, 0.5, { radius: 0.05, halfWidth: 0.002 });
  eraseSegment([line], 0.35, 0.5, 0.35, 0.5, { radius: 0.05, halfWidth: 0.002 });
  expect(line.gaps).toHaveLength(1);
});

test("erasing nearly everything drops the element", () => {
  const line = el("line", { x1: 0.4, y1: 0.5, x2: 0.6, y2: 0.5 });
  const { list } = eraseSegment([line], 0.3, 0.5, 0.7, 0.5, { radius: 0.05, halfWidth: 0.002 });
  expect(list).toHaveLength(0);
});

test("gaps are parametric: they ride along when the element moves", () => {
  const line = el("line", { x1: 0, y1: 0.5, x2: 1, y2: 0.5 });
  eraseSegment([line], 0.5, 0.5, 0.5, 0.5, { radius: 0.05, halfWidth: 0.002 });
  const before = JSON.parse(JSON.stringify(line.gaps));
  translateElement(line, 0.2, 0.1);
  invalidateSample(line);
  expect(line.gaps).toEqual(before);
});

test("a circle keeps its params through a partial erase", () => {
  const circle = el("ellipse", { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2, rot: 0 });
  eraseSegment([circle], 0.5, 0.3, 0.5, 0.3, { radius: 0.04, halfWidth: 0.002 });
  expect(circle.gaps.length).toBeGreaterThan(0);
  expect(visibleFraction(circle)).toBeLessThan(1);
  expect(circle.params.rx).toBe(0.2); // still a known circle
});
