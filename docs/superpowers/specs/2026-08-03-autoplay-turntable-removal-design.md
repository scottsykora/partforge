# Autoplay animations + turntable removal — design

**Date:** 2026-08-03
**Status:** Approved design, pre-implementation
**Predecessor:** `2026-08-02-model-animation-design.md` (the animation system this builds on, merged as PR #95)

## Goal

The idle auto-rotate turntable (and its pause/play button) adds little value now
that parts can animate themselves — remove it entirely. In its place, a part may
mark **one** animation `autoplay: true`; the viewer starts it on first show and
again on every view/tab switch, until the user manually touches the transport.

## Decisions

| Decision | Choice |
| --- | --- |
| Turntable | Removed entirely: button, viewer auto-rotate, suppression arbitration, persisted preference. |
| Contract | Per-animation boolean `autoplay: true`; lint errors on more than one, or a non-boolean value. |
| Trigger | First show of the assembly, and every view/tab switch after that. |
| Disarm | Any manual transport interaction (play/pause button, scrubber, picker, step buttons, reset, `runtime.animation` calls) or a param edit that pauses playback disarms auto-retriggering for the session. |
| Loops | `play()` on an already-playing animation is a no-op, so a looping autoplay simply keeps running across tab switches — the turntable replacement. |
| Camera cues | Autoplay plays the animation exactly as a user press would (intro cues included); a user orbit disarms cues as before. |

## 1. Turntable removal

- `viewer.js`: drop `controls.autoRotate`/`autoRotateSpeed` init, the
  `autoRotateRequested`/`autoRotateSuppressed`/`syncAutoRotate` block, and the
  `setAutoRotate`/`suppressAutoRotate` exports. Cutaway no longer needs to
  suppress anything.
- `viewer-controls.js`: drop the pause-button wiring; `view-state.js`: drop
  `loadRotating`/`saveRotating` (and their tests).
- `animation-controls.js`: drop both `viewer.suppressAutoRotate(...)` calls.
- `mount.js`: stop resolving `els.chrome.pause` (a host still passing one is
  silently ignored). Embedding-contract comment version bumped.
- All app HTML pages: remove the `#pause` button.
- `scripts/check-app.mjs`: remove the two pause-click stabilization blocks (the
  canvas no longer rotates at idle); the frame-wait + consecutive-identical
  screenshot loops stay.
- Affected tests updated (viewer-controls pause cases, view-state rotating
  round-trip, animation-controls suppression assertions).

## 2. `autoplay: true`

- `normalizeAnimation` carries `autoplay: !!spec.autoplay`.
- The transport driver resolves the (single) autoplay animation at attach and
  keeps an `autoplayArmed` flag. New handle method `autoplayKick()`: when armed,
  select the autoplay animation if needed and `play()` it (no-op when already
  playing/intro). Every manual interaction listed above sets
  `autoplayArmed = false`.
- `mount.js` calls `animCtl?.autoplayKick()` (a) when the first build resolves
  `ready`, and (b) in the view-tabs `onChange` handler.
- Lint: `animation-autoplay-invalid` (error) — non-boolean `autoplay`, or more
  than one animation declaring it. Registered + rule-catalog entry.
- Example: hinged-box's `cycle` loop gains `autoplay: true`.
- CLI stills ignore `autoplay` (nothing to do headless).

## 3. Docs & version

- AUTHORING-PARTS.md: `autoplay` in the Animations contract rules; remove
  turntable/pause references. README: same sweep. Version → 0.44.0 (main is
  0.43.0).
- Downstream note for the PR: hosts that passed `elements.chrome.pause` get a
  no-op; there was no other public rotation API.

## Out of scope

Per-view autoplay overrides; autoplay delay/once-only modes; re-arming UI.
