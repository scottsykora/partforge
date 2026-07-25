// Group 2 — parameter schema. features-requires-sliders is the exact crash that
// shipped in the nameplate and bracket demos: controls.js:313 does
// `feat.sliders.filter(...)` with no guard, so a bare boolean placed in `features`
// instead of `toggles` throws "Cannot read properties of undefined (reading 'filter')"
// only once a browser boots the panel.
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const goodPart = () => ({
  meta: { title: "Test", units: "mm" },
  parameters: [{
    id: "body", title: "Body",
    presets: { M3: { od: 8 } },
    advanced: [{ key: "od", label: "Outer diameter", unit: "mm", min: 4, max: 40, step: 0.5 }],
    features: [{ key: "flange_d", label: "Flange", on: 16,
      sliders: [{ key: "flange_d", label: "Flange diameter", min: 8, max: 50, step: 1 }] }],
    toggles: [{ key: "vented", label: "Vented", on: false }],
  }],
  defaults: { od: 8, flange_d: 0, vented: false },
  parts: { body: { views: ["main"], build: (k, p) => k.box({ size: [p.od, p.od, p.od] }) } },
  views: { main: { label: "Main" } },
});

const ids = (findings) => findings.map((f) => f.rule);
const find = (r, rule) => [...r.errors, ...r.warnings].find((f) => f.rule === rule);

test("a well-formed schema produces no schema findings", () => {
  const r = lintPart(goodPart());
  expect(ids(r.errors)).toEqual([]);
  expect(ids(r.warnings)).toEqual([]);
});

test("a features entry with no sliders is an error", () => {
  const part = goodPart();
  delete part.parameters[0].features[0].sliders;
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("features-requires-sliders");
  expect(find(r, "features-requires-sliders").path).toBe("parameters[0].features[0]");
  expect(find(r, "features-requires-sliders").hint).toMatch(/toggles/);
});

test("a control key absent from defaults is an error", () => {
  const part = goodPart();
  part.parameters[0].advanced[0].key = "diameter";
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("control-key-not-in-defaults");
  expect(find(r, "control-key-not-in-defaults").path).toBe("parameters[0].advanced[0].key");
});

test("a toggle key absent from defaults is an error", () => {
  const part = goodPart();
  part.parameters[0].toggles[0].key = "ventilated";
  expect(ids(lintPart(part).errors)).toContain("control-key-not-in-defaults");
});

test("a preset bundle key absent from defaults is an error", () => {
  const part = goodPart();
  part.parameters[0].presets.M3 = { outerDiameter: 8 };
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("preset-key-not-in-defaults");
  expect(find(r, "preset-key-not-in-defaults").path).toBe('parameters[0].presets["M3"].outerDiameter');
});

test("a default outside a slider's range is a warning, not an error", () => {
  const part = goodPart();
  part.defaults.od = 80; // slider is min 4 max 40
  const r = lintPart(part);
  expect(ids(r.warnings)).toContain("slider-range-excludes-default");
  expect(ids(r.errors)).not.toContain("slider-range-excludes-default");
});

test("an unrecognised control field warns with a did-you-mean", () => {
  const part = goodPart();
  part.parameters[0].advanced[0].lable = "typo";
  const r = lintPart(part);
  expect(ids(r.warnings)).toContain("unknown-control-field");
  expect(find(r, "unknown-control-field").hint).toMatch(/label/);
});

test("the same key owned by two sections warns", () => {
  const part = goodPart();
  part.parameters.push({ id: "other", title: "Other",
    advanced: [{ key: "od", label: "Also OD", min: 1, max: 5, step: 1 }] });
  expect(ids(lintPart(part).warnings)).toContain("duplicate-control-key");
});

test("a defaults key no control references warns", () => {
  const part = goodPart();
  part.defaults.orphan = 3;
  expect(ids(lintPart(part).warnings)).toContain("default-not-exposed");
});

test("a hidden control still counts as exposing its key", () => {
  // demo.js's flange_h is a documented, legitimate hidden internal constant.
  const part = goodPart();
  part.defaults.flange_h = 2;
  part.parameters[0].advanced.push({ key: "flange_h", label: "Flange thickness", min: 1, max: 5, step: 0.5, hidden: true });
  expect(ids(lintPart(part).warnings)).not.toContain("default-not-exposed");
});

test("a part with no parameters section produces no schema findings", () => {
  // `parameters` is optional — a part can ship with defaults and no control panel.
  const part = goodPart();
  delete part.parameters;
  const r = lintPart(part);
  expect(ids(r.errors)).toEqual([]);
});

test("a feature's own-key slider with the off-sentinel default does not warn", () => {
  // goodPart() already is exactly this shape: feature "flange_d" owns a slider
  // keyed "flange_d" (range 8..50), and defaults.flange_d is 0 — controls.js's
  // documented "feature off" sentinel, not an out-of-range slider value.
  const r = lintPart(goodPart());
  expect(ids(r.warnings)).not.toContain("slider-range-excludes-default");
});

test("a feature's own-key slider with a non-sentinel out-of-range default still warns", () => {
  // Same shape as demo.js, but the default is a mistyped "on" value (999) rather
  // than the 0 off-sentinel — matching keys alone must not exempt this from the
  // range check, since it's exactly the authoring mistake the rule exists to catch.
  const part = goodPart();
  part.defaults.flange_d = 999; // slider range is min:8 max:50
  const r = lintPart(part);
  expect(ids(r.warnings)).toContain("slider-range-excludes-default");
  expect(find(r, "slider-range-excludes-default").path).toBe("parameters[0].features[0].sliders[0]");
});

test("an explicit empty defaults still gets its control keys checked", () => {
  // missing-defaults (shape rule) only fires when `defaults` isn't a plain object;
  // an explicit `defaults: {}` passes that check but must not silently exempt
  // control-key-not-in-defaults, or a real control key with no matching default
  // goes unreported forever.
  const part = goodPart();
  part.defaults = {};
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("control-key-not-in-defaults");
});
