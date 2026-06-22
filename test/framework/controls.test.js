import { expect, test } from "vitest";
import { clampToRange } from "../../src/framework/controls.js";

// The value-commit logic for the editable number boxes (DOM wiring is browser-only).
test("clampToRange clamps a typed value into [min, max], allowing exact (non-step) values", () => {
  expect(clampToRange("12", 0, 40)).toBe(12);
  expect(clampToRange("100", 0, 40)).toBe(40);     // above max → max
  expect(clampToRange("-5", 0, 40)).toBe(0);       // below min → min
  expect(clampToRange("3.456", 0, 40)).toBe(3.456); // exact, no step snapping
});

test("clampToRange returns null for non-numeric input", () => {
  expect(clampToRange("", 0, 40)).toBeNull();
  expect(clampToRange("abc", 0, 40)).toBeNull();
});
