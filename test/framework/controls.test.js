// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { clampToRange } from "../../src/framework/controls.js";

// The value-commit logic for the editable number boxes (DOM wiring is browser-only).
test("clampToRange clamps a typed value into [min, max], allowing exact (non-step) values", () => {
  expect(clampToRange("12", 0, 40)).toBe(12);
  expect(clampToRange("100", 0, 40)).toBe(40);     // above max → max
  expect(clampToRange("-5", 0, 40)).toBe(0);       // below min → min
  expect(clampToRange("3.456", 0, 40)).toBe(3.456); // exact, no step snapping
});

test("clampToRange returns null for non-numeric input", () => {
  expect(clampToRange("", 0, 40)).toBeNull();
  expect(clampToRange("abc", 0, 40)).toBeNull();
});

import { buildControls, visibleAdvanced, visibleFeatures, sectionRenders } from "../../src/framework/controls.js";

const presetSec = (over = {}) => ({ id: "body", title: "Body",
  advanced: [
    { key: "od", label: "OD", min: 1, max: 10, step: 1 },
    { key: "secret", label: "Secret", min: 0, max: 1, step: 1, hidden: true },
  ], ...over });
const featureSec = (over = {}) => ({ id: "f", title: "Flange", features: [
    { label: "Flange", key: "flange_d", on: 16, sliders: [{ key: "flange_d", label: "D", min: 1, max: 50, step: 1 }] },
    { label: "Hidden feat", key: "hf", on: 1, hidden: true, sliders: [{ key: "hf", label: "H", min: 0, max: 1, step: 1 }] },
  ], ...over });

test("visibleAdvanced / visibleFeatures drop hidden entries", () => {
  expect(visibleAdvanced(presetSec()).map((d) => d.key)).toEqual(["od"]);
  expect(visibleFeatures(featureSec()).map((f) => f.key)).toEqual(["flange_d"]);
});

test("sectionRenders: hidden section never renders; empty section doesn't; preset/feature do", () => {
  expect(sectionRenders({ title: "X", hidden: true, presets: { A: {} } })).toBe(false);
  expect(sectionRenders({ title: "X", advanced: [{ key: "z", label: "Z", min: 0, max: 1, step: 1, hidden: true }] })).toBe(false);
  expect(sectionRenders(presetSec())).toBe(true);                // has a visible control
  expect(sectionRenders({ title: "P", presets: { A: {} }, advanced: [] })).toBe(true); // presets only
  expect(sectionRenders(featureSec())).toBe(true);
  expect(sectionRenders({ title: "F", features: [{ label: "h", key: "h", on: 1, hidden: true, sliders: [] }] })).toBe(false);
});

test("buildControls omits hidden advanced control from the DOM", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  buildControls(root, [presetSec()], { od: 5, secret: 0 }, () => {});
  const labels = [...root.querySelectorAll("label")].map((l) => l.textContent);
  expect(labels.join(" ")).toContain("OD");
  expect(labels.join(" ")).not.toContain("Secret");
});

test("buildControls skips a section whose every control is hidden", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const allHidden = { id: "h", title: "AllHidden", advanced: [{ key: "z", label: "Z", min: 0, max: 1, step: 1, hidden: true }] };
  buildControls(root, [allHidden], { z: 0 }, () => {});
  expect(root.textContent).not.toContain("AllHidden");
  expect(root.querySelectorAll(".section").length).toBe(0);
});
