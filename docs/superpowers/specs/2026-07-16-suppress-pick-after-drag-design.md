# Suppress Pick After Drag Design

## Problem

The selection picker listens to the viewer canvas's native `click` event. Browsers can emit that event after a pointer gesture that started and ended on the canvas even when the pointer moved far enough to orbit the camera. When picking is active, finishing an orbit can therefore select geometry unintentionally.

## Chosen approach

Keep click-to-select inside `attachPicker`, but classify the pointer gesture that precedes each click:

- On `pointerdown`, remember each active pointer's starting client coordinates without allowing an additional touch to reset the gesture.
- On matching `pointermove` events, mark the overall gesture as a drag once any pointer's squared displacement exceeds 16 pixels squared (a four-pixel tolerance).
- On `pointerup` and `pointercancel`, retire that pointer's coordinates while preserving drag suppression long enough for the browser's subsequent `click`; a wholly cancelled gesture resets immediately.
- On `click`, consume the gesture state. If it was a drag, return before raycasting; otherwise preserve the existing selection behavior.
- Register and remove the new pointer listeners alongside the existing click listener.

The tolerance keeps minor hand jitter from defeating intentional clicks while making an actual orbit gesture unambiguously non-selecting. A synthetic click without preceding pointer events remains supported by treating it as an ordinary click.

## Alternatives considered

### Listen to OrbitControls lifecycle events

The picker could suppress clicks between OrbitControls `start` and `end` events. That couples the selection module to a particular controls implementation and makes the picker less reusable and harder to unit test.

### Filter the event in each consuming application

Partforge Cloud could track drag state around its `onPick` callback. That duplicates viewer interaction policy in consumers and leaves Partforge's built-in pick modes with the same bug.

### Replace click handling with pointer-up selection

Selecting directly from `pointerup` would make movement classification straightforward, but changes established click semantics and risks differences for synthetic events and accessibility tooling. Keeping the click listener is the narrower compatibility-preserving change.

## Testing

Extend `test/selection-pick.test.js` with focused interaction tests:

- A pointer gesture moving beyond four pixels followed by `click` must not raycast, flash, or call `onPick`.
- A pointer gesture moving within four pixels followed by `click` must still select normally.
- A second pointer joining after the first has crossed the threshold must not erase drag suppression.
- Existing plain-click, inactive, miss, and detach behavior must remain green.

Run the focused Vitest file first, then the entire unit suite and production build.
