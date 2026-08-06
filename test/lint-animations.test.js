// test/lint-animations.test.js
// Static animations-block validation. Each fixture perturbs one thing on a
// minimal valid part; assertions check the finding id lands on the right path.
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const base = () => ({
  meta: { title: "T" },
  parameters: [{ id: "s", title: "S", advanced: [
    { key: "a", label: "A", min: 0, max: 100, step: 1 },
  ] }],
  defaults: { a: 0, txt: "hi" },
  parts: { p: { views: ["v"], build: (k) => k.box({ size: [1, 1, 1] }) } },
  views: { v: { label: "V" } },
});
const withAnim = (anim) => ({ ...base(), animations: { x: anim } });
const ids = (r) => [...r.errors, ...r.warnings].map((f) => f.rule);

const valid = { duration: 1, tracks: { a: [[0, 0], [1, 100]] } };

test("a valid animation lints clean", () => {
  const r = lintPart(withAnim(valid));
  expect(ids(r).filter((i) => i.startsWith("animation"))).toEqual([]);
});

test("animations must be a plain object of plain objects", () => {
  expect(ids(lintPart({ ...base(), animations: [] }))).toContain("animations-not-object");
  expect(ids(lintPart({ ...base(), animations: { x: 5 } }))).toContain("animations-not-object");
});

test("tracks XOR steps", () => {
  expect(ids(lintPart(withAnim({ duration: 1 })))).toContain("animation-tracks-or-steps");
  expect(ids(lintPart(withAnim({ duration: 1, tracks: { a: [[0, 0], [1, 1]] }, steps: [] }))))
    .toContain("animation-tracks-or-steps");
});

test("track params must exist and be numeric", () => {
  expect(ids(lintPart(withAnim({ duration: 1, tracks: { nope: [[0, 0], [1, 1]] } }))))
    .toContain("animation-unknown-param");
  expect(ids(lintPart(withAnim({ duration: 1, tracks: { txt: [[0, 0], [1, 1]] } }))))
    .toContain("animation-param-not-numeric");
});

test("keyframes: sorted, 0/1 endpoints, finite pairs", () => {
  for (const kf of [[[0, 0]], [[0.2, 0], [1, 1]], [[0, 0], [0.9, 1]], [[0, 0], [0.5, 1], [0.4, 2], [1, 3]], [[0, 0], [1, "x"]]]) {
    expect(ids(lintPart(withAnim({ duration: 1, tracks: { a: kf } })))).toContain("animation-keyframes-invalid");
  }
});

test("keyframe values must sit inside the control's range", () => {
  expect(ids(lintPart(withAnim({ duration: 1, tracks: { a: [[0, 0], [1, 500]] } }))))
    .toContain("animation-value-out-of-range");
});

test("durations positive; loop only on single-step; labels unique; easing known; description a string", () => {
  expect(ids(lintPart(withAnim({ duration: 0, tracks: { a: [[0, 0], [1, 1]] } }))))
    .toContain("animation-duration-invalid");
  expect(ids(lintPart(withAnim({ loop: true, steps: [
    { label: "one", duration: 1, tracks: { a: [[0, 0], [1, 1]] } },
    { label: "two", duration: 1, tracks: { a: [[0, 1], [1, 0]] } },
  ] })))).toContain("animation-loop-invalid");
  expect(ids(lintPart(withAnim({ steps: [
    { label: "same", duration: 1, tracks: { a: [[0, 0], [1, 1]] } },
    { label: "same", duration: 1, tracks: { a: [[0, 1], [1, 0]] } },
  ] })))).toContain("animation-step-label-duplicate");
  expect(ids(lintPart(withAnim({ ...valid, easing: "bouncy" })))).toContain("animation-easing-unknown");
  expect(ids(lintPart(withAnim({ ...valid, description: 42 })))).toContain("animation-description-invalid");
});

test("camera: canonical names, sorted in-range cues, one mechanism per animation", () => {
  expect(ids(lintPart(withAnim({ ...valid, camera: "sideways" })))).toContain("animation-camera-invalid");
  expect(ids(lintPart(withAnim({ ...valid, camera: [[0.5, "iso"], [0.2, "front"]] })))).toContain("animation-camera-invalid");
  expect(ids(lintPart(withAnim({ ...valid, camera: [[0, "iso"], [2, "front"]] })))).toContain("animation-camera-invalid");
  expect(ids(lintPart(withAnim({ camera: "iso", steps: [
    { label: "one", camera: "front", duration: 1, tracks: { a: [[0, 0], [1, 1]] } },
  ] })))).toContain("animation-camera-invalid");
  // valid forms stay clean
  expect(ids(lintPart(withAnim({ ...valid, camera: [[0, "iso"], [0.5, "front"]] })))
    .filter((i) => i === "animation-camera-invalid")).toEqual([]);
});

test("classification: pose-only tracks are silent, geometry tracks get a note", () => {
  const poseOnly = {
    ...base(),
    parts: { p: { views: ["v"],
      build: (k) => k.box({ size: [10, 10, 10] }),
      place: (s, { p }) => s.rotate(-p.a, [0, 0, 0], [1, 0, 0]),
    } },
    animations: { x: { duration: 1, tracks: { a: [[0, 0], [1, 100]] } } },
  };
  expect(lintPart(poseOnly).notes.map((f) => f.rule)).toEqual([]);

  const rebuilds = {
    ...base(),
    parts: { p: { views: ["v"], build: (k, p) => k.box({ size: [10, 10, 10 + p.a] }) } },
    animations: { x: { duration: 1, tracks: { a: [[0, 0], [1, 100]] } } },
  };
  const notes = lintPart(rebuilds).notes;
  expect(notes.map((f) => f.rule)).toContain("animation-track-rebuilds");
  expect(notes[0].severity).toBe("note");
});

