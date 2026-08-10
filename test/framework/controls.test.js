// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { clampToRange, popoverTop, popoverLeft } from "../../src/framework/controls.js";

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

test("popoverTop places below when it fits, flips above when clipped", () => {
  // fits below
  expect(popoverTop({ glyphTop: 100, glyphBottom: 120, popHeight: 200, viewportHeight: 800 })).toBe(126);
  // would clip the viewport bottom → flips above the glyph
  expect(popoverTop({ glyphTop: 700, glyphBottom: 720, popHeight: 200, viewportHeight: 800 })).toBe(494);
  // no room above either → clamps to the 8px margin
  expect(popoverTop({ glyphTop: 30, glyphBottom: 50, popHeight: 780, viewportHeight: 800 })).toBe(8);
});

test("popoverLeft aligns near the glyph, clamps to a 10px margin at both edges", () => {
  // fits: aligned 8px left of the glyph
  expect(popoverLeft({ glyphLeft: 100, popWidth: 200, viewportWidth: 800 })).toBe(92);
  // glyph near the right edge: pulled left so the right edge sits 10px in
  expect(popoverLeft({ glyphLeft: 700, popWidth: 200, viewportWidth: 800 })).toBe(590);
  // popover wider than the viewport allows: the left margin wins
  expect(popoverLeft({ glyphLeft: 5, popWidth: 900, viewportWidth: 800 })).toBe(10);
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

test("buildControls renders live single-line and multiline string controls", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { title: "Spacer", label: "Line one\nLine two" };
  let dirty = 0;
  const sec = { id: "copy", title: "Copy", advanced: [
    { key: "title", label: "Title", control: "text" },
    { key: "label", label: "Label", control: "textarea" },
  ] };

  buildControls(root, [sec], params, () => dirty++);

  const title = root.querySelector('input[type="text"]');
  const label = root.querySelector("textarea");
  expect(title?.value).toBe("Spacer");
  expect(label?.value).toBe("Line one\nLine two");

  title.value = "Bracket";
  title.dispatchEvent(new Event("input"));
  label.value = "Upper\nLower\n";
  label.dispatchEvent(new Event("input"));

  expect(params).toMatchObject({ title: "Bracket", label: "Upper\nLower\n" });
  expect(dirty).toBe(2);
});

test("text edits select Custom and presets resynchronize string controls", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { title: "Stock", label: "First\nPreset" };
  let dirty = 0;
  const sec = { id: "copy", title: "Copy", presets: {
    First: { title: "Stock", label: "First\nPreset" },
    Second: { title: "Revised", label: "Second\nPreset" },
  }, advanced: [
    { key: "title", label: "Title", control: "text" },
    { key: "label", label: "Label", control: "textarea" },
  ] };

  buildControls(root, [sec], params, () => dirty++);
  const preset = root.querySelector("select.preset");
  const title = root.querySelector('input[type="text"]');
  const label = root.querySelector("textarea");

  title.value = "Custom title";
  title.dispatchEvent(new Event("input"));
  expect(preset.value).toBe("Custom");

  preset.value = "Second";
  preset.dispatchEvent(new Event("change"));
  expect(params).toMatchObject({ title: "Revised", label: "Second\nPreset" });
  expect(title.value).toBe("Revised");
  expect(label.value).toBe("Second\nPreset");
  expect(dirty).toBe(2);
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

test("section header: chevron precedes the title; .collapsed tracks the disclosure", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  // "Shut" uses the NEW authored shape (`controls:`) because legacy desugar
  // hard-sets `collapsed: "auto"` on legacy-shaped sections (legacy.js:105) —
  // only author.js honors an explicit `collapsed: true` (author.js:82).
  buildControls(root, [
    { id: "open", title: "Open", advanced: [{ key: "a", label: "A", min: 0, max: 1, step: 1 }] },
    { id: "shut", title: "Shut", collapsed: true,
      controls: [{ type: "slider", key: "b", label: "B", min: 0, max: 1, step: 1 }] },
  ], { a: 0, b: 0 }, () => {});

  const openSec = sectionByTitle(root, "Open");
  const shutSec = sectionByTitle(root, "Shut");
  const title = openSec.querySelector(".sec-title");
  expect(title.firstElementChild.className).toBe("chev"); // chevron leads
  expect(title.textContent).toBe("Open");                 // …and carries no text

  // initial open state → class matches
  expect(openSec.classList.contains("collapsed")).toBe(false);
  expect(shutSec.classList.contains("collapsed")).toBe(true);

  // clicking toggles both the body and the class
  shutSec.querySelector(".sec-title").click();
  expect(shutSec.classList.contains("collapsed")).toBe(false);
  expect(shutSec.querySelector(".sec-body").classList.contains("hidden")).toBe(false);
  openSec.querySelector(".sec-title").click();
  expect(openSec.classList.contains("collapsed")).toBe(true);
});

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

// syncValues is the programmatic twin of a user edit: setParams() writes into
// `params` behind the widgets' backs, so the panel has to be told to re-read.
test("syncValues re-reads params into the widgets", () => {
  const params = { h: 4 };
  const root = document.createElement("div");
  const panel = buildControls(root, [
    { id: "s", title: "S", advanced: [{ key: "h", label: "H", min: 1, max: 10, step: 1 }] },
  ], params, () => {});
  params.h = 7; // programmatic change (setParams path)
  panel.syncValues(["h"]);
  expect(root.querySelector('input[type="range"]').value).toBe("7");
  expect(root.querySelector('input[type="number"]').value).toBe("7");
  panel.dispose();
});

test("syncValues() with no keys syncs every widget — sliders, toggles, features — and never fires onDirty", () => {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  document.body.append(root);
  let dirty = 0;
  const params = { od: 5, show_motor: 0, flange_d: 0 };
  const panel = buildControls(root, [
    { id: "body", title: "Body",
      advanced: [{ key: "od", label: "OD", min: 1, max: 10, step: 1 }],
      toggles: [{ key: "show_motor", label: "Show motor", on: 1 }] },
    featureSec(),
  ], params, () => dirty++);
  const feature = root.querySelector(".feat-group");
  expect(feature.classList.contains("hidden")).toBe(true); // flange off to start

  Object.assign(params, { od: 9, show_motor: 1, flange_d: 16 });
  panel.syncValues(); // no keys → everything

  const [motorBox, flangeBox] = root.querySelectorAll('input[type="checkbox"]');
  expect(root.querySelector('input[type="range"]').value).toBe("9");
  expect(motorBox.checked).toBe(true);
  expect(flangeBox.checked).toBe(true);
  expect(feature.classList.contains("hidden")).toBe(false); // enabling reveals its controls
  expect(dirty).toBe(0); // programmatic: the caller drives the change path itself
  panel.dispose();
});

// A programmatic edit diverges from the preset just as a user edit does, so the
// picker has to fall back to "Custom" — otherwise it names a preset the params
// no longer match, and (worse) re-clicking that still-selected option fires no
// change event, so the user can't get the preset back.
const presetsSec = () => ({ id: "body", title: "Body",
  presets: { First: { od: 5 }, Second: { od: 8 } },
  advanced: [{ key: "od", label: "OD", min: 1, max: 10, step: 1 }] });

test("syncValues on a preset-section control drops the picker to Custom", () => {
  const root = document.createElement("div");
  const params = { od: 5 };
  const panel = buildControls(root, [presetsSec()], params, () => {});
  const preset = root.querySelector("select.preset");
  preset.value = "Second";
  preset.dispatchEvent(new Event("change"));

  params.od = 9; // programmatic change (setParams path)
  panel.syncValues(["od"]);

  expect(root.querySelector('input[type="range"]').value).toBe("9");
  expect(preset.value).toBe("Custom");
  panel.dispose();
});

test("applying a preset via the picker keeps its name — the raw syncs don't self-Custom", () => {
  const root = document.createElement("div");
  const params = { od: 5 };
  const panel = buildControls(root, [presetsSec()], params, () => {});
  const preset = root.querySelector("select.preset");

  preset.value = "Second";
  preset.dispatchEvent(new Event("change"));

  expect(params.od).toBe(8);
  expect(root.querySelector('input[type="range"]').value).toBe("8");
  expect(preset.value).toBe("Second"); // not clobbered by its own refresh
  panel.dispose();
});

test("syncValues(keys) leaves widgets outside the key list alone", () => {
  const root = document.createElement("div");
  const params = { od: 5, h: 5, bore: 2 };
  const panel = buildControls(root, twoSections, params, () => {});
  Object.assign(params, { od: 9, bore: 4 });
  panel.syncValues(["od"]);
  expect(wrapByLabel(root, "OD").querySelector('input[type="range"]').value).toBe("9");
  expect(wrapByLabel(root, "Bore").querySelector('input[type="range"]').value).toBe("2"); // untouched
  panel.dispose();
});

test("sections stay flat siblings so the rail can divide them with hairlines", () => {
  const root = document.createElement("div");
  buildControls(root, [presetSec(), featureSec()], { od: 5, secret: 0, flange_d: 16, hf: 0 }, () => {});
  const sections = [...root.children].filter((el) => el.classList.contains("section"));
  expect(sections).toHaveLength(2);
  // No nesting: a full-bleed divider between siblings only reads correctly if
  // sections really are siblings, not boxes inside boxes.
  for (const section of sections) {
    expect(section.querySelector(".section")).toBeNull();
    expect(section.parentElement).toBe(root);
  }
  // The Advanced fold survives. With two sections, the auto-open rule now
  // opens it on load — the one deliberate visible change of this release.
  expect(sections[0].querySelector(".adv-toggle")).not.toBeNull();
  const adv = sections[0].querySelector(".adv");
  expect(adv).not.toBeNull();
  expect(adv.classList.contains("hidden")).toBe(false);
});

test("a section title is a disclosure button that toggles its body", () => {
  const root = document.createElement("div");
  buildControls(root, [presetSec()], { od: 5, secret: 0 }, () => {});
  const btn = root.querySelector("button.sec-title");
  expect(btn).toBeTruthy();
  expect(btn.getAttribute("aria-expanded")).toBe("true");   // 1 section → auto-open
  const body = root.querySelector(".sec-body");
  expect(body.classList.contains("hidden")).toBe(false);
  btn.click();
  expect(btn.getAttribute("aria-expanded")).toBe("false");
  expect(body.classList.contains("hidden")).toBe(true);
});

test("the section ⓘ is a sibling of the title button, not nested inside it", () => {
  const root = document.createElement("div");
  buildControls(root, [presetSec({ description: "about the body" })], { od: 5, secret: 0 }, () => {});
  const btn = root.querySelector("button.sec-title");
  expect(btn.querySelector(".info")).toBeNull();            // a button inside a button never gets clicks
  expect(root.querySelector(".sec-header .info")).toBeTruthy();
});

test("four sections start collapsed; three start open", () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({
    id: `s${i}`, title: `S${i}`, advanced: [{ key: `k${i}`, label: "K", min: 0, max: 9, step: 1 }],
  }));
  const params = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`k${i}`, 1]));

  const three = document.createElement("div");
  buildControls(three, mk(3), params, () => {});
  expect([...three.querySelectorAll("button.sec-title")].map((b) => b.getAttribute("aria-expanded")))
    .toEqual(["true", "true", "true"]);

  const four = document.createElement("div");
  buildControls(four, mk(4), params, () => {});
  expect([...four.querySelectorAll("button.sec-title")].map((b) => b.getAttribute("aria-expanded")))
    .toEqual(["false", "false", "false", "false"]);
});

