// Validation of the Minkowski-union oracle itself (test/helpers/minkowski-oracle.js).
//
// An oracle is only worth what it has been checked against, so this file checks it ONLY
// against closed-form answers — areas anybody can derive on paper — and never against the
// engine it is meant to judge. The engine appears in exactly one place at the bottom, on the
// case that motivated all of this, and there the closed form is the arbiter for both.
//
// Manifold-only file (see AGENTS.md: OCCT and Manifold must not boot in the same process).
import { beforeAll, describe, expect, test } from "vitest";
import Module from "manifold-3d";
import { minkowskiOracle } from "./helpers/minkowski-oracle.js";
import { offsetRegions } from "../src/framework/geometry/contour-offset.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

let O;
beforeAll(async () => {
  const wasm = await Module();
  wasm.setup();
  O = minkowskiOracle(wasm.CrossSection);
});

const reg = (outer, holes = []) => ({ outer, holes });
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const rectCW = (x0, y0, x1, y1) => rect(x0, y0, x1, y1).slice().reverse();
const circle = (r, n = 4096) => Array.from({ length: n }, (_, i) => {
  const t = (2 * Math.PI * i) / n; return [r * Math.cos(t), r * Math.sin(t)];
});
const pts2contour = (p) => ({ start: [p[0][0], p[0][1]],
  segments: [...p.slice(1).map((q) => ({ to: [q[0], q[1]] })), { to: [p[0][0], p[0][1]] }] });
const nativeArea = (out) => out.reduce((s, rg) =>
  s + ringArea(tessellateContour(rg.outer, 256)) + rg.holes.reduce((t, h) => t + ringArea(tessellateContour(h, 256)), 0), 0);

describe("minkowski oracle — closed-form dilation", () => {
  // A convex polygon dilated by r gains: perimeter × r, plus the vertex caps. For a disk the
  // caps sum to a full circle (πr²); for chamfer they sum to the inscribed polygon of that
  // circle cut at the exterior angles; for miter (all corners inside the limit) they sum to
  // the full circumscribed corner, which on a rectangle is exactly the r² square.
  const s = 10, r = 2;
  test("square: round = s² + 4sr + πr²", () => {
    expect(O.area([reg(rect(0, 0, s, s))], r, { corners: "round", fan: 8192 }))
      .toBeCloseTo(s * s + 4 * s * r + Math.PI * r * r, 4);
  });
  test("square: chamfer = s² + 4sr + 2r² (four r/2·r corner triangles)", () => {
    expect(O.area([reg(rect(0, 0, s, s))], r, { corners: "chamfer" }))
      .toBeCloseTo(s * s + 4 * s * r + 2 * r * r, 9);
  });
  test("square: sharp = (s + 2r)²", () => {
    expect(O.area([reg(rect(0, 0, s, s))], r, { corners: "sharp" }))
      .toBeCloseTo((s + 2 * r) ** 2, 9);
  });
  test("circle: round = π(R + r)², independent of corner style", () => {
    const R = 5;
    for (const corners of ["round", "chamfer", "sharp"])
      expect(O.area([reg(circle(R))], r, { corners, fan: 4096 })).toBeCloseTo(Math.PI * (R + r) ** 2, 2);
  });
  test("L-shape: A + Pr + convex sectors − the reflex vertex's slab overlap", () => {
    // 10×10 with a 5×5 bite: area 75, perimeter 40, five 90° convex vertices and one 270°
    // reflex vertex. A + P·r + πr² is the CONVEX formula and does not apply here; two
    // corrections turn it into the exact answer.
    //   • Sectors are added only at convex vertices, one per exterior angle: Σφ/2 · r².
    //     Turning sums to 2π, so Σφ_convex = 2π + π/2 (the reflex vertex turns −π/2).
    //   • At the reflex vertex the two outward slabs OVERLAP, in a kite of area
    //     r²·tan((θ−π)/2) — for θ = 3π/2 that is exactly r². Counting P·r counts it twice.
    const L = [[0, 0], [10, 0], [10, 10], [5, 10], [5, 5], [0, 5]];
    const sectors = ((2 * Math.PI + Math.PI / 2) / 2) * r * r;
    const reflexOverlap = r * r * Math.tan((3 * Math.PI / 2 - Math.PI) / 2);
    expect(O.area([reg(L)], r, { corners: "round", fan: 8192 }))
      .toBeCloseTo(75 + 40 * r + sectors - reflexOverlap, 4);
  });
  test("square with a square hole: dilation fills the hole once r passes its inradius", () => {
    const R = [reg(rect(0, 0, 20, 20), [rectCW(8, 8, 12, 12)])];
    expect(O.area(R, 1, { corners: "sharp" })).toBeCloseTo(22 * 22 - 2 * 2, 9);   // hole 4×4 → 2×2
    expect(O.area(R, 2, { corners: "sharp" })).toBeCloseTo(24 * 24, 9);            // hole gone
  });
});

