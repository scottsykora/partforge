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

import { buildControls, visibleAdvanced, visibleFeatures, visibleToggles, sectionRenders } from "../../src/framework/controls.js";

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

test("visibleToggles drops hidden; a toggles-only section still renders", () => {
  const sec = { id: "m", title: "Motor", toggles: [
    { key: "show", label: "Show", on: 1 },
    { key: "h", label: "Hidden", on: 1, hidden: true },
  ] };
  expect(visibleToggles(sec).map((t) => t.key)).toEqual(["show"]);
  expect(sectionRenders(sec)).toBe(true);
  expect(sectionRenders({ title: "X", toggles: [{ key: "h", label: "H", hidden: true }] })).toBe(false);
});

test("buildControls renders a preset-section toggle that updates params + fires onDirty", () => {
  const root = document.createElement("div");
  let dirty = 0;
  const params = { od: 5, show_motor: 0 };
  const sec = { id: "motor", title: "Motor", presets: { A: {} },
    advanced: [{ key: "od", label: "OD", min: 0, max: 10, step: 1 }],
    toggles: [{ key: "show_motor", label: "Show motor", on: 1, description: "preview" }] };
  buildControls(root, [sec], params, () => dirty++);
  const box = root.querySelector('input[type="checkbox"]');
  expect(box).toBeTruthy();
  expect(box.checked).toBe(false);          // reflects params.show_motor = 0
  box.checked = true; box.dispatchEvent(new Event("change"));
  expect(params.show_motor).toBe(1);
  expect(dirty).toBe(1);
  box.checked = false; box.dispatchEvent(new Event("change"));
  expect(params.show_motor).toBe(0);
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

const descSec = () => ({ id: "d", title: "Body", description: "Body **section** docs",
  advanced: [{ key: "od", label: "OD", min: 1, max: 10, step: 1, description: "Outer [dia](https://x.test/d)" },
             { key: "h", label: "H", min: 1, max: 10, step: 1 }] }); // h has no description

function render(sec, params) {
  document.body.innerHTML = '<div id="root"></div>';
  document.querySelectorAll(".popover").forEach((p) => p.remove()); // reset shared popover between tests
  const root = document.getElementById("root");
  buildControls(root, [sec], params, () => {});
  return root;
}

test("info glyph appears only for items with a description", () => {
  const root = render(descSec(), { od: 5, h: 5 });
  // section title + the OD control have descriptions; H does not
  expect(root.querySelectorAll(".info").length).toBe(2);
});

test("clicking the glyph opens a popover with rendered markdown; Escape closes it", () => {
  const root = render(descSec(), { od: 5, h: 5 });
  const glyph = root.querySelector(".info");
  glyph.click();
  const pop = document.querySelector(".popover");
  expect(pop).toBeTruthy();
  expect(pop.hidden).toBe(false);
  expect(pop.innerHTML).toContain("<strong>section</strong>");
  expect(glyph.getAttribute("aria-expanded")).toBe("true");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(document.querySelector(".popover").hidden).toBe(true);
  expect(glyph.getAttribute("aria-expanded")).toBe("false");
});

test("opening a second glyph swaps content and closes the first", () => {
  const root = render(descSec(), { od: 5, h: 5 });
  const [g1, g2] = root.querySelectorAll(".info"); // section, then OD control
  g1.click();
  g2.click();
  const pop = document.querySelector(".popover");
  expect(pop.hidden).toBe(false);
  expect(pop.innerHTML).toContain('href="https://x.test/d"'); // OD's link
  expect(g1.getAttribute("aria-expanded")).toBe("false");
  expect(g2.getAttribute("aria-expanded")).toBe("true");
});

import { RELEVANT_ALL } from "../../src/framework/param-deps.js";

function buildPanel(parameters, params) {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const panel = buildControls(root, parameters, params, () => {});
  return { root, panel };
}
const wrapByLabel = (root, t) =>
  [...root.querySelectorAll(".slider")].find((w) => w.querySelector("label")?.textContent === t);
const sectionByTitle = (root, t) =>
  [...root.querySelectorAll(".section")].find((s) => s.querySelector(".sec-title")?.textContent === t);

const twoSections = [
  { id: "body", title: "Body", advanced: [
    { key: "od", label: "OD", min: 1, max: 10, step: 1 },
    { key: "h", label: "H", min: 1, max: 10, step: 1 },
  ] },
  { id: "bore", title: "Bore", advanced: [{ key: "bore", label: "Bore", min: 1, max: 5, step: 1 }] },
];

test("buildControls returns an applyRelevance method", () => {
  const { panel } = buildPanel(twoSections, { od: 5, h: 5, bore: 2 });
  expect(typeof panel.applyRelevance).toBe("function");
});

test("applyRelevance dims out-of-set controls and hides all-irrelevant sections", () => {
  const { root, panel } = buildPanel(twoSections, { od: 5, h: 5, bore: 2 });
  panel.applyRelevance(new Set(["od"]));
  expect(wrapByLabel(root, "OD").classList.contains("irrelevant")).toBe(false);
  expect(wrapByLabel(root, "H").classList.contains("irrelevant")).toBe(true);
  expect(wrapByLabel(root, "H").getAttribute("title")).toMatch(/current view/i);
  // Bore section's only control is out of the set → section hidden
  expect(sectionByTitle(root, "Bore").classList.contains("section-hidden")).toBe(true);
  expect(sectionByTitle(root, "Body").classList.contains("section-hidden")).toBe(false);
});

test("re-applying a different set un-dims / re-shows", () => {
  const { root, panel } = buildPanel(twoSections, { od: 5, h: 5, bore: 2 });
  panel.applyRelevance(new Set(["od"]));
  panel.applyRelevance(new Set(["h", "bore"]));
  expect(wrapByLabel(root, "OD").classList.contains("irrelevant")).toBe(true);
  expect(wrapByLabel(root, "H").classList.contains("irrelevant")).toBe(false);
  expect(sectionByTitle(root, "Bore").classList.contains("section-hidden")).toBe(false);
});

test("applyRelevance(RELEVANT_ALL) clears all dimming and shows all sections", () => {
  const { root, panel } = buildPanel(twoSections, { od: 5, h: 5, bore: 2 });
  panel.applyRelevance(new Set([]));                 // everything irrelevant
  expect(sectionByTitle(root, "Body").classList.contains("section-hidden")).toBe(true);
  panel.applyRelevance(RELEVANT_ALL);
  expect(sectionByTitle(root, "Body").classList.contains("section-hidden")).toBe(false);
  expect(wrapByLabel(root, "OD").classList.contains("irrelevant")).toBe(false);
});

test("info glyph toggles a popover; dispose removes it and its listeners", () => {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  document.body.append(root);
  const panel = buildControls(
    root,
    [{ id: "b", title: "Body", description: "About the body",
       advanced: [{ key: "od", label: "OD", min: 1, max: 10, step: 1 }] }],
    { od: 5 },
    () => {},
  );

  const glyph = root.querySelector("button.info");
  glyph.click();
  const pop = document.body.querySelector(".popover");
  expect(pop.hidden).toBe(false);
  expect(glyph.getAttribute("aria-expanded")).toBe("true");

  glyph.click(); // toggle off
  expect(pop.hidden).toBe(true);

  panel.dispose();
  expect(document.body.querySelector(".popover")).toBeNull();
  expect(root.children.length).toBe(0);
});

test("Escape closes the popover; after dispose the document listener is gone", () => {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  document.body.append(root);
  const panel = buildControls(
    root,
    [{ id: "b", title: "Body", description: "About the body",
       advanced: [{ key: "od", label: "OD", min: 1, max: 10, step: 1 }] }],
    { od: 5 },
    () => {},
  );
  root.querySelector("button.info").click();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(document.body.querySelector(".popover").hidden).toBe(true);
  panel.dispose();
  // no popover left to act on — dispatching again must not throw or recreate one
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(document.body.querySelector(".popover")).toBeNull();
});
