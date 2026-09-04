// test/framework/stage-clear.test.js
// The arithmetic behind --pf-viewbar-clear and --pf-anim-clear. The case that
// matters is the empty box: a bar hidden by ANYONE measures all zeros, and
// `stageRect.bottom - 0` is the stage's own bottom edge in viewport px — a
// claim as tall as the stage, which is what flung the view cube and a host's
// pills off screen whenever a host stylesheet hid the bar.
import { expect, test } from "vitest";
import { stageClearFor } from "../../src/framework/stage-clear.js";

const stage = { top: 100, bottom: 700, height: 600 };

test("a visible bar claims the distance from the stage's bottom to its top, rounded", () => {
  expect(stageClearFor(stage, { top: 640, bottom: 680, height: 40 })).toBe(60);
  expect(stageClearFor(stage, { top: 640.4, bottom: 680, height: 39.6 })).toBe(60);
});

test("a bar with no box claims nothing, whoever hid it", () => {
  expect(stageClearFor(stage, { top: 0, bottom: 0, height: 0 })).toBe(0);
  expect(stageClearFor(stage, null)).toBe(0);
});

test("never negative: a bar below the stage's edge claims 0", () => {
  expect(stageClearFor(stage, { top: 720, bottom: 760, height: 40 })).toBe(0);
});
