# Model animation — design

**Date:** 2026-08-02
**Status:** Approved design, pre-implementation
**Predecessor:** `2026-07-27-pose-fast-path-design.md` — the pose fast path was built
explicitly to feed this project ("the animation system itself (keyframes/timelines/
easing) — separate upcoming project; this provides its fast entry point").

## Goal

Let a part author declare named animations on a `PartDefinition` — a hinged box
opening, gears turning, an assembly sequence with labeled steps — and let end
users play, scrub, and step through them in the viewer. Animations drive
**existing params over time**; nothing new is introduced at the geometry level.
Pose-only params replay at frame rate through the existing pose fast path;
geometry-rebuilding params play best-effort at whatever cadence the worker
sustains.

## Decisions (from brainstorming)

| Decision | Choice |
| --- | --- |
| Audience | Part author declares; viewer UI plays. Runtime handle gets a minimal programmatic surface. |
| Geometry-rebuilding params | Allowed, best-effort live. No prebaking in v1. |
| Assembly sequences | First-class named steps with labels and prev/next navigation. |
| Headless surface | Lint validation + CLI frame stills. Sweep-verify and GIF deferred. |
| Contract shape | Pure keyframe data. Procedural coupling via existing `derive`. No `apply(t)` escape hatch in v1. |
| Camera pose | Optional: a single intro angle, or keyframed camera cues (`[t, angle]` list / per-step sugar); camera tweens between canonical angles during playback. |
| Description | Optional markdown string per animation; info icon in the transport bar opens a popover. |

## 1. Contract — `animations` key on the PartDefinition

New optional top-level key, pure data:

```js
animations: {
  open: {
    label: "Open lid",
    description: "Shows the lid swing clearance. **Max open:** 110°.", // optional, markdown
    camera: "front",                       // optional, canonical angle name
    duration: 1.2,                         // seconds
    loop: false,                           // true = wraps continuously (gears)
    easing: "ease-in-out",                 // "linear" | "ease-in" | "ease-out" | "ease-in-out"
    tracks: { lidAngle: [[0, 0], [1, 110]] } // param -> [t, value] keyframes, t in 0..1
  },
  assemble: {
    label: "Assembly",
    steps: [
      { label: "Insert shaft", camera: "left", duration: 1.0, tracks: { shaftZ: [[0, 40], [1, 0]] } },
      { label: "Close lid",    camera: "iso",  duration: 0.8, tracks: { lidAngle: [[0, 110], [1, 0]] } },
    ],
  },
}
```

Rules:

- An animation has **either** `tracks` (sugar for a single anonymous step) **or**
  `steps` (non-empty array). Internally everything normalizes to a step list.
- Tracks reference **existing numeric params** by key. `t` is normalized per
  step; keyframes must be sorted, starting at `t = 0` and ending at `t = 1`.
  Values are absolute param values.
- Params not in any track keep their current UI values — animations compose
  with the user's parameter state.
- `easing` applies per step (default `ease-in-out`; use `linear` for loops).
- `loop: true` is valid only on single-step animations.
- `camera` (optional) is either a single canonical angle name or a list of
  camera cues `[[t, name], ...]` with `t` normalized over the animation's
  total duration and cue times sorted. Angle names are the seven canonical
  angles in `src/framework/view-angles.js` (`CANONICAL_VIEWS`: iso, front,
  back, top, bottom, left, right) — shared with CLI render, so headless stills
  agree with the viewer by construction. A step may instead declare
  `camera: "<name>"` as sugar for a cue at that step's start; mixing per-step
  cameras with an animation-level cue **list** is a lint error (a single
  animation-level intro name plus per-step cameras is also disallowed — one
  mechanism per animation).
- `description` (optional) is a CommonMark string rendered with the existing
  `renderMarkdown` sanitizer (`src/framework/markdown.js`).
- Procedural coupling (gear B turns at −2× gear A) is expressed with the
  existing `derive` mechanism: animate one master param, derive the rest.
- Animations are data, not code: no functions anywhere in the block. This keeps
  lint fully static, scrubbing deterministic, and the block editable by future
  tooling (partforge-cloud).