test("classification: a round-trip track on a geometry param still gets a note", () => {
  const rebuilds = {
    ...base(),
    parts: { p: { views: ["v"], build: (k, p) => k.box({ size: [10, 10, 10 + p.a] }) } },
    animations: { x: { duration: 1, tracks: { a: [[0, 0], [0.5, 100], [1, 0]] } } },
  };
  const r = lintPart(rebuilds);
  expect(r.notes.map((f) => f.rule)).toContain("animation-track-rebuilds");
  expect(r.ok).toBe(true); // notes never gate
});

test("classification: a round-trip track on a pose-only param stays silent", () => {
  const poseOnly = {
    ...base(),
    parts: { p: { views: ["v"],
      build: (k) => k.box({ size: [10, 10, 10] }),
      place: (s, { p }) => s.rotate(-p.a, [0, 0, 0], [1, 0, 0]),
    } },
    animations: { x: { duration: 1, tracks: { a: [[0, 0], [0.5, 100], [1, 0]] } } },
  };
  expect(lintPart(poseOnly).notes.map((f) => f.rule)).toEqual([]);
});

test("autoplay must be boolean and unique", () => {
  expect(ids(lintPart(withAnim({ ...valid, autoplay: "yes" })))).toContain("animation-autoplay-invalid");
  const two = { ...base(), animations: {
    a: { duration: 1, autoplay: true, tracks: { a: [[0, 0], [1, 1]] } },
    b: { duration: 1, autoplay: true, tracks: { a: [[0, 1], [1, 0]] } },
  } };
  expect(ids(lintPart(two))).toContain("animation-autoplay-invalid");
  expect(ids(lintPart(withAnim({ ...valid, autoplay: true }))).filter((i) => i === "animation-autoplay-invalid")).toEqual([]);
});

test("an easing named after an Object.prototype member is rejected", () => {
  // `easing in EASINGS` is true for every prototype member, so an `in`-based
  // check waved these through to a runtime that then threw mid-frame.
  for (const easing of ["__proto__", "toString", "constructor", "isPrototypeOf"]) {
    const r = lintPart(withAnim({ ...valid, easing }));
    expect(ids(r), `easing: ${easing}`).toContain("animation-easing-unknown");
  }
});

// --- lint and the runtime have to agree about what a valid block is -----------

const twoStep = (extra) => ({ ...extra, steps: [
  { label: "One", duration: 1, tracks: { a: [[0, 0], [1, 50]] } },
  { label: "Two", duration: 1, tracks: { a: [[0, 50], [1, 100]] } },
] });

test("a truthy non-boolean `loop` is rejected, not waved through", () => {
  // normalizeAnimation stores `!!spec.loop`, so `loop: 1` really does loop — and
  // on a stepped animation that makes the step-boundary stop unreachable.
  for (const loop of [1, "yes", {}, []]) {
    expect(ids(lintPart(withAnim(twoStep({ loop })))), `loop: ${JSON.stringify(loop)}`)
      .toContain("animation-loop-invalid");
  }
  expect(ids(lintPart(withAnim({ ...valid, loop: false })))).not.toContain("animation-loop-invalid");
  expect(ids(lintPart(withAnim({ ...valid, loop: true })))).not.toContain("animation-loop-invalid");
});

test("a truthy non-boolean `loop` is caught on a SINGLE-step animation too", () => {
  // The multi-step rule would flag `loop: 1` anyway (it tests truthiness), so this
  // single-phase case is what actually pins the type check: nothing else can fire.
  expect(ids(lintPart(withAnim({ ...valid, loop: 1 })))).toContain("animation-loop-invalid");
  expect(ids(lintPart(withAnim({ ...valid, loop: "yes" })))).toContain("animation-loop-invalid");
});

test("a non-boolean `loop` reports once, not twice", () => {
  const found = ids(lintPart(withAnim(twoStep({ loop: 1 })))).filter((i) => i === "animation-loop-invalid");
  expect(found).toHaveLength(1); // the type error supersedes the multi-step check
});

test("a camera-only step is allowed — it holds the pose and moves the camera", () => {
  const part = withAnim({ steps: [
    { label: "Look", camera: "iso", duration: 1 },
    { label: "Move", duration: 1, tracks: { a: [[0, 0], [1, 100]] } },
  ] });
  expect(ids(lintPart(part))).not.toContain("animation-tracks-or-steps");
});

test("an animation where no step has tracks is still rejected", () => {
  const part = withAnim({ steps: [
    { label: "Look", camera: "iso", duration: 1 },
    { label: "Also look", camera: "front", duration: 1 },
  ] });
  expect(ids(lintPart(part))).toContain("animation-tracks-or-steps");
});

test("an explicit `camera: null` reads as no camera, not as a malformed one", () => {
  const part = withAnim({ camera: null, steps: [
    { label: "One", camera: "iso", duration: 1, tracks: { a: [[0, 0], [1, 50]] } },
    { label: "Two", camera: "front", duration: 1, tracks: { a: [[0, 50], [1, 100]] } },
  ] });
  expect(ids(lintPart(part))).not.toContain("animation-camera-invalid");
});
