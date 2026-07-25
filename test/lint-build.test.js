// Group 3 — kernel API usage, via the validating probe. Every error here already
// fails at runtime today; the linter just reaches it before a WASM boot.
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const partWith = (build, extra = {}) => ({
  meta: { title: "T" },
  defaults: {},
  parts: { body: { views: ["main"], build } },
  views: { main: { label: "Main" } },
  ...extra,
});

const ids = (findings) => findings.map((f) => f.rule);
const find = (r, rule) => [...r.errors, ...r.warnings].find((f) => f.rule === rule);

test("a valid build produces no build findings", () => {
  const r = lintPart(partWith((k) => k.cylinder({ r: 5, h: 10 })));
  expect(ids(r.errors)).toEqual([]);
});

test("an unknown kernel op is an error", () => {
  const r = lintPart(partWith((k) => k.cylindre({ r: 5, h: 10 })));
  expect(ids(r.errors)).toContain("unknown-kernel-op");
  expect(find(r, "unknown-kernel-op").message).toContain("cylindre");
});

test("an unknown solid op is an error", () => {
  const r = lintPart(partWith((k) => k.cylinder({ r: 5, h: 10 }).tranlsate([1, 0, 0])));
  expect(ids(r.errors)).toContain("unknown-solid-op");
});

test("an unknown option key is an error carrying the did-you-mean text", () => {
  const r = lintPart(partWith((k) => k.cylinder({ radius: 5, h: 10 })));
  expect(ids(r.errors)).toContain("invalid-op-options");
  expect(find(r, "invalid-op-options").message).toMatch(/did you mean r\?/);
});

test("a missing required option is an error", () => {
  const r = lintPart(partWith((k) => k.cylinder({ r: 5 })));
  expect(find(r, "invalid-op-options").message).toMatch(/h is required/);
});

test("a throwing build is an error naming the sub-part", () => {
  const r = lintPart(partWith(() => { throw new Error("bad maths"); }));
  expect(ids(r.errors)).toContain("build-throws");
  expect(find(r, "build-throws").message).toContain("bad maths");
  expect(find(r, "build-throws").path).toBe("parts.body.build");
});

test("an OCCT-only op with meta.backend manifold is an error", () => {
  const r = lintPart(partWith((k) => k.box({ size: [1, 1, 1] }).fillet({ r: 1 }),
    { meta: { title: "T", backend: "manifold" } }));
  expect(ids(r.errors)).toContain("manifold-backend-uses-occt-op");
  expect(find(r, "manifold-backend-uses-occt-op").message).toContain("fillet");
});

test("an OCCT-only op without a pinned backend is fine — routing handles it", () => {
  const r = lintPart(partWith((k) => k.box({ size: [1, 1, 1] }).fillet({ r: 1 })));
  expect(ids(r.errors)).not.toContain("manifold-backend-uses-occt-op");
});

test("a runaway build is an error, not a hang", () => {
  const r = lintPart(partWith((k) => { for (;;) k.box({ size: [1, 1, 1] }); }));
  expect(ids(r.errors)).toContain("build-runaway");
});

test("an impure build is a warning citing the error pattern", () => {
  const r = lintPart(partWith((k) => k.cylinder({ r: Math.random() * 5 + 1, h: 10 })));
  expect(ids(r.warnings)).toContain("nondeterministic-build");
  expect(find(r, "nondeterministic-build").pattern).toBe("impure-build-stale-preview");
});

test("a pure build is not flagged as nondeterministic", () => {
  const r = lintPart(partWith((k, p) => k.cylinder({ r: p.r ?? 5, h: 10 })));
  expect(ids(r.warnings)).not.toContain("nondeterministic-build");
});

test("params override defaults for the probe pass", () => {
  // r: 0 is invalid geometry but a legal option value; what we assert is that the
  // override reaches build(), by making the build throw only for the injected value.
  const part = partWith((k, p) => {
    if (p.mode === "explode") throw new Error("exploded");
    return k.box({ size: [1, 1, 1] });
  });
  part.defaults = { mode: "ok" };
  expect(ids(lintPart(part).errors)).not.toContain("build-throws");
  expect(ids(lintPart(part, { params: { mode: "explode" } }).errors)).toContain("build-throws");
});
