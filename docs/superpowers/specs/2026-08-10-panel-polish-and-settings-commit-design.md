# Panel polish + settings-commit mount point

**Date:** 2026-08-10
**Repos:** partforge (sections 1–3), partforge-cloud (section 4)
**Status:** approved

Three pieces of work on the new node/nested-group control panel, plus the
cloud-side feature they enable:

1. Info popovers clamp to the viewport instead of being cut off at the right
   edge.
2. Collapsible section headers become unmistakably clickable: larger
   left-justified disclosure triangle, larger title, hover state, bottom rule
   when collapsed.
3. A new mount point, `onParamsCommit`, tells the host when the user *finishes*
   changing a control (drag release, not every input event).
4. partforge-cloud uses it to auto-save edited settings into the part's
   `defaults`, with Undo, Reset-to-defaults, and an agent-facing chat marker.

## 1. Info popover edge clamping (partforge)

`createInfoPopover` in `src/framework/panel/info.js` positions the popover at
`left = max(8, glyph.left - 8)` and never considers the right edge, so a glyph
near the panel's right side gets a clipped popover.

- Add a pure helper `popoverLeft({ glyphLeft, popWidth, viewportWidth })`
  mirroring the existing `popoverTop`: prefer the glyph-aligned position
  (`glyphLeft - 8`), clamp so the popover's right edge stays ≥ 10px from the
  viewport edge, and its left edge ≥ 10px.
- `toggle()` calls it with `pop.offsetWidth` after content is set (the popover
  must be unhidden before measuring, same ordering as the top calculation).
- Pure helper = direct unit tests; happy-dom reports zero layout metrics, so
  the clamp cannot be exercised through the DOM (same rationale documented on
  `popoverTop`).

## 2. Section header restyle (partforge)

Constraints carried over from the current code (`src/framework/panel/render.js`):

- Tests locate sections by `.sec-title` `textContent === title`, so the
  chevron stays a text-free `::before` on the `.chev` span.
- Disclosure state and condition-visibility both use `.hidden` on different
  elements; nothing here may conflate them.

Changes:

- **Chevron left of the title**: reorder the spans inside the `.sec-title`
  button (`chev` first, then `sec-name`); flex layout switches from
  `space-between` to a leading row with a gap. Chevron glyph grows to ~12px.
  Rotate-on-collapse mechanic unchanged.
- **Title**: 10px → 12px, color stepped up from `--pf-muted-2` to
  `--pf-text-2`; keeps mono / uppercase / letter-spacing.
- **Hover**: the whole `.sec-header` row gets a rounded background tint on
  hover (open or collapsed — it is always clickable), replacing the color-only
  change.
- **Collapsed affordance**: the section element gets a `.collapsed` class,
  toggled by the title click handler and by `applyOpenState` (which decides
  initial open state). CSS draws a bottom rule under the header when
  `.collapsed` is present. Class-based rather than `:has()` so the rule stays
  robust in older engines and testable in happy-dom.
- **Inner "Advanced" folds** (`.adv-toggle`) keep their current lighter
  treatment — they are subordinate disclosures and should not compete with
  section headers.

## 3. `onParamsCommit` mount point (partforge)

A **commit** is the moment the user finishes an interaction. Today every
widget fires `onChange` on every `input` event (continuously during a slider
drag); nothing represents "stopped dragging."

- Widget factories receive `onCommit` alongside `onChange`:
  - slider: native `change` event (fires at drag release);
  - number box: its existing clamp-on-commit `change` handler;
  - checkbox / select / radio / text: same moment as their change;
  - preset application: commits all keys the preset wrote.
- `buildControls` gains an `onCommit(keys)` hook (array of param keys the
  interaction wrote).
- `mount()` exposes it as a new option: **`onParamsCommit({ changed, params })`**
  — `changed` is the key list, `params` a snapshot copy (not the live object).
- **Only user panel edits fire it.** Programmatic `setParams` and animation
  playback do not — the host's own undo/reset call `setParams`, and a loop
  would result.
- Version bump to 0.49.0 in the same PR (release process: bump on the feature
  branch; publish is automatic on merge). Cloud feature-detects, so partforge
  publishes first and cloud bumps its dep after.

