# Per-view animations + animated part opacity

Date: 2026-08-10
Status: approved

## Problem

Animations (shipped 0.48, spec 2026-08-02) are a part-level `animations: {}`
map. The transport bar therefore appears on **every** view whenever the part
declares any animation, even on views where the animated params drive nothing —
in a box assembly, the standalone Body and Lid views show a transport whose
animations visibly do nothing there. Separately, assembly-style animations need
parts to be able to **appear over time** — fade a part in, then animate it into
place — which the param-track system cannot express: params pose geometry, they
cannot hide it.

## Decisions (settled during brainstorming)

- **Ownership:** each animation is owned by exactly one view. Two views wanting
  the same motion declare it twice.
- **Visibility primitive:** continuous opacity keyframes (0 = fully hidden,
  1 = normal), not a boolean flag. Boolean hide is a track that holds 0.
- **Compatibility:** clean break. The feature is days old; top-level
  `animations` becomes a lint error and is ignored at runtime. No legacy
  normalization path.

## Authoring contract

The `views` map entry grows an `animations` key. The animation body keeps its
0.48 shape (label, description, camera, duration, easing, loop, autoplay,
`tracks` XOR `steps`), plus a new `opacity` track type beside `tracks` in a
step (or beside `tracks` in the bare single-step form):

```js
views: {
  box: { label: "Box" },
  assembly: {
    label: "Assembly",
    animations: {
      assemble: {
        label: "Assemble",
        description: "…CommonMark…",
        steps: [
          { label: "Lid appears", duration: 0.6,
            opacity: { lid: [[0, 0], [1, 1]] } },          // NEW: fade the lid in
          { label: "Lower the lid", duration: 1.0, camera: "left",
            tracks: { lidLift: [[0, 40], [1, 0]] } },
        ],
      },
    },
  },
},
```

### `opacity` semantics

- Keyed by **sub-part name**; the sub-part must belong to the owning view
  (lint error otherwise). Values are 0–1. Keyframe rules are identical to
  param tracks: per-step normalized `t`, strictly ascending from exactly 0 to
  exactly 1.
- **Hold rule, same as params:** a sub-part opacity-tracked in one step holds
  its nearest keyframe value while other steps play. Sub-parts never mentioned
  render normally. An assembly part that fades in during step 3 is held at its
  step-3 opening value (0, hidden) during steps 1–2 — "absent until its
  moment" needs no extra declaration.
- Opacity 0 hides the mesh **and its edge lines** entirely — not a ghost.
- Animation opacity **multiplies** a static `display.opacity`: a ghost part
  (0.5) faded to 1 shows at 0.5.
- **Display-only, always.** It never touches params, export, measure, or
  verify. Reset restores normal visibility. This is a deliberate asymmetry
  with param tracks (which export the posed state while paused) and is
  documented as such.
- An animation must animate *something*: at least one step carrying `tracks`
  **or** `opacity`. A pure fade animation is legal.

### Other contract changes

- `autoplay: true` is allowed on at most one animation **per view** (was per
  part). A view switch kicks the incoming view's own autoplay, under the
  existing arming rules (user transport touch / param writes / reduced motion
  all still disarm).
- A top-level `animations` key is a lint **error** ("animations moved into
  views — declare this under `views.<name>.animations`") and is ignored at
  runtime: no transport bar, no crash.

## Viewer & transport behavior

- The transport bar is **built per view**: it exists only while the active
  view declares animations, listing exactly that view's set (picker/pagers
  when more than one, title when one). Views without animations render no bar
  at all.
- A **view switch resets animation state**: the playing/paused animation is
  stopped, its param snapshot restored, and all opacity overrides cleared
  before the bar rebuilds for the incoming view. No animation state survives a
  view switch; each view's transport starts fresh at its first animation,
  position 0.
- **Opacity applies at the display layer, not the param pipeline.** The viewer
  gains `setSubPartOpacity(name, value)` plus a clear-all, called by the
  animation driver each frame alongside its param writes. Implementation rides
  the existing per-sub-part material machinery: while faded (0 < v < 1) the
  sub-part gets a cloned material with `transparent: true, depthWrite: false`
  (the same treatment static `display.opacity` gets) and its edge lines get a
  cloned `LineMaterial` at matching opacity; at 0 the mesh and lines are not
  visible; at 1 the sub-part returns to its normal shared material. Because
  this never touches params, fades run at frame rate even when param tracks
  force worker-cadence rebuilds.

## Runtime API and CLI

- `runtime.animation` becomes **active-view-scoped**: `play(name)` resolves
  within the current view's animations (unknown name → warn, do nothing);
  `state()` gains the owning view's name. A host wanting a cross-view
  animation calls `setView` first — no compound "view/name" syntax.
- `partforge render --animation <name>` searches all views; a unique name
  implies its owning view (overriding the default-view rule for that render).
  If two views share the name, the CLI errors and asks for the existing
  positional `view` argument (`partforge render <part-module> [view]` — NOT a
  new flag: `--views` already means camera angles). When the positional view is
  given, the animation resolves within it. Stills apply opacity at the rendered
  `t`, so a faded frame renders faded.
- `measure` / `verify` / export are untouched.

## Lint

Findings are pathed like
`views.assembly.animations.assemble.steps[0].opacity.lid`.

- **New** `animation-not-in-view` (error): top-level `animations` key present;
  message says to move each animation under its view.
- **New** `animation-opacity-unknown-part` (error): an `opacity` track names a
  sub-part not in the owning view.
- **New** `animation-opacity-range` (error): opacity values outside 0–1.
  Keyframe *shape* problems reuse the existing `animation-keyframes-invalid`
  rule.
- **Updated:** the "animates nothing" rule accepts opacity-only steps;
  `animation-autoplay-invalid` enforces one autoplay per view; all existing
  rules (numeric params from `defaults`, values within control min/max, camera
  names, loop-vs-steps, minimum step duration) keep their semantics, scoped
  per view.

## Docs, reference part, and downstream

- `AUTHORING-PARTS.md`'s Animations section is rewritten for the view-owned
  shape and gains the opacity contract (hold rule, display-only/export
  asymmetry). The default-export sketch shows
  `views: { <name>: { label, animations? } }`.
- **hinged-box stays the worked example** and demonstrates the new feature:
  its animations move under a view, and `assemble` gains a leading fade-in
  step (lid fades in, then lowers, then opens) — exercising opacity, steps,
  and cameras together.
- Version bumps to **0.49.0 in the same PR**. After partforge-cloud picks up
  the bump, `npm run docs:generate && npm run prompt:generate` there
  regenerates the corpus and prompts — which is how the authoring LLM learns
  the new contract, and closes the discoverability gap (the prompt's inline
  `views:` sketch will now carry `animations`).

## Testing

- `animation.js` unit tests: normalization of view-owned animations, opacity
  evaluation (`evaluate()` returns `{ stepIndex, values, opacity }`), hold
  semantics, opacity-only animations.
- `animation-controls` tests: bar present only on views with animations; view
  switch resets state, clears opacity, rebuilds the bar; autoplay-per-view
  kick; reset restores visibility.
- Viewer test: `setSubPartOpacity` material handling (fade → clone, 0 →
  hidden, 1 → shared material restored; ghost multiply).
- Lint tests per new/updated rule; CLI test for `--animation` resolution and
  the ambiguity error.
- The existing lint-purity test keeps holding `animation.js` import-free.
