// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { buildControls } from "../../../src/framework/panel/render.js";

const selectSec = (over = {}) => ({ id: "s", title: "S", controls: [
  { key: "profile", type: "select", label: "Profile",
    options: [{ value: "round", label: "Round" }, { value: "faceted", label: "Faceted" }] },
  ...(over.extra ?? []),
] });

test("select renders options, reflects params, writes on change, fires onDirty", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  let dirty = 0;
  const params = { profile: "round" };
  buildControls(root, [selectSec()], params, () => dirty++);
  const sel = root.querySelector("select.select-input");
  expect([...sel.options].map((o) => o.textContent)).toEqual(["Round", "Faceted"]);
  expect(sel.value).toBe("round");
  sel.value = "faceted"; sel.dispatchEvent(new Event("change"));
  expect(params.profile).toBe("faceted");
  expect(dirty).toBe(1);
});

test("select round-trips NUMERIC option values through the string-valued DOM", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { teeth: 12 };
  buildControls(root, [{ id: "s", controls: [
    { key: "teeth", type: "select", options: [8, 12, 16] },   // shorthand: value === label
  ] }], params, () => {});
  const sel = root.querySelector("select.select-input");
  expect(sel.value).toBe("12");
  sel.value = "16"; sel.dispatchEvent(new Event("change"));
  expect(params.teeth).toBe(16);                              // number, not "16"
});

test("radio renders a segmented control; clicking writes and marks .on", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { mode: "a" };
  buildControls(root, [{ id: "s", controls: [
    { key: "mode", type: "radio", label: "Mode", options: ["a", "b", "c"] },
  ] }], params, () => {});
  const seg = root.querySelector(".seg");
  const btns = [...seg.querySelectorAll("button")];
  expect(btns.map((b) => b.textContent)).toEqual(["a", "b", "c"]);
  expect(btns[0].classList.contains("on")).toBe(true);
  btns[2].click();
  expect(params.mode).toBe("c");
  expect(btns[2].classList.contains("on")).toBe(true);
  expect(btns[0].classList.contains("on")).toBe(false);
});

test("sync re-reads params into select and radio without firing onDirty", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  let dirty = 0;
  const params = { profile: "round", mode: "a" };
  const panel = buildControls(root, [
    selectSec(), { id: "r", controls: [{ key: "mode", type: "radio", options: ["a", "b"] }] },
  ], params, () => dirty++);
  Object.assign(params, { profile: "faceted", mode: "b" });
  panel.syncValues();
  expect(root.querySelector("select.select-input").value).toBe("faceted");
  const on = [...root.querySelectorAll(".seg button")].filter((b) => b.classList.contains("on"));
  expect(on.map((b) => b.textContent)).toEqual(["b"]);
  expect(dirty).toBe(0);
  panel.dispose();
});

test("editing a select in a preset section drops the picker to Custom", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { profile: "round" };
  buildControls(root, [{ id: "s", controls: [
    { type: "preset", presets: { P: { profile: "round" } } },
    { key: "profile", type: "select", options: ["round", "faceted"] },
  ] }], params, () => {});
  const sel = root.querySelector("select.select-input");
  sel.value = "faceted"; sel.dispatchEvent(new Event("change"));
  expect(root.querySelector("select.preset").value).toBe("Custom");
});
