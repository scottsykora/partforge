import { describe, expect, it, test } from "vitest";
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
// vector-size-missing only fires for "artwork" units (units are unknown without
// vectorDocs, so it stays silent by default) — the pre-existing size tests below
// need to supply a document to exercise it.
const ARTWORK_DOCS = { vectorDocs: { badge: { format: "partforge-vector", version: 1, units: "artwork", shapes: {} } } };

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

test("a k.vector2d call with no options object is an error naming the three options, for artwork units", () => {
  const r = lintPart(withArt((k) => k.vector2d("badge").extrude(1)), ARTWORK_DOCS);
  expect(ids(r.errors)).toContain("vector-size-missing");
  expect(find(r, "vector-size-missing").message).toMatch(/width|height|fit/);
});

test("an options literal with none of width/height/fit is an error, for artwork units", () => {
  expect(ids(lintPart(withArt((k) => k.vector2d("badge", { align: "left" }).extrude(1)), ARTWORK_DOCS).errors))
    .toContain("vector-size-missing");
});

test("each of width, height and fit clears the rule", () => {
  for (const opt of ["{ width: 10 }", "{ height: 10 }", "{ fit: 10 }"]) {
    const build = new Function("k", `return k.vector2d("badge", ${opt}).extrude(1)`);
    expect(ids(lintPart(withArt(build), ARTWORK_DOCS).errors)).not.toContain("vector-size-missing");
  }
});

// Same story as the name case above: an options argument passed by reference
// is judged by what it resolves to under the part's default params, not
// skipped outright — flagged here because the resolved default has none of
// width/height/fit.
test("an options argument computed from a param is judged by its resolved default value", () => {
  const part = partWith((k, p) => k.vector2d("badge", p.opts).extrude(1),
    { vectors: { badge: new URL("file:///badge.svg.json") }, defaults: { opts: { align: "left" } } });
  expect(ids(lintPart(part, ARTWORK_DOCS).errors)).toContain("vector-size-missing");
});

test("vector-size-missing stays silent for mm units, even with none of width/height/fit", () => {
  const mmDocs = { vectorDocs: { badge: { format: "partforge-vector", version: 1, units: "mm", shapes: {} } } };
  expect(ids(lintPart(withArt((k) => k.vector2d("badge").extrude(1)), mmDocs).errors))
    .not.toContain("vector-size-missing");
});

// Findings key off `rule` (finding.js's `make`), not `id` — the field the
// brief's own draft used before it was reconciled against the actual shape.
const DOC = (units, shapes) => ({ format: "partforge-vector", version: 1, units, shapes });
const partWithDoc = (buildFn) => ({
  meta: { title: "T" },
  vectors: { plate: new Uint8Array() },
  defaults: {},
  parts: { body: { views: ["main"], build: buildFn } },
  views: { main: { label: "Main" } },
});

describe("vector lint rules needing vectorDocs", () => {
  it("vector-unknown-name fires without vectorDocs", () => {
    const r = lintPart(partWithDoc((k) => k.vector2d("nope", { width: 10 }).extrude(1)));
    expect(r.errors.map((e) => e.rule)).toContain("vector-unknown-name");
  });

  it("vector-size-missing needs vectorDocs and fires only for artwork units", () => {
    const build = (k) => k.vector2d("plate").extrude(1);
    // No documents supplied → the rule cannot know the units, so it stays quiet.
    expect(lintPart(partWithDoc(build)).errors.map((e) => e.rule)).not.toContain("vector-size-missing");
    // mm → a size is genuinely optional.
    expect(lintPart(partWithDoc(build), { vectorDocs: { plate: DOC("mm", { s: [] }) } })
      .errors.map((e) => e.rule)).not.toContain("vector-size-missing");
    // artwork → a size is required.
    expect(lintPart(partWithDoc(build), { vectorDocs: { plate: DOC("artwork", { artwork: [] }) } })
      .errors.map((e) => e.rule)).toContain("vector-size-missing");
  });

  it("vector-unknown-shape names the shapes the file declares", () => {
    const build = (k) => k.vector2d("plate", { shape: "rim" }).extrude(1);
    const r = lintPart(partWithDoc(build), { vectorDocs: { plate: DOC("mm", { body: [], holes: [] }) } });
    const f = r.errors.find((e) => e.rule === "vector-unknown-shape");
    expect(f.message).toMatch(/body, holes/);
  });

  it("survives a malformed vectorDocs without throwing", () => {
    const build = (k) => k.vector2d("plate", { shape: "rim" }).extrude(1);
    for (const bad of [null, 42, "x", { plate: null }, { plate: "not a doc" }]) {
      expect(() => lintPart(partWithDoc(build), { vectorDocs: bad })).not.toThrow();
    }
  });
});