Tests: `popoverLeft` unit tests; commit-vs-change wiring in controls tests
(commit fires on `change`, not `input`; preset commit carries all its keys);
mount pass-through including the snapshot-copy property and the
setParams-does-not-commit rule.

## 4. Save / undo / reset in partforge-cloud

### Rule

**Reset always means: return every control to the part's authored defaults** —
the defaults as the design (chat/agent) last set them.

### Wiring

- `createMountManager` grows an `onParamsCommit` pass-through option;
  EditorScreen supplies the handler. Older partforge simply never calls it.
- **Ownership gates persistence, not the buttons.** Owners save; non-owners
  get the same Undo/Reset controls operating purely locally via `setParams`.

### Owner save path

- On commit: rewrite the changed keys inside the part source's
  `defaults: { ... }` object literal. A balanced-brace scan (string-aware)
  locates the literal; it is replaced wholesale with a re-serialization of
  `{ ...currentDefaults, ...committedValues }`.
- **Validate before persisting**: re-run `loadPart` on the rewritten source;
  on any failure, skip the save (the viewer keeps working; nothing corrupts).
- **Coalesce**: commits within ~2s collapse into one `updateTree` +
  `enqueueSave` (existing CAS checkpoint path, auto-thumbnail included).
- **Tag**: panel-save checkpoint messages carry a fixed machine-readable
  prefix (e.g. `Panel settings: …`). The tag is what makes the authored
  baseline recoverable (below).

### Undo

Session-level stack in the editor: each saved commit pushes
`{ keys, before, after }`. Undo pops one entry, calls
`runtime.setParams(before)`, and (owners) re-saves. No redo.

### Reset

- **Non-owner**: tweaks never persist, so load-time defaults *are* authored.
  Reset = `setParams(loadTimeDefaults)`.
- **Owner**: resolved lazily on first Reset click — walk `part.revisions`
  newest-first for the first message *without* the panel prefix, fetch that
  revision (`getPart(id, revision)`), read its defaults. Reset then
  `setParams(baseline)` + saves (itself a panel checkpoint). Fallback when
  history cannot resolve (older parts, exhausted window): load-time defaults.
- Server tweak: `getPart`'s revision window is hardcoded to 10; bump it (~50)
  so a fiddling session cannot push the authored revision out of sight.

### UI

Small Undo / Reset controls in cloud's chrome near the viewer header,
appearing only once panel edits exist this session.

### Telling the agent

Same pattern as version restores (`makeRestoreMarker` in
`src/chat/messages.js`), not the checkpoint prefix:

- Cloud accumulates a **net-change map** fed by every panel-originated save —
  commits, undo, and reset alike (first-seen `before` per key, latest `after`;
  keys that round-trip back to their original value drop out, so a fully
  undone session produces no marker). Nothing is injected per save.
- When the user next sends a chat message and the map is non-empty, cloud
  appends one user-role marker message before it, e.g.
  `[Note: the user adjusted control-panel settings and saved them as the
  part's defaults: wall_t 2 → 3.2 mm, facets 6 → 8. The current part source
  already reflects these values; treat them as the user's intended defaults.]`
  with metadata so ChatPane renders it as a divider, then clears the map.
- The prefix and the marker serve different readers: the prefix is a machine
  tag on revisions for the Reset baseline walk; the marker is the agent-facing
  narrative. The agent also receives the current part source every request, so
  the marker explains *why* defaults changed rather than carrying them.

## Sequencing

1. partforge PR: sections 1–3 + version bump to 0.49.0. Merge → auto-publish.
2. `npm view partforge version` confirms; partforge-cloud PR: dep bump +
   section 4.

## Error handling summary

- Popover: pure clamp math, no failure modes beyond what CSS already handles.
- Commit hook: callback errors from the host must not break the panel — wrap
  the `onParamsCommit` dispatch so a throwing host handler is contained.
- Cloud save: validation failure → skip persisting, keep viewer state; CAS
  409 → existing conflict surface; baseline fetch failure → fall back to
  load-time defaults.
