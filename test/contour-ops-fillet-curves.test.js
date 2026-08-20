import { test, expect, vi } from "vitest";
import { filletProfile, profileCorners, jointTangents, liftProfile } from "../src/framework/geometry/contour-ops.js";
import { pathProfile, circleProfile } from "../src/framework/geometry/polygon.js";
import { booleanRegions } from "../src/framework/geometry/paper-bridge.js";

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

test("oversized radius on a curve corner is clamped to its bisected max", () => {
  // The bisected ceiling used to be reported in a throw; it is now the radius
  // the corner is actually built at.
  const record = vi.fn();
  const out = filletProfile(tab(), 20, { corners: { near: [20, 10] } }, record);
  expect(out.segments.some((s) => s.via)).toBe(true);
  expect(record.mock.calls[0][0]).toMatch(/r=20 does not fit against the curved segment — clamped to /);
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

test("two curve corners over-claiming a shared line are backed off until they fit", () => {
  const record = vi.fn();
  const out = filletProfile(bumps(), 2.5, { corners: { indices: [1, 2] } }, record);
  expect(out.segments.filter((s) => s.via).length).toBe(2);
  expect(record).toHaveBeenCalled();
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

// A rectangle-with-one-cubic-bulge outline, authored so `start`'s closing edge (the
// last segment's `to` back to `start`) is left IMPLICIT — `close()` never revisits
// `start` itself, and that closing edge is adjacent to the cubic. This is the exact
// shape src/parts/gasket.js's outline construction bumped into: contourCorners/
// buildCornerOpRing (contour-ops.js) index corner 0 as "the joint arriving via
// segments[n-1]", which is only true if the ring is EXPLICITLY closed — here
// segments[n-1] is really the cubic bulge (nowhere near `start`), not the missing
// straight closer, so corner 0's fillet solve pairs the cubic against the wrong
// neighbor entirely.
const bulgeRectImplicitlyClosed = () => pathProfile([-10, 0])
  .lineTo([10, 0])
  .lineTo([10, 10])
  .cubicTo([-10, 10], [5, 13], [-5, 13])   // ends at [-10,10] — NOT back at start [-10,0]
  .close();                                 // the [-10,10]→[-10,0] edge is left implicit

test("fillet on a raw contour with an implicit closing edge adjacent to a curve does not misfire at corner 0", () => {
  // Target exactly the seam corner (near start, [-10,0]) rather than "convex" (which
  // would fillet all 4 corners and leave none sharp to compare against) — this is the
  // one whose neighbor buildCornerOpRing misidentified pre-fix.
  const out = filletProfile(bulgeRectImplicitlyClosed(), 2, { corners: { near: [-10, 0], count: 1 } });
  const arcIdx = out.segments.findIndex((s) => s.via);
  expect(arcIdx).toBeGreaterThan(-1);          // a real arc was inserted at the seam
  const tans = jointTangents(out);
  const dotIn = tans[arcIdx].inTan[0] * tans[arcIdx].outTan[0] + tans[arcIdx].inTan[1] * tans[arcIdx].outTan[1];
  expect(dotIn).toBeGreaterThan(0.9999);        // G1 at the arc's incoming tangency point
  // The other 3 corners were left untouched — still reported as sharp.
  expect(profileCorners(out).length).toBe(3);
});

test("fillet on a UNION's readback contour with the same implicit-closing-edge shape does not misfire (gasket regression)", () => {
  // A tab unioned in elsewhere doesn't touch the seam corner directly, but paper.js's
  // boolean still round-trips the WHOLE contour through toContour() — which is where
  // the closing edge becomes implicit in the first place (see paper-bridge.js).
  let regions = liftProfile(bulgeRectImplicitlyClosed()).regions;
  regions = booleanRegions(regions, liftProfile(circleProfile(2, [5, 0])).regions, "unite");
  const out = filletProfile(regions, 1, { corners: "convex" });
  const kinds = out[0].outer.segments.map((s) => (s.via ? "arc" : s.c1 ? "cubic" : "line"));
  expect(kinds).toContain("arc");    // the fillet actually ran, not a silent no-op
  expect(kinds).toContain("cubic");  // the bulge survived the union
});
