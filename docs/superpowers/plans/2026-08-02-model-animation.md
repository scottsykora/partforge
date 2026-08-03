# Model Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Part authors declare named keyframe animations (with steps, camera cues, and markdown descriptions) on a `PartDefinition`; end users play/scrub/step them in the viewer; lint validates them and the CLI renders animation stills.

**Architecture:** A pure timeline model + playback state machine (`animation.js`, no DOM/clock) is ticked by a driver inside the viewer's existing render loop and applies param values through the existing `setParams` path — the pose fast path repairs pose-only params at frame rate; geometry params rebuild best-effort via a new debounce-free `markDirty` mode. Camera cues drive a retargetable orbit tween. Lint gains static animation rules, a note tier, probe-based track classification, and the two `place()` invariant rules. CLI `render` gains `--params` and `--animation/--at/--step`.

**Tech Stack:** Plain ESM JS (no TypeScript), three.js (viewer only), vitest (`happy-dom` for DOM tests), Node 24.

**Spec:** `docs/superpowers/specs/2026-08-02-model-animation-design.md` — read it before starting any task.

## Global Constraints

- **Node 24 required**: run `nvm use` before `npm install`, any test, or the CLI (AGENTS.md — wrong Node fails confusingly).
- Plain ESM JavaScript only — no TypeScript syntax anywhere.
- Part modules stay **DOM-free and side-effect-free**; `build`/`place` stay pure functions of `(k, p, d)` / `(solid, ctx)`.
- **Lint purity**: nothing imported (transitively) by `src/framework/lint/**` may reach `three`, `manifold-3d`, or `replicad` — enforced by `test/lint-purity.test.js`. This is why Task 9 splits `pose-probe.js`.
- `src/framework/animation.js` must import **nothing** (pure data/math) so lint and the Node CLI can both import it. Camera math lives separately in `camera-tween.js` (which may import `three`).
- Units are millimetres. Display placement must not depend on the active view; display-vs-export deltas must be rigid.
- On any build/test failure, grep `docs/ERROR-PATTERNS.md` for the symptom first.
- Run a single test file with `npx vitest run test/<file>` — never the whole suite mid-task (it boots WASM kernels and is slow). Full `npm test` happens at the end of Tasks 7 and 12.
- Commit after every green test cycle. Do not run `npm publish`; version bump only (Task 12).

## File Structure

| File | Responsibility |
| --- | --- |
| `src/framework/animation.js` (new) | Pure: easings, contract normalization, timeline evaluation, camera-cue lookup, playback state machine. Zero imports. |
| `src/framework/camera-tween.js` (new) | Pure retargetable orbit tween math (spherical interpolation). Imports `three` + `animation.js`. |
| `src/framework/animation-controls.js` (new) | Transport bar DOM + playback driver (ticks state machine from viewer frames, applies values, fires camera tweens). |
| `src/framework/viewer.js` (modify) | `onFrame(cb)` hook with dt, `tweenCameraTo`/`cancelCameraTween`, `onCameraStart`, `suppressAutoRotate`. |
| `src/framework/regen-loop.js` (modify) | `markDirty({ debounce })` opt-out. |
| `src/framework/mount.js` (modify) | Wire animation controls, `applyAnimationValues`, user-edit pause notifications, `runtime.animation` on the handle. |
| `src/framework/controls.js` (modify) | Export `createInfoPopover` + `attachInfo` for reuse by the transport bar. |
| `src/framework/chrome.css` (modify) | `.pf-anim-*` transport bar styles. |
| `src/framework/pose-probe-core.js` (new, Task 9) | `makeProbeSession` + `probeSubPartPose` split out of `pose-probe.js` so lint can import it (purity). |
| `src/framework/lint/rules-animations.js` (new) | Static animation contract rules + probe-based track classification note. |
| `src/framework/lint/rules-place.js` (new) | `view-dependent-display-place` and `place-not-rigid` probe rules. |
| `src/framework/lint/finding.js` + `index.js` (modify) | `note` severity tier; `notes` array on the lint report. |
| `bin/cli.js` + `src/testing/render.js` (modify) | `--params`, `--animation/--at/--step`, filename `tag`. |
| `src/parts/hinged-box.js` + glue (new) | Reference part: hinged lid, `open`/`cycle`/`assemble` animations. |

Task order: 1 → 2 → (3, 4 independent) → 5 → 6 → 7; 8 → 9 → 10 (lint track, independent of 3–7); 11 (needs 1 and 7); 12 last.

---

### Task 1: Timeline model (`animation.js`: normalize + evaluate)

**Files:**
- Create: `src/framework/animation.js`
- Test: `test/framework/animation.test.js`

**Interfaces:**
- Produces: `EASINGS` (map name → fn), `DEFAULT_EASING`, `normalizeAnimation(name, spec) → anim`, `normalizeAnimations(part) → anim[]`, `evaluate(anim, t) → { stepIndex, values }`, `stepIndexAt(anim, t) → number`, `cueAt(anim, t) → { t, view } | null`.
- The normalized `anim` shape (relied on by Tasks 2, 5, 8, 11): `{ name, label, description, loop, steps: [{ label, duration, easing, tracks, camera }], stepStarts: number[], totalDuration, cues: [{ t, view }], trackedKeys: string[] }`.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/framework/animation.test.js`
Expected: FAIL — cannot resolve `src/framework/animation.js`.

- [ ] **Step 3: Implement `src/framework/animation.js` (model half)**

```js
// Timeline model + playback state machine for part-declared animations
// (spec: docs/superpowers/specs/2026-08-02-model-animation-design.md).
// Pure and import-free on purpose: no DOM, no clock, no three — the driver
// (animation-controls.js) owns time and the viewer owns rendering, and both
// partforge/lint and the Node CLI import this module, so it must satisfy the
// lint purity guarantee (test/lint-purity.test.js).

export const EASINGS = {
  linear: (t) => t,
  "ease-in": (t) => t * t,
  "ease-out": (t) => 1 - (1 - t) * (1 - t),
  "ease-in-out": (t) => t * t * (3 - 2 * t),
};
export const DEFAULT_EASING = "ease-in-out";

// Normalize one animations-map entry to the canonical shape every consumer
// (playback, transport UI, lint, CLI) works against: a step list (a bare
// `tracks` form becomes one anonymous step), normalized step starts, and the
// camera declaration desugared to a sorted cue list. Assumes lint-valid input;
// runtime callers guard with try/catch (see attachAnimationControls).
export function normalizeAnimation(name, spec) {
  const steps = spec.steps
    ? spec.steps.map((s, i) => ({
        label: s.label ?? `Step ${i + 1}`,
        duration: s.duration,
        easing: s.easing ?? spec.easing ?? DEFAULT_EASING,
        tracks: s.tracks ?? {},
        camera: s.camera ?? null,
      }))
    : [{
        label: null, duration: spec.duration,
        easing: spec.easing ?? DEFAULT_EASING,
        tracks: spec.tracks ?? {}, camera: null,
      }];
  const totalDuration = steps.reduce((sum, s) => sum + s.duration, 0) || 1;
  let acc = 0;
  const stepStarts = steps.map((s) => { const t = acc / totalDuration; acc += s.duration; return t; });
  let cues;
  if (typeof spec.camera === "string") cues = [{ t: 0, view: spec.camera }];
  else if (Array.isArray(spec.camera)) cues = spec.camera.map(([t, view]) => ({ t, view }));
  else cues = steps.flatMap((s, i) => (s.camera ? [{ t: stepStarts[i], view: s.camera }] : []));
  const trackedKeys = [...new Set(steps.flatMap((s) => Object.keys(s.tracks)))];
  return {
    name, label: spec.label ?? name, description: spec.description ?? null,
    loop: !!spec.loop, steps, stepStarts, totalDuration, cues, trackedKeys,
  };
}

export function normalizeAnimations(part) {
  return Object.entries(part?.animations ?? {}).map(([name, spec]) => normalizeAnimation(name, spec));
}

// Step containing t. Boundaries belong to the LATER step, and t clamps to [0,1].
export function stepIndexAt(anim, t) {
  const tc = Math.min(1, Math.max(0, t));
  let idx = 0;
  for (let i = 0; i < anim.stepStarts.length; i++) if (tc >= anim.stepStarts[i]) idx = i;
  return idx;
}

// Most recent cue at or before t, or null. This is both the CLI's default
// camera for a still and the cue play() honors when starting mid-timeline.
export function cueAt(anim, t) {
  let g = null;
  for (const c of anim.cues) if (c.t <= t) g = c;
  return g;
}

// The timeline segments (global [start,end] spans) in which `key` is tracked.
function segmentsFor(anim, key) {
  const out = [];
  anim.steps.forEach((step, i) => {
    const kf = step.tracks[key];
    if (!kf) return;
    const start = anim.stepStarts[i];
    const end = i + 1 < anim.steps.length ? anim.stepStarts[i + 1] : 1;
    out.push({ start, end, keyframes: kf, easing: step.easing });
  });
  return out;
}

// Piecewise-linear keyframe interpolation at (already-eased) local time u.
function interpKeyframes(kf, u) {
  if (u <= kf[0][0]) return kf[0][1];
  for (let i = 1; i < kf.length; i++) {
    const [t1, v1] = kf[i];
    if (u <= t1) {
      const [t0, v0] = kf[i - 1];
      return t1 === t0 ? v1 : v0 + (v1 - v0) * ((u - t0) / (t1 - t0));
    }
  }
  return kf[kf.length - 1][1];
}

function evaluateTrack(anim, key, t) {
  const segs = segmentsFor(anim, key);
  let prev = null;
  for (const seg of segs) {
    if (t < seg.start) break;
    if (t <= seg.end) {
      const span = seg.end - seg.start || 1;
      const local = (EASINGS[seg.easing] ?? EASINGS[DEFAULT_EASING])((t - seg.start) / span);
      return interpKeyframes(seg.keyframes, local);
    }
    prev = seg;
  }
  // Outside every segment: hold the nearest boundary value, so a param tracked
  // only in step 2 doesn't jump while step 1 plays.
  return prev ? prev.keyframes[prev.keyframes.length - 1][1] : segs[0].keyframes[0][1];
}

