// test/lint-place.test.js
// The two place() invariants, promoted from doc-only to lint: display
// placement must not read `view`, and display-vs-export must differ by a
// rigid motion only. Both are probe-based; untrusted probes stay silent.
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const mk = (place) => ({
  meta: { title: "T" },
  parameters: [],
  defaults: { a: 1 },
  parts: { p: { views: ["v", "w"], build: (k) => k.box({ size: [1, 1, 1] }), ...(place && { place }) } },
  views: { v: { label: "V" }, w: { label: "W" } },
});
const ids = (r) => r.errors.map((f) => f.rule);

test("clean part: no place findings", () => {
  expect(ids(lintPart(mk())).filter((i) => i.includes("place"))).toEqual([]);
  expect(ids(lintPart(mk((s) => s.translate([1, 0, 0])))).filter((i) => i.includes("place"))).toEqual([]);
});

test("display pose depending on view → view-dependent-display-place", () => {
  const r = lintPart(mk((s, { view }) => (view === "w" ? s.translate([5, 0, 0]) : s)));
  expect(ids(r)).toContain("view-dependent-display-place");
});

test("non-rigid display/export delta → place-not-rigid", () => {
  const r = lintPart(mk((s, { purpose }) => (purpose === "export" ? s.scale(2) : s)));
  expect(ids(r)).toContain("place-not-rigid");
});

test("a rigid display/export difference is allowed", () => {
  const r = lintPart(mk((s, { purpose }) => (purpose === "export" ? s.translate([10, 0, 0]) : s.rotate(30, [0, 0, 0], [1, 0, 0]))));
  expect(ids(r).filter((i) => i.includes("place"))).toEqual([]);
});

test("an untrusted probe (query in build) stays silent", () => {
  const part = mk((s) => s);
  part.parts.p.build = (k) => { const b = k.box({ size: [1, 1, 1] }); b.volume(); return b; };
  expect(ids(lintPart(part)).filter((i) => i.includes("place"))).toEqual([]);
});