## 2. Playback engine

Two units, following the `rail.js` / `rail-state.js` split:

- **`src/framework/animation.js`** — pure, DOM-free: contract normalization
  (tracks → steps), `evaluate(anim, timeSeconds) → { stepIndex, values }`,
  easing functions, loop/clamp math, and the playback state machine
  (idle / camera-intro / playing / paused; play, pause, seek, stepNext,
  stepPrev, reset). No clock inside; fully unit-testable.
- **A driver wired in `mount.js`** that ticks the state machine. The viewer
  gains a small `onFrame(cb)` hook invoked inside its existing `renderFrame`
  loop — so playback automatically halts when an embedder parks the viewer via
  `setActive(false)`; no second rAF loop, no drift. Delta time comes from the
  frame callback, not `Date.now()` in shared code paths.

Each tick applies evaluated values through the existing `setParams` path — the
sanctioned "animation-system hook" (`mount.js`). Pose-only params are repaired
synchronously by the pose fast path at frame rate; geometry-affecting params
flow through the regen loop best-effort.

**One targeted regen-loop change:** today `markDirty()` restarts the 180 ms
debounce on every call, so a param changing every frame would *never* rebuild
during playback. `markDirty` gains a `{ debounce: false }` mode (used only by
the animation driver): the version still bumps, but instead of arming the
timer the driver kicks the loop directly after the pose fast path has
repaired — a pose-only frame finds nothing missing and sends no job, while a
geometry frame dispatches immediately whenever the worker is idle. That gives
best-effort rebuilds at worker cadence, clock-free, with at most one build in
flight exactly as today. Typing behavior in the controls is unchanged.

### Camera cues

Camera direction is presentational and driven by cues. A single `camera` name
is one cue at `t = 0`; a cue list places moves anywhere on the timeline;
per-step `camera` desugars to a cue at the step's start. Semantics:

- A cue at `t = 0` is the **intro**: pressing play first tweens the orbit
  camera to that angle (~0.6 s, eased; target/distance derived from the
  current framing via `cameraPoseForView`), and playback begins when it
  settles. It runs once per play, including for loops.
- A cue at `t > 0` **starts** its eased tween at that moment, overlapping
  playback. The tween helper is retargetable, so closely spaced cues blend
  smoothly instead of snapping.
- Cues fire only during play. Scrubbing or stepping without pressing play
  never moves the camera. Pressing play mid-timeline first honors the most
  recent cue at or before the current position.
- The user can orbit freely at any time. Orbiting cancels the in-flight tween
  **and disarms the remaining cues for that play-through** — the user has
  taken the camera. Reset or replaying from the start re-arms them.

The playback state machine tracks the current cue index alongside step index;
the tween itself lives in the viewer as a small retargetable orbit-tween
helper.

### Interplay rules

- User edits to any control while playing → playback pauses.
- Selecting an animation snapshots the current values of its tracked params;
  **Reset** restores them. Stopping/pausing *holds* the current pose — params
  are real params, so inspecting, verifying relevance, and even exporting the
  posed state all behave normally (documented, intentional).
- Auto-rotate (turntable) is suppressed while an animation is playing, same
  pattern as cutaway's suppression; restored after.
- Scrubbing while paused applies values through the same path (pose-only =
  instant, geometry = best-effort).
- `onBuild` continues not to fire for pose-only repairs (existing fast-path
  semantics unchanged).

## 3. Viewer UI

A transport bar on the stage (styled with the existing viewer-controls
chrome), shown only when the part declares animations:

- Animation picker (only when more than one animation is declared).
- Title with an **info icon when `description` is present** — tapping opens a
  popover rendering the markdown via `renderMarkdown`, the same pattern as the
  existing control/section info popovers.
- Play/pause, scrubber, Reset.
- Stepped animations: prev/next step buttons with the current step's label;
  tick marks on the scrubber at step boundaries.
- Loop animations: play/stop; scrubber shows position within the cycle.
- Lives on the stage, so it works unchanged in the mobile single-pane layout.

Minimal runtime surface for hosts (near-free once the engine exists):
`runtime.animation.play(name)`, `.pause()`, `.seek(t)`, `.stop()`, plus a
current-state getter. partforge-cloud can build its own transport on this.

