import { expect, test } from "vitest";
import { desugar } from "../../../src/framework/panel/legacy.js";

test("a preset section becomes a group with a preset node and an Advanced group", () => {
  const tree = desugar([{
    id: "body", title: "Body", presets: { A: { od: 5 } },
    advanced: [{ key: "od", label: "OD", min: 1, max: 10, step: 1 }],
  }]);
  expect(tree).toHaveLength(1);
  const sec = tree[0];
  expect(sec.kind).toBe("group");
  expect(sec.title).toBe("Body");
  expect(sec.presets).toBeUndefined();          // the field is gone; it's a node now
  expect(sec.children).toHaveLength(2);
  expect(sec.children[0]).toMatchObject({ kind: "preset", presets: { A: { od: 5 } } });
  const adv = sec.children[1];
  expect(adv).toMatchObject({ kind: "group", title: "Advanced", collapsed: "auto" });
  expect(adv.children).toEqual([
    expect.objectContaining({ kind: "control", type: "slider", key: "od", label: "OD",
      min: 1, max: 10, step: 1, marksCustom: true }),
  ]);
});

test("the legacy preset field lands at position 0, where the picker renders today", () => {
  const [sec] = desugar([{
    id: "m", presets: { A: {} },
    toggles: [{ key: "show", label: "Show" }],
    advanced: [{ key: "od", min: 0, max: 10, step: 1 }],
  }]);
  expect(sec.children.map((c) => c.kind)).toEqual(["preset", "control", "group"]);
});

test("a section with no presets gets no preset node", () => {
  const [sec] = desugar([{ id: "m", toggles: [{ key: "show", label: "Show" }] }]);
  expect(sec.children.map((c) => c.kind)).toEqual(["control"]);
});

test("an empty presets object gets no preset node", () => {
  // sectionRenders treated `presets: {}` as "no presets" (controls.js:39), and a
  // picker with nothing but "Custom" in it is useless.
  const [sec] = desugar([{ id: "m", presets: {}, toggles: [{ key: "s", label: "S" }] }]);
  expect(sec.children.map((c) => c.kind)).toEqual(["control"]);
});

test("toggles become checkbox controls placed before the Advanced group", () => {
  const [sec] = desugar([{
    id: "m", title: "Motor",
    toggles: [{ key: "show", label: "Show", on: 1, description: "preview" }],
    advanced: [{ key: "od", label: "OD", min: 0, max: 10, step: 1 }],
  }]);
  expect(sec.children.map((c) => c.kind)).toEqual(["control", "group"]);
  expect(sec.children[0]).toMatchObject({
    kind: "control", type: "checkbox", key: "show", label: "Show",
    on: 1, preserveOn: false, description: "preview",
  });
});

test("a toggle with no `on` defaults to 1", () => {
  const [sec] = desugar([{ id: "m", toggles: [{ key: "show", label: "S" }] }]);
  expect(sec.children[0].on).toBe(1);
});

test("a feature becomes a checkbox plus a conditional bare group", () => {
  const [sec] = desugar([{
    id: "f", title: "Flange",
    features: [{ label: "Flange", key: "flange_d", on: 16,
      sliders: [{ key: "flange_d", label: "D", min: 1, max: 50, step: 1 }] }],
  }]);
  const adv = sec.children[0];
  expect(adv.title).toBe("Advanced");
  const [box, group] = adv.children;
  expect(box).toMatchObject({ kind: "control", type: "checkbox", key: "flange_d",
    on: 16, preserveOn: true });
  expect(group).toMatchObject({ kind: "group", bare: true,
    when: { flange_d: { gt: 0 } } });
  expect(group.children).toEqual([
    expect.objectContaining({ key: "flange_d", type: "slider", marksCustom: false }),
  ]);
});

test("hidden nodes are RETAINED — lint needs them", () => {
  const [sec] = desugar([{
    id: "body", hidden: true,
    advanced: [{ key: "secret", label: "S", min: 0, max: 1, step: 1, hidden: true }],
  }]);
  expect(sec.hidden).toBe(true);
  expect(sec.children[0].children[0]).toMatchObject({ key: "secret", hidden: true });
});

test("the legacy `control` field maps to `type`, defaulting to slider", () => {
  const [sec] = desugar([{ id: "b", advanced: [
    { key: "a", control: "number" }, { key: "b", control: "textarea" }, { key: "c" },
  ] }]);
  expect(sec.children[0].children.map((c) => c.type)).toEqual(["number", "textarea", "slider"]);
});

test("a feature with no sliders array does not throw", () => {
  // rules-schema.js flags this as an error, but desugar must survive it —
  // lint has to be able to walk a broken part in order to report on it.
  expect(() => desugar([{ id: "f", features: [{ key: "k", on: 1 }] }])).not.toThrow();
});

test("a preset-only section yields exactly one child — the picker", () => {
  const [sec] = desugar([{ id: "p", presets: { A: {} } }]);
  expect(sec.children.map((c) => c.kind)).toEqual(["preset"]);
});

test("a features section ignores presets, toggles and advanced — legacy routing", () => {
  // controls.js routes any section with `features` exclusively to
  // buildFeatureSection, which never reads the other arrays.
  const [sec] = desugar([{
    id: "f", presets: { A: {} }, toggles: [{ key: "t", label: "T" }],
    advanced: [{ key: "a", min: 0, max: 1, step: 1 }],
    features: [{ key: "k", on: 1, sliders: [{ key: "k", min: 0, max: 9, step: 1 }] }],
  }]);
  expect(sec.children).toHaveLength(1);
  expect(sec.children[0]).toMatchObject({ kind: "group", title: "Advanced" });
  expect(sec.children[0].children.map((c) => c.kind)).toEqual(["control", "group"]);
});
