import { expect, test } from "vitest";
import { resolveProfile, PROFILES } from "../src/testing/dfm-profiles.js";

test("resolves a built-in profile by name", () => {
  expect(resolveProfile("fdm-pla")).toEqual({ bed: [220, 220, 250], minWall: 1.2, clearance: 0.2 });
  expect(Object.keys(PROFILES)).toContain("resin");
});

test("accepts an inline profile object", () => {
  expect(resolveProfile({ bed: [100, 100, 100], minWall: 1 })).toEqual({ bed: [100, 100, 100], minWall: 1 });
});

test("merges overrides onto a named base", () => {
  expect(resolveProfile({ base: "fdm-pla", minWall: 2 })).toEqual({ bed: [220, 220, 250], minWall: 2, clearance: 0.2 });
});

test("throws on an unknown profile name", () => {
  expect(() => resolveProfile("fdm-unobtainium")).toThrow();
  expect(() => resolveProfile(42)).toThrow();
});
