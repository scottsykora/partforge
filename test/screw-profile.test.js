import { expect, test } from "vitest";
import { screwCrossSection, SCREW_STEP_DEG } from "../src/framework/geometry/screw-profile.js";

test("a constant-z segment needs no subdivision and maps to itself", () => {
  // No z change → no polar sweep → no chordal error to correct.
  expect(screwCrossSection([[5, 0], [3, 0]], 2)).toEqual([[5, 0], [3, 0]]);
});

test("densifies each segment to the 5 degree polar step", () => {
  // z spans 1 of a pitch of 2 → 180 deg of sweep → 180/5 = 36 segments, 37 points.
  expect(SCREW_STEP_DEG).toBe(5);
  expect(screwCrossSection([[5, 0], [5, 1]], 2)).toHaveLength(37);
});

test("right-hand maps +z to NEGATIVE polar angle", () => {
  // z = 0.5 of pitch 2 → psi = -360 * 0.5/2 = -90 deg → [0, -5].
  const out = screwCrossSection([[5, 0], [5, 0.5]], 2);
  const [x, y] = out[out.length - 1];
  expect(x).toBeCloseTo(0, 6);
  expect(y).toBeCloseTo(-5, 6);
});

test("lefthand mirrors the polar angle", () => {
  const out = screwCrossSection([[5, 0], [5, 0.5]], 2, { lefthand: true });
  const [x, y] = out[out.length - 1];
  expect(x).toBeCloseTo(0, 6);
  expect(y).toBeCloseTo(5, 6);
});

test("a full-pitch profile is periodic: the wrap point is dropped", () => {
  // 360 deg of sweep at 5 deg = 72 points; the 73rd would land on the 1st.
  const out = screwCrossSection([[5, 0], [5, 2]], 2);
  expect(out).toHaveLength(72);
  expect(out[0][0]).toBeCloseTo(5, 6);
});

test("rejects a profile taller than the pitch", () => {
  expect(() => screwCrossSection([[4, 0], [6, 0], [6, 2.5], [4, 2.5]], 1.5))
    .toThrow(/exceeds pitch/);
});

test("rejects a full-pitch profile that is not periodic", () => {
  expect(() => screwCrossSection([[5, 0], [6, 0], [4, 2]], 2))
    .toThrow(/must be periodic/);
});

test("rejects a negative radius, matching revolve's rule", () => {
  expect(() => screwCrossSection([[-1, 0], [5, 0], [5, 0.5]], 2))
    .toThrow("screwSweep: profile radius must be ≥ 0");
});

test("rejects a non-positive pitch and a too-short profile", () => {
  expect(() => screwCrossSection([[5, 0], [5, 1]], 0)).toThrow(/pitch must be > 0/);
  expect(() => screwCrossSection([[5, 0]], 2)).toThrow(/at least 2/);
});
