// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { buildControls } from "../src/framework/panel/render.js";

// mount() boots a viewer and a worker, neither of which exists in a unit test —
// so the contract asserted here is the one mount is a thin pass-through for:
// the option reaches the widget factory. mount's own wiring is covered by the
// smoke check in Task 8.
test("buildControls forwards fontCatalog to the font widget", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const catalog = { async search() { return []; } };
  const params = { face: "https://fonts.gstatic.com/s/anton/v1/anton.ttf" };
  buildControls(root, [{ id: "s", controls: [{ key: "face", type: "font", label: "T" }] }],
    params, () => {}, undefined, { fontCatalog: catalog });
  expect(root.querySelector("button.font-btn"), "catalog present → button form").toBeTruthy();
});

const degraded = (extra) => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { face: "https://fonts.gstatic.com/s/anton/v1/anton.ttf" };
  buildControls(root, [{ id: "s", controls: [{ key: "face", type: "font", label: "T", ...extra }] }],
    params, () => {});
  return root;
};

test("without the option the same control degrades to a drop zone", () => {
  const root = degraded();
  expect(root.querySelector("button.font-btn"), "no catalog → no picker button").toBeNull();
  // The URL field is opt-in (`sourceField`), so with no catalog the labelled drop
  // zone is the whole control — which is why this branch keeps its label rather
  // than going ambient the way the catalog branch does.
  expect(root.querySelector("[data-pf-drop]"), "the drop zone is the way in").toBeTruthy();
  expect(root.querySelector("input.text-input"), "no URL field unless asked for").toBeNull();
});

test("sourceField: true restores the URL field on the degraded branch", () => {
  expect(degraded({ sourceField: true }).querySelector("input.text-input")).toBeTruthy();
});
