import { expect, test } from "vitest";
import { liftLoftRings, classifyLoftRings, loftRingsKey, LOFT_SEGS } from "../src/framework/geometry/loft-rings.js";
import { roundedProfile, regularPolygon } from "../src/framework/geometry/polygon.js";

const SQ = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
const fakeShape = (regions) => ({ _shape2d: true, _regions: regions, _hash: "abc123", toContours: () => JSON.parse(JSON.stringify(regions)) });
const rsq = roundedProfile(SQ, 2); // curve contour: 4 lines + 4 arcs, "LALALALA"

test("point-list rings lift with legacy scale-then-rotate baked into pts (bit-exact math)", () => {
  const [r] = liftLoftRings([{ polygon: SQ, z: 0, scale: 2, rotate: 90 }, { polygon: SQ, z: 1 }]);
  // scale 2 → (−10,−10), rotate 90° CCW → (10,−10)
  expect(r.pts[0][0]).toBeCloseTo(10, 12);
  expect(r.pts[0][1]).toBeCloseTo(-10, 12);
  expect(r.z).toBe(0);
});

test("sides+radius shorthand lifts to regularPolygon points", () => {
  const [r] = liftLoftRings([{ sides: 6, radius: 8, z: 0 }, { sides: 6, radius: 8, z: 5 }]);
  expect(r.pts).toEqual(regularPolygon(6, 8));
});

test("a curve contour ring lifts with a contour and no pts", () => {
  const [r] = liftLoftRings([{ polygon: rsq, z: 0 }, { polygon: rsq, z: 5 }]);
  expect(r.pts).toBeNull();
  expect(r.contour.segments.filter((s) => s.via).length).toBe(4); // 4 corner arcs survive lifting
});

test("a Shape2D ring lifts its single region's outer contour", () => {
  const s = fakeShape([{ outer: rsq, holes: [] }]);
  const [r] = liftLoftRings([{ polygon: s, z: 0 }, { polygon: s, z: 5 }]);
  expect(r.contour.segments.filter((s2) => s2.via).length).toBe(4);
});

test("a multi-region Shape2D ring throws a loud error", () => {
  const s = fakeShape([{ outer: rsq, holes: [] }, { outer: rsq, holes: [] }]);
  expect(() => liftLoftRings([{ polygon: s, z: 0 }, { polygon: s, z: 5 }]))
    .toThrow(/ring 0 is a Shape2D with 2 regions/);
});

test("a Shape2D ring with holes throws a loud error", () => {
  const s = fakeShape([{ outer: rsq, holes: [rsq] }]);
  expect(() => liftLoftRings([{ polygon: s, z: 0 }, { polygon: s, z: 5 }]))
    .toThrow(/ring 0 has holes/);
});

test("an empty Shape2D ring throws a loud error", () => {
  const s = fakeShape([]);
  expect(() => liftLoftRings([{ polygon: s, z: 0 }, { polygon: s, z: 5 }])).toThrow(/ring 0 is an empty Shape2D/);
});

test("existing validation survives: <2 rings, missing z, short point list all throw", () => {
  expect(() => liftLoftRings([{ polygon: SQ, z: 0 }])).toThrow(/at least 2 rings/);
  expect(() => liftLoftRings([{ polygon: SQ }, { polygon: SQ, z: 1 }])).toThrow(/finite z/);
  expect(() => liftLoftRings([{ polygon: [[0, 0], [1, 0]], z: 0 }, { polygon: SQ, z: 1 }])).toThrow(/≥3 points/);
});

test("classify: equal-N point rings → poly-exact", () => {
  const c = classifyLoftRings(liftLoftRings([{ polygon: SQ, z: 0 }, { polygon: SQ, z: 9 }]));
  expect(c).toEqual({ mode: "poly-exact", hasCurve: false });
});

test("classify: identical curved signatures → curve", () => {
  const c = classifyLoftRings(liftLoftRings([{ polygon: rsq, z: 0 }, { polygon: rsq, z: 9, scale: 0.5 }]));
  expect(c).toEqual({ mode: "curve", hasCurve: true });
});

test("classify: rounded square → plain square is resample (signatures differ)", () => {
  const c = classifyLoftRings(liftLoftRings([{ polygon: rsq, z: 0 }, { polygon: SQ, z: 9 }]));
  expect(c.mode).toBe("resample");
  expect(c.hasCurve).toBe(true);
});

test("classify: unequal-N point rings → resample (was an error before this feature)", () => {
  const oct = regularPolygon(8, 5);
  expect(classifyLoftRings(liftLoftRings([{ polygon: SQ, z: 0 }, { polygon: oct, z: 9 }])).mode).toBe("resample");
});

test("classify: NON-uniform scale on a curved ring still classifies deterministically", () => {
  // arcs under non-uniform scale become cubics (transformContour), so the scaled ring's
  // signature differs from the unscaled one → resample, not a crash.
  const c = classifyLoftRings(liftLoftRings([{ polygon: rsq, z: 0 }, { polygon: rsq, z: 9, scale: [2, 1] }]));
  expect(c.mode).toBe("resample");
});

test("loftRingsKey substitutes a Shape2D with its _hash and is h()-stable", () => {
  const s = fakeShape([{ outer: rsq, holes: [] }]);
  const k1 = JSON.stringify(loftRingsKey([{ polygon: s, z: 0 }, { polygon: s, z: 5 }]));
  expect(k1).toContain("abc123");
  expect(k1).not.toContain("_shape2d"); // no live object leaked into the key
});
