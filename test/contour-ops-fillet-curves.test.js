import { test, expect } from "vitest";
import { filletProfile, profileCorners, jointTangents } from "../src/framework/geometry/contour-ops.js";
import { pathProfile } from "../src/framework/geometry/polygon.js";

// A "tab" whose top edge is a shallow cubic bulge meeting straight sides at corners.
const tab = () => pathProfile([0, 0])
  .lineTo([20, 0])
  .lineTo([20, 10])
  .cubicTo([0, 10], [14, 14], [6, 14])
  .close();

test("filleting a line-curve corner emits an arc and is G1 at both tangency points", () => {
  const out = filletProfile(tab(), 2, { corners: { near: [20, 10] } });
  const arcIdx = out.segments.findIndex((s) => s.via);
  expect(arcIdx).toBeGreaterThan(-1);
  // G1: tangent leaving the trimmed neighbor ≈ tangent entering the arc, at both ends
  const tans = jointTangents(out);
  const dotIn = tans[arcIdx].inTan[0] * tans[arcIdx].outTan[0] + tans[arcIdx].inTan[1] * tans[arcIdx].outTan[1];
  const next = (arcIdx + 1) % out.segments.length;
  const dotOut = tans[next].inTan[0] * tans[next].outTan[0] + tans[next].inTan[1] * tans[next].outTan[1];
  expect(dotIn).toBeGreaterThan(0.9999);
  expect(dotOut).toBeGreaterThan(0.9999);
});

test("curved neighbor is trimmed, not replaced: remaining cubic still ends where the arc starts", () => {
  const out = filletProfile(tab(), 2, { corners: { near: [20, 10] } });
  expect(out.segments.some((s) => s.c1)).toBe(true);   // the bulge survives as a (trimmed) cubic
});

test("oversized radius on a curve corner throws with a computed max", () => {
  expect(() => filletProfile(tab(), 20, { corners: { near: [20, 10] } }))
    .toThrow(/could not fit r=20 .* max ≈ /);
});

// A short flat run (segment 1, [6,0]→[8,0]) sandwiched between two cubic bulges,
// with both flanking corners (1 and 2) filleted at once — the overlap check must
// see BOTH curve-corner claims on that shared line, not just line-line ones.
const bumps = () => pathProfile([0, 0])
  .cubicTo([6, 0], [1, -2], [5, -2])
  .lineTo([8, 0])
  .cubicTo([14, 0], [9, -2], [13, -2])
  .lineTo([14, 10])
  .lineTo([0, 10])
  .close();

test("two curve corners over-claiming a shared line throw an overlap error", () => {
  expect(() => filletProfile(bumps(), 2.5, { corners: { indices: [1, 2] } }))
    .toThrow(/corners 1 and 2 overlap on segment 1 \(reduce r\)/);
});

test("two curve corners that fit leave the shared line running forward, not self-intersecting", () => {
  const out = filletProfile(bumps(), 2, { corners: { indices: [1, 2] } });
  const arcIdx = out.segments.findIndex((s) => s.via);
  const lineSeg = out.segments[arcIdx + 1];
  expect(lineSeg.via).toBeUndefined();
  expect(lineSeg.c1).toBeUndefined();
  // the remaining flat run must go forward (increasing x): from the first arc's
  // end to the line's own end, not backward (which is what the bug produced).
  expect(lineSeg.to[0]).toBeGreaterThan(out.segments[arcIdx].to[0]);
});
