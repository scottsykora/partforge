import { expect, test } from "vitest";
import { placeRegions } from "../src/framework/geometry/svg2d.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";

// a 20 x 10 box in artwork units
const BOX = [{ outer: { start: [0, 0], segments: [
  { to: [20, 0] }, { to: [20, 10] }, { to: [0, 10] },
] }, holes: [] }];

const bbox = (rs) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rs) for (const [x, y] of tessellateContour(r.outer, 128)) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
};

test("width sizes the tight bbox and preserves aspect", () => {
  const b = bbox(placeRegions(BOX, { width: 40 }));
  expect(b.w).toBeCloseTo(40, 4);
  expect(b.h).toBeCloseTo(20, 4);
});

test("height sizes the other axis", () => {
  const b = bbox(placeRegions(BOX, { height: 5 }));
  expect(b.h).toBeCloseTo(5, 4);
  expect(b.w).toBeCloseTo(10, 4);
});

test("fit sizes the longer edge", () => {
  expect(Math.max(...Object.values({ w: bbox(placeRegions(BOX, { fit: 30 })).w, h: bbox(placeRegions(BOX, { fit: 30 })).h })))
    .toBeCloseTo(30, 4);
});

test("omitting all three size options throws and names them", () => {
  expect(() => placeRegions(BOX, {})).toThrow(/width.*height.*fit/s);
});

test("a non-positive size throws", () => {
  expect(() => placeRegions(BOX, { width: 0 })).toThrow(/svg2d: /);
  expect(() => placeRegions(BOX, { height: -3 })).toThrow(/svg2d: /);
});

test("placement ignores where the artwork sits in its own coordinate space", () => {
  const far = [{ outer: { start: [400, 700], segments: [
    { to: [420, 700] }, { to: [420, 710] }, { to: [400, 710] },
  ] }, holes: [] }];
  const b = bbox(placeRegions(far, { width: 40 }));
  expect(b.w).toBeCloseTo(40, 4);
  expect((b.minX + b.maxX) / 2).toBeCloseTo(0, 6);
});

test("default alignment centres on the origin", () => {
  const b = bbox(placeRegions(BOX, { width: 20 }));
  expect((b.minX + b.maxX) / 2).toBeCloseTo(0, 6);
  expect((b.minY + b.maxY) / 2).toBeCloseTo(0, 6);
});

test("align left and valign bottom put those edges on the origin", () => {
  const b = bbox(placeRegions(BOX, { width: 20, align: "left", valign: "bottom" }));
  expect(b.minX).toBeCloseTo(0, 6);
  expect(b.minY).toBeCloseTo(0, 6);
});

test("align right and valign top put the far edges on the origin", () => {
  const b = bbox(placeRegions(BOX, { width: 20, align: "right", valign: "top" }));
  expect(b.maxX).toBeCloseTo(0, 6);
  expect(b.maxY).toBeCloseTo(0, 6);
});

test("holes are scaled and aligned with their outer", () => {
  const withHole = [{
    outer: BOX[0].outer,
    holes: [{ start: [5, 2], segments: [{ to: [5, 8] }, { to: [15, 8] }, { to: [15, 2] }] }],
  }];
  const [r] = placeRegions(withHole, { width: 40, align: "left", valign: "bottom" });
  expect(r.holes).toHaveLength(1);
  expect(r.holes[0].start).toEqual([10, 4]);          // scale 2, origin at the corner
});

test("arcs stay symbolic through placement", () => {
  const arcs = [{ outer: { start: [2, 0], segments: [
    { to: [-2, 0], via: [0, 2] }, { to: [2, 0], via: [0, -2] },
  ] }, holes: [] }];
  const [r] = placeRegions(arcs, { width: 8 });
  expect(r.outer.segments.every((s) => s.via)).toBe(true);
  expect(r.outer.segments[0].via).toEqual([0, 4]);
});
