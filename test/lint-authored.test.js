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

test("a readout whose derivedKey no derive() group produces warns", () => {
  const part = authoredPart();
  part.derive = (p) => ({ innerDia: p.od - 2 * p.wall });
  part.parameters[0].controls.push({ type: "readout", label: "X", derivedKey: "nope" });
  const f = lintPart(part).warnings.find((f) => f.rule === "readout-unknown-derived-key");
  expect(f).toBeTruthy();
  part.parameters[0].controls.at(-1).derivedKey = "innerDia";
  expect(ids(lintPart(part).warnings)).not.toContain("readout-unknown-derived-key");
});

test("scale:log with a non-positive min errors", () => {
  const part = authoredPart();
  part.parameters[0].controls.push({ key: "wall", type: "slider", min: 0, max: 4, step: 0.1, scale: "log" });
  expect(ids(lintPart(part).errors)).toContain("log-scale-needs-positive-min");
});

test("out-of-range ticks and an inverted recommended band warn", () => {
  const part = authoredPart();
  part.parameters[0].controls.push(
    { key: "wall", type: "slider", min: 0.8, max: 4, step: 0.1, ticks: [0.5, 2] },
    { key: "od", type: "slider", min: 1, max: 10, step: 1, recommended: [9, 2] },
  );
  const found = ids(lintPart(part).warnings).filter((r) => r === "slider-refinement-invalid");
  expect(found).toHaveLength(2);
});

test("a when condition naming a key not in defaults errors, on any node kind", () => {
  const part = authoredPart();
  part.parameters[0].controls[3].when = { nope: { gt: 0 } };            // group
  part.parameters[0].controls[1].when = { missing: 1 };                 // control
  const errs = lintPart(part).errors.filter((f) => f.rule === "when-key-not-in-defaults");
  expect(errs).toHaveLength(2);
  expect(errs.map((f) => f.path).sort()).toEqual([
    "parameters[0].controls[1].when", "parameters[0].controls[3].when",
  ]);
});

test("allOf/anyOf/not recurse; keys inside them are checked too", () => {
  const part = authoredPart();
  part.parameters[0].controls[1].when = { allOf: [{ show: 1 }, { not: { ghost: 1 } }] };
  const errs = lintPart(part).errors.filter((f) => f.rule === "when-key-not-in-defaults");
  expect(errs).toHaveLength(1);           // `ghost` only — `show` is real
});

test("an unknown operator errors with a did-you-mean", () => {
  const part = authoredPart();
  part.parameters[0].controls[1].when = { show: { gte1: 1 } };
  const f = lintPart(part).errors.find((f) => f.rule === "when-unknown-operator");
  expect(f).toBeTruthy();
  expect(f.hint).toMatch(/Recognised: gt, gte/);   // the operator list comes from WHEN_OPS
});

test("a valid condition produces no when findings", () => {
  const part = authoredPart();
  part.parameters[0].controls[1].when = { show: { gt: 0 }, wall: { in: [1, 2] } };
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("when-key-not-in-defaults");
  expect(ids(r.errors)).not.toContain("when-unknown-operator");
});

test("nesting groups past two levels warns", () => {
  const part = authoredPart();
  part.parameters[0].controls = [{ type: "group", title: "L1", controls: [
    { type: "group", title: "L2", controls: [
      { type: "group", title: "L3", controls: [{ key: "od", min: 1, max: 10, step: 1 }] },
    ] },
  ] }];
  const found = lintPart(part).warnings.filter((f) => f.rule === "group-depth");
  expect(found).toHaveLength(2);                          // L2 (depth 2) and L3 (depth 3)
  expect(found[0].path).toBe("parameters[0].controls[0].controls[0]");
});

test("a section showing more than twelve visible controls warns", () => {
  const part = authoredPart();
  part.parameters[0].controls = Array.from({ length: 13 }, (_, i) => (
    { key: `k${i}`, type: "slider", min: 0, max: 1, step: 1 }));
  for (let i = 0; i < 13; i++) part.defaults[`k${i}`] = 0;
  expect(ids(lintPart(part).warnings)).toContain("section-too-many-controls");
  part.parameters[0].controls[12].hidden = true;            // 12 visible → fine
  expect(ids(lintPart(part).warnings)).not.toContain("section-too-many-controls");
});

test("a legacy section is measured too — features and toggles count as controls", () => {
  const part = authoredPart();
  part.parameters[0] = { id: "big", advanced: Array.from({ length: 13 }, (_, i) => (
    { key: `k${i}`, min: 0, max: 1, step: 1 })) };
  for (let i = 0; i < 13; i++) part.defaults[`k${i}`] = 0;
  expect(ids(lintPart(part).warnings)).toContain("section-too-many-controls");
});
