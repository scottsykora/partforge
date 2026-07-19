import { expect, test } from "vitest";
import { h } from "../src/framework/geometry/solid-hash.js";

test("Shape2D op hashes are operand-sensitive and stable", () => {
  const a = "aaa", b = "bbb", c = "ccc";
  expect(h("union2d", a, b)).toBe(h("union2d", a, b));       // stable
  expect(h("union2d", a, b)).not.toBe(h("union2d", a, c));   // operand-sensitive
  expect(h("cut2d", a, b)).not.toBe(h("union2d", a, b));     // op-sensitive
});

test("Hash composition folds multiple operations", () => {
  const a = "aaa", b = "bbb", c = "ccc";
  const h1 = h("union2d", h("cut2d", a, b), c);
  const h2 = h("union2d", h("cut2d", a, b), c);
  expect(h1).toBe(h2);  // composed hashes are stable
});

test("Object and array args hash canonically", () => {
  // Scalars and structures hash to the same key regardless of argument order for the canon function
  const h1 = h("shape2d", { outer: "pts", holes: "none" });
  const h2 = h("shape2d", { holes: "none", outer: "pts" });
  expect(h1).toBe(h2);  // keys sorted alphabetically before hashing
});
