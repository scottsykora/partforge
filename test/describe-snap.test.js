import { expect, test } from "vitest";
import { snapValue, inferGrid, snapHoleDiameter } from "../src/framework/oracle/describe/snap.js";

test("a near-integer snaps to the integer and keeps its raw value", () => {
  const s = snapValue(11.9976);
  expect(s.to).toBe(12);
  expect(s.raw).toBe(11.9976);
});

test("a value that is genuinely 11.5 snaps to 11.5, not to 12", () => {
  expect(snapValue(11.4998).to).toBe(11.5);
});

test("a value far from any round number does not snap", () => {
  expect(snapValue(11.732)).toBeNull();
});

test("snapping is scale-aware: 0.4999 snaps to 0.5", () => {
  expect(snapValue(0.4999).to).toBe(0.5);
});

test("a hole diameter matching an M5 clearance is annotated", () => {
  const s = snapHoleDiameter(5.2996);
  expect(s.to).toBe(5.3);
  expect(s.note).toMatch(/M5/);
});

test("a hole diameter matching no standard fastener still snaps numerically", () => {
  const s = snapHoleDiameter(7.0004);
  expect(s.to).toBe(7);
  expect(s.note).toBeNull();
});

test("inferGrid finds a 5mm working grid", () => {
  const g = inferGrid([5, 10, 20, 35, 60]);
  expect(g.grid).toBe(5);
  expect(g.coverage).toBeCloseTo(1, 6);
});

test("inferGrid returns null when values share no grid", () => {
  expect(inferGrid([3.1, 7.7, 11.3])).toBeNull();
});
