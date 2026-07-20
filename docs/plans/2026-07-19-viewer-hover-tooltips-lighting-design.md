# Viewer Hover, Tooltips, and Lighting Design

**Date:** 2026-07-19
**Status:** Approved

## Goal

Improve the viewer's interaction clarity and model readability by:

- emphasizing the cutaway gizmo component under the pointer;
- giving gizmo interaction priority over part/feature hover;
- adding consistent, accessible tooltips to every viewer button; and
- brightening the scene into a technical CAD-style lighting presentation.

The work extends the existing cutaway implementation without coupling the
three.js gizmo to the DOM toolbar or part-selection details.

## Interaction Design

### Gizmo hover

The cutaway gizmo's existing invisible hit proxies remain the authoritative hit
targets. Passive pointer movement performs the same priority-aware pick used to
begin a drag and identifies one of `translate`, `rotate-x`, `rotate-y`, or no
handle.

The visible component for the hovered handle brightens and grows by roughly 12%
around the gizmo origin. Its invisible hit proxy does not change size, avoiding
pointer jitter as the visual changes. Hover emphasis follows these rules:

- only one component is emphasized at a time;
- a pressed/dragged handle keeps its emphasis until the drag ends;
- pointer exit, cutaway disable, lost capture, and disposal clear emphasis; and
- theme and active/idle opacity changes preserve the hover distinction.

The gizmo reports hover ownership through a callback but does not know about
part highlighting, feature labels, or toolbar elements.

### Hover priority

Gizmo handles have priority over the model. The cutaway controller forwards the
gizmo's hover state through the viewer's small subscription API. The existing
feature-hover controller subscribes to that state.

When a gizmo handle owns hover, feature hover immediately:

1. removes the current feature highlight;
2. hides the current part/feature tooltip; and
3. skips model raycasts until gizmo hover clears.

Normal feature hover resumes on the next pointer movement after the gizmo
releases ownership. This keeps the systems modular while ensuring that geometry
behind a translucent or narrow gizmo component never appears interactive at the
same time.

## Shared Tooltip Design

A reusable tooltip presenter will own the tooltip element, show/hide lifecycle,
and positioning. It uses the existing part/feature tooltip visual language:
surface color, border, rounded corners, typography, muted secondary text, and
compact shadow.

Both feature hover and a button-tooltip attachment consume this presenter. The
presenter supports cursor-relative content for features and element-anchored
content for controls, so toolbar tooltips avoid chasing the pointer while still
matching the feature tooltip style.

Every viewer button is covered, including:

- enable/disable cutaway;
- pause/resume rotation;
- re-frame model;
- switch light/dark mode;
- flip cutaway; and
- reset cutaway.

Labels are action-oriented and update with state. Tooltips appear on mouse hover
and keyboard focus, and disappear on click, pointer exit, blur, disablement, or
disposal. Existing accessible names are preserved or improved with
`aria-label`. Native `title` popups are suppressed while the custom behavior is
attached to prevent duplicate tooltips. Ordinary touch taps do not show a
tooltip.

## Module Boundaries

- `cutaway-gizmo.js` owns handle picking, drag locking, and visual emphasis.
- `cutaway.js` forwards hover state and clears it as part of disable/dispose.
- `viewer.js` exposes a subscription surface without exposing gizmo internals.
- `selection/hover.js` owns model-hover suppression and feature highlighting.
- A new tooltip presenter module owns shared tooltip presentation.
- A small button-tooltip attachment owns DOM button listeners and dynamic text.
- `mount.js` composes the controllers and disposes their subscriptions.

This event-driven boundary avoids polling, shared mutable flags, and direct
imports between the gizmo and selection modules.

## Lighting Design

The viewer will keep its current directional key light but shift toward a
brighter, evenly readable CAD presentation:

- increase the hemisphere light's overall contribution;
- substantially lighten its ground color so downward-facing surfaces remain
  legible;
- add a lower-intensity directional fill from the opposite side; and
- keep the key stronger than the fill to preserve curvature and edge cues.

The lights remain neutral to slightly cool and are shared by light and dark
themes. No shadows or material changes are introduced, keeping runtime cost and
scope low.

## Accessibility and Input

- Button tooltips mirror accessible action labels and appear on keyboard focus.
- Hover-only behavior is disabled on touch-only devices.
- Stable gizmo hit proxies preserve current drag affordances and motor behavior.
- Tooltip elements remain non-interactive and never steal pointer events.
- Disabling or hiding cutaway clears all hover state so no stale highlight or
  tooltip remains.

## Verification

Focused tests will cover:

- handle entry, transition, exit, and one-at-a-time emphasis;
- unchanged hit-proxy sizing and drag-locked emphasis;
- cleanup on pointer exit, cutaway disable, and disposal;
- immediate feature-highlight suppression and later resumption;
- tooltip mouse/focus behavior, state-aware labels, and listener cleanup;
- tooltip coverage for primary and secondary viewer buttons; and
- the brighter hemisphere/key/fill light configuration.

The full unit suite, production build, and browser smoke checks for the shipped
demo pages will run before completion. Manual browser verification will confirm
that handle emphasis reads clearly, tooltip placement is clean, feature hover
never competes with gizmo hover, and undersides/cavities are more legible in both
themes.

## Non-goals

- Changing cutaway geometry, hatch rendering, or plane manipulation behavior.
- Adding tooltips to generated parameter controls outside the viewer chrome.
- Introducing shadows, ambient occlusion, or a user-configurable lighting UI.
- Enlarging gizmo hit targets or altering drag sensitivity.