## 4. Headless surface — lint + CLI stills

**Lint** (`src/framework/lint/rules-animations.js`, static, no kernel boot):

- Track references an unknown or non-numeric param → error.
- Keyframe value outside the param schema's min/max → error.
- Keyframes unsorted, or missing the 0/1 endpoints → error.
- Non-positive duration; `loop` on a multi-step animation; duplicate step
  labels; empty `tracks`/`steps`; both `tracks` and `steps` present → error.
- `camera` angle name not in `CANONICAL_VIEWS` (wherever it appears) → error;
  cue times unsorted or outside 0..1 → error; per-step cameras mixed with an
  animation-level `camera` → error. `description` not a string → error.
- Info-level: classify each tracked param via the existing kernel-free pose
  probe — "track `twist` rebuilds geometry; playback will be best-effort" — so
  agents know the performance shape of what they authored.

**CLI:**

- `partforge render` gains `--params '{"lidAngle":45}'` (currently missing and
  generally useful; a prerequisite for everything else).
- `--animation open --at 0.5` (comma list allowed) and `--step <index|label>`
  (renders that step's end state) render animation-addressed stills. `--at` —
  like `seek(t)` on the runtime surface — takes a position normalized over the
  animation's **total** duration (0 = start of first step, 1 = end of last);
  per-step keyframe `t` values in the contract are unrelated to this. When the
  animation declares camera cues, a still at `--at t` defaults to the angle of
  the cue governing that moment (the most recent cue at or before `t`). When the
  animation declares `camera`, that angle is the default view for its stills.
- `renderViews` filenames gain the animation/time suffix so frames don't
  collide (today the name is `${name}-${view}-${angle}.png` with no frame
  component).

## 5. Example part, docs, hardening

- New `src/parts/hinged-box.js` + the standard three glue files
  (`hinged-box.html`, `src/app-hinged-box.js`, `src/hinged-box-worker.js`):
  lid hinged via `place()` rotation, an `open` animation with an intro `camera`
  and a `description`, and a stepped `assemble` animation with per-step camera
  cues. This is the reference
  part for the new AUTHORING-PARTS.md section.
- AUTHORING-PARTS.md gains an "Animations" section (contract, rules, the
  pose-only vs rebuild performance distinction, derive-for-coupling pattern).
- ERROR-PATTERNS.md entries added as failure modes are identified during
  implementation.
- Hardening (cheap, newly load-bearing): lint rules for the two currently
  doc-only `place()` invariants — view-dependent display placement and
  non-rigid display/export deltas — since animation leans much harder on
  `place()`.

## 6. Testing

- Unit: `animation.js` normalization, evaluation, easing, loop math, and the
  playback state machine (pure, like `rail-state.js` tests).
- Unit: lint rules; CLI `--params` / `--at` / `--step` parsing and filename
  suffixes.
- Camera cue logic (desugaring, cue selection for a given `t`, disarm-on-orbit)
  and tween math (pose interpolation toward `cameraPoseForView` output) unit
  tested; the viewer tween stays thin over it.
- Smoke check (`scripts/check-app.mjs`) gains `hinged-box.html`.
- Existing invariants re-asserted: display placement view-independence and the
  render-angle table consistency test already pin the seams animation touches.

## 7. Explicitly out of scope (v1)

- Sweep-collision verify across an animation's param range (the obvious next
  verify extension; a hinge colliding only at 30° still passes today).
- GIF/APNG assembly from frames (stills only).
- Prebaked frame caches for smooth geometry-rebuild playback.
- Free-form camera paths: cues are limited to the seven canonical angles — no
  arbitrary azimuth/elevation targets, dolly/zoom keyframes, or continuous
  orbit sweeps.
- Scene-graph parent/child hierarchy (poses remain absolute per sub-part).
- Pose blending/slerp of arbitrary poses; `pose.js` stays compose/invert only.
- An `apply(t, p)` function escape hatch in the contract.
- Non-numeric (boolean/choice) param tracks.
- Any partforge-cloud UI work (it consumes the runtime surface).
