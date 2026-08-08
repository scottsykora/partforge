# Chapter hover-reveal on the animation timeline — design

**Date:** 2026-08-08
**Status:** Approved

## Problem

For multi-step animations, the transport bar today shows a step readout and
paging buttons — `[‹] [1/2 · Lower] [›]` — between play and the scrubber.
That's three pieces of chrome for information the timeline itself could
carry: the scrubber already draws tick marks at chapter boundaries. And for
parts with several top-level animations, the dropdown picker is the only way
to move between them — no quick next/previous.

## Requirements

- **Chapters (steps within one animation):** remove the step label and the
  `‹`/`›` step-paging buttons. Chapter names appear instead as a small
  bubble floating above the scrubber, revealed while hovering the timeline
  or dragging the playhead, naming the chapter under the pointer/playhead.
- **Top-level animations:** when a part declares more than one animation,
  add `‹`/`›` paging buttons alongside the existing dropdown picker to step
  through the animations. This paging is for whole animations only — never
  chapters.
- Keyboard and screen-reader users must not lose chapter access when the
  buttons go away.

## Design

### Chapter bubble (steps > 1 only)

- **Reveal:** the bubble shows while the pointer hovers anywhere over the
  scrubber wrap (tracking the cursor's timeline fraction), while the
  playhead is being dragged by mouse or touch (tracking the playhead), and
  on keyboard seeks (fading out ~1s after the last input). It hides on
  pointer-leave. Chapter lookup maps the fraction through the animation's
  existing `stepStarts` array — the same math `animation.js` uses for
  `stepIndex`.
- **Placement:** an out-of-flow (`position: absolute`) child of
  `.pf-anim-scrub-wrap`, sitting above the bar, horizontally clamped to the
  scrubber's ends. Being out-of-flow, it never changes the bar's size, so it
  cannot disturb the ResizeObserver placement clamp. In the rare
  width-capped state the bar clips its contents by design and the bubble
  clips with them — accepted.
- **Look:** the bar's own language — `--pf-mono` 10px in `--pf-text-2` (the
  old step label's voice) on a `--pf-surface` card with `--pf-border`
  hairline, `--pf-radius-control`, and the float shadow. No caret, no
  entrance animation beyond a fast opacity fade, suppressed under
  `prefers-reduced-motion`. Ticks and playhead are untouched.
- **Content:** the chapter's label, nothing else.
- Single-step animations get no bubble and no hover handlers.

### Scrubber width

140px → 220px, constant for all animations — the paging UI's freed space is
spent on chapter-targeting precision, and a constant width keeps the bar
from jumping when the picker switches between stepped and un-stepped
animations.

### Accessibility (the replacement for the removed buttons)

- The range input's `aria-valuetext` announces "«chapter» — NN%" (percent
  only, for single-step animations) on every value change.
- `PageUp`/`PageDown` on the focused scrubber jump to the next/previous
  chapter boundary (seek, not play) — matching the keys' native slider
  direction, where PageUp increases the value; arrow keys keep native
  fine-seeking. No-ops for single-step animations.

### Top-level animation pager (animations > 1 only)

- `‹` and `›` buttons flanking the dropdown picker: `[‹][picker ▾][›]`.
- They cycle with wrap-around (`›` on the last animation returns to the
  first), through the exact same `selectAnimation` path as the picker —
  reset, structure rebuild, and autoplay disarm included — and update the
  picker's displayed value.
- Absent (not rendered) for single-animation parts, exactly like the picker.
- aria-labels "Previous animation" / "Next animation".

### What goes, what stays

- **Removed:** `prevBtn`, `nextBtn`, `stepLabel`, their listeners and
  detach entries, the step-label `textSetter`, `syncStructure`'s
  stepped-visibility toggling, and the `.pf-anim-step` CSS rule.
- **Kept:** the playback machine (`animation.js`) keeps `stepNext` /
  `stepPrev` / `playStep` untouched — pure, contract-tested, and this is
  deliberately a UI-only change. Picker, ⓘ info, play, reset, ticks, and
  the placement clamp are untouched.

## Testing & docs

- **Unit (happy-dom):** bubble appears with the right label and clamped
  position for synthesized pointer events; absent for single-step
  animations; `aria-valuetext` tracks chapter + percent; PageUp/PageDown
  land on `stepStarts` boundaries; animation pager cycles with wrap and
  routes through `selectAnimation`; teardown removes all new listeners.
  Existing tests referencing `prevBtn`/`stepLabel` are updated.
- **check-app:** existing layout assertions already cover the (now
  narrower) bar; no new browser check — the hover interaction is
  deterministic in unit tests.
- **Docs:** `docs/AUTHORING-PARTS.md`'s transport descriptions ("play/
  scrub/step", "steps play in order; prev/next navigate them") are
  rewritten to describe hover-reveal chapters and the animation pager.

## Out of scope

- No changes to the `PartDefinition` animations schema or lint rules.
- No removal of step APIs from the playback machine.
- No new check-app coverage.