test("the legacy Advanced fold opens with a small panel", () => {
  const root = document.createElement("div");
  buildControls(root, [presetSec()], { od: 5, secret: 0 }, () => {});
  expect(root.querySelector(".adv").classList.contains("hidden")).toBe(false);
  expect(root.querySelector(".adv-toggle").textContent).toBe("Advanced ▴");
});

test("a section the user closed stays closed across applyState re-runs (the openApplied latch)", () => {
  const root = document.createElement("div");
  const params = { od: 5, secret: 0 };
  const panel = buildControls(root, [presetSec()], params, () => {});
  const btn = root.querySelector("button.sec-title");
  const body = root.querySelector(".sec-body");
  expect(body.classList.contains("hidden")).toBe(false); // auto-open
  btn.click();                                            // user closes it
  expect(body.classList.contains("hidden")).toBe(true);
  panel.syncValues();                                     // runs applyState — must NOT reopen
  expect(body.classList.contains("hidden")).toBe(true);
  panel.applyRelevance(new Set(["od"]));                  // also runs applyState
  expect(body.classList.contains("hidden")).toBe(true);
  panel.dispose();
});

test("onCommit fires on slider release (change), not during drag (input)", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const commits = [];
  const params = { od: 5 };
  buildControls(root, [{ id: "b", title: "Body",
    advanced: [{ key: "od", label: "OD", min: 1, max: 10, step: 1 }] }],
    params, () => {}, (keys) => commits.push(keys));
  const slider = root.querySelector('input[type="range"]');
  slider.value = "7";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  expect(params.od).toBe(7);
  expect(commits).toEqual([]);            // mid-drag: no commit
  slider.dispatchEvent(new Event("change", { bubbles: true }));
  expect(commits).toEqual([["od"]]);      // release: one commit, the key
});