// Evaluate the whole animation at normalized position t ∈ [0,1] (over the
// TOTAL duration — the same t the scrubber, seek(t), and the CLI's --at use).
export function evaluate(anim, t) {
  const tc = Math.min(1, Math.max(0, t));
  const values = {};
  for (const key of anim.trackedKeys) values[key] = evaluateTrack(anim, key, tc);
  return { stepIndex: stepIndexAt(anim, tc), values };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/framework/animation.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/animation.js test/framework/animation.test.js
git commit -m "feat(animation): timeline model — normalize, evaluate, camera cues"
```

---

### Task 2: Playback state machine (`animation.js`: createPlayback)

**Files:**
- Modify: `src/framework/animation.js` (append)
- Test: `test/framework/animation-state.test.js`

**Interfaces:**
- Consumes: `normalizeAnimation`, `evaluate`, `stepIndexAt` from Task 1.
- Produces: `createPlayback(anim)` returning `{ play(), pause(), toggle(), introDone(), seek(t), stepNext(), stepPrev(), playStep(i), reset(), disarmCues(), userEdited(), tick(dtSeconds), state() }`. Every mutator returns a snapshot `{ t, status, stepIndex, values, cue }` (cue only when one fired); `tick` returns that snapshot or `null` when not playing; `state()` returns `{ status, t, stepIndex }`. `status ∈ "idle" | "intro" | "playing" | "paused" | "done"`. Tasks 5–6 and the runtime surface rely on these exact names.

- [ ] **Step 1: Write the failing test**

```js
// test/framework/animation-state.test.js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/framework/animation-state.test.js`
Expected: FAIL — `createPlayback` is not exported.

- [ ] **Step 3: Append `createPlayback` to `src/framework/animation.js`**

```js
// --- playback state machine --------------------------------------------------
// Owns WHAT the animation is doing (position, status, cue arming); the driver
// owns WHEN (it feeds dt from the viewer's frame loop) and WHERE the results
// go (params + camera tweens). Statuses: idle → intro (a governing camera cue
// is tweening; params hold) → playing → paused/done. "intro" is entered on any
// play() with an armed, unfired cue at-or-before the current position — that
// covers both the t=0 intro and play-from-the-middle honoring the governing
// cue. Cues crossed DURING playback fire without gating (overlapping tween).
export function createPlayback(anim) {
  let status = "idle";
  let t = 0;
  let armed = true;       // user orbit disarms cues until reset/replay
  let firedCueT = -1;     // cues with t <= firedCueT already fired this run
  let stopAt = null;      // stepNext/playStep pause playback on reaching this t

  const snapshot = (cue = null) => ({ t, status, ...evaluate(anim, t), cue });

  const governingCue = () => {
    if (!armed) return null;
    let g = null;
    for (const c of anim.cues) if (c.t <= t && c.t > firedCueT) g = c;
    return g;
  };

  function begin() {
    const cue = governingCue();
    if (cue) { firedCueT = Math.max(firedCueT, cue.t); status = "intro"; }
    else status = "playing";
    return snapshot(cue);
  }

  function play() {
    if (status === "playing" || status === "intro") return snapshot();
    if (t >= 1 && !anim.loop) { t = 0; firedCueT = -1; armed = true; } // replay from start re-arms
    stopAt = null;
    return begin();
  }
  function pause() {
    if (status === "playing" || status === "intro") status = "paused";
    return snapshot();
  }
  function introDone() {
    if (status === "intro") status = "playing";
    return snapshot();
  }
  function seek(v) {
    t = Math.min(1, Math.max(0, v));
    if (status !== "idle") status = "paused";
    stopAt = null;
    firedCueT = -1; // a later play() re-honors the cue governing the new position
    return snapshot();
  }
  function playStep(i) {
    const idx = Math.min(anim.steps.length - 1, Math.max(0, i));
    t = anim.stepStarts[idx];
    stopAt = idx + 1 < anim.steps.length ? anim.stepStarts[idx + 1] : 1;
    firedCueT = -1;
    return begin();
  }
  function stepNext() {
    const cur = stepIndexAt(anim, t);
    return cur + 1 < anim.steps.length ? playStep(cur + 1) : snapshot();
  }
  function stepPrev() {
    return playStep(Math.max(0, stepIndexAt(anim, t) - 1));
  }
  function reset() {
    t = 0; status = "idle"; stopAt = null; firedCueT = -1; armed = true;
    return snapshot();
  }
  function disarmCues() { armed = false; }
  function userEdited() { if (status === "playing" || status === "intro") status = "paused"; }

  function tick(dt) {
    if (status !== "playing" || !(dt > 0)) return null;
    t += dt / anim.totalDuration;
    if (anim.loop) {
      if (t >= 1) t -= Math.floor(t);
    } else if (stopAt != null && t >= stopAt) {
      t = stopAt; stopAt = null; status = "paused";
    } else if (t >= 1) {
      t = 1; status = "done";
    }
    let cue = null;
    if (armed) {
      for (const c of anim.cues) if (c.t <= t && c.t > firedCueT) cue = c;
      if (cue) firedCueT = cue.t;
    }
    return snapshot(cue);
  }

  return {
    play, pause, toggle: () => (status === "playing" || status === "intro" ? pause() : play()),
    introDone, seek, stepNext, stepPrev, playStep, reset, disarmCues, userEdited, tick,
    state: () => ({ status, t, stepIndex: stepIndexAt(anim, t) }),
  };
}
```

- [ ] **Step 4: Run both animation test files**

Run: `npx vitest run test/framework/animation.test.js test/framework/animation-state.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/animation.js test/framework/animation-state.test.js
git commit -m "feat(animation): playback state machine — intro gating, steps, cues, loop"
```

---

### Task 3: Regen-loop debounce opt-out + mount fast-apply path

**Files:**
- Modify: `src/framework/regen-loop.js:33-37`
- Modify: `src/framework/mount.js:417-438`
- Test: `test/framework/regen-loop.test.js` (append)

**Interfaces:**
- Consumes: existing `createRegenLoop` contract.
- Produces: `loop.markDirty({ debounce = true })`; mount-internal `onParamChange({ debounce = true })` and `applyAnimationValues(values)` (Task 6 hands the latter to the transport driver). Nothing outside mount calls these directly yet.

- [ ] **Step 1: Write the failing test (append to `test/framework/regen-loop.test.js`)**

Read the existing file first and match its fixture style (it uses fake timers and a recorded `send`). Append:

```js
test("markDirty({debounce:false}) bumps the version without arming the timer", () => {
  const sent = [];
  const loop = createRegenLoop({ missingParts: () => ["a"], send: (m) => sent.push(m) });
  loop.ready();
  sent.length = 0;
  loop.markDirty({ debounce: false });
  expect(loop.version()).toBe(1);
  vi.advanceTimersByTime(1000);
  expect(sent).toEqual([]); // no debounced kick was armed
  loop.kick(); // the caller kicks explicitly on this path
  expect(sent).toEqual([["a"]]);
});

test("markDirty({debounce:false}) cancels a previously armed debounce", () => {
  const sent = [];
  const loop = createRegenLoop({ missingParts: () => ["a"], send: (m) => sent.push(m) });
  loop.ready();
  sent.length = 0;
  loop.markDirty();                  // arms the 180ms timer
  loop.markDirty({ debounce: false }); // animation frame takes over
  vi.advanceTimersByTime(1000);
  expect(sent).toEqual([]);
});
```

(If the existing file's helpers differ — e.g. `send` receives the missing list differently — adapt the assertions to the established fixture, keeping the two behaviors under test identical.)

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run test/framework/regen-loop.test.js`
Expected: the two new tests FAIL (timer still armed); existing tests PASS.

- [ ] **Step 3: Implement the regen-loop change**

In `src/framework/regen-loop.js`, replace `markDirty()`:

```js
    // `debounce: false` is the animation driver's mode: the version still bumps
    // (stale in-flight builds are still detected), but no timer is armed — the
    // driver kicks explicitly after the pose fast path has repaired, so a
    // pose-only frame sends no job and a geometry frame dispatches immediately
    // whenever the worker is idle (best-effort at worker cadence, clock-free).
    markDirty({ debounce = true } = {}) {
      paramsVersion++;
      clearTimeout(timer);
      if (debounce) timer = setTimeout(kick, debounceMs);
    },
```

Also extend the invariants comment at the top of the file (line 9) with: `— markDirty({debounce:false}) bumps without arming the timer (the animation fast-apply path kicks explicitly).`

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/framework/regen-loop.test.js`
Expected: PASS.

- [ ] **Step 5: Thread the option through mount**

In `src/framework/mount.js`, change `onParamChange` and add `applyAnimationValues` directly below `setParams`:

```js
    function onParamChange({ debounce = true } = {}) {
      loop.markDirty({ debounce }); // bump the version first: refreshView below must see the parts as stale
      // Pose-only edits: re-posed + re-stamped current, no job. Skipped entirely
      // when caching is off — ?debug&nocache is there to measure true uncached
      // rebuilds, which the fast path would otherwise hide.
      const posed = cachingOn ? fastPath.repair() : [];
      if (posed.length) {
        for (const name of posed) pendingPosed.add(name);
        dbg?.update({ posed: pendingPosed.size }); // partial: merges over the last build's numbers
      }
      refreshView();    // keep showing the now-stale mesh (no flicker); disable export
      updateRelevance();
    }
```

(The body is unchanged except the signature and the `markDirty` call — keep the existing comments.) Then add:

```js
    // Animation-frame param entry point: same change path as setParams, minus
    // the regen debounce. The explicit kick after repair is what makes playback
    // best-effort — a pose-only frame finds nothing missing (repair re-stamped
    // it) and sends no job; a geometry frame dispatches immediately when the
    // worker is idle and is otherwise absorbed until buildDone re-kicks.
    function applyAnimationValues(values) {
      Object.assign(params, values);
      panel.syncValues(Object.keys(values));
      onParamChange({ debounce: false });
      loop.kick();
    }
```

Note: `applyAnimationValues` references `panel`, which is created later in mount's body than `setParams` — place `applyAnimationValues` AFTER the `const panel = buildControls(...)` line (next to `onParamChange`, which already sits there).

- [ ] **Step 6: Run the mount tests**

Run: `npx vitest run test/framework/mount.test.js`
Expected: PASS (no behavior change on the default path).

- [ ] **Step 7: Commit**

```bash
git add src/framework/regen-loop.js src/framework/mount.js test/framework/regen-loop.test.js
git commit -m "feat(animation): debounce-free param apply path for animation frames"
```

---

### Task 4: Camera tween + viewer frame/camera hooks

**Files:**
- Create: `src/framework/camera-tween.js`
- Modify: `src/framework/viewer.js` (renderFrame, syncAutoRotate, new exports)
- Test: `test/framework/camera-tween.test.js`

**Interfaces:**
- Consumes: `EASINGS` from `animation.js`; `cameraPoseForView` from `view-angles.js`.
- Produces: `createCameraTween() → { start(from, to, { duration, onComplete }), update(dtSeconds) → { position, target, done } | null, cancel(), isActive() }` (poses are `{ position: [x,y,z], target: [x,y,z] }`). Viewer gains `onFrame(cb) → unsubscribe` (cb receives dt seconds), `tweenCameraTo(viewName, { duration, onComplete })`, `cancelCameraTween()`, `onCameraStart(cb) → unsubscribe`, `suppressAutoRotate(on)`. Task 5 consumes all five.

- [ ] **Step 1: Write the failing test**

```js
// test/framework/camera-tween.test.js
// Pure orbit-tween math: eased spherical interpolation, shortest-path azimuth,
// pole clamping, retargeting, cancel.
import { expect, test, vi } from "vitest";
import { createCameraTween } from "../../src/framework/camera-tween.js";

const FROM = { position: [10, 0, 0], target: [0, 0, 0] };

test("update interpolates from → to and reports done at the end", () => {
  const tw = createCameraTween();
  tw.start(FROM, { position: [0, 0, 10], target: [0, 0, 0] }, { duration: 1 });
  const mid = tw.update(0.5);
  expect(mid.done).toBe(false);
  // radius preserved through the arc (both poses are 10 from the target)
  expect(Math.hypot(...mid.position)).toBeCloseTo(10, 5);
  const end = tw.update(0.5);
  expect(end.done).toBe(true);
  expect(end.position[0]).toBeCloseTo(0, 5);
  expect(end.position[2]).toBeCloseTo(10, 5);
  expect(tw.isActive()).toBe(false);
});

test("azimuth takes the short way around", () => {
  const tw = createCameraTween();
  // +x → -z is -90° the short way; the long way would pass through -x
  tw.start(FROM, { position: [0, 0, -10], target: [0, 0, 0] }, { duration: 1 });
  const mid = tw.update(0.5);
  expect(mid.position[0]).toBeGreaterThan(0); // stays on the +x side of the arc
});

test("a straight-overhead destination is clamped off the pole", () => {
  const tw = createCameraTween();
  tw.start(FROM, { position: [0, 10, 0], target: [0, 0, 0] }, { duration: 1 });
  const end = tw.update(1);
  const horizontal = Math.hypot(end.position[0], end.position[2]);
  expect(horizontal).toBeGreaterThan(0.01); // never exactly on the Y axis
});

test("onComplete fires exactly once, at the end", () => {
  const done = vi.fn();
  const tw = createCameraTween();
  tw.start(FROM, { position: [0, 0, 10], target: [0, 0, 0] }, { duration: 1, onComplete: done });
  tw.update(0.5);
  expect(done).not.toHaveBeenCalled();
  tw.update(0.6);
  expect(done).toHaveBeenCalledTimes(1);
});

test("restart while active retargets from the caller-supplied current pose", () => {
  const tw = createCameraTween();
  tw.start(FROM, { position: [0, 0, 10], target: [0, 0, 0] }, { duration: 1 });
  const mid = tw.update(0.5);
  tw.start({ position: mid.position, target: mid.target },
    { position: [-10, 0, 0], target: [0, 0, 0] }, { duration: 1 });
  expect(tw.update(0).position[0]).toBeCloseTo(mid.position[0], 5); // no jump at retarget
});

test("cancel drops the tween and suppresses onComplete", () => {
  const done = vi.fn();
  const tw = createCameraTween();
  tw.start(FROM, { position: [0, 0, 10], target: [0, 0, 0] }, { duration: 1, onComplete: done });
  tw.cancel();
  expect(tw.update(1)).toBeNull();
  expect(done).not.toHaveBeenCalled();
});

test("duration 0 completes on the first update (reduced-motion jump cut)", () => {
  const tw = createCameraTween();
  tw.start(FROM, { position: [0, 0, 10], target: [0, 0, 0] }, { duration: 0 });
  expect(tw.update(0.016).done).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/framework/camera-tween.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/framework/camera-tween.js`**

```js
import * as THREE from "three";
import { EASINGS } from "./animation.js";

// Retargetable orbit-camera tween for animation camera cues: eased spherical
// interpolation of {position, target} pairs about the (linearly moving) orbit
// target, shortest-path in azimuth, clamped off the poles so OrbitControls
// never gimbal-locks on a "top"/"bottom" cue. Pure math, no clock — the viewer
// feeds dt seconds into update() each frame and applies the returned pose.
const POLE_EPS = 0.01;

function toSpherical(position, target) {
  const off = new THREE.Vector3().fromArray(position).sub(new THREE.Vector3().fromArray(target));
  const sph = new THREE.Spherical().setFromVector3(off);
  sph.phi = Math.min(Math.PI - POLE_EPS, Math.max(POLE_EPS, sph.phi));
  return sph;
}

export function createCameraTween() {
  let tw = null; // { fromSph, toSph, fromTarget, toTarget, duration, elapsed, onComplete }

  // `from` is always the CALLER's current pose, which is what makes a restart
  // mid-flight retarget smoothly: the new tween begins wherever the camera is.
  function start(from, to, { duration = 0.6, onComplete } = {}) {
    const fromSph = toSpherical(from.position, from.target);
    const toSph = toSpherical(to.position, to.target);
    const d = toSph.theta - fromSph.theta;
    if (d > Math.PI) toSph.theta -= 2 * Math.PI;
    if (d < -Math.PI) toSph.theta += 2 * Math.PI;
    tw = {
      fromSph, toSph,
      fromTarget: new THREE.Vector3().fromArray(from.target),
      toTarget: new THREE.Vector3().fromArray(to.target),
      duration, elapsed: 0, onComplete,
    };
  }

  function update(dt) {
    if (!tw) return null;
    tw.elapsed += dt;
    const done = tw.elapsed >= tw.duration;
    const u = done ? 1 : EASINGS["ease-in-out"](tw.elapsed / tw.duration);
    const lerp = (a, b) => a + (b - a) * u;
    const sph = new THREE.Spherical(
      lerp(tw.fromSph.radius, tw.toSph.radius),
      lerp(tw.fromSph.phi, tw.toSph.phi),
      lerp(tw.fromSph.theta, tw.toSph.theta),
    );
    const target = tw.fromTarget.clone().lerp(tw.toTarget, u);
    const position = new THREE.Vector3().setFromSpherical(sph).add(target);
    const onComplete = tw.onComplete;
    if (done) tw = null;
    const out = { position: position.toArray(), target: target.toArray(), done };
    if (done) onComplete?.();
    return out;
  }

  return { start, update, cancel: () => { tw = null; }, isActive: () => !!tw };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/framework/camera-tween.test.js`
Expected: PASS.

- [ ] **Step 5: Wire the viewer**

In `src/framework/viewer.js`:

a. Add the import: `import { createCameraTween } from "./camera-tween.js";`

b. After the cutaway construction (around line 215), add:

```js
  // --- animation hooks --------------------------------------------------------
  // Frame listeners get dt (seconds, clamped so a background-tab return doesn't
  // fast-forward playback) inside the render loop — so a parked viewer
  // (setActive(false)) automatically halts playback too: no loop, no ticks.
  const frameListeners = new Set();
  function onFrame(cb) { frameListeners.add(cb); return () => frameListeners.delete(cb); }

  const camTween = createCameraTween();
  // Tween the orbit camera to a canonical angle, framed on what's visible now.
  // Presentational only; a caller passing duration 0 gets a jump cut.
  function tweenCameraTo(viewName, { duration = 0.6, onComplete } = {}) {
    const box = getVisibleWorldBounds();
    if (!box || box.isEmpty()) { onComplete?.(); return; }
    const center = box.getCenter(new THREE.Vector3()).toArray();
    const size = box.getSize(new THREE.Vector3());
    const pose = cameraPoseForView(viewName, { center, radius: Math.max(size.x, size.y, size.z) / 2 || 10 });
    camTween.start(
      { position: camera.position.toArray(), target: controls.target.toArray() },
      { position: pose.position, target: pose.target },
      { duration, onComplete },
    );
  }
  const cancelCameraTween = () => camTween.cancel();

  // User grabbing the orbit cancels any cue tween (the user owns the camera) and
  // tells subscribers (the animation driver disarms remaining cues).
  const cameraStartListeners = new Set();
  const onControlsStart = () => { camTween.cancel(); for (const cb of [...cameraStartListeners]) cb(); };
  controls.addEventListener("start", onControlsStart);
  function onCameraStart(cb) { cameraStartListeners.add(cb); return () => cameraStartListeners.delete(cb); }
```

c. Extend auto-rotate arbitration (replace the existing `syncAutoRotate` block at lines 333-340):

```js
  let autoRotateRequested = true;
  let autoRotateSuppressed = false; // playback suppresses the turntable, like cutaway does
  function syncAutoRotate() {
    controls.autoRotate = autoRotateRequested && !cutaway.isEnabled && !autoRotateSuppressed;
  }
  function setAutoRotate(on) {
    autoRotateRequested = !!on;
    syncAutoRotate();
  }
  function suppressAutoRotate(on) {
    autoRotateSuppressed = !!on;
    syncAutoRotate();
  }
```

d. Replace `renderFrame` (lines 492-498) — the tween is applied after `controls.update()` so the cue wins the frame, and listeners run before render so a playback frame draws its own pose:

```js
  let lastFrameTime = null;
  function renderFrame(time) {
    const dt = lastFrameTime == null ? 0 : Math.min(0.1, (time - lastFrameTime) / 1000);
    lastFrameTime = time;
    controls.update();
    const tw = camTween.update(dt);
    if (tw) {
      camera.position.fromArray(tw.position);
      controls.target.fromArray(tw.target);
    }
    for (const cb of [...frameListeners]) cb(dt);
    if (cutaway.isEnabled) cutaway.updateForCamera();
    renderer.render(scene, camera);
    cutaway.renderOverlay(renderer, camera);
  }
```

e. In `setActive`, reset the clock on unpark (before `renderer.setAnimationLoop(renderFrame)` at line 533): `lastFrameTime = null;`

f. In `dispose()`, add `controls.removeEventListener("start", onControlsStart); cameraStartListeners.clear(); frameListeners.clear(); camTween.cancel();` before `controls.dispose()`.

g. Add to the returned object: `onFrame, tweenCameraTo, cancelCameraTween, onCameraStart, suppressAutoRotate,`

- [ ] **Step 6: Run the existing viewer-adjacent tests**

Run: `npx vitest run test/framework/viewer-active.test.js test/framework/viewer-pose.test.js test/framework/viewer-controls.test.js test/framework/viewer-cutaway.test.js`
Expected: PASS. If a test constructs the viewer and asserts its handle shape, extend it with the five new keys.

- [ ] **Step 7: Commit**

```bash
git add src/framework/camera-tween.js src/framework/viewer.js test/framework/camera-tween.test.js
git commit -m "feat(animation): camera cue tween + viewer frame/orbit hooks"
```

---

### Task 5: Transport bar + playback driver (`animation-controls.js`)

**Files:**
- Modify: `src/framework/controls.js` (export two existing helpers)
- Create: `src/framework/animation-controls.js`
- Modify: `src/framework/chrome.css` (append styles)
- Test: `test/framework/animation-controls.test.js`

**Interfaces:**
- Consumes: `normalizeAnimations`, `createPlayback` (Tasks 1–2); viewer hooks from Task 4; `createInfoPopover`/`attachInfo` from controls.js.
- Produces: `attachAnimationControls(viewer, part, { container, applyValues, getParamValues }) → { detach, notifyUserEdit, runtime } | null` (null when the part declares no valid animations). `runtime` = `{ play(name?), pause(), seek(t), stop(), state() }` where `state()` returns `{ animation, status, t, stepIndex }`. Task 6 wires it into mount and the handle.

- [ ] **Step 1: Export the popover helpers**

In `src/framework/controls.js`, change `function createInfoPopover()` → `export function createInfoPopover()` (line 54) and `function attachInfo(...)` → `export function attachInfo(...)` (line 94). No behavior change.

Run: `npx vitest run test/framework/controls.test.js` — Expected: PASS.

- [ ] **Step 2: Write the failing test**

```js
// @vitest-environment happy-dom
// test/framework/animation-controls.test.js
// Transport bar + driver against a fake viewer: play/pause/scrub/step wiring,
// cue → tween dispatch, intro gating, auto-rotate suppression, snapshot/reset,
// user-edit pause, and the runtime surface.
import { afterEach, expect, test, vi } from "vitest";
import { attachAnimationControls } from "../../src/framework/animation-controls.js";

function fakeViewer() {
  const frameCbs = new Set(); const orbitCbs = new Set();
  return {
    onFrame: (cb) => { frameCbs.add(cb); return () => frameCbs.delete(cb); },
    onCameraStart: (cb) => { orbitCbs.add(cb); return () => orbitCbs.delete(cb); },
    tweenCameraTo: vi.fn((view, { onComplete } = {}) => onComplete?.()), // completes instantly
    cancelCameraTween: vi.fn(),
    suppressAutoRotate: vi.fn(),
    frame: (dt) => { for (const cb of [...frameCbs]) cb(dt); },
    orbit: () => { for (const cb of [...orbitCbs]) cb(); },
  };
}

const part = {
  animations: {
    open: { label: "Open lid", camera: "front", duration: 2, easing: "linear",
      description: "Opens the **lid**.", tracks: { lidAngle: [[0, 0], [1, 110]] } },
    assemble: { label: "Assemble", steps: [
      { label: "Lower", duration: 1, easing: "linear", tracks: { lidLift: [[0, 40], [1, 0]] } },
      { label: "Open", duration: 1, easing: "linear", tracks: { lidAngle: [[0, 0], [1, 110]] } },
    ] },
  },
};

function setup(defn = part) {
  const container = document.createElement("div");
  document.body.append(container);
  const params = { lidAngle: 5, lidLift: 0 };
  const applied = [];
  const ctl = attachAnimationControls(fakeViewer(), defn, {
    container,
    applyValues: (v) => { applied.push({ ...v }); Object.assign(params, v); },
    getParamValues: (keys) => Object.fromEntries(keys.map((k) => [k, params[k]])),
  });
  return { container, params, applied, ctl, viewer: ctl.__viewer };
}

let handles = [];
afterEach(() => { for (const h of handles.splice(0)) h?.detach(); document.body.replaceChildren(); });

test("no animations → null, no DOM", () => {
  const container = document.createElement("div");
  expect(attachAnimationControls(fakeViewer(), {}, { container, applyValues: () => {}, getParamValues: () => ({}) })).toBeNull();
  expect(container.children).toHaveLength(0);
});

test("renders the bar with a picker (two animations) and an info glyph", () => {
  const { container, ctl } = setup(); handles.push(ctl);
  expect(container.querySelector(".pf-anim-bar")).toBeTruthy();
  expect(container.querySelector(".pf-anim-pick")).toBeTruthy();
  expect(container.querySelector(".pf-anim-bar .info")).toBeTruthy(); // description glyph
});

test("play runs the intro tween, then frames drive param values", () => {
  const { applied, ctl } = setup(); handles.push(ctl);
  const viewer = ctl.__viewer;
  ctl.runtime.play();
  expect(viewer.tweenCameraTo).toHaveBeenCalledWith("front", expect.anything());
  expect(viewer.suppressAutoRotate).toHaveBeenLastCalledWith(true);
  viewer.frame(1); // 1s of 2s → t=0.5 → lidAngle 55
  expect(applied.at(-1).lidAngle).toBeCloseTo(55);
});

test("reset restores the pre-animation param snapshot", () => {
  const { applied, ctl } = setup(); handles.push(ctl);
  ctl.runtime.play();
  ctl.__viewer.frame(1);
  ctl.runtime.stop();
  expect(applied.at(-1)).toEqual({ lidAngle: 5 }); // the snapshot taken at play
});

test("user orbit disarms cues; user edit pauses", () => {
  const { ctl } = setup(); handles.push(ctl);
  const viewer = ctl.__viewer;
  ctl.runtime.play();
  viewer.orbit();
  ctl.notifyUserEdit();
  expect(ctl.runtime.state().status).toBe("paused");
  expect(viewer.suppressAutoRotate).toHaveBeenLastCalledWith(false);
});

test("scrubbing applies values without moving the camera", () => {
  const { container, applied, ctl } = setup(); handles.push(ctl);
  const viewer = ctl.__viewer;
  const scrub = container.querySelector(".pf-anim-scrub");
  scrub.value = "500";
  scrub.dispatchEvent(new Event("input", { bubbles: true }));
  expect(applied.at(-1).lidAngle).toBeCloseTo(55);
  expect(viewer.tweenCameraTo).not.toHaveBeenCalled();
});

test("stepped animation shows step chrome and step ticks", () => {
  const { container, ctl } = setup(); handles.push(ctl);
  container.querySelector(".pf-anim-pick").value = "assemble";
  container.querySelector(".pf-anim-pick").dispatchEvent(new Event("change", { bubbles: true }));
  expect(container.querySelector(".pf-anim-step").hidden).toBe(false);
  expect(container.querySelectorAll(".pf-anim-tick")).toHaveLength(1); // one interior boundary
});

test("runtime.play(name) switches animation; detach removes the bar", () => {
  const { container, ctl } = setup(); handles.push(ctl);
  ctl.runtime.play("assemble");
  expect(ctl.runtime.state().animation).toBe("assemble");
  ctl.detach();
  expect(container.querySelector(".pf-anim-bar")).toBeNull();
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/framework/animation-controls.test.js`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement `src/framework/animation-controls.js`**

```js
// Transport bar + playback driver for part-declared animations. The bar is
// framework-generated DOM appended to the stage (no host markup needed, like
// the debug overlay); the driver ticks the pure playback state machine
// (animation.js) from the viewer's frame loop and routes every param write
// through the mount-supplied applyValues hook — the same path as a slider
// edit, minus the regen debounce. Returns null when the part declares no
// (valid) animations, so mount can wire it unconditionally.
import { normalizeAnimations, createPlayback } from "./animation.js";
import { createInfoPopover, attachInfo } from "./controls.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function btn(className, text, label) {
  const b = el("button", className, text);
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.title = label;
  return b;
}

export function attachAnimationControls(viewer, part, { container, applyValues, getParamValues }) {
  // A malformed animations block must degrade to "no transport bar", never a
  // crashed mount — lint reports the specifics; the viewer just goes without.
  let animations;
  try { animations = normalizeAnimations(part); } catch { animations = []; }
  if (!animations.length) return null;

  const reducedMotion = typeof matchMedia === "function"
    && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tweenDuration = reducedMotion ? 0 : 0.6; // reduced motion: jump cut, no sweep

  let current = animations[0];
  let playback = createPlayback(current);
  let snapshot = null; // tracked-param values before this animation first drove them

  // --- DOM --------------------------------------------------------------------
  const bar = el("div", "pf-anim-bar");
  const info = createInfoPopover();

  const pick = document.createElement("select");
  pick.className = "pf-anim-pick";
  for (const a of animations) {
    const o = document.createElement("option");
    o.value = a.name; o.textContent = a.label;
    pick.append(o);
  }
  const title = el("span", "pf-anim-title", "");
  bar.append(animations.length > 1 ? pick : title);
  const infoSlot = el("span", "pf-anim-info");
  const playBtn = btn("pf-anim-play", "▶", "Play animation");
  const prevBtn = btn("pf-anim-step-btn", "‹", "Previous step");
  const stepLabel = el("span", "pf-anim-step", "");
  const nextBtn = btn("pf-anim-step-btn", "›", "Next step");
  const scrubWrap = el("span", "pf-anim-scrub-wrap");
  const scrub = document.createElement("input");
  scrub.type = "range";
  scrub.min = "0"; scrub.max = "1000"; scrub.step = "1"; scrub.value = "0";
  scrub.className = "pf-anim-scrub";
  scrub.setAttribute("aria-label", "Animation position");
  scrubWrap.append(scrub);
  const resetBtn = btn("pf-anim-reset", "↺", "Reset animation");
  bar.append(infoSlot, playBtn, prevBtn, stepLabel, nextBtn, scrubWrap, resetBtn);
  container.append(bar);

  // Per-animation chrome: title, ⓘ description, step buttons, scrubber ticks.
  function syncStructure() {
    title.textContent = current.label;
    infoSlot.replaceChildren();
    attachInfo(infoSlot, current.description ?? "", info);
    const stepped = current.steps.length > 1;
    prevBtn.hidden = nextBtn.hidden = stepLabel.hidden = !stepped;
    for (const n of scrubWrap.querySelectorAll(".pf-anim-tick")) n.remove();
    if (stepped) {
      for (const t of current.stepStarts.slice(1)) {
        const tick = el("span", "pf-anim-tick");
        tick.style.left = `${t * 100}%`;
        scrubWrap.append(tick);
      }
    }
  }

  function syncUi() {
    const { status, t, stepIndex } = playback.state();
    const active = status === "playing" || status === "intro";
    playBtn.textContent = active ? "⏸" : "▶";
    playBtn.setAttribute("aria-label", active ? "Pause animation" : "Play animation");
    playBtn.title = playBtn.getAttribute("aria-label");
    scrub.value = String(Math.round(t * 1000));
    if (current.steps.length > 1) {
      const step = current.steps[stepIndex];
      stepLabel.textContent = `${stepIndex + 1}/${current.steps.length} · ${step.label}`;
    }
    viewer.suppressAutoRotate(active);
  }

  // --- driver -----------------------------------------------------------------
  function apply(r) {
    if (!r) return;
    // First write for this run: remember what the user's params were, so Reset
    // can put them back.
    if (snapshot == null && Object.keys(r.values).length) snapshot = getParamValues(current.trackedKeys);
    applyValues(r.values);
    if (r.cue) {
      viewer.tweenCameraTo(r.cue.view, {
        duration: tweenDuration,
        // An intro cue gates playback until the tween settles; mid-timeline
        // cues overlap playback and need no completion signal.
        onComplete: r.status === "intro" ? () => apply(playback.introDone()) : undefined,
      });
    }
    syncUi();
  }

  function doReset() {
    playback.reset();
    viewer.cancelCameraTween();
    if (snapshot) { applyValues(snapshot); snapshot = null; }
    syncUi();
  }

  function selectAnimation(name) {
    const next = animations.find((a) => a.name === name);
    if (!next || next === current) return;
    doReset();
    current = next;
    playback = createPlayback(current);
    if (animations.length > 1) pick.value = name;
    syncStructure();
    syncUi();
  }

  const offFrame = viewer.onFrame((dt) => apply(playback.tick(dt)));
  const offOrbit = viewer.onCameraStart(() => playback.disarmCues()); // viewer already cancelled the tween

  const onPlayClick = () => {
    const active = playback.state().status;
    if (active === "playing" || active === "intro") {
      viewer.cancelCameraTween();
      apply(playback.pause());
    } else {
      apply(playback.play());
    }
  };
  const onScrub = () => apply(playback.seek(Number(scrub.value) / 1000));
  const onPrev = () => apply(playback.stepPrev());
  const onNext = () => apply(playback.stepNext());
  const onPick = () => selectAnimation(pick.value);
  playBtn.addEventListener("click", onPlayClick);
  scrub.addEventListener("input", onScrub);
  prevBtn.addEventListener("click", onPrev);
  nextBtn.addEventListener("click", onNext);
  pick.addEventListener("change", onPick);
  resetBtn.addEventListener("click", doReset);

  syncStructure();
  syncUi();

  const runtime = {
    play(name) { if (name) selectAnimation(name); apply(playback.play()); },
    pause() { viewer.cancelCameraTween(); apply(playback.pause()); },
    seek(t) { apply(playback.seek(t)); },
    stop() { doReset(); },
    state: () => ({ animation: current.name, ...playback.state() }),
  };

  const handle = {
    runtime,
    // A user edit to any control (or a host setParams) takes over the params:
    // pause playback rather than fight over them.
    notifyUserEdit() {
      viewer.cancelCameraTween();
      playback.userEdited();
      syncUi();
    },
    detach() {
      offFrame();
      offOrbit();
      playBtn.removeEventListener("click", onPlayClick);
      scrub.removeEventListener("input", onScrub);
      prevBtn.removeEventListener("click", onPrev);
      nextBtn.removeEventListener("click", onNext);
      pick.removeEventListener("change", onPick);
      resetBtn.removeEventListener("click", doReset);
      info.dispose();
      bar.remove();
      viewer.suppressAutoRotate(false);
    },
    __viewer: viewer, // test hook only
  };
  return handle;
}
```

- [ ] **Step 5: Append transport styles to `src/framework/chrome.css`**

Find the `.pf-float-viewbar` rules and append below them:

```css
/* --- animation transport bar (generated by animation-controls.js) ---------- */
.pf-anim-bar {
  position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; z-index: 5; max-width: calc(100% - 24px);
  background: var(--pf-surface); border: 1px solid var(--pf-border);
  border-radius: var(--pf-radius-control); box-shadow: var(--pf-shadow-float);
}
.pf-anim-bar button {
  border: 0; background: transparent; color: var(--pf-muted);
  cursor: pointer; font-size: 13px; padding: 2px 4px;
}
.pf-anim-bar button:hover { color: var(--pf-text-2); }
.pf-anim-title, .pf-anim-pick {
  font-family: var(--pf-mono); font-size: 11px; color: var(--pf-text-2);
}
.pf-anim-pick {
  background: var(--pf-input-bg); border: 1px solid var(--pf-border);
  border-radius: var(--pf-radius-control); padding: 3px 6px;
}
.pf-anim-step {
  font-family: var(--pf-mono); font-size: 10px; color: var(--pf-muted-2);
  min-width: 90px; text-align: center; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.pf-anim-scrub-wrap { position: relative; display: inline-flex; align-items: center; width: 140px; }
.pf-anim-scrub { width: 100%; accent-color: var(--pf-accent); }
.pf-anim-tick {
  position: absolute; top: 50%; width: 2px; height: 8px; margin-top: -4px;
  background: var(--pf-muted); pointer-events: none;
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run test/framework/animation-controls.test.js test/framework/controls.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/framework/animation-controls.js src/framework/controls.js src/framework/chrome.css test/framework/animation-controls.test.js
git commit -m "feat(animation): transport bar + playback driver"
```

---

### Task 6: Mount wiring + `runtime.animation`

**Files:**
- Modify: `src/framework/mount.js`
- Test: `test/framework/mount.test.js` (extend)

**Interfaces:**
- Consumes: `attachAnimationControls` (Task 5), `applyAnimationValues` (Task 3).
- Produces: `runtime.animation` on the mount handle — `{ play, pause, seek, stop, state } | null`. `makeHandle` gains an `animation` field (defaulting to `null`).

- [ ] **Step 1: Extend the handle-shape test**

In `test/framework/mount.test.js`, find the `makeHandle` shape test and add to its assertions:

```js
  expect(handle.animation).toBeNull(); // no animation runtime supplied
```

and a sibling assertion constructing `makeHandle({ ...same fixture..., animation: fakeRuntime })` expecting `handle.animation` to be `fakeRuntime` (where `const fakeRuntime = { play() {}, pause() {}, seek() {}, stop() {}, state: () => ({}) }`). Follow the file's existing fixture style.

Run: `npx vitest run test/framework/mount.test.js` — Expected: the new assertions FAIL.

- [ ] **Step 2: Implement**

In `src/framework/mount.js`:

a. Add the import: `import { attachAnimationControls } from "./animation-controls.js";`

b. In `makeHandle`, add `animation` to the destructured params and to the returned object:

```js
export function makeHandle({ ready, dispose, viewer, setParams, listExportableParts, exportParts, setHostPane, animation }) {
  return {
    ready, dispose, setParams,
    // Part-declared animation playback (spec 2026-08-02): null when the part
    // declares no animations. { play(name?), pause(), seek(t), stop(), state() }.
    animation: animation ?? null,
    ...
```

c. In `mount`, declare `let animCtl = null;` just above the `const panel = buildControls(...)` line, and route panel edits through the pause notification:

```js
    let animCtl = null; // assigned below; panel edits must pause active playback
    const panel = buildControls(els.controls, part.parameters, params, () => {
      animCtl?.notifyUserEdit();
      onParamChange();
    });
```

d. After `applyAnimationValues` (added in Task 3), attach the transport:

```js
    // Animation transport + driver (no-op null when the part declares none).
    animCtl = attachAnimationControls(viewer, part, {
      container: els.viewer,
      applyValues: applyAnimationValues,
      getParamValues: (keys) => Object.fromEntries(keys.map((k) => [k, params[k]])),
    });
    if (animCtl) cleanup.defer(() => animCtl.detach());
```

e. In `setParams`, notify before applying (a host edit is a user edit):

```js
    function setParams(partial) {
      animCtl?.notifyUserEdit();
      Object.assign(params, partial);
      panel.syncValues(Object.keys(partial));
      onParamChange();
    }
```

f. Pass the runtime into the handle: in the `makeHandle({ ... })` call at the bottom, add `animation: animCtl?.runtime ?? null,`.

- [ ] **Step 3: Run the mount + wiring tests**

Run: `npx vitest run test/framework/mount.test.js test/export-mount-wiring.test.js test/mount-capture.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/framework/mount.js test/framework/mount.test.js
git commit -m "feat(animation): mount wiring + runtime.animation surface"
```

---### Task 7: Hinged-box example part + app glue + smoke

**Files:**
- Create: `src/parts/hinged-box.js`, `hinged-box.html`, `src/app-hinged-box.js`, `src/hinged-box-worker.js`
- Modify: `.github/workflows/ci.yml` (add the app to the smoke list)
- Test: `test/hinged-box-part.test.js`

**Interfaces:**
- Consumes: the full `animations` contract; `place()` with purpose-split poses.
- Produces: the reference part every doc/test example points at. Sub-parts `base`, `lid`; view `box`; animations `open` (intro camera + description), `cycle` (loop), `assemble` (two steps with per-step cameras).

- [ ] **Step 1: Write the failing part test**

Model on `test/demo-part.test.js` (read it first; reuse its kernel-boot helper — Manifold):

```js
// test/hinged-box-part.test.js
// The animation reference part: builds clean, poses are rigid and
// view-independent, and the animations block round-trips the timeline model.
import { beforeAll, expect, test } from "vitest";
import part from "../src/parts/hinged-box.js";
import { createManifoldKernel, measure } from "../src/testing.js";
import { normalizeAnimations, evaluate } from "../src/framework/animation.js";

let kernel;
beforeAll(async () => { kernel = await createManifoldKernel(); });

test("builds and measures clean at defaults", () => {
  const r = measure(kernel, part, "box");
  expect(r.ok).toBe(true);
  expect(r.subparts.map((s) => s.name).sort()).toEqual(["base", "lid"]);
  expect(r.overlaps).toEqual([]);
});

test("lidAngle/lidLift are pose-only: same volume at any pose", () => {
  const closed = measure(kernel, part, "box");
  const open = measure(kernel, part, "box", { lidAngle: 90, lidLift: 20 }); // params is the 4th positional
  const vol = (r, n) => r.subparts.find((s) => s.name === n).volume;
  expect(vol(open, "lid")).toBeCloseTo(vol(closed, "lid"), 3);
  expect(vol(open, "base")).toBeCloseTo(vol(closed, "base"), 3);
});

test("animations normalize: open has an intro cue, assemble has step cues", () => {
  const [open, cycle, assemble] = normalizeAnimations(part);
  expect(open.cues).toEqual([{ t: 0, view: "front" }]);
  expect(open.description).toMatch(/lid/i);
  expect(cycle.loop).toBe(true);
  expect(assemble.steps.map((s) => s.label)).toEqual(["Lower the lid", "Open to check clearance"]);
  expect(assemble.cues.map((c) => c.view)).toEqual(["left", "iso"]);
  expect(evaluate(open, 1).values.lidAngle).toBe(110);
});
```

(Signature verified against `src/testing/measure.js:21` — `measure(kernel, part, view, params = {})`.)

Run: `npx vitest run test/hinged-box-part.test.js` — Expected: FAIL (no part module).

- [ ] **Step 2: Write the part**

`src/parts/hinged-box.js`:

```js
// Animation reference part — a box with a hinged lid. Worked example for
// docs/AUTHORING-PARTS.md "Animations": pose-only animated params (lidAngle,
// lidLift) driven through place(), an intro camera + markdown description on
// `open`, a looping `cycle`, and a stepped `assemble` with per-step cameras.
export default {
  meta: { title: "Hinged Box", units: "mm" },
  parameters: [
    {
      id: "box",
      title: "Box",
      description: "Outer dimensions of the base. The lid is a flat plate of the same wall thickness.",
      advanced: [
        { key: "width", label: "Width", unit: "mm", min: 20, max: 120, step: 1,
          description: "Outer width (X)." },
        { key: "depth", label: "Depth", unit: "mm", min: 20, max: 120, step: 1,
          description: "Outer depth (Y). The hinge runs along the rear edge." },
        { key: "height", label: "Height", unit: "mm", min: 10, max: 80, step: 1,
          description: "Outer height of the base (Z)." },
        { key: "wall", label: "Wall", unit: "mm", min: 1.2, max: 5, step: 0.2,
          description: "Wall and lid thickness." },
      ],
    },
    {
      id: "pose",
      title: "Pose",
      description: "Presentation pose. The **Open lid** and **Assemble** animations drive these — both are pose-only, so animating them never rebuilds geometry.",
      advanced: [
        { key: "lidAngle", label: "Lid angle", unit: "°", min: 0, max: 110, step: 1,
          description: "Hinge opening angle about the rear top edge." },
        { key: "lidLift", label: "Lid lift", unit: "mm", min: 0, max: 60, step: 1,
          description: "Assembly explode offset: raises the lid straight up off the hinge." },
      ],
    },
  ],
  defaults: { width: 60, depth: 40, height: 24, wall: 2, lidAngle: 0, lidLift: 0 },
  parts: {
    base: {
      label: "Base",
      views: ["box"],
      export: { name: "base" },
      build: (k, p) =>
        k.box({ min: [0, 0, 0], max: [p.width, p.depth, p.height] })
          .cut(k.box({ min: [p.wall, p.wall, p.wall], max: [p.width - p.wall, p.depth - p.wall, p.height + 1] })),
    },
    lid: {
      label: "Lid",
      views: ["box"],
      export: { name: "lid" },
      build: (k, p) => k.box({ min: [0, 0, p.height], max: [p.width, p.depth, p.height + p.wall] }),
      // Display: swing about the hinge line (rear top edge, axis +X through
      // [0, depth, height]; negative angle opens upward), then the assembly
      // lift. Export: the lid prints flat beside the base. Both poses are
      // rigid motions of the same solid, and neither reads `view` — the two
      // invariants lint's place rules hold every part to.
      place: (s, { purpose, p }) =>
        purpose === "export"
          ? s.translate([p.width + 10, 0, -p.height])
          : s.rotate(-p.lidAngle, [0, p.depth, p.height], [1, 0, 0]).translate([0, 0, p.lidLift]),
    },
  },
  views: { box: { label: "Box" } },
  animations: {
    open: {
      label: "Open lid",
      description: "Swings the lid to **110°** about the rear hinge line.\n\nPose-only: playback runs at frame rate with no geometry rebuild.",
      camera: "front",
      duration: 1.2,
      tracks: { lidAngle: [[0, 0], [1, 110]] },
    },
    cycle: {
      label: "Open / close",
      duration: 2.4,
      loop: true,
      easing: "linear",
      tracks: { lidAngle: [[0, 0], [0.5, 110], [1, 0]] },
    },
    assemble: {
      label: "Assemble",
      description: "How the parts come together: the lid drops onto the base, then swings open to check hinge clearance.",
      steps: [
        { label: "Lower the lid", camera: "left", duration: 1.0, tracks: { lidLift: [[0, 40], [1, 0]] } },
        { label: "Open to check clearance", camera: "iso", duration: 1.0, tracks: { lidAngle: [[0, 0], [1, 110]] } },
      ],
    },
  },
  verify: {
    process: "fdm-pla",
    expect: {
      base: { bbox: "<=[200,200,200]" },
      _view: { overlaps: 0 },
    },
  },
};
```

- [ ] **Step 3: Run the part test**

Run: `npx vitest run test/hinged-box-part.test.js`
Expected: PASS. If a kernel error appears, grep `docs/ERROR-PATTERNS.md` for the message first (e.g. the box min/max form, or the rotate signature).

Also run the CLI checks:

```bash
npx partforge lint src/parts/hinged-box.js
npx partforge measure src/parts/hinged-box.js
```

Expected: lint clean, measure exits 0 (verify gates pass).

- [ ] **Step 4: Wire the app (copy the demo pattern exactly)**

`src/app-hinged-box.js`:

```js
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import hingedBox from "./parts/hinged-box.js";
import { mount } from "./framework/index.js";

// Dev-only example app for the hinged-box part (the animation reference part).
// `npm run dev`, then open /hinged-box.html. The worker URL must stay inline
// so Vite bundles it.
window.__pfRuntime = mount(hingedBox, {
  createWorker: (name) =>
    new Worker(new URL("./hinged-box-worker.js", import.meta.url), { type: "module", name }),
});
```

`src/hinged-box-worker.js`:

```js
import part from "./parts/hinged-box.js";
import { runWorker } from "./framework/worker.js";
runWorker(part);
```

`hinged-box.html`: copy `demo.html` verbatim, then change: `<title>Hinged Box — animation example</title>`, the `<h1>` to `Hinged Box`, the `.sub` line to `Animation reference part`, the hint line to `Drag to orbit · scroll to zoom. Use the transport bar to play animations.`, and the script src to `/src/app-hinged-box.js`.

- [ ] **Step 5: Smoke-test in real Chromium**

```bash
node scripts/check-app.mjs hinged-box.html
```

Expected: exits 0. (Needs Playwright Chromium: `npx playwright install chromium` if missing.) Then open `.github/workflows/ci.yml`, find the lines running `check-app.mjs` for the three existing apps, and add `hinged-box.html` in the same pattern.

- [ ] **Step 6: Manual verification in the dev server (visual)**

```bash
npm run dev
```

Open `/hinged-box.html`: transport bar visible; **Open lid** play → camera sweeps to front, lid swings smoothly (watch the `?debug` overlay report `posed`, not `rebuilt`); ⓘ shows the markdown popover; **Assemble** steps navigate with camera cuts; scrub works; Reset restores the closed pose; editing a slider mid-play pauses. Stop the server when done.

- [ ] **Step 7: Run the full suite once (integration checkpoint)**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/parts/hinged-box.js hinged-box.html src/app-hinged-box.js src/hinged-box-worker.js test/hinged-box-part.test.js .github/workflows/ci.yml
git commit -m "feat(animation): hinged-box reference part + app + smoke coverage"
```

---

### Task 8: Lint — static animation rules

**Files:**
- Create: `src/framework/lint/rules-animations.js`
- Modify: `src/framework/lint/index.js` (registry)
- Test: `test/lint-animations.test.js`; update `test/lint-registry.test.js`

**Interfaces:**
- Consumes: `err`/`warn` from `finding.js`; `EASINGS` from `animation.js`; `CANONICAL_VIEWS` from `view-angles.js` (both pure — lint purity holds).
- Produces: `ANIMATION_RULES` (array of rule objects), merged into `RULES`. Rule ids listed below; Task 9 appends one more rule to this file.

- [ ] **Step 1: Write the failing test**

```js
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
```

Run: `npx vitest run test/lint-animations.test.js` — Expected: FAIL (no rules → no findings).

- [ ] **Step 2: Implement `src/framework/lint/rules-animations.js`**

```js
// Group 5 — the `animations` block (spec 2026-08-02-model-animation-design.md).
// Everything here is static data validation: the block is pure keyframe data
// by design, so lint can hold every track to the schema without executing
// author code. The probe-backed classification note is appended by Task 9.
import { err } from "./finding.js";
import { EASINGS } from "../animation.js";
import { CANONICAL_VIEWS } from "../view-angles.js";

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// [name, spec] pairs, only when the block is well-shaped enough to walk.
const animEntries = (part) =>
  isPlainObject(part?.animations)
    ? Object.entries(part.animations).filter(([, a]) => isPlainObject(a))
    : [];

// Steps in normalized-adjacent form for rule walks (does NOT validate — each
// rule checks its own slice). A bare-tracks animation is one anonymous step.
const rawSteps = (a) => (Array.isArray(a.steps) ? a.steps.filter(isPlainObject) : [{ ...a, label: null }]);

// The control descriptor ranges, for value-in-range checks. Mirrors
// rules-schema.js's collectDescriptors walk (not shared: each group owns its
// own walk by design — see lint/index.js header).
function paramRanges(part) {
  const ranges = new Map();
  const secs = Array.isArray(part?.parameters) ? part.parameters : [];
  const add = (d) => {
    if (d && typeof d.key === "string" && !ranges.has(d.key)) ranges.set(d.key, { min: d.min, max: d.max });
  };
  for (const sec of secs) {
    for (const d of Array.isArray(sec?.advanced) ? sec.advanced : []) add(d);
    for (const f of Array.isArray(sec?.features) ? sec.features : []) {
      for (const s of Array.isArray(f?.sliders) ? f.sliders : []) add(s);
    }
  }
  return ranges;
}

const validKeyframes = (kf) =>
  Array.isArray(kf) && kf.length >= 2
  && kf.every((e) => Array.isArray(e) && e.length === 2 && Number.isFinite(e[0]) && Number.isFinite(e[1]))
  && kf[0][0] === 0 && kf[kf.length - 1][0] === 1
  && kf.every((e, i) => i === 0 || e[0] > kf[i - 1][0]);

export const ANIMATION_RULES = [
  {
    id: "animations-not-object",
    run: ({ part }) => {
      if (part?.animations === undefined) return [];
      if (!isPlainObject(part.animations)) {
        return [err("animations-not-object", "`animations` is not a plain object",
          "Declare animations as `animations: { <name>: { duration, tracks } }` — see docs/AUTHORING-PARTS.md \"Animations\".",
          "animations")];
      }
      return Object.entries(part.animations)
        .filter(([, a]) => !isPlainObject(a))
        .map(([name]) => err("animations-not-object", `animation "${name}" is not a plain object`,
          "Each animations entry must be an object with `duration` + `tracks`, or `steps`.",
          `animations.${name}`));
    },
  },
  {
    id: "animation-tracks-or-steps",
    run: ({ part }) => {
      const out = [];
      for (const [name, a] of animEntries(part)) {
        const hasTracks = a.tracks !== undefined;
        const hasSteps = a.steps !== undefined;
        if (hasTracks === hasSteps) {
          out.push(err("animation-tracks-or-steps",
            `animation "${name}" must have exactly one of \`tracks\` or \`steps\``,
            "A single-phase animation declares `tracks` directly; a stepped one declares `steps: [{ label, duration, tracks }]`. Never both, never neither.",
            `animations.${name}`));
          continue;
        }
        if (hasSteps && (!Array.isArray(a.steps) || a.steps.length === 0 || !a.steps.every(isPlainObject))) {
          out.push(err("animation-tracks-or-steps",
            `animation "${name}" has an empty or malformed \`steps\` array`,
            "`steps` must be a non-empty array of `{ label, duration, tracks }` objects.",
            `animations.${name}.steps`));
          continue;
        }
        rawSteps(a).forEach((s, i) => {
          const path = hasSteps ? `animations.${name}.steps[${i}].tracks` : `animations.${name}.tracks`;
          if (!isPlainObject(s.tracks) || Object.keys(s.tracks).length === 0) {
            out.push(err("animation-tracks-or-steps",
              `animation "${name}"${hasSteps ? ` step ${i}` : ""} has no tracks`,
              "Every step needs a non-empty `tracks` object mapping a param key to keyframes.",
              path));
          }
        });
      }
      return out;
    },
  },
  {
    id: "animation-unknown-param",
    run: ({ part }) => {
      if (!isPlainObject(part?.defaults)) return [];
      const known = new Set(Object.keys(part.defaults));
      const out = [];
      for (const [name, a] of animEntries(part)) {
        rawSteps(a).forEach((s, i) => {
          for (const key of Object.keys(isPlainObject(s.tracks) ? s.tracks : {})) {
            if (!known.has(key)) {
              out.push(err("animation-unknown-param",
                `animation "${name}" tracks "${key}", which is not in \`defaults\``,
                `Animations drive existing params — add "${key}" to \`defaults\` (and a control for it), or correct the key.`,
                `animations.${name}${a.steps ? `.steps[${i}]` : ""}.tracks.${key}`));
            }
          }
        });
      }
      return out;
    },
  },
  {
    id: "animation-param-not-numeric",
    run: ({ part }) => {
      if (!isPlainObject(part?.defaults)) return [];
      const out = [];
      for (const [name, a] of animEntries(part)) {
        rawSteps(a).forEach((s, i) => {
          for (const key of Object.keys(isPlainObject(s.tracks) ? s.tracks : {})) {
            if (key in part.defaults && typeof part.defaults[key] !== "number") {
              out.push(err("animation-param-not-numeric",
                `animation "${name}" tracks "${key}", whose default is not a number`,
                "v1 animations interpolate numeric params only — text/choice params cannot be keyframed.",
                `animations.${name}${a.steps ? `.steps[${i}]` : ""}.tracks.${key}`));
            }
          }
        });
      }
      return out;
    },
  },
  {
    id: "animation-keyframes-invalid",
    run: ({ part }) => {
      const out = [];
      for (const [name, a] of animEntries(part)) {
        rawSteps(a).forEach((s, i) => {
          for (const [key, kf] of Object.entries(isPlainObject(s.tracks) ? s.tracks : {})) {
            if (!validKeyframes(kf)) {
              out.push(err("animation-keyframes-invalid",
                `animation "${name}" track "${key}" has invalid keyframes`,
                "Keyframes are `[[t, value], …]` with finite numbers, at least two entries, `t` strictly ascending from exactly 0 to exactly 1.",
                `animations.${name}${a.steps ? `.steps[${i}]` : ""}.tracks.${key}`));
            }
          }
        });
      }
      return out;
    },
  },
  {
    id: "animation-value-out-of-range",
    run: ({ part }) => {
      const ranges = paramRanges(part);
      const out = [];
      for (const [name, a] of animEntries(part)) {
        rawSteps(a).forEach((s, i) => {
          for (const [key, kf] of Object.entries(isPlainObject(s.tracks) ? s.tracks : {})) {
            const r = ranges.get(key);
            if (!r || !validKeyframes(kf)) continue;
            for (const [, v] of kf) {
              if ((typeof r.min === "number" && v < r.min) || (typeof r.max === "number" && v > r.max)) {
                out.push(err("animation-value-out-of-range",
                  `animation "${name}" track "${key}" keyframes value ${v}, outside the control's range ${r.min ?? "-∞"}..${r.max ?? "∞"}`,
                  "Keyframe values are applied as-is (the engine does not clamp) — widen the control's range or move the keyframe inside it.",
                  `animations.${name}${a.steps ? `.steps[${i}]` : ""}.tracks.${key}`));
                break; // one finding per track
              }
            }
          }
        });
      }
      return out;
    },
  },
  {
    id: "animation-duration-invalid",
    run: ({ part }) => {
      const out = [];
      for (const [name, a] of animEntries(part)) {
        rawSteps(a).forEach((s, i) => {
          if (!(typeof s.duration === "number" && Number.isFinite(s.duration) && s.duration > 0)) {
            out.push(err("animation-duration-invalid",
              `animation "${name}"${a.steps ? ` step ${i}` : ""} has no positive \`duration\``,
              "Every animation (or step) needs a finite `duration` in seconds, greater than 0.",
              `animations.${name}${a.steps ? `.steps[${i}]` : ""}.duration`));
          }
        });
      }
      return out;
    },
  },
  {
    id: "animation-loop-invalid",
    run: ({ part }) => animEntries(part)
      .filter(([, a]) => a.loop === true && Array.isArray(a.steps) && a.steps.length > 1)
      .map(([name]) => err("animation-loop-invalid",
        `animation "${name}" sets \`loop: true\` on a multi-step animation`,
        "Loop is for continuous single-phase motion (gears). A stepped sequence replays via the transport instead — drop `loop` or collapse to one step.",
        `animations.${name}.loop`)),
  },
  {
    id: "animation-step-label-duplicate",
    run: ({ part }) => {
      const out = [];
      for (const [name, a] of animEntries(part)) {
        if (!Array.isArray(a.steps)) continue;
        const seen = new Set();
        a.steps.forEach((s, i) => {
          const label = s?.label;
          if (typeof label !== "string") return;
          if (seen.has(label)) {
            out.push(err("animation-step-label-duplicate",
              `animation "${name}" repeats the step label "${label}"`,
              "Step labels identify steps in the transport UI and the CLI's `--step <label>` — make each unique.",
              `animations.${name}.steps[${i}].label`));
          }
          seen.add(label);
        });
      }
      return out;
    },
  },
  {
    id: "animation-easing-unknown",
    run: ({ part }) => {
      const out = [];
      const check = (easing, path) => {
        if (easing !== undefined && !(easing in EASINGS)) {
          out.push(err("animation-easing-unknown",
            `unknown easing "${easing}"`,
            `Use one of: ${Object.keys(EASINGS).join(", ")}.`,
            path));
        }
      };
      for (const [name, a] of animEntries(part)) {
        check(a.easing, `animations.${name}.easing`);
        if (Array.isArray(a.steps)) a.steps.forEach((s, i) => check(s?.easing, `animations.${name}.steps[${i}].easing`));
      }
      return out;
    },
  },
  {
    id: "animation-camera-invalid",
    run: ({ part }) => {
      const out = [];
      const badName = (v) => typeof v !== "string" || !CANONICAL_VIEWS.includes(v);
      for (const [name, a] of animEntries(part)) {
        const stepCameras = Array.isArray(a.steps)
          ? a.steps.map((s, i) => [s?.camera, i]).filter(([c]) => c !== undefined && c !== null)
          : [];
        if (a.camera !== undefined && stepCameras.length) {
          out.push(err("animation-camera-invalid",
            `animation "${name}" mixes an animation-level \`camera\` with per-step cameras`,
            "One camera mechanism per animation: either the animation-level name/cue-list, or per-step names — not both.",
            `animations.${name}.camera`));
        }
        for (const [cam, i] of stepCameras) {
          if (badName(cam)) {
            out.push(err("animation-camera-invalid",
              `animation "${name}" step ${i} camera "${cam}" is not a canonical angle`,
              `Camera cues use the canonical angles: ${CANONICAL_VIEWS.join(", ")}.`,
              `animations.${name}.steps[${i}].camera`));
          }
        }
        if (a.camera === undefined) continue;
        if (typeof a.camera === "string") {
          if (badName(a.camera)) {
            out.push(err("animation-camera-invalid",
              `animation "${name}" camera "${a.camera}" is not a canonical angle`,
              `Camera cues use the canonical angles: ${CANONICAL_VIEWS.join(", ")}.`,
              `animations.${name}.camera`));
          }
        } else if (Array.isArray(a.camera)) {
          const cues = a.camera;
          const wellFormed = cues.length > 0 && cues.every((c) =>
            Array.isArray(c) && c.length === 2 && Number.isFinite(c[0]) && c[0] >= 0 && c[0] <= 1 && !badName(c[1]));
          const sorted = cues.every((c, i) => i === 0 || (Array.isArray(c) && Array.isArray(cues[i - 1]) && c[0] > cues[i - 1][0]));
          if (!wellFormed || !sorted) {
            out.push(err("animation-camera-invalid",
              `animation "${name}" has an invalid camera cue list`,
              `Cues are \`[[t, angle], …]\` with t strictly ascending in 0..1 and angles from: ${CANONICAL_VIEWS.join(", ")}.`,
              `animations.${name}.camera`));
          }
        } else {
          out.push(err("animation-camera-invalid",
            `animation "${name}" \`camera\` is neither an angle name nor a cue list`,
            "Use a canonical angle string, or `[[t, angle], …]` cues.",
            `animations.${name}.camera`));
        }
      }
      return out;
    },
  },
  {
    id: "animation-description-invalid",
    run: ({ part }) => animEntries(part)
      .filter(([, a]) => a.description !== undefined && typeof a.description !== "string")
      .map(([name]) => err("animation-description-invalid",
        `animation "${name}" \`description\` is not a string`,
        "The description is CommonMark shown behind the ⓘ glyph — supply a string or omit it.",
        `animations.${name}.description`)),
  },
];
```

- [ ] **Step 3: Register the rules**

In `src/framework/lint/index.js`: `import { ANIMATION_RULES } from "./rules-animations.js";` and extend `RULES = [...SHAPE_RULES, ...SCHEMA_RULES, ...BUILD_RULES, ...VERIFY_RULES, ...ANIMATION_RULES];`

- [ ] **Step 4: Run the tests, update the registry test**

Run: `npx vitest run test/lint-animations.test.js test/lint-registry.test.js test/lint-purity.test.js`
Expected: `lint-animations` PASS; `lint-registry` FAIL until you add the new rule ids to its expected catalog (read that file and extend its list); `lint-purity` PASS (animation.js and view-angles.js import nothing impure). Fix the registry list, re-run all three: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/lint/rules-animations.js src/framework/lint/index.js test/lint-animations.test.js test/lint-registry.test.js
git commit -m "feat(lint): static animations-block rules"
```

---

### Task 9: Lint note tier + probe-based track classification

**Files:**
- Create: `src/framework/pose-probe-core.js` (split from `pose-probe.js`)
- Modify: `src/framework/pose-probe.js` (delegate to the core)
- Modify: `src/framework/lint/finding.js`, `src/framework/lint/index.js`, `bin/cli.js` (`printLint`)
- Modify: `src/framework/lint/rules-animations.js` (append the classification rule)
- Test: extend `test/lint-animations.test.js`; run `test/pose-probe.test.js`, `test/framework/pose-fast-path.test.js`, `test/lint-purity.test.js`

**Interfaces:**
- Produces: `probeSubPartPose(sp, { view, purpose = "display", p, d }) → { trusted, baseHash?, pose? }` from `pose-probe-core.js` (Task 10 consumes it too). `note(...)` finding constructor; lint reports gain a `notes: []` array (severity `"note"`, never gates `ok` or `--strict`).

- [ ] **Step 1: Split the probe core**

Create `src/framework/pose-probe-core.js` by MOVING from `src/framework/pose-probe.js`: the module-header comment, the imports of `h`, `addSugar`, the kernel-contract op lists, and `MAX_PROBE_OPS`/`ProbeRunawayError`, plus `makeProbeSession`, `NAN3`, `finiteVec`, `stepsFinite` — all verbatim. Then add at the bottom:

```js
// Probe ONE sub-part's build+place at explicit params/purpose. The shared
// primitive under probePoses (pose-probe.js) and the lint place/animation
// rules — kept free of jobs.js imports so the lint import closure stays pure
// (test/lint-purity.test.js).
export function probeSubPartPose(sp, { view, purpose = "display", p, d }) {
  try {
    const { kernel, state } = makeProbeSession();
    let s = sp.build(kernel, p, d);
    if (sp.place) s = sp.place(s, { view, purpose, p, d });
    const ok = s && s.__poseToken && !state.queried && !state.unhashable && stepsFinite(s._pose);
    return ok ? { trusted: true, baseHash: s._hash, pose: s._pose } : { trusted: false };
  } catch {
    return { trusted: false };
  }
}
```

Rewrite `src/framework/pose-probe.js` to keep ONLY `probePoses`, importing `probeSubPartPose` from the core and `viewSubParts, resolveParams` from jobs as before:

```js
// Geometry-free pose probe over a view — see pose-probe-core.js for the probe
// session itself and the trust model. This wrapper resolves params/derive and
// walks the view's sub-parts; it stays separate so lint can import the core
// without dragging in jobs.js (purity).
import { probeSubPartPose } from "./pose-probe-core.js";
import { viewSubParts, resolveParams } from "./jobs.js";

export function probePoses(part, view, params) {
  const out = new Map();
  let resolved;
  try { resolved = resolveParams(part, params); }
  catch {
    for (const name of viewSubParts(part, view, params)) out.set(name, { trusted: false });
    return out;
  }
  const { p, d } = resolved;
  for (const name of viewSubParts(part, view, params)) {
    out.set(name, probeSubPartPose(part.parts[name], { view, purpose: "display", p, d }));
  }
  return out;
}
```

Run: `npx vitest run test/pose-probe.test.js test/framework/pose-fast-path.test.js`
Expected: PASS (pure refactor — `probePoses` results now include `trusted: true` alongside baseHash/pose exactly as before; if a test asserted the exact object shape `{ baseHash, pose, trusted }` vs `{ trusted, baseHash, pose }`, key order is irrelevant to `toEqual`).

- [ ] **Step 2: Add the note tier**

`src/framework/lint/finding.js` — append:

```js
// note → neither broken nor suspicious; informational context an authoring
// agent should see (e.g. "this animated track rebuilds geometry"). Notes never
// gate measure or --strict.
export const note = make("note");
```

`src/framework/lint/index.js` — in `lintPart`, extend the filtering and return:

```js
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  const notes = findings.filter((f) => f.severity === "note");
  return { ok: errors.length === 0, errors, warnings, notes };
```

Also update the JSDoc `@returns` line to `{{ok: boolean, errors: object[], warnings: object[], notes: object[]}}`.

`bin/cli.js` `printLint` — include notes (after warnings, icon `·`), keeping `lint: clean` for a report with only notes… no: notes should still print. Replace the function body:

```js
function printLint(r) {
  const all = [...r.errors, ...r.warnings, ...(r.notes ?? [])];
  if (all.length === 0) { console.log("lint: clean"); return; }
  console.log("lint:");
  for (const f of all) {
    const icon = f.severity === "error" ? "✗" : f.severity === "warning" ? "⚠" : "·";
    console.log(`  ${icon} ${f.rule}${f.path ? `  ${f.path}` : ""}`);
    console.log(`      ${f.message}`);
    console.log(`      hint: ${f.hint}${f.pattern ? ` (ERROR-PATTERNS.md#${f.pattern})` : ""}`);
  }
  const e = r.errors.length, w = r.warnings.length, n = (r.notes ?? []).length;
  console.log(`  result: ${e ? `${e} error(s)` : "no errors"}${w ? `, ${w} warning(s)` : ""}${n ? `, ${n} note(s)` : ""}`);
}
```

(`--strict` remains warnings-only: `report.ok && (!flags.strict || report.warnings.length === 0)` — unchanged.)

- [ ] **Step 3: Write the failing classification test (append to `test/lint-animations.test.js`)**

```js
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
```

Run: `npx vitest run test/lint-animations.test.js` — Expected: the new test FAILS (`notes` undefined or empty).

- [ ] **Step 4: Append the classification rule to `rules-animations.js`**

Add imports at the top: `import { note } from "./finding.js";`, `import { probeSubPartPose } from "../pose-probe-core.js";`, `import { resolveDerived } from "../derive.js";`. Append to `ANIMATION_RULES`:

```js
  {
    // note tier: performance shape, not correctness. A track whose param feeds
    // real geometry still plays — just best-effort at worker cadence instead
    // of frame rate — and the authoring agent should know which it wrote.
    id: "animation-track-rebuilds",
    run: ({ part, p }) => {
      const out = [];
      for (const [name, a] of animEntries(part)) {
        const steps = rawSteps(a);
        // endpoint values per key: first keyframe of the first segment, last of the last
        const endpoints = new Map();
        for (const s of steps) {
          for (const [key, kf] of Object.entries(isPlainObject(s.tracks) ? s.tracks : {})) {
            if (!validKeyframes(kf)) continue; // keyframes rule already reported it
            if (!endpoints.has(key)) endpoints.set(key, [kf[0][1], kf[kf.length - 1][1]]);
            else endpoints.get(key)[1] = kf[kf.length - 1][1];
          }
        }
        for (const [key, [v0, v1]] of endpoints) {
          if (typeof part?.defaults?.[key] !== "number") continue; // other rules own that
          const cls = classifyTrack(part, p, key, v0, v1);
          if (cls === "pose") continue;
          out.push(note("animation-track-rebuilds",
            cls === "rebuild"
              ? `animation "${name}" track "${key}" rebuilds geometry — playback is best-effort, not frame-rate`
              : `animation "${name}" track "${key}" cannot use the pose fast path (untrusted probe) — playback is best-effort`,
            "Frame-rate playback needs the param to feed only rigid placement (translate/rotate in `place()` or at the end of `build`). If that's the intent, restructure so the param never feeds a geometry op, a query, or a function selector; if geometry morphing is the intent, this is expected.",
            `animations.${name}`));
        }
      }
      return out;
    },
  },
```

And below `ANIMATION_RULES`, the helper:

```js
// Classify one animated param by probing every sub-part it can show, at the
// track's two endpoint values: identical trusted baseHashes at both ends →
// the param only re-poses ("pose"); differing hashes → real geometry
// ("rebuild"); any untrusted probe → "untrusted" (the fast path will decline
// it at runtime too). Mirrors the runtime trust model in pose-probe-core.js.
function classifyTrack(part, p, key, v0, v1) {
  let result = "pose";
  for (const view of Object.keys(isPlainObject(part?.views) ? part.views : {})) {
    for (const sp of Object.values(isPlainObject(part?.parts) ? part.parts : {})) {
      if (!Array.isArray(sp?.views) || !sp.views.includes(view)) continue;
      const probes = [];
      for (const v of [v0, v1]) {
        const pv = { ...p, [key]: v };
        let dv;
        try { dv = resolveDerived(part, pv) ?? {}; } catch { return "untrusted"; }
        try { if (sp.enabled && !sp.enabled(pv)) { probes.push(null); continue; } } catch { return "untrusted"; }
        probes.push(probeSubPartPose(sp, { view, purpose: "display", p: pv, d: dv }));
      }
      if (probes.some((x) => x && !x.trusted)) return "untrusted";
      const [a, b] = probes;
      if (a && b && a.baseHash !== b.baseHash) result = "rebuild";
    }
  }
  return result;
}
```

- [ ] **Step 5: Run the lint tests + purity + CLI smoke**

Run: `npx vitest run test/lint-animations.test.js test/lint-purity.test.js test/lint-registry.test.js test/lint-cli.test.js test/lint-parts.test.js`
Expected: PASS after adding `animation-track-rebuilds` to the registry list. If `lint-purity` fails naming a module, the import chain from `pose-probe-core.js` reached something impure — trace and trim (the core must import only `solid-hash`, `solid-sugar`, `kernel.js`, and `geometry/probe.js`). Then:

```bash
npx partforge lint src/parts/hinged-box.js
```

Expected: clean (both hinged-box tracks are pose-only — no notes).

- [ ] **Step 6: Commit**

```bash
git add src/framework/pose-probe-core.js src/framework/pose-probe.js src/framework/lint/ bin/cli.js test/lint-animations.test.js test/lint-registry.test.js
git commit -m "feat(lint): note tier + pose/rebuild track classification"
```

---

### Task 10: Lint place-invariant rules

**Files:**
- Create: `src/framework/lint/rules-place.js`
- Modify: `src/framework/lint/index.js`
- Test: `test/lint-place.test.js`; update `test/lint-registry.test.js`

**Interfaces:**
- Consumes: `probeSubPartPose` (Task 9), `resolveDerived`, `err` from finding.js.
- Produces: rules `view-dependent-display-place` and `place-not-rigid`, referencing the existing `docs/ERROR-PATTERNS.md` pattern ids of the same names (verify the exact `##` ids in that file first and use them verbatim as the `pattern` argument).

- [ ] **Step 1: Write the failing test**

```js
// test/lint-place.test.js
// The two place() invariants, promoted from doc-only to lint: display
// placement must not read `view`, and display-vs-export must differ by a
// rigid motion only. Both are probe-based; untrusted probes stay silent.
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const mk = (place) => ({
  meta: { title: "T" },
  parameters: [],
  defaults: { a: 1 },
  parts: { p: { views: ["v", "w"], build: (k) => k.box({ size: [1, 1, 1] }), ...(place && { place }) } },
  views: { v: { label: "V" }, w: { label: "W" } },
});
const ids = (r) => r.errors.map((f) => f.rule);

test("clean part: no place findings", () => {
  expect(ids(lintPart(mk())).filter((i) => i.includes("place"))).toEqual([]);
  expect(ids(lintPart(mk((s) => s.translate([1, 0, 0])))).filter((i) => i.includes("place"))).toEqual([]);
});

test("display pose depending on view → view-dependent-display-place", () => {
  const r = lintPart(mk((s, { view }) => (view === "w" ? s.translate([5, 0, 0]) : s)));
  expect(ids(r)).toContain("view-dependent-display-place");
});

test("non-rigid display/export delta → place-not-rigid", () => {
  const r = lintPart(mk((s, { purpose }) => (purpose === "export" ? s.scale(2) : s)));
  expect(ids(r)).toContain("place-not-rigid");
});

test("a rigid display/export difference is allowed", () => {
  const r = lintPart(mk((s, { purpose }) => (purpose === "export" ? s.translate([10, 0, 0]) : s.rotate(30, [0, 0, 0], [1, 0, 0]))));
  expect(ids(r).filter((i) => i.includes("place"))).toEqual([]);
});

test("an untrusted probe (query in build) stays silent", () => {
  const part = mk((s) => s);
  part.parts.p.build = (k) => { const b = k.box({ size: [1, 1, 1] }); b.volume(); return b; };
  expect(ids(lintPart(part)).filter((i) => i.includes("place"))).toEqual([]);
});
```

(`scale(factor, center?)` is a contract op — `src/framework/geometry/kernel.js:38` — and takes a number, not a vector.)

Run: `npx vitest run test/lint-place.test.js` — Expected: FAIL.

- [ ] **Step 2: Implement `src/framework/lint/rules-place.js`**

```js
// Group 6 — the two place() invariants (docs/AUTHORING-PARTS.md "Display vs
// export placement"), promoted from doc-only conventions to lint because the
// animation system leans on place() for every pose-only track:
//   1. Display placement must not depend on the active view (display meshes
//      are cached across views; a view-dependent pose serves stale geometry).
//   2. Display vs export may differ only by a rigid motion (translate/rotate).
// Both checks run the geometry-free pose probe; an untrusted probe (query op /
// function selector in build or place) proves nothing and stays silent — the
// runtime declines the fast path for those sub-parts anyway.
import { err } from "./finding.js";
import { probeSubPartPose } from "../pose-probe-core.js";
import { resolveDerived } from "../derive.js";

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// The sub-part names visible in a view at params p — restated locally (like
// rules-schema.js restates controls.js's visibility predicates) rather than
// imported from jobs.js, which would break the lint purity closure.
function viewNames(part, view, p) {
  return Object.entries(isPlainObject(part?.parts) ? part.parts : {})
    .filter(([, sp]) => Array.isArray(sp?.views) && sp.views.includes(view))
    .filter(([, sp]) => { try { return sp.enabled ? !!sp.enabled(p) : true; } catch { return false; } })
    .map(([name]) => name);
}

const poseKey = (pose) => JSON.stringify(pose);

export const PLACE_RULES = [
  {
    id: "view-dependent-display-place",
    run: ({ part, p, d }) => {
      const out = [];
      const views = Object.keys(isPlainObject(part?.views) ? part.views : {});
      if (views.length < 2) return out;
      for (const [name, sp] of Object.entries(isPlainObject(part?.parts) ? part.parts : {})) {
        const inViews = views.filter((v) => viewNames(part, v, p).includes(name));
        if (inViews.length < 2) continue;
        const probes = inViews.map((view) => probeSubPartPose(sp, { view, purpose: "display", p, d }));
        if (probes.some((x) => !x.trusted)) continue;
        const first = probes[0];
        const differs = probes.some((x) => x.baseHash !== first.baseHash || poseKey(x.pose) !== poseKey(first.pose));
        if (differs) {
          out.push(err("view-dependent-display-place",
            `sub-part "${name}" display placement differs between views (${inViews.join(", ")})`,
            "Display meshes are built once per sub-part and cached across views, so a view-dependent display pose shows stale geometry after a tab switch. Only `place(..., { purpose: \"export\" })` may vary; keep the display branch view-independent.",
            `parts.${name}.place`,
            "view-dependent-display-place"));
        }
      }
      return out;
    },
  },
  {
    id: "place-not-rigid",
    run: ({ part, p, d }) => {
      const out = [];
      for (const view of Object.keys(isPlainObject(part?.views) ? part.views : {})) {
        for (const name of viewNames(part, view, p)) {
          const sp = part.parts[name];
          if (!sp?.place) continue;
          const display = probeSubPartPose(sp, { view, purpose: "display", p, d });
          const exportP = probeSubPartPose(sp, { view, purpose: "export", p, d });
          if (!display.trusted || !exportP.trusted) continue;
          if (display.baseHash !== exportP.baseHash) {
            out.push(err("place-not-rigid",
              `sub-part "${name}" display and export placements differ by more than a rigid motion (view "${view}")`,
              "place() may move a solid between purposes (translate/rotate) but never reshape it — a geometry op on one branch means the exported part is not the previewed part. Move the op into build().",
              `parts.${name}.place`,
              "place-not-rigid"));
            break; // one finding per sub-part
          }
        }
      }
      return out;
    },
  },
];
```

Register in `src/framework/lint/index.js`: import `PLACE_RULES` and append to `RULES`.

- [ ] **Step 3: Verify the pattern ids and run**

Check `docs/ERROR-PATTERNS.md` for the exact `##` heading ids (`grep -n "view-dependent-display-place\|place-not-rigid" docs/ERROR-PATTERNS.md`) and make the `pattern` arguments match verbatim. Then:

