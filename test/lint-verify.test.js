// Group 4 — the verify block. Each of these currently throws mid-run, after measure
// has already printed and the kernel has booted; lint reaches them before any of that.
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const partWith = (verify) => ({
  meta: { title: "T" },
  defaults: { h: 10 },
  parts: { body: { views: ["main"], build: (k, p) => k.box({ size: [p.h, p.h, p.h] }) } },
  views: { main: { label: "Main" } },
  verify,
});

const ids = (findings) => findings.map((f) => f.rule);
const find = (r, rule) => [...r.errors, ...r.warnings].find((f) => f.rule === rule);

test("a well-formed verify block produces no findings", () => {
  const r = lintPart(partWith({ process: "fdm-pla", expect: { body: { holes: 0, bbox: "<=[60,60,60]" }, _view: { overlaps: 0 } } }));
  expect(ids(r.errors)).toEqual([]);
});

test("a part with no verify block produces no findings", () => {
  const part = partWith(undefined);
  delete part.verify;
  expect(ids(lintPart(part).errors)).toEqual([]);
});

test("an unknown subpart metric is an error", () => {
  const r = lintPart(partWith({ expect: { body: { wallThickness: 2 } } }));
  expect(ids(r.errors)).toContain("verify-unknown-metric");
  expect(find(r, "verify-unknown-metric").path).toBe("verify.expect.body.wallThickness");
});

test("a subpart metric used under _view is an error", () => {
  // `holes` is subpart-scoped only; _view has its own smaller vocabulary.
  const r = lintPart(partWith({ expect: { _view: { holes: 1 } } }));
  expect(ids(r.errors)).toContain("verify-unknown-metric");
});

test("an unknown subpart name is an error", () => {
  const r = lintPart(partWith({ expect: { boddy: { holes: 0 } } }));
  expect(ids(r.errors)).toContain("verify-unknown-subpart");
  expect(find(r, "verify-unknown-subpart").hint).toMatch(/body/);
});

test("an unparseable assertion is an error", () => {
  const r = lintPart(partWith({ expect: { body: { volume: ">>> 5" } } }));
  expect(ids(r.errors)).toContain("verify-bad-expr");
});

test("an unknown process profile is an error", () => {
  const r = lintPart(partWith({ process: "fdm-unobtanium", expect: {} }));
  expect(ids(r.errors)).toContain("verify-unknown-process");
  expect(find(r, "verify-unknown-process").hint).toMatch(/fdm-pla/);
});

test("an inline process object is accepted", () => {
  const r = lintPart(partWith({ process: { bed: [200, 200, 200], minWall: 1.2 }, expect: {} }));
  expect(ids(r.errors)).not.toContain("verify-unknown-process");
});

test("the function form of expect is resolved and linted", () => {
  const r = lintPart(partWith({ expect: () => ({ body: { wallThickness: 2 } }) }));
  expect(ids(r.errors)).toContain("verify-unknown-metric");
});

test("a throwing expect function is an error", () => {
  const r = lintPart(partWith({ expect: () => { throw new Error("nope"); } }));
  expect(ids(r.errors)).toContain("verify-expect-throws");
  expect(find(r, "verify-expect-throws").message).toContain("nope");
});

test("the { expr, hint } expectation form is accepted", () => {
  const r = lintPart(partWith({ expect: { body: { volume: { expr: ">=100", hint: "keep it chunky" } } } }));
  expect(ids(r.errors)).toEqual([]);
});
