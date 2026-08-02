// Group 1 — definition shape and view wiring. These rules replace the hand-rolled
// validate() in partforge-cloud's sandbox loader, which checks meta.title/defaults/
// build but NOT views, and had already drifted from the eval runner's separate check.
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

// A minimal well-formed part. Each test clones and breaks exactly one thing, so a
// finding can only come from the mutation under test.
const goodPart = () => ({
  meta: { title: "Test", units: "mm" },
  defaults: { h: 10 },
  parts: { body: { label: "Body", views: ["main"], build: (k, p) => k.box({ size: [p.h, p.h, p.h] }) } },
  views: { main: { label: "Main" } },
});

const ids = (findings) => findings.map((f) => f.rule);

test("a well-formed part produces no shape findings", () => {
  const r = lintPart(goodPart());
  expect(ids(r.errors)).toEqual([]);
  expect(r.ok).toBe(true);
});

test("missing meta.title is an error", () => {
  const part = goodPart();
  delete part.meta.title;
  expect(ids(lintPart(part).errors)).toContain("missing-meta-title");
});

test("missing defaults is an error", () => {
  const part = goodPart();
  delete part.defaults;
  expect(ids(lintPart(part).errors)).toContain("missing-defaults");
});

test("a part entry whose build is not a function is an error", () => {
  const part = goodPart();
  part.parts.body.build = "not a function";
  expect(ids(lintPart(part).errors)).toContain("no-buildable-parts");
});

test("missing views map is an error", () => {
  const part = goodPart();
  delete part.views;
  expect(ids(lintPart(part).errors)).toContain("missing-views");
});

test("a subpart naming a view absent from the views map is an error", () => {
  const part = goodPart();
  part.parts.body.views = ["nope"];
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("part-view-unknown");
  expect(r.errors.find((f) => f.rule === "part-view-unknown").path).toBe("parts.body.views[0]");
});

test("a declared view no subpart renders into is a warning, not an error", () => {
  const part = goodPart();
  part.views.orphan = { label: "Orphan" };
  const r = lintPart(part);
  expect(ids(r.warnings)).toContain("view-unused");
  expect(ids(r.errors)).not.toContain("view-unused");
});

test("two views both flagged default is a warning naming the winner", () => {
  const part = goodPart();
  part.views.main.default = true;
  part.views.extra = { label: "Extra", default: true };
  part.parts.body.views = ["main", "extra"];
  const r = lintPart(part);
  expect(ids(r.warnings)).toContain("default-view-ambiguous");
  expect(ids(r.errors)).not.toContain("default-view-ambiguous");
  const f = r.warnings.find((w) => w.rule === "default-view-ambiguous");
  expect(f.hint).toContain('"main"');
  expect(f.path).toBe("views.extra.default");
});

test("a single default-flagged view is not a finding", () => {
  const part = goodPart();
  part.views.main.default = true;
  expect(ids(lintPart(part).warnings)).not.toContain("default-view-ambiguous");
});

test("every finding carries a rule, severity, message, hint and path", () => {
  const part = goodPart();
  delete part.meta.title;
  for (const f of [...lintPart(part).errors, ...lintPart(part).warnings]) {
    expect(typeof f.rule).toBe("string");
    expect(["error", "warning"]).toContain(f.severity);
    expect(typeof f.message).toBe("string");
    expect(f.hint.length, `${f.rule} has an empty hint`).toBeGreaterThan(0);
    expect(typeof f.path).toBe("string");
  }
});

test("lintPart never throws, even on garbage input", () => {
  for (const junk of [null, undefined, 42, "a string", [], {}]) {
    expect(() => lintPart(junk), `threw on ${JSON.stringify(junk)}`).not.toThrow();
  }
  expect(lintPart(null).ok).toBe(false);
});

// A downstream harness passing a literal `null` for opts (rather than omitting the
// second argument) must not throw destructuring `{ params }` out of it — see
// lintPart's own comment on why `opts` is defaulted inside the body.
test("lintPart(part, null) does not throw and behaves like the one-arg call", () => {
  const part = goodPart();
  expect(() => lintPart(part, null)).not.toThrow();
  expect(lintPart(part, null)).toEqual(lintPart(part));
});

// `lintPart(null)` has no `derive` at all — it shouldn't manufacture a `derive-throws`
// finding just because `part.derive` can't be read off a null part.
test("lintPart(null) reports no spurious derive-throws", () => {
  expect(lintPart(null).errors.map((f) => f.rule)).not.toContain("derive-throws");
  expect(lintPart(null).warnings.map((f) => f.rule)).not.toContain("derive-throws");
});

// A `defaults` getter that throws must not escape lintPart — it must degrade to a
// well-formed (non-ok) report instead.
test("a throwing defaults getter does not escape lintPart", () => {
  const part = goodPart();
  delete part.defaults;
  Object.defineProperty(part, "defaults", {
    get() { throw new Error("defaults boom"); },
    enumerable: true, configurable: true,
  });
  expect(() => lintPart(part)).not.toThrow();
  const r = lintPart(part);
  expect(r.ok).toBe(false);
  expect(ids(r.errors)).toContain("lint-context-error");
});

// A `defaults` Proxy whose `ownKeys` trap throws (spreading it to build `p` walks
// its own keys) must not escape lintPart either.
test("a defaults Proxy with a throwing ownKeys trap does not escape lintPart", () => {
  const part = goodPart();
  part.defaults = new Proxy({ h: 10 }, { ownKeys() { throw new Error("ownKeys boom"); } });
  expect(() => lintPart(part)).not.toThrow();
  const r = lintPart(part);
  expect(r.ok).toBe(false);
  expect(ids(r.errors)).toContain("lint-context-error");
});

// Same hostile-Proxy case, but on the `params` override passed at the call site.
test("a params Proxy with a throwing ownKeys trap does not escape lintPart", () => {
  const part = goodPart();
  const params = new Proxy({}, { ownKeys() { throw new Error("ownKeys boom"); } });
  expect(() => lintPart(part, { params })).not.toThrow();
  const r = lintPart(part, { params });
  expect(r.ok).toBe(false);
  expect(ids(r.errors)).toContain("lint-context-error");
});

test("a rule that throws degrades to an internal-rule-error warning", async () => {
  const { runRules } = await import("../src/framework/lint/index.js");
  const boom = { id: "boom", run() { throw new Error("kaboom"); } };
  const out = runRules([boom], { part: {}, p: {}, d: {} });
  expect(out).toHaveLength(1);
  expect(out[0].rule).toBe("internal-rule-error");
  expect(out[0].severity).toBe("warning");
  expect(out[0].message).toContain("boom");
  expect(out[0].message).toContain("kaboom");
});
