import { expect, test } from "vitest";
import { desugar, visibleAdvanced, visibleFeatures, visibleToggles, sectionRenders }
  from "../../../src/framework/panel/legacy.js";

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

// Pinning: rules-schema.js's collectDescriptors walks these same arrays with a
// per-entry null guard, so lint hands the four predicates and desugar() a part
// that can contain null entries — a malformed-but-not-yet-flagged part. None of
// the five may throw on that input; a throw aborts the whole rule and lint
// reports a generic internal-rule-error instead of the specific finding.
test("visibleAdvanced/visibleFeatures/visibleToggles skip null entries without throwing", () => {
  const sec = { advanced: [null, { key: "a" }], features: [null, { key: "f" }], toggles: [null, { key: "t" }] };
  expect(() => visibleAdvanced(sec)).not.toThrow();
  expect(() => visibleFeatures(sec)).not.toThrow();
  expect(() => visibleToggles(sec)).not.toThrow();
  expect(visibleAdvanced(sec)).toEqual([{ key: "a" }]);
  expect(visibleFeatures(sec)).toEqual([{ key: "f" }]);
  expect(visibleToggles(sec)).toEqual([{ key: "t" }]);
});

test("sectionRenders does not throw on a section with null feature/advanced/toggle entries", () => {
  expect(() => sectionRenders({ features: [null, { key: "f" }] })).not.toThrow();
  expect(() => sectionRenders({ advanced: [null, { key: "a" }] })).not.toThrow();
  expect(() => sectionRenders({ toggles: [null, { key: "t" }] })).not.toThrow();
  expect(sectionRenders({ features: [null] })).toBe(false);
  expect(sectionRenders({ features: [null, { key: "f" }] })).toBe(true);
});

test("desugar survives a null entry in features, advanced, or toggles", () => {
  expect(() => desugar([{ id: "f", features: [null, { key: "k", on: 1, sliders: [null, { key: "s", min: 0, max: 1, step: 1 }] }] }]))
    .not.toThrow();
  expect(() => desugar([{ id: "a", advanced: [null, { key: "a", min: 0, max: 1, step: 1 }] }])).not.toThrow();
  expect(() => desugar([{ id: "t", toggles: [null, { key: "t", label: "T" }] }])).not.toThrow();

  const [fsec] = desugar([{ id: "f", features: [null, { key: "k", on: 1, sliders: [null, { key: "s", min: 0, max: 1, step: 1 }] }] }]);
  const [box, group] = fsec.children[0].children;
  expect(box).toMatchObject({ key: "k", type: "checkbox" });
  expect(group.children).toEqual([expect.objectContaining({ key: "s" })]);

  const [asec] = desugar([{ id: "a", advanced: [null, { key: "a", min: 0, max: 1, step: 1 }] }]);
  expect(asec.children[0].children).toEqual([expect.objectContaining({ key: "a" })]);

  const [tsec] = desugar([{ id: "t", toggles: [null, { key: "t", label: "T" }] }]);
  expect(tsec.children).toEqual([expect.objectContaining({ key: "t" })]);
});
