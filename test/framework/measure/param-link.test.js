// Heuristic dimension->param linking: read-keys ∩ value match, unique or null.
import { expect, test } from "vitest";
import { linkParam } from "../../../src/framework/measure/param-link.js";

const params = { bore_d: 8, height: 30, wall: 2.5, slots: 4 };

test("unique value match links", () => {
  expect(linkParam(["bore_d", "wall"], params, { diameter: 8, depth: 12 })).toBe("bore_d");
});

test("radius-style param matches a measured diameter at value/2", () => {
  expect(linkParam(["wall"], { wall: 4 }, { diameter: 8 })).toBe("wall");
});

test("ambiguous match -> null (never guess)", () => {
  expect(linkParam(["a", "b"], { a: 8, b: 8 }, { diameter: 8 })).toBeNull();
});

test("no candidates or no match -> null", () => {
  expect(linkParam([], params, { diameter: 8 })).toBeNull();
  expect(linkParam(["height"], params, { diameter: 8.2 })).toBeNull();
});

test("matches within the 0.01 quantum only", () => {
  expect(linkParam(["wall"], { wall: 2.5 }, { width: 2.504 })).toBe("wall");
  expect(linkParam(["wall"], { wall: 2.5 }, { width: 2.52 })).toBeNull();
});

test("non-numeric params and the partial flag are ignored", () => {
  expect(linkParam(["style"], { style: "hex" }, { diameter: 8, partial: false })).toBeNull();
});
