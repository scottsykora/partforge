import { expect, test } from "vitest";
import { SMOOTH, FACETED, SMOOTH_SIDES_MIN, cosDeg, loftShadingPolicy } from "../src/framework/geometry/shading-policy.js";

test("policies carry the spec'd angles and line gating", () => {
  expect(SMOOTH).toEqual({ creaseAngle: 35, sameSurfaceLines: true });
  expect(FACETED).toEqual({ creaseAngle: 10, sameSurfaceLines: false });
  expect(Object.isFrozen(SMOOTH)).toBe(true);
  expect(Object.isFrozen(FACETED)).toBe(true);
});

test("cosDeg converts degrees to a cosine", () => {
  expect(cosDeg(0)).toBeCloseTo(1, 10);
  expect(cosDeg(60)).toBeCloseTo(0.5, 10);
});

test("explicit shading hint wins in both directions", () => {
  const rings = [{ sides: 12, radius: 20, z: 0 }, { sides: 12, radius: 20, z: 10 }];
  expect(loftShadingPolicy(rings, { shading: "smooth" })).toBe(SMOOTH);
  expect(loftShadingPolicy(rings, { shading: "faceted" })).toBe(FACETED);
  const many = [{ sides: 64, radius: 20, z: 0 }, { sides: 64, radius: 20, z: 10 }];
  expect(loftShadingPolicy(many, { shading: "faceted" })).toBe(FACETED);
});

test("an invalid shading value throws a loud, specific error", () => {
  const rings = [{ sides: 12, radius: 20, z: 0 }, { sides: 12, radius: 20, z: 10 }];
  expect(() => loftShadingPolicy(rings, { shading: "flat" })).toThrow('loft: shading must be "smooth" | "faceted"');
});

test("ruled:false (OCCT smooth blend) implies smooth shading intent", () => {
  const rings = [{ sides: 6, radius: 20, z: 0 }, { sides: 6, radius: 20, z: 10 }];
  expect(loftShadingPolicy(rings, { ruled: false })).toBe(SMOOTH);
});

test("inference: low side counts are facets, high counts approximate smooth", () => {
  const few = [{ sides: 12, radius: 20, z: 0 }, { sides: 12, radius: 20, z: 10 }];
  expect(loftShadingPolicy(few, {})).toBe(FACETED);
  const many = [{ sides: SMOOTH_SIDES_MIN, radius: 20, z: 0 }, { sides: SMOOTH_SIDES_MIN, radius: 20, z: 10 }];
  expect(loftShadingPolicy(many, {})).toBe(SMOOTH);
  expect(loftShadingPolicy(undefined, undefined)).toBe(FACETED); // malformed input: safe default, no throw
});

test("inference reads explicit polygon rings by point count", () => {
  const poly = (n) => Array.from({ length: n }, (_, i) => [Math.cos((i / n) * 2 * Math.PI), Math.sin((i / n) * 2 * Math.PI)]);
  expect(loftShadingPolicy([{ polygon: poly(8), z: 0 }, { polygon: poly(8), z: 5 }], {})).toBe(FACETED);
  expect(loftShadingPolicy([{ polygon: poly(48), z: 0 }, { polygon: poly(48), z: 5 }], {})).toBe(SMOOTH);
});
