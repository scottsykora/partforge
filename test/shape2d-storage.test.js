import { test, expect, beforeEach } from "vitest";
import { makeShape2dFactory } from "../src/framework/geometry/shape2d.js";

const deps = {
  segs: 64,
  offsetRegions: (regions, delta) => { calls.push(["offset", delta]); return regions; },
  extrude: (o) => ({ fake: "solid", ...o }),
  revolve: (o) => ({ fake: "solid", ...o }),
};
let calls; let shape2d;
beforeEach(() => { calls = []; shape2d = makeShape2dFactory(deps); });

const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];

test("lifts every profile form, is idempotent, and stores winding-normalized contours", () => {
  const s = shape2d(sq);
  expect(shape2d(s)).toBe(s);
  expect(s._regions[0].outer.segments.length).toBe(4);
  const rings = s.toContours();
  expect(rings).not.toBe(s._regions);                    // deep copy
  rings[0].outer.start[0] = 999;
  expect(s._regions[0].outer.start[0]).toBe(0);          // storage untouched
});

test("union is curve-native and backend-free; area/boundingBox are curve-exact", () => {
  const a = shape2d(sq), b = shape2d([[5, 0], [15, 0], [15, 10], [5, 10]]);
  const u = a.union(b);
  expect(u.area()).toBeCloseTo(150, 6);
  expect(u.boundingBox()).toEqual({ min: [0, 0], max: [15, 10] });
  expect(a.area()).toBeCloseTo(100, 6);                  // value semantics — operand untouched
});

test("toRegions tessellates at deps.segs and groups via assembleRegions", () => {
  const s = shape2d({ outer: sq, holes: [[[3, 3], [7, 3], [7, 7], [3, 7]]] });
  const regions = s.toRegions();
  expect(regions.length).toBe(1);
  expect(regions[0].holes.length).toBe(1);
  expect(Array.isArray(regions[0].outer[0])).toBe(true); // point rings, not contours
});

test("transforms, fillet, simplify, corners, contains delegate and return new Shape2D values", () => {
  const s = shape2d(sq);
  const moved = s.translate([5, 5]);
  expect(moved._shape2d).toBe(true);
  expect(moved.boundingBox().min).toEqual([5, 5]);
  expect(s.corners().length).toBe(4);
  const filleted = s.fillet(2, { corners: "convex" });
  expect(filleted.toContours()[0].outer.segments.some((seg) => seg.via)).toBe(true);
  expect(s.contains([5, 5])).toBe(true);
});

test("offset delegates to the backend hook; extrude/revolve route through sugar deps", () => {
  const s = shape2d(sq);
  s.offset(1, { corners: "round" });
  expect(calls).toContainEqual(["offset", 1]);
  expect(s.extrude({ h: 5 }).fake).toBe("solid");
});

test("simple() error message is preserved verbatim", () => {
  const two = shape2d(sq).union(shape2d([[30, 0], [40, 0], [40, 10], [30, 10]]));
  expect(() => two.simple()).toThrow("Shape2D.simple: result has 2 regions, not 1 (use toRegions())");
});
