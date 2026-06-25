// test/param-deps-subpart.test.js
import { expect, test } from "vitest";
import { subPartReadKeys, relevanceHash, RELEVANT_ALL } from "../src/framework/param-deps.js";

const view = { v: { label: "V" } };
const part = {
  defaults: { a: 1, b: 2 }, views: view,
  parts: {
    one: { views: ["v"], build: (k, p) => k.cylinder(p.a, p.a, p.a) },   // reads a only
    two: { views: ["v"], build: (k, p) => k.box([0, 0, 0], [p.b, p.b, p.b]) }, // reads b only
  },
};

test("each sub-part's read set contains only the params it reads", () => {
  const map = subPartReadKeys(part, "v", part.defaults);
  expect([...map.get("one")]).toEqual(["a"]);
  expect([...map.get("two")]).toEqual(["b"]);
});

test("relevanceHash is stable for equal values and differs when a value changes", () => {
  expect(relevanceHash(["a"], { a: 1, b: 2 })).toBe(relevanceHash(["a"], { a: 1, b: 9 }));
  expect(relevanceHash(["a"], { a: 1 })).not.toBe(relevanceHash(["a"], { a: 2 }));
});

test("an unanalyzable build yields RELEVANT_ALL (safe fallback)", () => {
  const bad = { defaults: {}, views: view, parts: { x: { views: ["v"], build: () => { throw new Error("nope"); } } } };
  expect(subPartReadKeys(bad, "v", {})).toBe(RELEVANT_ALL);
});
