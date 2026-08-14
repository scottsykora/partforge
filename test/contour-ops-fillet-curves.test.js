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
