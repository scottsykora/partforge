import { expect, test } from "vitest";
import { toEdgeFinder } from "../src/framework/geometry/edge-selector.js";

// A stand-in EdgeFinder that records the calls and chains.
function mockFinder() {
  const calls = [];
  const f = {
    inDirection(d) { calls.push(["inDirection", d]); return f; },
    inPlane(p, o) { calls.push(["inPlane", p, o]); return f; },
    containsPoint(pt) { calls.push(["containsPoint", pt]); return f; },
  };
  return { f, calls };
}

test("undefined selector → undefined (all edges)", () => {
  expect(toEdgeFinder(undefined)).toBeUndefined();
});

test("a function selector is passed through unchanged", () => {
  const fn = (e) => e;
  expect(toEdgeFinder(fn)).toBe(fn);
});

test("{dir} maps named axis to inDirection(unit vector)", () => {
  const { f, calls } = mockFinder();
  toEdgeFinder({ dir: "Z" })(f);
  expect(calls).toEqual([["inDirection", [0, 0, 1]]]);
});

test("{dir:[..]} passes a raw vector through", () => {
  const { f, calls } = mockFinder();
  toEdgeFinder({ dir: [1, 0, 0] })(f);
  expect(calls).toEqual([["inDirection", [1, 0, 0]]]);
});

test("{inPlane, at} and {near} map to inPlane/containsPoint", () => {
  const { f, calls } = mockFinder();
  toEdgeFinder({ inPlane: "XY", at: 5, near: [1, 2, 3] })(f);
  expect(calls).toEqual([["inPlane", "XY", 5], ["containsPoint", [1, 2, 3]]]);
});
