# Text Controls and Cutaway Picking Design

## Goal

Let part authors expose editable string parameters in the generated control panel,
including multiline content, and make cutaway rotation handles reliably selectable
where their hit bands overlap the translation handle's center affordance.

## Text controls

The parameter schema gains two explicit control values:

- `control: "text"` renders a single-line text input.
- `control: "textarea"` renders a multiline text area.

Both controls bind directly to a string-valued key in `defaults`. The `input` event
updates `params[key]` and calls the existing dirty callback for live preview. Rapid
edits continue through the existing regeneration loop, which already coalesces work.
Changing a text field in a preset section selects `Custom`, and preset application
updates text fields through the same `sync` contract used by numeric controls.

The control factory will dispatch by `def.control`: text controls use a dedicated
string implementation, while `slider` and `number` retain their current numeric
behavior. Text fields reuse the existing label, description, relevance, advanced,
and feature-section wiring. Styling uses the current control-panel colors, borders,
focus ring, and typography, with text areas occupying the available panel width.

The nameplate example moves its hard-coded two-line label into a string default and
exposes it with `control: "textarea"`. This provides an authoring example and an
end-to-end smoke path. Empty strings remain valid parameter values; individual part
build functions remain responsible for deciding how empty content affects geometry.

## Cutaway picking

The current picker checks a fixed 22 CSS-pixel center circle before raycasting the
actual handle proxies. The rotation proxy bands extend into this circle, so an early
translation return makes part of each visible rotation arc impossible to select.

Picking will instead:

1. Raycast all real handle proxies and return the nearest intersection, preserving
   the widget's visual depth ordering.
2. Only when no real proxy is hit, use the 22-pixel center circle as a semantic
   fallback for an end-on translation arrow.
3. Return no handle when neither condition matches.

This retains the accessible end-on translation target without allowing it to mask
visible rotation geometry. Hit proxy sizes and visual geometry do not change.

## Testing

Controls tests will verify single-line and multiline rendering, live string updates,
dirty notifications, preset-to-`Custom` behavior, preset synchronization, and
disposal. A nameplate test will verify that the editable label reaches `text2d`.

Cutaway gizmo tests will reproduce a rotation hit inside the former center overlap,
verify that it selects rotation rather than translation, retain the center fallback
when raycasting misses, and preserve nearest-hit depth behavior. The full test suite,
production build, and browser smoke checks will run before the follow-up PR is opened.
