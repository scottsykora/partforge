# Relevance-aware control panel — design

**Date:** 2026-06-23
**Status:** Approved (design); pending implementation plan
**Sub-project:** A of 3 (sequence was B → A → C). B (control metadata: descriptions,
tooltips, `hidden`) is merged. C = authoring-guidance docs, comes last. This spec
covers **A only**.

## Motivation

The control panel shows every section regardless of whether its controls affect the
parts in the current view. This sub-project makes the panel reflect what's on screen:
sections whose controls don't affect any visible sub-part are hidden, and individual
controls that don't currently affect the on-screen parts are visually de-emphasized
(dimmed, with a hover hint) — so the user sees a focused panel and understands when a
control won't change what they're looking at.

## Design goal: isolation / removability

This feature is deliberately a **separable layer** that can be reworked or removed later
without touching core logic. It consists of exactly:
1. one standalone module `src/framework/param-deps.js` (pure; no DOM, no geometry);
2. one additive method `applyRelevance(...)` returned from `buildControls` (existing
   build logic unchanged otherwise);
3. three call sites in `mount.js` that invoke it.

Deleting the module, the method, and the three calls reverts the panel to today's exact
behavior. No change to geometry, the worker, the kernel, the schema, or B's
descriptions/`hidden` handling. If the heuristic proves too clever, it can be simplified
or dropped in isolation.

## In scope

- A dependency probe: which parameters affect the on-screen sub-parts of the active view.
- Hiding sections with no on-screen-relevant controls.
- Dimming + hover-hinting individual controls that don't currently affect on-screen parts.
- Dynamic recomputation on view change and on every parameter change.

## Out of scope

- Disabling/locking irrelevant controls (they stay fully interactive).
- Changing which sub-parts a view shows, geometry, or export.
- C's authoring docs.
- Per-derived-key precision (see "Derive handling").

---

## Component 1 — Dependency probe (`src/framework/param-deps.js`)

Pure module. No DOM, no real geometry. Reuses `probe.js`'s geometry-free kernel
(`createProbeKernel`) so a sub-part's `build` runs as plain JS + proxy reads
(microseconds — no meshing).

Export:

```
relevantParamKeys(part, view, params) => Set<string> | RELEVANT_ALL
```

`RELEVANT_ALL` is an exported sentinel meaning "treat everything as relevant" (the
conservative fallback).

Algorithm:
1. Build a **recording Proxy** factory: wraps an object and records every property key
   read into a provided `Set`.
2. Probe `derive`: if `part.derive` exists, call `part.derive(recordingP_derive)` and
   collect `deriveInputs` (raw param keys it read). Wrapped in try/catch — on throw,
   return `RELEVANT_ALL`.
3. Compute the on-screen sub-parts: `viewSubParts(part, view, params)` (the view's
   enabled sub-parts — this already accounts for `enabled(p)` gating and includes any
   `display` ghost/reference parts that are on screen).
4. For each on-screen sub-part, run
   `sub.build(probeKernel, recordingP, recordingD)` in try/catch:
   - `recordingP` records direct raw-param reads into the relevant set.
   - `recordingD` records whether the sub-part read **any** derived value (a boolean
     flag; the specific derived keys are not needed).
   - On **any** throw, return `RELEVANT_ALL` (we can't analyze this sub-part, so we must
     not dim/hide anything).
5. Relevant set = union of all direct `p`-reads across the on-screen sub-parts, **plus**
   `deriveInputs` **iff** at least one on-screen sub-part read a derived value.
6. Return the Set.

Notes:
- `params` is `{ ...part.defaults, ...userParams }` — the same object `mount` already
  maintains; relevance reflects current values (so conditional reads resolve to the
  current branch).
- The probe must not mutate `params` (the recording Proxy is read-tracking only; writes,
  if any build does them, pass through to a throwaway copy — use a shallow clone of
  `params` as the proxy target so the real params object is never written).

## Component 2 — Relevance application (`src/framework/controls.js`)

`buildControls(root, parameters, params, onDirty)` keeps its current behavior and
additionally builds an internal **registry** and returns an API:

