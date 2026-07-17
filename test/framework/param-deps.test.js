import { expect, test } from "vitest";
import { relevantParamKeys, RELEVANT_ALL } from "../../src/framework/param-deps.js";

// part: subpart 'a' always reads p.x and p.on; reads p.y only when on>0.
const conditional = () => ({
  defaults: { x: 5, y: 3, on: 0 },
  views: { v: { label: "V" } },
  parts: {
    a: { views: ["v"], build: (k, p) => {
      let s = k.cylinder({ r: p.x, h: 10 });
      if (p.on > 0) s = s.cut(k.cylinder({ r: p.y, h: 12 }));
      return s;
    } },
  },
});

test("conditional read: y is relevant only when the gate is on", () => {
  const part = conditional();
  expect([...relevantParamKeys(part, "v", { ...part.defaults, on: 0 })].sort()).toEqual(["on", "x"]);
  expect([...relevantParamKeys(part, "v", { ...part.defaults, on: 1 })].sort()).toEqual(["on", "x", "y"]);
});

test("derive inputs are included only when a visible sub-part reads a derived value", () => {
  const usesDerived = {
    defaults: { a: 1, b: 2, c: 9 },
    views: { v: { label: "V" } },
    derive: (p) => ({ sum: p.a + p.b }),                 // reads a, b
    parts: { d: { views: ["v"], build: (k, p, d) => k.cylinder({ r: d.sum, h: 10 }) } }, // reads d.sum
  };
  expect([...relevantParamKeys(usesDerived, "v", usesDerived.defaults)].sort()).toEqual(["a", "b"]);

  const ignoresDerived = {
    defaults: { a: 1, b: 2, c: 9 },
    views: { v: { label: "V" } },
    derive: (p) => ({ sum: p.a + p.b }),
    parts: { d: { views: ["v"], build: (k, p) => k.cylinder({ r: p.c, h: 10 }) } }, // reads p.c only, no d
  };
  expect([...relevantParamKeys(ignoresDerived, "v", ignoresDerived.defaults)].sort()).toEqual(["c"]);
});

test("a param used only in a sub-part's enabled() gate is relevant", () => {
  const part = {
    defaults: { capOn: 0, r: 4 },
    views: { v: { label: "V" } },
    parts: {
      base: { views: ["v"], build: (k, p) => k.cylinder({ r: p.r, h: 10 }) },
      cap: { views: ["v"], enabled: (p) => p.capOn > 0, build: (k) => k.sphere(2) },
    },
  };
  expect([...relevantParamKeys(part, "v", part.defaults)].sort()).toEqual(["capOn", "r"]);
});

test("a throwing build yields RELEVANT_ALL", () => {
  const part = {
    defaults: { x: 1 }, views: { v: { label: "V" } },
    parts: { bad: { views: ["v"], build: () => { throw new Error("boom"); } } },
  };
  expect(relevantParamKeys(part, "v", part.defaults)).toBe(RELEVANT_ALL);
});

test("probing does not mutate the passed params", () => {
  const part = conditional();
  const params = { ...part.defaults, on: 1 };
  const snap = { ...params };
  relevantParamKeys(part, "v", params);
  expect(params).toEqual(snap);
});
