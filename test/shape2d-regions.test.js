import { expect, test } from "vitest";
import { assembleRegions, svgPathToRings, regionsArea } from "../src/framework/geometry/shape2d-regions.js";

const area = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const [x1,y1]=p[i],[x2,y2]=p[(i+1)%p.length]; a += x1*y2 - x2*y1; } return a/2; };

test("assembleRegions nests a CW hole inside its CCW outer", () => {
  const outer = [[0,0],[10,0],[10,10],[0,10]];                 // CCW, area +100
  const hole  = [[3,3],[3,7],[7,7],[7,3]];                     // CW,  area -16
  const regions = assembleRegions([outer, hole]);
  expect(regions).toHaveLength(1);
  expect(area(regions[0].outer)).toBeCloseTo(100, 6);
  expect(regions[0].holes).toHaveLength(1);
  expect(Math.abs(area(regions[0].holes[0]))).toBeCloseTo(16, 6);
});

test("assembleRegions returns two disjoint outers as two regions", () => {
  const a = [[0,0],[5,0],[5,5],[0,5]], b = [[20,20],[25,20],[25,25],[20,25]];
  expect(assembleRegions([a, b])).toHaveLength(2);
});

test("svgPathToRings parses M/L into a polygon ring", () => {
  const rings = svgPathToRings("M0,0 L10,0 L10,10 L0,10 Z", 32);
  expect(rings).toHaveLength(1);
  expect(Math.abs(area(rings[0]))).toBeCloseTo(100, 6);
});

test("svgPathToRings samples a cubic C command via sampleBezier", () => {
  // one quarter-circle-ish cubic; ring should have many points, not 2
  const rings = svgPathToRings("M10,0 C10,5.52 5.52,10 0,10", 32);
  expect(rings[0].length).toBeGreaterThan(4);
  expect(rings[0][rings[0].length - 1][0]).toBeCloseTo(0, 6);
  expect(rings[0][rings[0].length - 1][1]).toBeCloseTo(10, 6);
});

test("regionsArea = Σ|outer| − Σ|holes|", () => {
  const outer = [[0,0],[10,0],[10,10],[0,10]], hole = [[3,3],[3,7],[7,7],[7,3]];
  expect(regionsArea(assembleRegions([outer, hole]))).toBeCloseTo(100 - 16, 6);
});

test("svgPathToRings samples an A arc onto the true circle (semicircle, not a chord)", () => {
  const rings = svgPathToRings("M2,0 A2,2 0 0 1 -2,0", 32);
  for (const [x, y] of rings[0]) expect(Math.hypot(x, y)).toBeCloseTo(2, 4);
});
test("svgPathToRings reconstructs a full circle from two 180° A commands", () => {
  const rings = svgPathToRings("M2,0 A2,2 0 0 1 -2,0 A2,2 0 0 1 2,0 Z", 64);
  expect(rings).toHaveLength(1);
  expect(Math.abs(area(rings[0]))).toBeCloseTo(Math.PI * 4, 1);
});
test("svgPathToRings elevates a quadratic Q to a cubic and samples it", () => {
  const rings = svgPathToRings("M0,0 Q5,10 10,0 Z", 32);
  expect(rings[0].length).toBeGreaterThan(4);
});
test("svgPathToRings throws on an unsupported (e.g. relative) command", () => {
  expect(() => svgPathToRings("m0,0 l10,0", 32)).toThrow("unsupported SVG command");
});
