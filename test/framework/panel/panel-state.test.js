import { expect, test } from "vitest";
import { buildTree } from "../../../src/framework/panel/model.js";
import { computeState } from "../../../src/framework/panel/panel-state.js";

const group = (over = {}) => ({ kind: "group", children: [], ...over });
const control = (key, over = {}) => ({ kind: "control", key, type: "slider", ...over });

const tree = () => buildTree([
  group({ id: "s", children: [
    control("gate", { type: "checkbox", on: 1 }),
    group({ id: "s/g", bare: true, when: { gate: { gt: 0 } }, children: [control("inner")] }),
    control("plain"),
  ] }),
]);

test("a control with no condition is visible and enabled", () => {
  const st = computeState(tree(), { params: { gate: 0, inner: 1, plain: 2 }, relevant: null });
  expect(st.get("s/2")).toMatchObject({ visible: true, disabled: false, dimmed: false });
});

test("a group whose condition is false is not visible", () => {
  const st = computeState(tree(), { params: { gate: 0, inner: 1, plain: 2 }, relevant: null });
  expect(st.get("s/g").visible).toBe(false);
});

test("a false group takes its subtree with it", () => {
  const st = computeState(tree(), { params: { gate: 0, inner: 1, plain: 2 }, relevant: null });
  expect(st.get("s/g/0").visible).toBe(false);
});

test("flipping the gate reveals the group and its children", () => {
  const st = computeState(tree(), { params: { gate: 1, inner: 1, plain: 2 }, relevant: null });
  expect(st.get("s/g").visible).toBe(true);
  expect(st.get("s/g/0").visible).toBe(true);
});

test("whenFalse:disable disables in place instead of hiding", () => {
  const t = buildTree([group({ id: "s", children: [
    control("a", { when: { m: "x" }, whenFalse: "disable" }),
  ] })]);
  const st = computeState(t, { params: { m: "y" }, relevant: null });
  expect(st.get("s/0")).toMatchObject({ visible: true, disabled: true });
});

test("relevance dims but never hides or disables", () => {
  const st = computeState(tree(), { params: { gate: 1 }, relevant: new Set(["gate"]) });
  expect(st.get("s/0").dimmed).toBe(false);       // gate is relevant
  expect(st.get("s/2")).toMatchObject({ dimmed: true, visible: true, disabled: false });
});

test("a non-Set relevant value means everything is relevant", () => {
  const st = computeState(tree(), { params: { gate: 1 }, relevant: Symbol("all") });
  expect(st.get("s/2").dimmed).toBe(false);
});

test("a section is dimmed-hidden when every control in it is irrelevant", () => {
  // The .section-hidden behavior applyRelevance had at controls.js:24-27.
  const st = computeState(tree(), { params: { gate: 1 }, relevant: new Set(["elsewhere"]) });
  expect(st.get("s").dimmed).toBe(true);
});

test("a section with at least one relevant control is not dimmed", () => {
  const st = computeState(tree(), { params: { gate: 1 }, relevant: new Set(["plain"]) });
  expect(st.get("s").dimmed).toBe(false);
});

test("a section with NO control keys dims under any relevance set", () => {
  // Legacy parity, and it is genuinely what controls.js:25 does: `keys` is empty,
  // so `[...keys].some(...)` is false and the section gets .section-hidden. Only a
  // preset-only section can hit this. Do not "fix" it here — a behavior change in
  // a phase whose whole claim is that nothing changed is how a refactor goes bad.
  const t = buildTree([group({ id: "p", children: [{ kind: "preset", presets: { A: {} } }] })]);
  expect(computeState(t, { params: {}, relevant: new Set(["anything"]) }).get("p").dimmed).toBe(true);
  expect(computeState(t, { params: {}, relevant: null }).get("p").dimmed).toBe(false);
});

test("a preset node never dims — relevance only applies to controls", () => {
  const t = buildTree([group({ id: "p", children: [
    { kind: "preset", presets: { A: {} } },
    control("od"),
  ] })]);
  const st = computeState(t, { params: {}, relevant: new Set(["elsewhere"]) });
  expect(st.get("p/0").dimmed).toBe(false);   // the picker
  expect(st.get("p/1").dimmed).toBe(true);    // the control
});