describe("minkowski oracle — closed-form erosion", () => {
  test("square: erosion is (s − 2r)² for every corner style", () => {
    for (const corners of ["round", "chamfer", "sharp"])
      expect(O.area([reg(rect(0, 0, 10, 10))], -2, { corners })).toBeCloseTo(36, 8);
  });
  test("circle: erosion is π(R − r)²", () => {
    expect(O.area([reg(circle(5))], -2, { corners: "round", fan: 4096 })).toBeCloseTo(Math.PI * 9, 2);
  });
  test("square with a square hole: erosion shrinks the plate and grows the hole", () => {
    // 20×20 plate, 4×4 hole. Erode by 1: plate → 18×18, hole → 6×6 with ROUNDED corners
    // (the hole's corners are reflex for the plate), so the hole loses (4 − π)r² of area.
    const R = [reg(rect(0, 0, 20, 20), [rectCW(8, 8, 12, 12)])];
    expect(O.area(R, -1, { corners: "round", fan: 8192 })).toBeCloseTo(18 * 18 - (36 - (4 - Math.PI)), 3);
    expect(O.area(R, -1, { corners: "sharp" })).toBeCloseTo(18 * 18 - 36, 8);
  });
  test("erosion past the inradius vanishes", () => {
    expect(O.area([reg(rect(0, 0, 10, 10))], -5.1, { corners: "round" })).toBeCloseTo(0, 9);
  });
});

// The Task 7C defect, measured by the oracle rather than asserted. The truth here is also
// closed-form — see the derivation in the test — so this is a three-way agreement.
describe("minkowski oracle — slotted block erosion (the Task 7C case)", () => {
  // 20×10 block with a w-wide slot cut from the top down to y = 2, eroded by 2. The slot's
  // 2mm floor is thinner than the erosion, so the band under the slot disappears entirely and
  // the result is TWO rectangles [2, 10−w/2−2]×[2,8] and [10+w/2+2, 18]×[2,8]: area 72 − 6w.
  // Corner style cannot matter — every join the erosion introduces sits at y < 2, below the
  // surviving material — which is itself a useful check on all three code paths agreeing.
  const slot = (w) => [[0, 0], [20, 0], [20, 10], [10 + w / 2, 10], [10 + w / 2, 2], [10 - w / 2, 2], [10 - w / 2, 10], [0, 10]];
  for (const w of [2, 4, 6]) {
    test(`slot width ${w}: oracle and engine both reach ${72 - 6 * w}`, () => {
      const truth = 72 - 6 * w;
      const regions = [reg(slot(w))];
      const irRegions = [{ outer: pts2contour(slot(w)), holes: [] }];
      for (const corners of ["round", "chamfer", "sharp"]) {
        expect(O.area(regions, -2, { corners, fan: 4096 })).toBeCloseTo(truth, 3);
        expect(nativeArea(offsetRegions(irRegions, -2, { corners }))).toBeCloseTo(truth, 6);
      }
    });
  }
});
