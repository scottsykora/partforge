// Fixed input set for the Shape2D boolean-chain golden fixture (Task 15).
// Shared verbatim between test/shape2d-parity-manifold.test.js and
// test/shape2d-parity-occt.test.js so both backends run the IDENTICAL chain
// `k.shape2d(A).union(B).cut(C).toContours()` against
// test/fixtures/shape2d-boolean-golden.json. toContours() is pure JS over the
// shared contour IR (paper.js booleans, no backend WASM involved) — so this
// fixture pins backend identity exactly (toEqual), not within a tolerance.
//
// A, B: two overlapping rounded rectangles (roundedProfile — arcs carried
// symbolically as {to,via}, not tessellated). C: a cubic-bulge tab
// (pathProfile) that bites a notch out of the union along its bottom edge.
import { roundedProfile, pathProfile } from "../../src/framework/geometry/polygon.js";

export const A = roundedProfile([[0, 0], [40, 0], [40, 30], [0, 30]], 6);
export const B = roundedProfile([[20, 10], [55, 10], [55, 35], [20, 35]], 5);
export const C = pathProfile([25, -5])
  .lineTo([35, -5])
  .cubicTo([35, 8], [38, -2], [38, 5])
  .lineTo([25, 8])
  .close();
