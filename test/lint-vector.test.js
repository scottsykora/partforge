import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const ids = (findings) => findings.map((f) => f.rule);
const find = (r, rule) => [...r.errors, ...r.warnings].find((f) => f.rule === rule);
const partWith = (build, extra = {}) => ({
  meta: { title: "T" },
  defaults: {},
  parts: { body: { views: ["main"], build } },
  views: { main: { label: "Main" } },
  ...extra,
});
const withArt = (build) => partWith(build, { vectors: { badge: new URL("file:///badge.svg.json") } });

test("a k.vector2d call naming an undeclared vector is an error", () => {
  const r = lintPart(withArt((k) => k.vector2d("logo", { width: 10 }).extrude(1)));
  expect(ids(r.errors)).toContain("vector-unknown-name");
  expect(find(r, "vector-unknown-name").message).toContain("logo");
  expect(find(r, "vector-unknown-name").message).toContain("badge");
});

test("a part with no vectors field at all still reports the unknown name", () => {
  expect(ids(lintPart(partWith((k) => k.vector2d("logo", { width: 10 }).extrude(1))).errors))
    .toContain("vector-unknown-name");
});

test("a declared name is clean", () => {
  expect(ids(lintPart(withArt((k) => k.vector2d("badge", { width: 10 }).extrude(1))).errors))
    .not.toContain("vector-unknown-name");
});

// A name computed from a param is not skipped outright: probe().calls carries
// the RESOLVED value under the part's default params (see rules-vector.js's file
// header), so this is judged exactly like a literal that happens to equal the
// same string — flagged here because "typo" isn't a declared name under the
// defaults actually in force. A param value that only goes wrong for some
// OTHER param setting is invisible to lint and still fails correctly at build
// time; that's a real gap, just not one this call demonstrates.
test("a name computed from a param is judged by its resolved default value", () => {
  const part = partWith((k, p) => k.vector2d(p.which, { width: 10 }).extrude(1),
    { vectors: { badge: new URL("file:///badge.svg.json") }, defaults: { which: "typo" } });
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("vector-unknown-name");
  expect(find(r, "vector-unknown-name").message).toContain("typo");
});

test("the same unknown name is reported once, not per call", () => {
  const r = lintPart(partWith((k) => k.vector2d("logo", { width: 10 }).extrude(1)
    .union(k.vector2d("logo", { width: 5 }).extrude(1))));
  expect(ids(r.errors).filter((i) => i === "vector-unknown-name")).toHaveLength(1);
});

test("a k.vector2d call with no options object is an error naming the three options", () => {
  const r = lintPart(withArt((k) => k.vector2d("badge").extrude(1)));
  expect(ids(r.errors)).toContain("vector-size-missing");
  expect(find(r, "vector-size-missing").message).toMatch(/width|height|fit/);
});

test("an options literal with none of width/height/fit is an error", () => {
  expect(ids(lintPart(withArt((k) => k.vector2d("badge", { align: "left" }).extrude(1))).errors))
    .toContain("vector-size-missing");
});

test("each of width, height and fit clears the rule", () => {
  for (const opt of ["{ width: 10 }", "{ height: 10 }", "{ fit: 10 }"]) {
    const build = new Function("k", `return k.vector2d("badge", ${opt}).extrude(1)`);
    expect(ids(lintPart(withArt(build)).errors)).not.toContain("vector-size-missing");
  }
});

// Same story as the name case above: an options argument passed by reference
// is judged by what it resolves to under the part's default params, not
// skipped outright — flagged here because the resolved default has none of
// width/height/fit.
test("an options argument computed from a param is judged by its resolved default value", () => {
  const part = partWith((k, p) => k.vector2d("badge", p.opts).extrude(1),
    { vectors: { badge: new URL("file:///badge.svg.json") }, defaults: { opts: { align: "left" } } });
  expect(ids(lintPart(part).errors)).toContain("vector-size-missing");
});
