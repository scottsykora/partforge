// Element store: undo snapshots, notifications, interval math.
import { expect, test } from "vitest";
import {
  createElementStore, mergeGaps, inGaps, visibleFraction,
  INK_COLORS, DEFAULT_STROKE_WIDTH, SNAP_RATIO, MIN_VISIBLE,
} from "../../../src/framework/annotate/elements.js";

const line = (over = {}) => ({
  type: "line", color: "red", width: DEFAULT_STROKE_WIDTH,
  params: { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 }, gaps: [], ...over,
});

test("constants are pinned to the spec", () => {
  expect(INK_COLORS).toEqual({ red: "#d92d20", blue: "#1570ef", green: "#079455" });
  expect(DEFAULT_STROKE_WIDTH).toBe(0.004);
  expect(SNAP_RATIO).toBe(0.12);
  expect(MIN_VISIBLE).toBe(0.02);
});

test("mergeGaps sorts, merges overlaps and near-touching spans", () => {
  expect(mergeGaps([])).toEqual([]);
  expect(mergeGaps([[0.5, 0.6], [0.1, 0.2]])).toEqual([[0.1, 0.2], [0.5, 0.6]]);
  expect(mergeGaps([[0.1, 0.3], [0.2, 0.4]])).toEqual([[0.1, 0.4]]);
  expect(mergeGaps([[0.1, 0.2], [0.20005, 0.3]])).toEqual([[0.1, 0.3]]); // touching within 1e-4
});

test("inGaps and visibleFraction", () => {
  const gaps = [[0.2, 0.3], [0.6, 0.7]];
  expect(inGaps(0.25, gaps)).toBe(true);
  expect(inGaps(0.5, gaps)).toBe(false);
  expect(visibleFraction({ gaps })).toBeCloseTo(0.8);
  expect(visibleFraction({ gaps: [] })).toBe(1);
});

test("snapshot/undo restores the previous list; canUndo tracks the stack", () => {
  const store = createElementStore();
  expect(store.canUndo()).toBe(false);
  store.snapshot();
  store.add(line());
  expect(store.count()).toBe(1);
  store.snapshot();
  store.add(line({ color: "blue" }));
  expect(store.count()).toBe(2);
  store.undo();
  expect(store.count()).toBe(1);
  expect(store.list()[0].color).toBe("red");
  store.undo();
  expect(store.isEmpty()).toBe(true);
  expect(store.canUndo()).toBe(false);
  store.undo(); // empty stack: no throw, no change
  expect(store.isEmpty()).toBe(true);
});

test("undo restores deep clones — later mutation of the live list cannot corrupt history", () => {
  const store = createElementStore();
  store.snapshot();
  store.add(line());
  store.snapshot();
  store.list()[0].params.x1 = 0.5; // an edit after the snapshot
  store.undo();
  expect(store.list()[0].params.x1).toBe(0.1);
});

test("add/touch/setList/clear notify; unsubscribe stops notifications", () => {
  const store = createElementStore();
  let calls = 0;
  const off = store.onChange(() => { calls += 1; });
  store.add(line());          // 1
  store.touch(store.list()[0]); // 2
  store.setList([]);          // 3
  store.clear();              // empty already: no-op, still 3
  expect(calls).toBe(3);
  off();
  store.add(line());
  expect(calls).toBe(3);
});

test("clear snapshots so undo brings everything back", () => {
  const store = createElementStore();
  store.snapshot();
  store.add(line());
  store.clear();
  expect(store.isEmpty()).toBe(true);
  store.undo();
  expect(store.count()).toBe(1);
});
