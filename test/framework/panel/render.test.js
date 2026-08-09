// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { buildControls } from "../../../src/framework/panel/render.js";

// The legacy feature check/reveal path (controls.js on main, buildFeatureSection):
// ticking a feature's checkbox writes `on` into params AND re-syncs the sliders
// it reveals, so they display the just-written value rather than a stale one.
// min is 0 (not 1) so the "off" value of 0 is in-range: a real <input
// type="range"> clamps `.value` to `min` on assignment, and a min above the
// off-state would make the "starts at 0" baseline below fail for reasons
// unrelated to what this test actually covers (the reveal re-sync).
const featureSec = () => ({ id: "f", title: "Flange", features: [
  { label: "Flange", key: "flange_d", on: 16,
    sliders: [{ key: "flange_d", label: "D", min: 0, max: 50, step: 1 }] },
] });

test("ticking a feature checkbox reveals its group with freshly synced sliders", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  let dirty = 0;
  const params = { flange_d: 0 };
  buildControls(root, [featureSec()], params, () => dirty++);

  const box = root.querySelector('input[type="checkbox"]');
  const group = root.querySelector(".feat-group");
  const slider = root.querySelector('input[type="range"]');
  expect(group.classList.contains("hidden")).toBe(true);  // off to start
  expect(slider.value).toBe("0");

  box.checked = true; box.dispatchEvent(new Event("change"));
  expect(params.flange_d).toBe(16);
  expect(group.classList.contains("hidden")).toBe(false);
  expect(slider.value).toBe("16");                        // re-synced on reveal, not stale
  expect(dirty).toBe(1);
});

test("unticking writes 0 and hides the group; re-ticking restores `on`", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { flange_d: 16 };
  buildControls(root, [featureSec()], params, () => {});

  const box = root.querySelector('input[type="checkbox"]');
  const group = root.querySelector(".feat-group");
  expect(box.checked).toBe(true);
  expect(group.classList.contains("hidden")).toBe(false);

  box.checked = false; box.dispatchEvent(new Event("change"));
  expect(params.flange_d).toBe(0);
  expect(group.classList.contains("hidden")).toBe(true);

  box.checked = true; box.dispatchEvent(new Event("change"));
  expect(params.flange_d).toBe(16);
  expect(root.querySelector('input[type="range"]').value).toBe("16");
});

test("the Advanced fold's toggle keeps aria-expanded in sync with clicks", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  buildControls(root, [{ id: "b", title: "Body",
    advanced: [{ key: "od", label: "OD", min: 1, max: 10, step: 1 }] }], { od: 5 }, () => {});
  const toggle = root.querySelector(".adv-toggle");
  const body = root.querySelector(".adv");
  expect(toggle.getAttribute("aria-expanded")).toBe("true");   // 1 section → auto-open
  toggle.click();
  expect(body.classList.contains("hidden")).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  toggle.click();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
});

const twoPickerSec = () => ({ id: "body", title: "Body", controls: [
  { type: "preset", presets: { Small: { od: 3 }, Large: { od: 9 } } },
  { key: "od", type: "slider", label: "OD", min: 1, max: 10, step: 1 },
  { type: "preset", presets: { Tall: { h: 20 } } },
  { key: "h", type: "slider", label: "H", min: 1, max: 30, step: 1 },
] });

test("a section renders every preset node, in authored order, among the controls", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  buildControls(root, [twoPickerSec()], { od: 5, h: 10 }, () => {});
  const kids = [...root.querySelectorAll(".sec-body > *")];
  const kinds = kids.map((el) => el.matches("select.preset") ? "preset" : "control");
  expect(kinds).toEqual(["preset", "control", "preset", "control"]);
});

test("applying a preset from the second picker syncs its keys and self-Customs nothing", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { od: 5, h: 10 };
  buildControls(root, [twoPickerSec()], params, () => {});
  const [first, second] = root.querySelectorAll("select.preset");
  second.value = "Tall";
  second.dispatchEvent(new Event("change"));
  expect(params.h).toBe(20);
  expect([...root.querySelectorAll('input[type="range"]')][1].value).toBe("20");
  expect(second.value).toBe("Tall");           // no self-Custom
  expect(first.value).toBe("Small");           // other pickers untouched
});

test("editing any control drops the FIRST picker to Custom (first-picker-wins)", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { od: 5, h: 10 };
  buildControls(root, [twoPickerSec()], params, () => {});
  const [first, second] = root.querySelectorAll("select.preset");
  const box = root.querySelector("input.num");
  box.value = "7"; box.dispatchEvent(new Event("input"));
  expect(first.value).toBe("Custom");
  expect(second.value).toBe("Tall");   // other pickers untouched (first-picker-wins)
});

test("disclosure buttons carry aria-controls naming their body element", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  buildControls(root, [{ id: "b", title: "Body",
    advanced: [{ key: "od", label: "OD", min: 1, max: 10, step: 1 }] }], { od: 5 }, () => {});
  const secBtn = root.querySelector("button.sec-title");
  const secBody = root.querySelector(".sec-body");
  expect(secBody.id).toBeTruthy();
  expect(secBtn.getAttribute("aria-controls")).toBe(secBody.id);
  const advBtn = root.querySelector(".adv-toggle");
  const advBody = root.querySelector(".adv");
  expect(advBody.id).toBeTruthy();
  expect(advBtn.getAttribute("aria-controls")).toBe(advBody.id);
});
