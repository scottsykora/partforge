import { expect, test } from "vitest";
import { buildTree, controlNodes, evalWhen, WHEN_OPS } from "../../../src/framework/panel/model.js";

const group = (over = {}) => ({ kind: "group", children: [], ...over });
const control = (key, over = {}) => ({ kind: "control", key, type: "slider", ...over });

test("buildTree drops hidden controls, hidden groups, and groups left empty", () => {
  const tree = buildTree([
    group({ title: "A", children: [control("a"), control("b", { hidden: true })] }),
    group({ title: "B", children: [control("c", { hidden: true })] }),
    group({ title: "C", hidden: true, children: [control("d")] }),
  ]);
  expect(tree.map((g) => g.title)).toEqual(["A"]);
  expect(tree[0].children.map((c) => c.key)).toEqual(["a"]);
});

test("a preset-only group survives — the picker is a child like anything else", () => {
  const tree = buildTree([group({ title: "P", children: [{ kind: "preset", presets: { A: {} } }] })]);
  expect(tree).toHaveLength(1);
  expect(tree[0].children[0].id).toBe("0/0");
});

test("a group whose only child is hidden is dropped", () => {
  const tree = buildTree([group({ title: "P", children: [control("x", { hidden: true })] })]);
  expect(tree).toEqual([]);
});

test("buildTree assigns stable positional ids, honouring an authored id", () => {
  const tree = buildTree([
    group({ id: "body", children: [control("a"), group({ children: [control("b")] })] }),
    group({ children: [control("c")] }),
  ]);
  expect(tree[0].id).toBe("body");
  expect(tree[0].children[0].id).toBe("body/0");
  expect(tree[0].children[1].id).toBe("body/1");
  expect(tree[0].children[1].children[0].id).toBe("body/1/0");
  expect(tree[1].id).toBe("1");
});

test("ids are stable across repeated builds of the same schema", () => {
  const schema = () => [group({ children: [control("a"), control("b")] })];
  const ids = (t) => controlNodes(t).map((c) => c.id);
  expect(ids(buildTree(schema()))).toEqual(ids(buildTree(schema())));
});

test("controlNodes walks depth-first and returns only controls", () => {
  const tree = buildTree([group({ children: [
    control("a"),
    group({ children: [control("b"), control("c")] }),
    control("d"),
  ] })]);
  expect(controlNodes(tree).map((c) => c.key)).toEqual(["a", "b", "c", "d"]);
});

test("evalWhen: absent condition is always true", () => {
  expect(evalWhen(undefined, { a: 1 })).toBe(true);
});

test("evalWhen: bare value is equality", () => {
  expect(evalWhen({ mode: "round" }, { mode: "round" })).toBe(true);
  expect(evalWhen({ mode: "round" }, { mode: "square" })).toBe(false);
});

test("evalWhen: every comparison operator", () => {
  expect(evalWhen({ w: { gt: 2 } }, { w: 3 })).toBe(true);
  expect(evalWhen({ w: { gt: 2 } }, { w: 2 })).toBe(false);
  expect(evalWhen({ w: { gte: 2 } }, { w: 2 })).toBe(true);
  expect(evalWhen({ w: { lt: 2 } }, { w: 1 })).toBe(true);
  expect(evalWhen({ w: { lte: 2 } }, { w: 2 })).toBe(true);
  expect(evalWhen({ w: { ne: 2 } }, { w: 3 })).toBe(true);
  expect(evalWhen({ w: { in: [1, 2] } }, { w: 2 })).toBe(true);
  expect(evalWhen({ w: { in: [1, 2] } }, { w: 3 })).toBe(false);
});

test("evalWhen: multiple keys in one object are ANDed", () => {
  expect(evalWhen({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
  expect(evalWhen({ a: 1, b: 2 }, { a: 1, b: 9 })).toBe(false);
});

test("evalWhen: allOf, anyOf, not", () => {
  expect(evalWhen({ allOf: [{ a: 1 }, { b: 2 }] }, { a: 1, b: 2 })).toBe(true);
  expect(evalWhen({ allOf: [{ a: 1 }, { b: 2 }] }, { a: 1, b: 9 })).toBe(false);
  expect(evalWhen({ anyOf: [{ a: 1 }, { b: 2 }] }, { a: 9, b: 2 })).toBe(true);
  expect(evalWhen({ anyOf: [{ a: 1 }, { b: 2 }] }, { a: 9, b: 9 })).toBe(false);
  expect(evalWhen({ not: { a: 1 } }, { a: 2 })).toBe(true);
  expect(evalWhen({ not: { a: 1 } }, { a: 1 })).toBe(false);
});

test("evalWhen: the legacy feature gate reads as expected", () => {
  expect(evalWhen({ flange_d: { gt: 0 } }, { flange_d: 16 })).toBe(true);
  expect(evalWhen({ flange_d: { gt: 0 } }, { flange_d: 0 })).toBe(false);
});

test("evalWhen: an unknown operator is false, never a throw", () => {
  expect(evalWhen({ w: { bogus: 1 } }, { w: 5 })).toBe(false);
});

test("WHEN_OPS is the single source of truth for operator names", () => {
  expect(Object.keys(WHEN_OPS).sort()).toEqual(["gt", "gte", "in", "lt", "lte", "ne"]);
});