test("number box commits on change (blur/Enter), including after live typing", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const commits = [];
  const params = { od: 5 };
  buildControls(root, [{ id: "b", title: "Body",
    advanced: [{ key: "od", label: "OD", min: 1, max: 10, step: 1 }] }],
    params, () => {}, (keys) => commits.push(keys));
  const box = root.querySelector('input[type="number"]');
  box.value = "8";
  box.dispatchEvent(new Event("input", { bubbles: true }));
  expect(commits).toEqual([]);            // live preview: no commit
  box.dispatchEvent(new Event("change", { bubbles: true }));
  expect(commits).toEqual([["od"]]);
  // an invalid entry reverts and must NOT commit
  box.value = "abc";
  box.dispatchEvent(new Event("change", { bubbles: true }));
  expect(commits).toEqual([["od"]]);
});

test("checkbox and preset commits: a preset carries every key it wrote", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const commits = [];
  const params = { od: 5, h: 2, show: 0 };
  buildControls(root, [
    { id: "b", title: "Body", presets: { Tall: { od: 3, h: 9 } },
      advanced: [
        { key: "od", label: "OD", min: 1, max: 10, step: 1 },
        { key: "h", label: "H", min: 1, max: 10, step: 1 },
      ] },
    { id: "m", title: "Motor", toggles: [{ key: "show", label: "Show", on: 1 }] },
  ], params, () => {}, (keys) => commits.push(keys));

  root.querySelector('input[type="checkbox"]')
    .dispatchEvent(new Event("change", { bubbles: true }));
  expect(commits).toEqual([["show"]]);

  const preset = root.querySelector("select.preset");
  preset.value = "Tall";
  preset.dispatchEvent(new Event("change", { bubbles: true }));
  expect(commits).toEqual([["show"], ["od", "h"]]);
  expect(params).toMatchObject({ od: 3, h: 9 });
});

test("syncValues never commits; a throwing commit handler never breaks the panel", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const commits = [];
  const params = { od: 5 };
  const panel = buildControls(root, [{ id: "b", title: "Body",
    advanced: [{ key: "od", label: "OD", min: 1, max: 10, step: 1 }] }],
    params, () => {}, (keys) => { commits.push(keys); throw new Error("host boom"); });
  params.od = 9;
  panel.syncValues(["od"]);               // programmatic: no commit
  expect(commits).toEqual([]);
  const slider = root.querySelector('input[type="range"]');
  slider.value = "7";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  expect(() => slider.dispatchEvent(new Event("change", { bubbles: true }))).not.toThrow();
  expect(commits).toEqual([["od"]]);      // dispatched despite the throw
  expect(params.od).toBe(7);              // the panel kept working
});
