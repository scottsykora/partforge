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

test("a readout renders, fills from refresh({derived}), and never syncs params", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { od: 10 };
  const panel = buildControls(root, [{ id: "s", controls: [
    { key: "od", type: "slider", min: 1, max: 20, step: 1 },
    { type: "readout", label: "Inner ø", derivedKey: "innerDia", unit: "mm" },
  ] }], params, () => {});
  const val = root.querySelector(".readout .val");
  expect(val.textContent).toBe("—");                       // no derived yet
  panel.refresh({ derived: { innerDia: 8.4 } });
  expect(val.textContent).toContain("8.4");
  panel.refresh({ derived: { innerDia: 9 } });
  expect(val.textContent).toContain("9");
  panel.dispose();
});

test("refresh({relevant}) still drives dimming — applyRelevance delegates", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const panel = buildControls(root, [{ id: "s", title: "S", controls: [
    { key: "od", type: "slider", label: "OD", min: 1, max: 20, step: 1 },
    { key: "h", type: "slider", label: "H", min: 1, max: 20, step: 1 },
  ] }], { od: 5, h: 5 }, () => {});
  panel.refresh({ relevant: new Set(["od"]) });
  const wraps = [...root.querySelectorAll(".slider")];
  expect(wraps[0].classList.contains("irrelevant")).toBe(false);
  expect(wraps[1].classList.contains("irrelevant")).toBe(true);
  panel.applyRelevance(new Set(["h"]));                    // old name still works
  expect(wraps[1].classList.contains("irrelevant")).toBe(false);
  panel.dispose();
});

test("a log slider maps its track logarithmically and round-trips through sync", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { r: 1 };
  const panel = buildControls(root, [{ id: "s", controls: [
    { key: "r", type: "slider", label: "R", min: 0.1, max: 100, step: 0.1, scale: "log" },
  ] }], params, () => {});
  const slider = root.querySelector('input[type="range"]');
  expect(slider.min).toBe("0");
  expect(slider.max).toBe("1000");
  // position 500 is the geometric midpoint: sqrt(0.1 * 100) ≈ 3.1623.
  // No step-rounding on the log path — the value is the exact mapping.
  slider.value = "500"; slider.dispatchEvent(new Event("input"));
  expect(params.r).toBeCloseTo(Math.sqrt(0.1 * 100), 6);
  // syncing back after a programmatic change lands the thumb where the value is
  params.r = 100; panel.syncValues(["r"]);
  expect(slider.value).toBe("1000");
  params.r = 0.1; panel.syncValues(["r"]);
  expect(slider.value).toBe("0");
  panel.dispose();
});

test("the value box on a log slider stays linear and clamps as usual", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { r: 1 };
  buildControls(root, [{ id: "s", controls: [
    { key: "r", type: "slider", min: 0.1, max: 100, step: 0.1, scale: "log" },
  ] }], params, () => {});
  const box = root.querySelector("input.num");
  box.value = "250"; box.dispatchEvent(new Event("change"));
  expect(params.r).toBe(100);   // clamped to max, linear semantics untouched
});

test("ticks render a datalist; snap quantizes slider input to the nearest tick", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { n: 6 };
  buildControls(root, [{ id: "s", controls: [
    { key: "n", type: "slider", min: 0, max: 12, step: 1, ticks: [0, 6, 12], snap: true },
  ] }], params, () => {});
  const slider = root.querySelector('input[type="range"]');
  const dl = root.querySelector("datalist");
  expect(dl).toBeTruthy();
  expect(slider.getAttribute("list")).toBe(dl.id);
  expect([...dl.querySelectorAll("option")].map((o) => o.value)).toEqual(["0", "6", "12"]);
  slider.value = "8"; slider.dispatchEvent(new Event("input"));
  expect(params.n).toBe(6);        // snapped to the nearest tick
  slider.value = "10"; slider.dispatchEvent(new Event("input"));
  expect(params.n).toBe(12);
});

test("recommended draws a band and warns the value box outside it", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { wall: 1.6 };
  const panel = buildControls(root, [{ id: "s", controls: [
    { key: "wall", type: "slider", min: 0.8, max: 4, step: 0.1, recommended: [1.2, 4] },
  ] }], params, () => {});
  const wrap = root.querySelector(".slider");
  const box = root.querySelector("input.num");
  expect(wrap.classList.contains("has-band")).toBe(true);
  expect(wrap.style.getPropertyValue("--band-lo")).toBe("12.5%");   // (1.2-0.8)/(4-0.8)
  expect(wrap.style.getPropertyValue("--band-hi")).toBe("100%");
  expect(box.classList.contains("warn")).toBe(false);
  box.value = "0.9"; box.dispatchEvent(new Event("input"));
  expect(box.classList.contains("warn")).toBe(true);
  params.wall = 2; panel.syncValues(["wall"]);
  expect(box.classList.contains("warn")).toBe(false);
  panel.dispose();
});
