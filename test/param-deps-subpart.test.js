// test/param-deps-subpart.test.js
import { expect, test } from "vitest";
import { subPartReadKeys, relevantParamKeys, relevanceHash, RELEVANT_ALL } from "../src/framework/param-deps.js";

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

// Regression: the probe kernel must implement the full solid build-step vocabulary
// (at / along / rotateX|Y|Z / rotateAbout). If it doesn't, a build using any of them
// throws inside relevantParamKeys, which silently falls back to RELEVANT_ALL — so the
// panel stops dimming/hiding controls. Every real part uses .at(), so this guards them.
const vocab = {
  defaults: { a: 1, b: 2 }, views: view,
  parts: {
    p: { views: ["v"], build: (k, p) =>
      k.cylinder(p.a, p.a, p.a)
        .at([0, 0, 0]).along("+Z").rotateX(0).rotateY(0).rotateZ(0).rotateAbout({ axis: "Z", deg: p.a }) },
  },
};

test("relevance analysis handles the build-step vocabulary instead of falling back to RELEVANT_ALL", () => {
  const r = relevantParamKeys(vocab, "v", vocab.defaults);
  expect(r).not.toBe(RELEVANT_ALL);   // probe must not throw on at/along/rotate*
  expect([...r]).toContain("a");      // read by cylinder + rotateAbout
  expect([...r]).not.toContain("b");  // never read → stays irrelevant (the whole point)
});

test("relevanceHash is stable for equal values and differs when a value changes", () => {
  expect(relevanceHash(["a"], { a: 1, b: 2 })).toBe(relevanceHash(["a"], { a: 1, b: 9 }));
  expect(relevanceHash(["a"], { a: 1 })).not.toBe(relevanceHash(["a"], { a: 2 }));
});

test("an unanalyzable build yields RELEVANT_ALL (safe fallback)", () => {
  const bad = { defaults: {}, views: view, parts: { x: { views: ["v"], build: () => { throw new Error("nope"); } } } };
  expect(subPartReadKeys(bad, "v", {})).toBe(RELEVANT_ALL);
});
