// Playback state machine: intro gating, cue firing/disarming, stepped
// playback with stop-at-step-end, loop wrap, seek/reset semantics.
import { expect, test } from "vitest";
import { normalizeAnimation, createPlayback } from "../../src/framework/animation.js";

const open = normalizeAnimation("open", {
  camera: "front", duration: 2, easing: "linear", tracks: { lidAngle: [[0, 0], [1, 110]] },
});
const plain = normalizeAnimation("plain", { duration: 2, easing: "linear", tracks: { k: [[0, 0], [1, 100]] } });
const stepped = normalizeAnimation("assemble", {
  steps: [
    { label: "Lower", camera: "left", duration: 1, easing: "linear", tracks: { lift: [[0, 40], [1, 0]] } },
    { label: "Open", camera: "iso", duration: 1, easing: "linear", tracks: { angle: [[0, 0], [1, 110]] } },
  ],
});
const looped = normalizeAnimation("cycle", { duration: 2, loop: true, easing: "linear", tracks: { k: [[0, 0], [1, 100]] } });

test("play with a governing cue gates in intro; introDone starts playback", () => {
  const pb = createPlayback(open);
  const r = pb.play();
  expect(r.status).toBe("intro");
  expect(r.cue).toEqual({ t: 0, view: "front" });
  expect(pb.tick(0.5)).toBeNull(); // params hold during the intro
  expect(pb.introDone().status).toBe("playing");
  const f = pb.tick(0.5); // 0.5s of 2s → t=0.25
  expect(f.t).toBeCloseTo(0.25);
  expect(f.values.lidAngle).toBeCloseTo(27.5);
});

test("play without cues goes straight to playing and finishes at done", () => {
  const pb = createPlayback(plain);
  expect(pb.play().status).toBe("playing");
  const r = pb.tick(5);
  expect(r.status).toBe("done");
  expect(r.t).toBe(1);
  expect(r.values.k).toBe(100);
});

test("replay after done rewinds and re-arms the intro cue", () => {
  const pb = createPlayback(open);
  pb.play(); pb.introDone(); pb.tick(5);
  const r = pb.play();
  expect(r.status).toBe("intro");
  expect(r.t).toBe(0);
});

test("pause holds; resume does not re-fire the already-fired cue", () => {
  const pb = createPlayback(open);
  pb.play(); pb.introDone(); pb.tick(0.5);
  expect(pb.pause().status).toBe("paused");
  const r = pb.play();
  expect(r.status).toBe("playing"); // no second intro
  expect(r.cue).toBeNull();
});

test("seek pauses, and a later play re-honors the governing cue", () => {
  const pb = createPlayback(stepped);
  const s = pb.seek(0.75);
  expect(s.status).toBe("paused");
  expect(s.values.angle).toBeCloseTo(55);
  const r = pb.play();
  expect(r.status).toBe("intro");
  expect(r.cue).toEqual({ t: 0.5, view: "iso" });
});

test("a mid-timeline cue fires during tick without gating", () => {
  const pb = createPlayback(stepped);
  pb.play(); pb.introDone(); // consumes the t=0 "left" cue
  const r = pb.tick(1.1); // crosses t=0.5
  expect(r.status).toBe("playing");
  expect(r.cue).toEqual({ t: 0.5, view: "iso" });
});

test("disarmCues stops all cue traffic until reset", () => {
  const pb = createPlayback(stepped);
  pb.play(); pb.introDone();
  pb.disarmCues();
  expect(pb.tick(1.1).cue).toBeNull();
  pb.reset();
  expect(pb.play().status).toBe("intro"); // re-armed
});

test("stepNext plays exactly one step then pauses at its end", () => {
  const pb = createPlayback(stepped);
  const r = pb.stepNext(); // from idle t=0 (step 0) → plays step 1
  expect(r.stepIndex).toBe(1);
  expect(r.status).toBe("intro"); // step 2's iso cue gates
  pb.introDone();
  const done = pb.tick(5);
  expect(done.status).toBe("paused");
  expect(done.t).toBe(1);
});

test("stepPrev replays the previous step", () => {
  const pb = createPlayback(stepped);
  pb.seek(0.75);
  const r = pb.stepPrev();
  expect(r.t).toBe(0);
  expect(r.stepIndex).toBe(0);
});

test("loop wraps t and keeps playing", () => {
  const pb = createPlayback(looped);
  pb.play();
  const r = pb.tick(2.5); // 1.25 cycles
  expect(r.status).toBe("playing");
  expect(r.t).toBeCloseTo(0.25);
});

test("userEdited pauses only active playback", () => {
  const pb = createPlayback(plain);
  pb.userEdited();
  expect(pb.state().status).toBe("idle");
  pb.play(); pb.userEdited();
  expect(pb.state().status).toBe("paused");
});

test("reset returns to idle at t=0", () => {
  const pb = createPlayback(plain);
  pb.play(); pb.tick(1);
  const r = pb.reset();
  expect(r).toMatchObject({ t: 0, status: "idle", stepIndex: 0 });
});

// --- an intro cue is only retired once its tween actually settles --------------
// camera-tween's cancel() drops onComplete, so a cue retired at begin() would
// never be re-issued: pausing mid-sweep left the camera stranded wherever the
// cancelled tween stopped, for the rest of the run.

test("pausing mid-intro re-issues the cue on resume", () => {
  const pb = createPlayback(open);
  expect(pb.play().cue).toEqual({ t: 0, view: "front" });
  expect(pb.pause().status).toBe("paused");
  const again = pb.play();
  expect(again.status).toBe("intro");
  expect(again.cue).toEqual({ t: 0, view: "front" });
});

test("a settled intro cue is not re-issued by a later pause/play", () => {
  const pb = createPlayback(open);
  expect(pb.play().cue).toEqual({ t: 0, view: "front" });
  expect(pb.introDone().status).toBe("playing");
  pb.pause();
  const again = pb.play();
  expect(again.status).toBe("playing"); // no gate: nothing left to tween
  expect(again.cue).toBeNull();
});

test("seek(NaN) folds to 0 rather than stalling playback forever", () => {
  const pb = createPlayback(plain);
  expect(pb.seek(NaN).t).toBe(0);
  pb.play();
  const r = pb.tick(100); // well past the 2s duration
  expect(r.t).toBe(1);
  expect(r.status).toBe("done"); // an unclamped NaN never satisfies t >= 1
});

test("a pending step boundary outranks looping", () => {
  // Lint rejects loop on a stepped animation, so these rarely coexist — but an
  // explicit "play this step" must still stop where it was told rather than being
  // swallowed by the wrap and running forever.
  const loopedSteps = normalizeAnimation("x", { loop: true, steps: [
    { label: "One", duration: 1, easing: "linear", tracks: { k: [[0, 0], [1, 50]] } },
    { label: "Two", duration: 1, easing: "linear", tracks: { k: [[0, 50], [1, 100]] } },
  ] });
  const pb = createPlayback(loopedSteps);
  pb.playStep(0);
  let r;
  for (let i = 0; i < 20; i++) r = pb.tick(0.2) ?? r;
  expect(r.status).toBe("paused");
  expect(r.t).toBeCloseTo(0.5);
});
