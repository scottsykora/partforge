# Click-to-select — design

**Date:** 2026-06-24
**Status:** Approved (design); pending implementation plan
**Builds on:** the feature/selector vocabulary (`face-selector.js`/`edge-selector.js`),
the per-sub-part read-key analysis (`param-deps.js`, from the geometry-cache work),
and the `?debug` overlay's opt-in/removability pattern
(`docs/superpowers/specs/2026-06-24-cache-debug-overlay-design.md`).

## Motivation

When a person and an LLM collaborate on a part, the conversation breaks down over
*deixis* — "this hole", "that edge", "add a boss right here". The person can see the
geometry; the LLM, editing the part `.js` file, cannot. Opaque element IDs don't fix
this: a parametric model regenerates on every parameter change, so triangle indices,
face ordering, and edge lists all churn (the topological-naming problem), and an ID
like `face_47` tells the LLM nothing about *which line of `build()`* produced it.

This module — **click-to-select** — turns a click on the 3-D viewer into a compact,
**semantic** token the LLM can act on: which sub-part, where (in local CAD
coordinates), the surface normal, and the parameter state the user was looking at,
expressed in the *same selector vocabulary* (`{ dir, inPlane, at, near }`) the part
author already writes in code. The token is a description of the geometry, not an
index into it, so it survives regeneration and maps back to source.

It is the **sensor** half of a future agent workflow. It only *emits* tokens; it does
not talk to an LLM, manage a build/edit loop, or own any product UX. See "Seam to the
agent harness".

## Scope: A, progressive resolution, v1 = L0

This is approach **A** (raycast → semantic selection token) of a larger exploration;
pins/annotations (B) and screenshot-context (C) are out of scope here.

Resolution is **progressive** — one stable token shape, richer when metadata allows:

- **L0 (v1, ships end-to-end):** sub-part + local point + surface normal + scoped
  parameter snapshot + a finder-ready `near`-based selector. Available from any
  raycast on any backend.
- **L1 (designed-for, deferred):** enrich with the typed face (cylinder r=, plane n=,
  …) and a fuller `{ dir, inPlane, at, near }` selector, *when* the rendered mesh
  carries a triangle→faceId grouping. Omitted gracefully when it doesn't.

## Module shape & boundaries

New isolated directory **`src/framework/selection/`**. Hard layering rule: **the core
knows nothing about three.js, the DOM, or the geometry kernel.**

| File | Role | May depend on |
|---|---|---|
| `resolve.js` | **Pure core.** `resolveSelection(part, ctx, hit) → Selection`. Data → data. | `param-deps.js` |
| `format.js` | **Serializer.** `formatSelection(selection, { style }) → string \| object`. | nothing |
| `pick.js` | **Viewer adapter.** `attachPicker(viewer, { onPick }) → detach()`. The *only* three.js/DOM-aware file. | three.js, `resolve.js` |
| `index.js` | Public surface — re-exports the three. | — |

`resolve.js` and `format.js` are framework-free and unit-testable headlessly (matches
the `partforge/testing` ethos). `pick.js` is deliberately thin: it does the raycast
and the coordinate transform, then delegates all interpretation to `resolve.js`.

## The `Selection` contract

`resolveSelection(part, ctx, hit)` returns one stable shape:

```js
{
  subPart: "spacer",                 // L0 — the meshed sub-part name (viewer._subCache key)
  point:   [0, 0, 5.2],              // L0 — local CAD coords, quantized to 0.01 mm
  normal:  [1, 0, 0],                // L0 — local, snapped to an axis when within ~3°
  params:  { bore: 3.4, h: 10 },     // L0 — scoped via subPartReadKeys(part, view, params)
  feature: {                         // L1 — present only when face metadata is available
    kind: "cylinder", axis: "+Z", radius: 1.7,
    selector: { dir: "Z", near: [0, 0, 5.2] }
  }
}
```

Inputs:
- `part` — the `PartDefinition`.
- `ctx` — `{ view, params, derived }`: the state the user is looking at.
- `hit` — a backend/viewer-agnostic raycast result already in the sub-part's local
  frame: `{ subPart, pointLocal, normalLocal, faceId? }`.

Design notes:
- **`params` is scoped, not dumped.** `subPartReadKeys(part, view, params)` returns the
  keys the clicked sub-part actually reads; the snapshot includes only those, so the
  token says "this geometry, at these inputs" without noise.
- **`feature.selector` is in the author's own vocabulary.** It is exactly the
  `{ dir, inPlane, at, near }` shape `toFaceFinder`/`toEdgeFinder` already consume, so
  the LLM can drop it straight into a `faces(...)`/`edges(...)` call. Even at L0 (no
  `feature`), `near: point` gives a usable `containsPoint`-style hint.
- **Graceful degradation:** no face metadata → omit `feature`; L0 alone is still
  actionable.
- **Quantization for stability/readability:** points round to 0.01 mm; normals snap to
  ±X/±Y/±Z when within ~3° of an axis.

## Data flow & the two fiddly bits

```
click → pick.js raycast → hit{ subPart, pointLocal, normalLocal, faceId? }
      → resolve.js → Selection → format.js → clipboard / tool-call
```

