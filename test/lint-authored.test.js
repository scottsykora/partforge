// Group 2 (authored shape) — collectDescriptors' recursive walkAuthored, and
// collectPresetBundles for preset-key-not-in-defaults / default-not-exposed.
// Mirrors test/lint-schema.test.js's goodPart()/ids() recipe for the new
// controls[]-based authoring shape (author.js's normalized node tree).
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const ids = (findings) => findings.map((f) => f.rule);
const authoredPart = () => ({
  meta: { id: "t", title: "T" },
  defaults: { od: 5, wall: 1.6, show: 0 },
  parameters: [{ id: "body", title: "Body", controls: [
    { type: "preset", presets: { A: { od: 7 } } },
    { key: "od", type: "slider", label: "OD", unit: "mm", min: 1, max: 10, step: 1 },
    { key: "show", type: "checkbox", label: "Show" },
    { type: "group", title: "Wall", controls: [
      { key: "wall", type: "slider", label: "Wall", min: 0.8, max: 4, step: 0.1 },
    ] },
  ] }],
  parts: { main: { views: ["main"], build: (k, p) => k.box({ size: [p.od, p.od, p.od] }) } },
  views: { main: { label: "Main" } },
});

test("a clean authored part lints clean", () => {
  const r = lintPart(authoredPart());
  expect(r.errors).toEqual([]);
  expect(ids(r.warnings)).toEqual([]);
});

test("an authored control key missing from defaults errors with a controls[] path", () => {
  const part = authoredPart();
  part.parameters[0].controls[1].key = "odd";
  const r = lintPart(part);
  const f = r.errors.find((f) => f.rule === "control-key-not-in-defaults");
  expect(f.path).toBe("parameters[0].controls[1].key");
});

test("a nested control's path threads through the group", () => {
  const part = authoredPart();
  part.parameters[0].controls[3].controls[0].key = "wal";
  const f = lintPart(part).errors.find((f) => f.rule === "control-key-not-in-defaults");
  expect(f.path).toBe("parameters[0].controls[3].controls[0].key");
});

test("unknown fields warn on authored controls, groups, and presets", () => {
  const part = authoredPart();
  part.parameters[0].controls[1].lable = "typo";
  part.parameters[0].controls[3].titel = "typo";
  part.parameters[0].controls[0].presests = {};
  const rules = ids(lintPart(part).warnings).filter((r) => r === "unknown-control-field");
  expect(rules).toHaveLength(3);
});

test("when/whenFalse are accepted fields on authored controls but not legacy ones", () => {
  const part = authoredPart();
  part.parameters[0].controls[1].when = { show: { gt: 0 } };
  expect(ids(lintPart(part).warnings)).not.toContain("unknown-control-field");
  const legacy = authoredPart();
  legacy.parameters.push({ id: "l", advanced: [
    { key: "od", label: "OD", min: 1, max: 10, step: 1, when: { show: 1 } }] });
  expect(ids(lintPart(legacy).warnings)).toContain("unknown-control-field");
});

test("an authored preset bundle with an unknown key errors with its node path", () => {
  const part = authoredPart();
  part.parameters[0].controls[0].presets = { A: { odd: 7 } };
  const f = lintPart(part).errors.find((f) => f.rule === "preset-key-not-in-defaults");
  expect(f.path).toBe('parameters[0].controls[0].presets["A"].odd');
});

test("default-not-exposed counts authored controls and preset bundles as exposure", () => {
  const part = authoredPart();
  part.defaults.orphan = 1;
  expect(ids(lintPart(part).warnings)).toContain("default-not-exposed");
  part.parameters[0].controls.push({ key: "orphan", type: "slider", min: 0, max: 2, step: 1, hidden: true });
  expect(ids(lintPart(part).warnings)).not.toContain("default-not-exposed");
});

test("slider-range-excludes-default fires on authored controls too", () => {
  const part = authoredPart();
  part.defaults.od = 99;
  expect(ids(lintPart(part).warnings)).toContain("slider-range-excludes-default");
});

test("mixing controls with any legacy array in one section is an error", () => {
  for (const extra of [
    { advanced: [{ key: "od", min: 1, max: 10, step: 1 }] },
    { toggles: [{ key: "show" }] },
    { features: [{ key: "show", on: 1, sliders: [] }] },
    { presets: { P: {} } },
  ]) {
    const part = authoredPart();
    Object.assign(part.parameters[0], extra);
    const f = lintPart(part).errors.find((f) => f.rule === "mixed-section-shape");
    expect(f, JSON.stringify(extra)).toBeTruthy();
    expect(f.path).toBe("parameters[0]");
  }
});

test("the same preset name twice in one part is an error, before verify would throw", () => {
  const part = authoredPart();
  part.parameters.push({ id: "more", controls: [
    { type: "preset", presets: { A: { wall: 2 } } },   // "A" already exists in section 0
  ] });
  const f = lintPart(part).errors.find((f) => f.rule === "duplicate-preset-name");
  expect(f).toBeTruthy();
  expect(f.path).toBe('parameters[1].controls[0].presets');
});

test("two nodes resolving to the same id is an error", () => {
  const part = authoredPart();
  part.parameters[0].controls[3].id = "body";      // collides with the section id
  const f = lintPart(part).errors.find((f) => f.rule === "duplicate-node-id");
  expect(f).toBeTruthy();
});

test("duplicate-node-id points at the true section index even when an earlier section is hidden", () => {
  const part = authoredPart();
  part.parameters.unshift({ id: "ghost", hidden: true, controls: [
    { key: "od", type: "slider", min: 1, max: 10, step: 1 },
  ] });
  part.parameters[1].controls[3].id = "body";   // collides with the section id "body"
  const f = lintPart(part).errors.find((f) => f.rule === "duplicate-node-id");
  expect(f).toBeTruthy();
  expect(f.path).toBe("parameters[1]");
});

test("a clean authored part still lints clean after the new rules", () => {
  expect(lintPart(authoredPart()).errors).toEqual([]);
});

test("select with no options errors; default outside options errors", () => {
  const part = authoredPart();
  part.defaults.profile = "round";
  part.parameters[0].controls.push({ key: "profile", type: "select", options: [] });
  expect(ids(lintPart(part).errors)).toContain("select-options-missing");
  part.parameters[0].controls.at(-1).options = ["faceted", "hex"];
  expect(ids(lintPart(part).errors)).toContain("select-default-not-in-options");
  part.parameters[0].controls.at(-1).options = ["faceted", "round"];
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("select-options-missing");
  expect(ids(r.errors)).not.toContain("select-default-not-in-options");
});
