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
const withArt = (build) => partWith(build, { svgs: { badge: new URL("file:///badge.svg.json") } });

test("a k.svg2d call naming an undeclared svg is an error", () => {
  const r = lintPart(withArt((k) => k.svg2d("logo", { width: 10 }).extrude(1)));
  expect(ids(r.errors)).toContain("svg-unknown-name");
  expect(find(r, "svg-unknown-name").message).toContain("logo");
  expect(find(r, "svg-unknown-name").message).toContain("badge");
});

test("a part with no svgs field at all still reports the unknown name", () => {
  expect(ids(lintPart(partWith((k) => k.svg2d("logo", { width: 10 }).extrude(1))).errors))
    .toContain("svg-unknown-name");
});

test("a declared name is clean", () => {
  expect(ids(lintPart(withArt((k) => k.svg2d("badge", { width: 10 }).extrude(1))).errors))
    .not.toContain("svg-unknown-name");
});

test("a non-literal name is skipped rather than guessed at", () => {
  const part = partWith((k, p) => k.svg2d(p.which, { width: 10 }).extrude(1),
    { svgs: { badge: new URL("file:///badge.svg.json") }, defaults: { which: "badge" } });
  expect(ids(lintPart(part).errors)).not.toContain("svg-unknown-name");
});

test("the same unknown name is reported once, not per call", () => {
  const r = lintPart(partWith((k) => k.svg2d("logo", { width: 10 }).extrude(1)
    .union(k.svg2d("logo", { width: 5 }).extrude(1))));
  expect(ids(r.errors).filter((i) => i === "svg-unknown-name")).toHaveLength(1);
});

test("a k.svg2d call with no options object is an error naming the three options", () => {
  const r = lintPart(withArt((k) => k.svg2d("badge").extrude(1)));
  expect(ids(r.errors)).toContain("svg-size-missing");
  expect(find(r, "svg-size-missing").message).toMatch(/width|height|fit/);
});

test("an options literal with none of width/height/fit is an error", () => {
  expect(ids(lintPart(withArt((k) => k.svg2d("badge", { align: "left" }).extrude(1))).errors))
    .toContain("svg-size-missing");
});

test("each of width, height and fit clears the rule", () => {
  for (const opt of ["{ width: 10 }", "{ height: 10 }", "{ fit: 10 }"]) {
    const build = new Function("k", `return k.svg2d("badge", ${opt}).extrude(1)`);
    expect(ids(lintPart(withArt(build)).errors)).not.toContain("svg-size-missing");
  }
});

test("a non-literal options argument is skipped", () => {
  const part = partWith((k, p) => k.svg2d("badge", p.opts).extrude(1),
    { svgs: { badge: new URL("file:///badge.svg.json") }, defaults: { opts: { width: 10 } } });
  expect(ids(lintPart(part).errors)).not.toContain("svg-size-missing");
});
