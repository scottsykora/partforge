import { expect, test } from "vitest";
import { toFaceFinder } from "../src/framework/geometry/face-selector.js";

// A minimal fake FaceFinder recording which filters were applied.
const fakeFinder = () => {
  const calls = [];
  const f = {
    calls,
    inPlane(plane, at) { calls.push(["inPlane", plane, at]); return f; },
    parallelTo(plane) { calls.push(["parallelTo", plane]); return f; },
    containsPoint(p) { calls.push(["containsPoint", p]); return f; },
  };
  return f;
};

test("null selector → undefined (all faces)", () => {
  expect(toFaceFinder(undefined)).toBeUndefined();
  expect(toFaceFinder(null)).toBeUndefined();
});

test("a raw function passes through", () => {
  const fn = (f) => f;
  expect(toFaceFinder(fn)).toBe(fn);
});

test("inPlane+at maps to FaceFinder.inPlane", () => {
  const f = fakeFinder();
  toFaceFinder({ inPlane: "XY", at: 16 })(f);
  expect(f.calls).toContainEqual(["inPlane", "XY", 16]);
});

test("dir maps to parallelTo the perpendicular plane (Z → XY)", () => {
  const f = fakeFinder();
  toFaceFinder({ dir: "Z" })(f);
  expect(f.calls).toContainEqual(["parallelTo", "XY"]);
});

test("near maps to containsPoint", () => {
  const f = fakeFinder();
  toFaceFinder({ near: [0, 0, 16] })(f);
  expect(f.calls).toContainEqual(["containsPoint", [0, 0, 16]]);
});
