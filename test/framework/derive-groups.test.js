import { expect, test } from "vitest";
import { resolveDerived } from "../../src/framework/derive.js";
import { relevantParamKeys, subPartReadKeys, RELEVANT_ALL } from "../../src/framework/param-deps.js";
import { resolveParams } from "../../src/framework/jobs.js";
import { detectBackend } from "../../src/framework/geometry/probe.js";

// A part with a grouped derive: two independent groups plus one chained off the
// first. `usesCore` touches only the core group; `usesChained` pulls in the
// chained group (and, through it, core's inputs). Nothing reads `other`, so its
// input `c` must never count as relevant.
const grouped = () => ({
  defaults: { a: 2, b: 3, c: 4 },
  views: { v: { label: "V" } },
  derive: {
    core: (p) => ({ w: p.a + 1 }),
    chained: (p, d) => ({ h: d.w * p.b }),
    other: (p) => ({ z: p.c * 2 }),
  },
  parts: {
    usesCore: { views: ["v"], build: (k, p, d) => k.cylinder(d.w, d.w, 10) },
    usesChained: { views: ["v"], build: (k, p, d) => k.box(d.h, 1, 1) },
  },
});

test("resolveDerived: function form and missing derive behave as before", () => {
  expect(resolveDerived({ derive: (p) => ({ s: p.a * 2 }) }, { a: 3 })).toEqual({ s: 6 });
  expect(resolveDerived({}, { a: 3 })).toEqual({});
});

test("resolveDerived: groups merge in order and later groups see earlier outputs", () => {
  const part = grouped();
  expect(resolveDerived(part, part.defaults)).toEqual({ w: 3, h: 9, z: 8 });
});

test("resolveParams resolves a grouped derive", () => {
  const part = grouped();
  const { p, d } = resolveParams(part, { a: 4 });
  expect(p.a).toBe(4);
  expect(d).toEqual({ w: 5, h: 15, z: 8 });
});

test("grouped derive: params feeding only unread groups are not relevant", () => {
  const part = grouped();
  expect([...relevantParamKeys(part, "v", part.defaults)].sort()).toEqual(["a", "b"]);
});

test("grouped derive: per-sub-part reads follow each group's own inputs", () => {
  const part = grouped();
  const map = subPartReadKeys(part, "v", part.defaults);
  expect(map).not.toBe(RELEVANT_ALL);
  expect([...map.get("usesCore")].sort()).toEqual(["a"]);
  expect([...map.get("usesChained")].sort()).toEqual(["a", "b"]); // chain: h ← w ← a
});

test("grouped derive: reading a derived key no group produced falls back to all derive inputs", () => {
  const part = grouped();
  part.parts.usesCore.build = (k, p, d) => k.cylinder(d.nope ?? 1, 1, 10);
  const map = subPartReadKeys(part, "v", part.defaults);
  expect([...map.get("usesCore")].sort()).toEqual(["a", "b", "c"]);
});

test("detectBackend handles a grouped derive", () => {
  const part = grouped();
  expect(detectBackend(part)).toBe("manifold");
  part.parts.usesCore.build = (k, p, d) => k.box(d.w, 1, 1).fillet(0.5);
  expect(detectBackend(part)).toBe("occt");
});
