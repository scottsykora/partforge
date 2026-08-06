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

// Look easings up by OWN key only. `EASINGS[name]` / `name in EASINGS` would walk
// the prototype chain, so "toString" resolves to a function that silently returns
// garbage and "__proto__" resolves to a non-function that throws — mid-frame, from
// inside the render loop. Lint applies the same test, so an unknown easing is an
// authoring error there and a quiet fall back to the default here.
export const easingFor = (name) =>
  (Object.hasOwn(EASINGS, name) ? EASINGS[name] : EASINGS[DEFAULT_EASING]);

// A track value has to be a non-empty keyframe array to be evaluable. Lint reports
// anything else as `animation-keyframes-invalid`; this predicate is what keeps the
// runtime total when a part reaches it unlinted, and it must stay the single rule
// both segmentsFor and trackedKeys agree on — if they disagree, evaluate() is asked
// for a key that has no segment and throws.
const usableKeyframes = (kf) => Array.isArray(kf) && kf.length > 0;

// t is clamped to [0,1]. Only an unorderable t (NaN, or anything that coerces to
// it, such as a host calling seek() with no argument) folds to 0 — ±Infinity is
// ordered and clamps normally. NaN has to be caught rather than clamped because
// it fails every comparison: `Math.min(1, Math.max(0, NaN))` is still NaN, and an
// unclamped NaN leaves `t >= 1` permanently false, so playback could never reach
// `done` and every later cue test would silently fail.
const clampT = (t) => {
  const n = Number(t);
  return Number.isNaN(n) ? 0 : Math.min(1, Math.max(0, n));
};

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
  const trackedKeys = [...new Set(steps.flatMap((s) =>
    Object.entries(s.tracks).filter(([, kf]) => usableKeyframes(kf)).map(([key]) => key)))];
  return {
    name, label: spec.label ?? name, description: spec.description ?? null,
    loop: !!spec.loop, autoplay: !!spec.autoplay, steps, stepStarts, totalDuration, cues, trackedKeys,
  };
}

export function normalizeAnimations(part) {
  return Object.entries(part?.animations ?? {}).map(([name, spec]) => normalizeAnimation(name, spec));
}

// Step containing t. Boundaries belong to the LATER step, and t clamps to [0,1].
export function stepIndexAt(anim, t) {
  const tc = clampT(t);
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
    if (!usableKeyframes(kf)) return;
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
  // trackedKeys and segmentsFor share usableKeyframes, so a tracked key always
  // has a segment. Guard anyway: this runs inside the render loop, where a throw
  // costs the whole viewer, not just the frame.
  if (!segs.length) return undefined;
  let prev = null;
  for (const seg of segs) {
    if (t < seg.start) break;
    if (t <= seg.end) {
      const span = seg.end - seg.start || 1;
      const local = easingFor(seg.easing)((t - seg.start) / span);
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
  const tc = clampT(t);
  const values = {};
  for (const key of anim.trackedKeys) values[key] = evaluateTrack(anim, key, tc);
  return { stepIndex: stepIndexAt(anim, tc), values };
}

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
  let pendingCueT = null; // cue handed to an in-flight intro tween, not yet settled
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
    // The cue is NOT counted as fired yet — only introDone() retires it. Pausing
    // mid-intro cancels the tween and drops its completion callback, so a cue
    // retired here would never be re-issued on resume and the camera would stay
    // stranded wherever the cancelled sweep left it.
    if (cue) { pendingCueT = cue.t; status = "intro"; }
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
    pendingCueT = null; // an unsettled intro cue is abandoned, so resume re-issues it
    return snapshot();
  }
  function introDone() {
    if (status === "intro") {
      if (pendingCueT != null) firedCueT = Math.max(firedCueT, pendingCueT);
      status = "playing";
    }
    pendingCueT = null;
    return snapshot();
  }
  function seek(v) {
    t = clampT(v);
    status = "paused";
    stopAt = null;
    firedCueT = -1; // a later play() re-honors the cue governing the new position
    pendingCueT = null;
    return snapshot();
  }
  function playStep(i) {
    const idx = Math.min(anim.steps.length - 1, Math.max(0, i));
    t = anim.stepStarts[idx];
    stopAt = idx + 1 < anim.steps.length ? anim.stepStarts[idx + 1] : 1;
    firedCueT = -1;
    pendingCueT = null;
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
    t = 0; status = "idle"; stopAt = null; firedCueT = -1; pendingCueT = null; armed = true;
    return snapshot();
  }
  function disarmCues() { armed = false; }
  function userEdited() { if (status === "playing" || status === "intro") status = "paused"; }

  function tick(dt) {
    if (status !== "playing" || !(dt > 0)) return null;
    t += dt / anim.totalDuration;
    // A pending step boundary outranks looping. Lint rejects loop on a stepped
    // animation, so the two rarely coexist — but when they do, an explicit
    // "play this step" must still stop where it was told to, rather than being
    // swallowed by the wrap and running forever.
    if (stopAt != null && t >= stopAt) {
      t = stopAt; stopAt = null; status = "paused";
    } else if (anim.loop) {
      if (t >= 1) t -= Math.floor(t);
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
