import { expect, test } from "vitest";
import { parseTransform, composeMatrix, isUniformMatrix, applyMatrixToContour, IDENTITY }
  from "../src/framework/geometry/svg-transform.js";

test("an absent or empty spec is the identity", () => {
  expect(parseTransform(undefined)).toEqual(IDENTITY);
  expect(parseTransform("   ")).toEqual(IDENTITY);
});

test("translate with one and two arguments", () => {
  expect(parseTransform("translate(3 4)")).toEqual([1, 0, 0, 1, 3, 4]);
  expect(parseTransform("translate(3)")).toEqual([1, 0, 0, 1, 3, 0]);
});

test("scale with one and two arguments", () => {
  expect(parseTransform("scale(2)")).toEqual([2, 0, 0, 2, 0, 0]);
  expect(parseTransform("scale(2,3)")).toEqual([2, 0, 0, 3, 0, 0]);
});

test("rotate about the origin and about a point", () => {
  const r = parseTransform("rotate(90)");
  expect(r[0]).toBeCloseTo(0, 12);
  expect(r[1]).toBeCloseTo(1, 12);
  const about = parseTransform("rotate(90 10 0)");
  // (10,0) is the fixed point
  expect(about[0] * 10 + about[2] * 0 + about[4]).toBeCloseTo(10, 9);
  expect(about[1] * 10 + about[3] * 0 + about[5]).toBeCloseTo(0, 9);
});

test("matrix() passes its six numbers through", () => {
  expect(parseTransform("matrix(1 2 3 4 5 6)")).toEqual([1, 2, 3, 4, 5, 6]);
});

test("a list of transforms applies left-to-right", () => {
  // translate then scale: the scale is applied first to the point, per SVG
  const m = parseTransform("translate(10 0) scale(2)");
  expect(m[0] * 1 + m[2] * 0 + m[4]).toBeCloseTo(12, 9);
});

test("skewX shears", () => {
  const m = parseTransform("skewX(45)");
  expect(m[2]).toBeCloseTo(1, 9);
});

test("throws on an unknown transform function", () => {
  expect(() => parseTransform("wobble(3)")).toThrow(/svg: /);
});

test("composeMatrix applies the parent after the child", () => {
  const child = parseTransform("translate(1 0)");
  const parent = parseTransform("scale(10)");
  const m = composeMatrix(parent, child);
  // a point at origin: child moves it to (1,0), parent scales to (10,0)
  expect([m[0] * 0 + m[2] * 0 + m[4], m[1] * 0 + m[3] * 0 + m[5]]).toEqual([10, 0]);
});

test("isUniformMatrix accepts rotation, uniform scale, and reflection", () => {
  expect(isUniformMatrix(IDENTITY)).toBe(true);
  expect(isUniformMatrix(parseTransform("scale(3)"))).toBe(true);
  expect(isUniformMatrix(parseTransform("rotate(37)"))).toBe(true);
  expect(isUniformMatrix(parseTransform("scale(-1,1)"))).toBe(true);
});

test("isUniformMatrix rejects non-uniform scale and skew", () => {
  expect(isUniformMatrix(parseTransform("scale(2,3)"))).toBe(false);
  expect(isUniformMatrix(parseTransform("skewX(20)"))).toBe(false);
});

test("a uniform matrix keeps an arc symbolic", () => {
  const arc = { start: [1, 0], segments: [{ via: [0, 1], to: [-1, 0] }] };
  const out = applyMatrixToContour(arc, parseTransform("scale(2)"));
  expect(out.segments).toHaveLength(1);
  expect(out.segments[0].via).toEqual([0, 2]);
  expect(out.segments[0].c1).toBeUndefined();
});

test("a non-uniform matrix degrades an arc to cubics", () => {
  const arc = { start: [1, 0], segments: [{ via: [0, 1], to: [-1, 0] }] };
  const out = applyMatrixToContour(arc, parseTransform("scale(2,1)"));
  expect(out.segments.length).toBeGreaterThan(1);
  for (const s of out.segments) {
    expect(s.via).toBeUndefined();
    expect(s.c1).toBeDefined();
  }
  // endpoint still lands where the matrix says
  expect(out.segments.at(-1).to[0]).toBeCloseTo(-2, 9);
});

test("cubic handles transform along with their endpoints", () => {
  const c = { start: [0, 0], segments: [{ to: [10, 0], c1: [0, 5], c2: [10, 5] }] };
  const out = applyMatrixToContour(c, parseTransform("translate(1 2)"));
  expect(out.start).toEqual([1, 2]);
  expect(out.segments[0].c1).toEqual([1, 7]);
  expect(out.segments[0].to).toEqual([11, 2]);
});