1. **Coordinate transform.** The viewer applies `pivot.rotation.x = -π/2` (model Z-up →
   vertical) plus per-view `partsGroup` recentring. The adapter must invert exactly
   that to recover model-local coordinates. This is extracted as a **pure helper**
   `worldToSubPartLocal(viewer, worldPoint) → [x, y, z]` so the math is unit-tested
   away from the raycast.
2. **Mesh face-ids (L1 only).** L1 needs `toMesh` to carry a triangle→faceId grouping.
   Replicad exposes face groups; threading that through the mesh payload is a
   **separate, later increment**. v1 ships L0 with no dependency on it; L1 lights up
   automatically when `hit.faceId` starts arriving.

## Output styles (`format.js`)

`formatSelection(selection, { style })`:

- **`"token"`** (default) — compact, clipboard/CLI-friendly single line:
  `@spacer · pt(0,0,5.2) n(+X) · {bore:3.4,h:10}` (with L1:
  `@spacer · cyl-face r=1.7 axis=+Z · pt(0,0,5.2) n(+X) · {bore:3.4,h:10}`).
- **`"json"`** — the full `Selection` object, for the embedded tool-call transport.
- **`"prompt"`** — one natural-language sentence an LLM ingests well, e.g.
  "On sub-part **spacer**, the user pointed at local point (0, 0, 5.2), normal +X,
  with params {bore: 3.4, h: 10}."

No `parseToken` in v1 (YAGNI) — the LLM reads tokens; nothing round-trips them back.

## Opt-in wiring (mirrors `?debug`)

Off by default; **zero** impact on existing app loads.

- Gated by **`?pick`** in the URL (or `mount(part, { pick: true })`), exactly as the
  cache overlay is gated by `?debug`.
- When on: a **"Pick" toggle** button; while active, a click raycasts, transiently
  highlights the hit, and the caller's `onPick` runs. v1's default `onPick` copies
  `formatSelection(selection, { style: "token" })` to the clipboard and shows a toast.
- Deleting the `selection/` directory and the `?pick` guard reverts the app to exactly
  today's behavior.

## Seam to the agent harness

The future (possibly closed-source) **agent harness** — prompts, the LLM conversation,
the build/edit/verify loop, productized UX — lives in its **own repo** and is *not*
built here. This module exposes the stable boundary it will plug into:

- **`onPick(selection)`** — the callback `attachPicker` invokes. The harness supplies
  one that ships `formatSelection(selection, { style: "json" })` to the LLM via a tool
  call; the CLI path supplies one that copies the `"token"` string. Same payload, two
  transports — the module picks neither.
- **The `Selection` contract** — treated as a versioned interface.

Because the harness only ever touches `onPick` + `Selection`, it can be lifted into a
separate repo later with **no churn to this module**. (Selection itself stays in
partforge: it is intrinsically coupled to the viewer internals, the selector
vocabulary, and `subPartReadKeys`, and "emit a token" is the broadly-useful,
commoditizable part — a poor candidate for closed-source.)

## Module boundaries (summary)

- **`selection/resolve.js`** — *new, pure.* `resolveSelection(part, ctx, hit)`. Owns the
  L0/L1 layering, param scoping (`subPartReadKeys`), quantization, and the
  selector-vocabulary mapping. No three.js, no DOM, no kernel.
- **`selection/format.js`** — *new, pure.* The `"token"` / `"json"` / `"prompt"` styles.
- **`selection/pick.js`** — *new, viewer-aware.* `attachPicker(viewer, { onPick })`; the
  raycast, the `worldToSubPartLocal` transform, transient highlight, and `detach()`.
- **`selection/index.js`** — *new.* Public surface.
- **`mount.js`** — `?pick` parsing + Pick-toggle button + default clipboard `onPick`,
  all guarded by `?pick` (no behavior change without it).

## Testing

- **`resolve.js`** (new `test/selection-resolve.test.js`, headless): synthetic `hit`s →
  assert `Selection` structure; param snapshot includes only `subPartReadKeys`;
  normal-axis snapping within tolerance; point quantization; **graceful L0-only** when
  `faceId` is absent; `feature.selector` shape when it's present.
- **`format.js`** (new `test/selection-format.test.js`): snapshot the three styles for an
  L0 token and an L1 token (incl. the L1 `cyl-face` prefix).
- **`worldToSubPartLocal`** (in the resolve/pick test): feed a known view pose + world
  point, assert the recovered local coordinates (round-trips the pivot rotation +
  recentring).
- **`pick.js` raycast + `?pick` wiring**: browser-only — covered by the existing
  `npm run check` smoke (default load has no `?pick`, so no Pick button appears → no
  regression) plus manual verification in the Drum Machine.

## Out of scope

- The agent harness itself (separate repo): prompts, LLM loop, tool transport, product UX.
- **L1 face-typing** and the `toMesh` face-id plumbing it needs (deferred increment;
  designed-for here).
- Pins/annotations (approach B) and screenshot-context (approach C).
- Arbitrary-point identity beyond "local point + normal" (B territory).
- `parseToken` / round-tripping a token back into a selection.
- Persisting selections across reloads; multi-select; selection history.
