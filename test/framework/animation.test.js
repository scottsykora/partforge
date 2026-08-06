// test/framework/animation.test.js
// Timeline model: normalization (tracks→steps, camera desugaring) and
// evaluation (per-step easing, hold-outside-segment, cue lookup).
import { expect, test } from "vitest";
import {
  EASINGS, DEFAULT_EASING, normalizeAnimation, normalizeAnimations,
  evaluate, stepIndexAt, cueAt,
} from "../../src/framework/animation.js";

const open = {
  label: "Open lid", camera: "front", duration: 1.2,
  tracks: { lidAngle: [[0, 0], [1, 110]] },
};
const assemble = {
  label: "Assembly",
  steps: [
    { label: "Lower", camera: "left", duration: 1.0, tracks: { lidLift: [[0, 40], [1, 0]] } },
    { label: "Open", camera: "iso", duration: 1.0, tracks: { lidAngle: [[0, 0], [1, 110]] } },
  ],
};

test("single-track animation normalizes to one anonymous step", () => {
  const a = normalizeAnimation("open", open);
  expect(a.steps).toHaveLength(1);
  expect(a.totalDuration).toBeCloseTo(1.2);
  expect(a.stepStarts).toEqual([0]);
  expect(a.steps[0].easing).toBe(DEFAULT_EASING);
  expect(a.trackedKeys).toEqual(["lidAngle"]);
});

test("animation-level camera name desugars to a cue at t=0", () => {
  expect(normalizeAnimation("open", open).cues).toEqual([{ t: 0, view: "front" }]);
});

test("per-step cameras desugar to cues at step starts", () => {
  const a = normalizeAnimation("assemble", assemble);
  expect(a.stepStarts).toEqual([0, 0.5]);
  expect(a.cues).toEqual([{ t: 0, view: "left" }, { t: 0.5, view: "iso" }]);
});

test("cue-list camera passes through", () => {
  const a = normalizeAnimation("x", { duration: 1, camera: [[0, "iso"], [0.4, "top"]], tracks: { k: [[0, 0], [1, 1]] } });
  expect(a.cues).toEqual([{ t: 0, view: "iso" }, { t: 0.4, view: "top" }]);
});

test("evaluate interpolates linearly under linear easing", () => {
  const a = normalizeAnimation("x", { duration: 1, easing: "linear", tracks: { k: [[0, 0], [1, 100]] } });
  expect(evaluate(a, 0.25).values.k).toBeCloseTo(25);
  expect(evaluate(a, 1).values.k).toBe(100);
});

test("default easing is smooth: midpoint exact, quarter below linear", () => {
  const a = normalizeAnimation("x", { duration: 1, tracks: { k: [[0, 0], [1, 100]] } });
  expect(evaluate(a, 0.5).values.k).toBeCloseTo(50);
  expect(evaluate(a, 0.25).values.k).toBeLessThan(25);
});

test("params hold outside their segment (before: first value, after: last)", () => {
  const a = normalizeAnimation("assemble", assemble);
  // during step 1, lidAngle (tracked only in step 2) holds its first keyframe value
  expect(evaluate(a, 0.25).values.lidAngle).toBe(0);
  // during step 2, lidLift holds its final value from step 1
  expect(evaluate(a, 0.75).values.lidLift).toBe(0);
  expect(evaluate(a, 0.75).stepIndex).toBe(1);
});

test("stepIndexAt clamps and maps boundaries to the later step", () => {
  const a = normalizeAnimation("assemble", assemble);
  expect(stepIndexAt(a, 0)).toBe(0);
  expect(stepIndexAt(a, 0.5)).toBe(1);
  expect(stepIndexAt(a, 1)).toBe(1);
  expect(stepIndexAt(a, 2)).toBe(1);
});

test("cueAt returns the governing (most recent at-or-before) cue", () => {
  const a = normalizeAnimation("assemble", assemble);
  expect(cueAt(a, 0.3)).toEqual({ t: 0, view: "left" });
  expect(cueAt(a, 0.9)).toEqual({ t: 0.5, view: "iso" });
});

test("normalizeAnimations reads part.animations, tolerates absence", () => {
  expect(normalizeAnimations({})).toEqual([]);
  expect(normalizeAnimations({ animations: { open } })[0].name).toBe("open");
});

test("EASINGS endpoints are exact", () => {
  for (const fn of Object.values(EASINGS)) { expect(fn(0)).toBe(0); expect(fn(1)).toBe(1); }
});

test("normalizeAnimation carries autoplay as a boolean, default false", () => {
  expect(normalizeAnimation("x", { duration: 1, tracks: { k: [[0, 0], [1, 1]] } }).autoplay).toBe(false);
  expect(normalizeAnimation("x", { duration: 1, autoplay: true, tracks: { k: [[0, 0], [1, 1]] } }).autoplay).toBe(true);
});