Run: `npx vitest run test/lint-place.test.js test/lint-registry.test.js test/lint-purity.test.js test/lint-parts.test.js test/error-patterns.test.js`
Expected: PASS after adding the two ids to the registry list. `lint-parts` runs lint across `src/parts/*` — all existing parts must stay clean; if one triggers a place rule, STOP and investigate (either the rule is wrong or a real latent defect was found — surface it, don't silence it).

- [ ] **Step 4: Commit**

```bash
git add src/framework/lint/rules-place.js src/framework/lint/index.js test/lint-place.test.js test/lint-registry.test.js
git commit -m "feat(lint): enforce the two place() invariants via the pose probe"
```

---

### Task 11: CLI `--params` + animation stills

**Files:**
- Modify: `src/testing/render.js` (filename `tag`)
- Modify: `bin/cli.js` (render command)
- Test: `test/render-animation-cli.test.js`

**Interfaces:**
- Consumes: `normalizeAnimation`, `evaluate`, `cueAt`, `stepIndexAt` from `animation.js`.
- Produces: `renderViews(..., { tag })` → filenames `${name}-${view}-${angle}-${tag}.png` when tag is set; CLI flags `--params <json>`, `--animation <name>`, `--at <t[,t…]>`, `--step <index|label>`.

- [ ] **Step 1: Write the failing test**

Read `test/render.test.js` and `test/cli.test.js` first; mirror how they boot the kernel / spawn the CLI and where they write output (use a temp dir under the scratchpad or `test/fixtures` convention the existing tests use). The test:

```js
// test/render-animation-cli.test.js
// CLI animation stills: --params passthrough, --animation/--at frame naming,
// --step targeting, and cue-derived default views.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const cli = (args) => execFileSync("node", ["bin/cli.js", ...args], { encoding: "utf8" });
const out = () => mkdtempSync(join(tmpdir(), "pf-anim-render-"));

test("--params renders at the given params", () => {
  const dir = out();
  cli(["render", "src/parts/hinged-box.js", "--views", "iso", "--out", dir, "--params", '{"lidAngle":90}']);
  expect(readdirSync(dir)).toEqual(["hinged-box-box-iso.png"]);
});

test("--animation --at writes tagged frames, defaulting views to the governing cue", () => {
  const dir = out();
  cli(["render", "src/parts/hinged-box.js", "--out", dir, "--animation", "open", "--at", "0,0.5,1"]);
  // open's cue is "front" at t=0 → governs every t
  expect(readdirSync(dir).sort()).toEqual([
    "hinged-box-box-front-open-t000.png",
    "hinged-box-box-front-open-t050.png",
    "hinged-box-box-front-open-t100.png",
  ]);
});

test("--step renders the end of the named step at its cue view", () => {
  const dir = out();
  cli(["render", "src/parts/hinged-box.js", "--out", dir, "--animation", "assemble", "--step", "Lower the lid"]);
  expect(readdirSync(dir)).toEqual(["hinged-box-box-left-assemble-step1.png"]);
});

test("--at without --animation fails loudly", () => {
  expect(() => cli(["render", "src/parts/hinged-box.js", "--at", "0.5"])).toThrow();
});
```

Run: `npx vitest run test/render-animation-cli.test.js` — Expected: FAIL (unknown flags; `parseArgs` strict mode dies).

- [ ] **Step 2: Implement `renderViews` tag support**

In `src/testing/render.js`, add `tag` to the options destructuring (`..., params = {}, tag = "" }`) and change the filename line (line 124) to:

```js
    const file = join(out, `${name}-${view}-${angle}${tag ? `-${slug(tag)}` : ""}.png`);
```

- [ ] **Step 3: Implement the CLI**

In `bin/cli.js`, add the import:

```js
import { normalizeAnimation, evaluate, cueAt } from "../src/framework/animation.js";
```

Replace the `render` command:

```js
  async render(args) {
    const usage = "usage: partforge render <part-module> [view] [--views iso,front] [--out <dir>] " +
      "[--params <json>] [--animation <name>] [--at <t[,t…]>] [--step <index|label>]";
    const { values: flags, positionals: [partPath, view] } = parse(args, {
      views: { type: "string" },
      out: { type: "string" },
      params: { type: "string" },
      animation: { type: "string" },
      at: { type: "string" },
      step: { type: "string" },
    }, usage);
    try {
      const part = await loadPart(partPath, usage);
      const baseParams = flags.params ? JSON.parse(flags.params) : {};
      const outDir = flags.out || "render";
      const views = flags.views ? flags.views.split(",") : undefined;
      const kernel = await bootKernel(part);

      if (!flags.animation) {
        if (flags.at || flags.step) die(`--at/--step require --animation\n${usage}`);
        const files = await renderViews(kernel, part, view, { views, out: outDir, params: baseParams });
        for (const f of files) console.log(`wrote ${f}`);
        process.exit(0);
      }

      const spec = part.animations?.[flags.animation];
      if (!spec) {
        throw new Error(`unknown animation "${flags.animation}" (have: ${Object.keys(part.animations ?? {}).join(", ") || "none"})`);
      }
      const anim = normalizeAnimation(flags.animation, spec);
      // Frames: --step renders one still at the END of that step (its fully
      // applied state); --at takes positions normalized over the animation's
      // TOTAL duration (same t as the viewer scrubber / runtime seek).
      let frames;
      if (flags.step != null) {
        const byLabel = anim.steps.findIndex((s) => s.label === flags.step);
        const idx = byLabel >= 0 ? byLabel : Number(flags.step) - 1;
        if (!(idx >= 0 && idx < anim.steps.length)) {
          throw new Error(`unknown step "${flags.step}" (use 1..${anim.steps.length} or a label: ${anim.steps.map((s) => JSON.stringify(s.label)).join(", ")})`);
        }
        const end = idx + 1 < anim.steps.length ? anim.stepStarts[idx + 1] : 1;
        frames = [{ t: end, tag: `${flags.animation}-step${idx + 1}` }];
      } else {
        const ts = (flags.at ?? "1").split(",").map(Number);
        if (!ts.length || ts.some((t) => !Number.isFinite(t) || t < 0 || t > 1)) {
          die(`--at takes comma-separated positions in 0..1\n${usage}`);
        }
        frames = ts.map((t) => ({ t, tag: `${flags.animation}-t${String(Math.round(t * 100)).padStart(3, "0")}` }));
      }
      for (const frame of frames) {
        const { values } = evaluate(anim, frame.t);
        const cue = cueAt(anim, frame.t);
        const frameViews = views ?? (cue ? [cue.view] : undefined);
        const files = await renderViews(kernel, part, view, {
          views: frameViews, out: outDir, params: { ...baseParams, ...values }, tag: frame.tag,
        });
        for (const f of files) console.log(`wrote ${f}`);
      }
      process.exit(0);
    } catch (e) {
      crash("render", e, false);
    }
  },
```

Note: `renderViews` calls `kernel.cleanup?.()` after copying meshes out — the same kernel serves every frame in sequence; if a second frame errors with a disposed-solid symptom, grep `docs/ERROR-PATTERNS.md` first, and fall back to booting the kernel per frame inside the loop.

- [ ] **Step 4: Run**

Run: `npx vitest run test/render-animation-cli.test.js test/render.test.js test/cli.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/cli.js src/testing/render.js test/render-animation-cli.test.js
git commit -m "feat(cli): render --params and animation stills (--animation/--at/--step)"
```

---

### Task 12: Docs, README, ERROR-PATTERNS, version bump

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (new "Animations" section), `README.md` (runtime surface), `docs/ERROR-PATTERNS.md` (one new entry), `package.json` (version)
- Test: `npx vitest run test/error-patterns.test.js`, then full `npm test`

- [ ] **Step 1: AUTHORING-PARTS.md — add an "Animations" section**

Place it after the `place()` / display-vs-export section. Content (adapt heading level to the file's conventions):

~~~markdown
## Animations

A part may declare named animations — pure keyframe data that drives **existing
params** over time. The viewer shows a transport bar (play/scrub/step); hosts
drive the same engine via `runtime.animation`; `partforge render` can render
stills at any position. The reference part is `src/parts/hinged-box.js`.

```js
animations: {
  open: {
    label: "Open lid",
    description: "Optional **CommonMark**, shown behind the ⓘ glyph.",
    camera: "front",          // optional: intro angle, cue list, or per-step (below)
    duration: 1.2,            // seconds
    loop: false,              // true = wraps continuously (single-step only)
    easing: "ease-in-out",    // linear | ease-in | ease-out | ease-in-out
    tracks: { lidAngle: [[0, 0], [1, 110]] },   // param -> [t, value] keyframes
  },
  assemble: {
    label: "Assemble",
    steps: [                  // steps play in order; prev/next navigate them
      { label: "Lower the lid", camera: "left", duration: 1.0,
        tracks: { lidLift: [[0, 40], [1, 0]] } },
      { label: "Open", camera: "iso", duration: 1.0,
        tracks: { lidAngle: [[0, 0], [1, 110]] } },
    ],
  },
}
```

Rules (all lint-enforced):

- An animation has **either** `tracks` (a single anonymous step) **or** `steps`.
- Tracks reference numeric params from `defaults`. Keyframe `t` is normalized
  per step, strictly ascending from exactly 0 to exactly 1; values must sit
  inside the owning control's min/max (the engine applies them unclamped).
- Params not tracked anywhere keep their current values; a param tracked in
  one step holds its nearest keyframe value while other steps play.
- Couple motions through `derive` (animate one master param; derive the rest),
  not by tracking dependent params separately.
- `camera` cues use the seven canonical angles (`iso front back top bottom
  left right`). One mechanism per animation: an animation-level name (an intro
  cue at t=0), an animation-level `[[t, angle], …]` list, or per-step names.
  Cues fire during play only — scrubbing never moves the camera — and a user
  orbit disarms the remaining cues for that run.
- Playback drives params through the real param pipeline: a **pose-only**
  param (feeds only rigid placement — see the fast path section above) plays
  at frame rate; anything else rebuilds best-effort at worker cadence. `lint`
  prints a note per track that can't take the fast path.
- Playback pauses when the user edits any control; Reset restores the values
  the animation found. Because animated values are real params, exporting
  while paused exports the posed state — by design.

Headless: `partforge render <part> --animation open --at 0,0.5,1` renders
tagged stills (`--at` is normalized over the animation's total duration, like
the scrubber); `--step <index|label>` renders a step's end state; stills
default to the governing camera cue's angle.
~~~

- [ ] **Step 2: README.md — extend the runtime section**

After the `runtime.setParams` bullet/example (README.md:154-171), add:

```markdown
For parts that declare `animations`, `runtime.animation` exposes the viewer's
playback engine (`null` otherwise):

```js
runtime.animation.play("open");   // switch + play (camera cue and all)
runtime.animation.seek(0.5);      // scrub, normalized 0..1 (pauses)
runtime.animation.pause();
runtime.animation.stop();         // reset + restore pre-animation params
runtime.animation.state();        // { animation, status, t, stepIndex }
```
```

- [ ] **Step 3: ERROR-PATTERNS.md — one new entry**

Read the file's preamble for the exact entry format (one `##` per pattern, symptom → cause → fix), then append:

```markdown
## animation-plays-choppy

**Symptom:** an animation stutters or updates a few times a second instead of
smoothly; `?debug` shows `rebuilt` counts climbing during playback.

**Cause:** a track drives a param that feeds real geometry (or a build the
pose probe can't trust — a query op or function selector), so every frame is
a worker rebuild instead of a pose repair.

**Fix:** run `npx partforge lint <part>` — the `animation-track-rebuilds`
note names the track. Restructure so the param only feeds rigid placement
(`place()` or trailing translate/rotate in `build`), or accept best-effort
playback if geometry morphing is the intent.
```

Run: `npx vitest run test/error-patterns.test.js` — Expected: PASS (the entry parses).

- [ ] **Step 4: Version bump**

In `package.json`, bump `"version"` from its current value to the next minor (e.g. `0.41.0` → `0.42.0` — check the current value first). Publishing itself stays tag-driven post-merge (AGENTS.md "Releasing") — do NOT tag or publish.

- [ ] **Step 5: Full suite + smoke**

```bash
npm test
npm run check
```

Expected: both green.

- [ ] **Step 6: Commit**

```bash
git add docs/AUTHORING-PARTS.md README.md docs/ERROR-PATTERNS.md package.json
git commit -m "docs(animation): authoring guide, runtime surface, error pattern; bump 0.42.0"
```

---

## Out of scope (do not build)

Sweep-collision verify across a param range; GIF/APNG assembly; prebaked frame caches; free-form camera paths (non-canonical angles, dolly/zoom); scene-graph hierarchy; pose slerp; an `apply(t)` contract escape hatch; non-numeric tracks; partforge-cloud UI.