```
buildControls(...) => { applyRelevance(relevant) }
```

Registry (built as controls are created, no new public schema):
- control key → its wrap element (the `.slider`/`.feat` wrapper already created per
  control). A key may map to more than one element (e.g. a feature toggle and its
  slider share a key) — store a list.
- section element → the set of control keys it contains.

`applyRelevance(relevant)` where `relevant` is a `Set<string>` or `RELEVANT_ALL`:
- `relevant === RELEVANT_ALL`: remove all `.irrelevant` marks and un-hide all sections
  (everything normal).
- Otherwise:
  - For each registered control element: if its key ∈ `relevant`, remove `.irrelevant`;
    else add `.irrelevant` and a hover hint (a `title` attribute, e.g. "Doesn't affect
    the current view"). Controls remain interactive.
  - For each section: if **none** of its control keys ∈ `relevant`, hide it
    (toggle a `.section-hidden` class → `display:none`); else show it. This is a
    reversible class toggle (distinct from B's `hidden`, which removes DOM).
- A section whose keys are all `hidden` (B) won't have rendered at all; relevance only
  toggles sections that are present.

CSS (`src/framework/app.css`): `.irrelevant` (reduced opacity ~0.45, muted) and
`.section-hidden { display: none; }`.

## Component 3 — Wiring (`src/framework/mount.js`)

- Capture the API: `const panel = buildControls(controls, part.parameters, params,
  onParamChange);`
- A small local helper `updateRelevance()` →
  `panel.applyRelevance(relevantParamKeys(part, view, params))`.
- Call `updateRelevance()`:
  1. once immediately after `buildControls` (initial view);
  2. inside `refreshView()` (view/tab change);
  3. inside `onParamChange()` (every parameter edit — dynamic; cheap, no debounce).
- `view` and `params` are already in scope at these sites.

## Error handling / edge cases

- Any probe throw (in `derive` or a sub-part `build`) → `RELEVANT_ALL` → panel fully
  shown for that evaluation. The feature never hides a control it couldn't analyze.
- A parameter read by no view → dimmed in every view (harmless; signals a possibly
  vestigial control).
- Irrelevant controls stay fully usable — editing one changes its param (which may
  affect a different view), it's only de-emphasized.
- The recording Proxy targets a shallow clone of `params`, so probing never mutates the
  live params.
- Empty parts / a view with no sub-parts → empty relevant set → all sections hidden is
  possible but only when truly nothing is on screen; acceptable.

## Testing

- **`test/framework/param-deps.test.js`** (pure, plain Node — no DOM, no WASM):
  - a sub-part reading `p.x` and conditionally `p.y` → `{x}` when the condition is off,
    `{x,y}` when on (proves dynamic conditional reads);
  - `derive` inputs included only when an on-screen sub-part reads a derived value, and
    excluded when none do;
  - a sub-part whose `build` throws → returns `RELEVANT_ALL`;
  - a multi-sub-part view unions each sub-part's reads;
  - probing does not mutate the passed `params`.
- **`test/framework/controls.test.js`** (extend, happy-dom):
  - `applyRelevance(new Set([...]))` adds `.irrelevant` (+ title) to out-of-set controls
    and leaves in-set controls normal;
  - a section whose every control is out-of-set gets `.section-hidden`;
  - re-calling with a different set un-dims/re-shows correctly;
  - `applyRelevance(RELEVANT_ALL)` clears all marks and shows all sections.
- **App behavior**: covered by the existing `npm run check` smoke; optionally a Playwright
  check that switching views changes which sections are visible (best-effort).

## Files touched (anticipated)

| File | Change |
|---|---|
| `src/framework/param-deps.js` | **new** — `relevantParamKeys` + `RELEVANT_ALL` |
| `src/framework/controls.js` | build a registry; return `{ applyRelevance }` (additive) |
| `src/framework/app.css` | `.irrelevant` + `.section-hidden` styles |
| `src/framework/mount.js` | capture API; `updateRelevance()` at 3 call sites |
| `test/framework/param-deps.test.js` | **new** |
| `test/framework/controls.test.js` | extend with `applyRelevance` tests |
