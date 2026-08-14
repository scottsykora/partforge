// @vitest-environment happy-dom
// revealParam: open the fold, focus the input, pulse the flash class.
//
// `parameters` here is the real buildControls shape — an ARRAY of sections
// (not the object-of-sections the brief guessed). "wall" sits directly in the
// Body section; "bore_d" sits inside a nested "Advanced" group with an
// explicit `collapsed: true` so it starts closed regardless of the
// AUTO_OPEN_MAX_SECTIONS auto-open rule (a single top-level section would
// otherwise auto-open every fold, defeating the "folds start closed" premise
// the brief's test relies on).
import { expect, test } from "vitest";
import { buildControls } from "../../../src/framework/panel/render.js";

const parameters = [
  {
    id: "body", title: "Body",
    controls: [
      { key: "wall", type: "number", label: "Wall", min: 1, max: 10 },
      {
        type: "group", title: "Advanced", collapsed: true,
        controls: [
          { key: "bore_d", type: "number", label: "Bore", min: 2, max: 20 },
        ],
      },
    ],
  },
];

function setup() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const params = { wall: 3, bore_d: 8 };
  const panel = buildControls(root, parameters, params, () => {}, () => {});
  return { root, panel };
}

test("revealParam opens the enclosing fold and focuses the input", () => {
  const { root, panel } = setup();
  const fold = root.querySelector(".adv");
  expect(fold.classList.contains("hidden")).toBe(true); // folds start closed
  expect(panel.revealParam("bore_d")).toBe(true);
  expect(fold.classList.contains("hidden")).toBe(false);
  const input = document.activeElement;
  expect(fold.contains(input)).toBe(true);
});

test("revealParam pulses the flash class on the control", () => {
  const { root, panel } = setup();
  panel.revealParam("wall");
  expect(root.querySelector(".pf-param-flash")).not.toBeNull();
});

test("unknown key returns false and changes nothing", () => {
  const { panel } = setup();
  expect(panel.revealParam("nope")).toBe(false);
});
