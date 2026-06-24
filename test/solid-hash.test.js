// test/solid-hash.test.js
import { expect, test } from "vitest";
import { h } from "../src/framework/geometry/solid-hash.js";

test("same inputs hash equal, different inputs hash differently", () => {
  expect(h("cylinder", 5, 5, 20)).toBe(h("cylinder", 5, 5, 20));
  expect(h("cylinder", 5, 5, 20)).not.toBe(h("cylinder", 5, 5, 21));
});

test("composes from operand hashes (order of args matters)", () => {
  const a = h("cylinder", 5, 5, 20);
  const b = h("cylinder", 2, 2, 30);
  expect(h("cut", a, b)).not.toBe(h("cut", b, a));
  expect(h("cut", a, b)).toBe(h("cut", a, b));
});

test("canonicalizes arrays and option objects (key order independent)", () => {
  expect(h("box", [0, 0, 0], [1, 2, 3])).toBe(h("box", [0, 0, 0], [1, 2, 3]));
  expect(h("p", { center: true, twist: 0 })).toBe(h("p", { twist: 0, center: true }));
  expect(h("p", { center: true })).not.toBe(h("p", { center: false }));
});

test("returns a short string", () => {
  expect(typeof h("cylinder", 5, 5, 20)).toBe("string");
  expect(h("cylinder", 5, 5, 20).length).toBeLessThanOrEqual(8);
});
