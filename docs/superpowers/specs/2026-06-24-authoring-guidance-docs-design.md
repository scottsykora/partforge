# Authoring-guidance docs (control-panel UX) — design

**Date:** 2026-06-24
**Status:** Approved (design); pending implementation plan
**Sub-project:** C of 3 (sequence B → A → C). B (descriptions/tooltips/`hidden`) and
A (relevance-aware panel) are merged. This is the final sub-project — documentation
plus a living example. No framework code changes.

## Motivation

B added per-control/section Markdown **descriptions** and a **`hidden`** flag; A made
the panel **relevance-aware** (auto-hiding sections and dimming controls that don't
affect the on-screen parts). Neither is documented yet, and the authoring guide has no
advice on *designing a good control panel* — making a part procedural so one control
drives many features, presenting a simple interface with progressive disclosure to deeper
controls, and writing a clear description for every control. This sub-project documents
all of that in `AUTHORING-PARTS.md` and upgrades `demo.js` into a living example that
models the practices.

## In scope

- Document the `description` and `hidden` schema fields.
- A new "Designing the control panel" guidance section (procedural/`derive` linking,
  progressive disclosure, a description-for-every-control recipe, the relevance behavior).
- Upgrade `src/parts/demo.js` to demonstrate all of the above (no new files).

## Out of scope

- Any framework/runtime code change (controls.js, param-deps.js, markdown.js, etc.).
- A brand-new example part or new app entry (we upgrade the existing `demo.js`).
- `filleted-box.js` (left as-is).

---

## Component 1 — `AUTHORING-PARTS.md`: document `description` & `hidden`

Extend the existing **"Parameters: the control-panel schema"** section. Add a short
subsection documenting the two optional fields B introduced, available on **section
objects, control defs** (in `advanced[]` and a feature's `sliders[]`), **and feature
objects**:

- `description?: string` — CommonMark (bold/italic, lists, code, **links**, **images**),
  rendered in a click-open info-glyph (`ⓘ`) popover next to the label. Links open in a
  new tab; content is sanitized. Use it to explain what the control does. Include one
  example with a Markdown link (and note images are supported for diagrams).
- `hidden?: boolean` — omits the control/section/feature from the panel. Its `key` stays
  in `defaults` and still drives geometry — i.e. an author-fixed value the end user
  doesn't edit (not a deleted parameter). Note: a section with no presets and no visible
  controls won't render.

Accuracy: descriptions render via `marked` + DOMPurify (main thread); the popover is
click-to-open (one at a time, dismiss on outside-click/Escape). These match the shipped B
behavior — do not describe a hover-only tooltip.

## Component 2 — `AUTHORING-PARTS.md`: new "Designing the control panel" section

A new top-level section (placed after "Parameters: the control-panel schema"), with four
subsections:

1. **Procedural & parametric parts.** Drive many features from a few controls so tweaking
   one control changes the part coherently:
   - `derive(p) => d` computes shared/dependent values once per build; sub-part `build`
     functions read `d` so a single input (e.g. `od`) feeds wall thickness, bore
     clearance, chamfer size, etc.
   - Reuse the same param `key` across sub-parts/features so one slider affects all of
     them.
   - `enabled(p)` gates a whole sub-part from a toggle param.
   - Brief example: one `od` slider deriving multiple downstream dimensions.

2. **Progressive disclosure (simple but deep).** The recommended tiering:
   - **presets** for the common cases (the first thing most users touch);
   - a **few primary sliders** for the dimensions users most often change;
   - **`Advanced`** (the existing collapsible block) for the rest;
   - **`hidden`** for internals the end user shouldn't edit (constants the geometry
     needs).
   The goal: a panel with a handful of visible controls that still exposes deep, correct
   adjustability when the user wants it.

3. **A description for every control.** A short authoring recipe/checklist — each
   description should state what the control does, its units, a sensible range, and when
   it matters; keep it brief; use Markdown links/images for diagrams or deeper reference.
   Frame it as guidance an LLM author should follow for every control and section.

4. **The relevance-aware panel (A).** Explain the automatic behavior: sections whose
   controls don't affect the active view's on-screen parts are hidden, and controls that
   don't currently affect them are dimmed (but stay usable), recomputed as the view and
   params change. Authoring implications: group controls into sections by the sub-parts
   they affect, scope params to the views that use them, and rely on this rather than
   manually hiding per-view — so the panel stays focused automatically.

A one-line pointer from the README's "Authoring guide" blurb to this new section is
optional but nice; not required.

## Component 3 — Upgrade `src/parts/demo.js` (living example)

Retrofit the spacer so it models every documented practice, while remaining a correct,
buildable part. No new files; `demo.html`/glue unchanged. Concretely:

- **Descriptions** on both sections and on each control, including **one description with
  a Markdown link** (e.g. linking to the authoring guide) to demonstrate rich content.
- **A `hidden` internal param** the build uses but the user shouldn't edit — e.g. a fixed
  chamfer/lead-in size or a wall floor; present in `defaults`, consumed by `build`, no UI.
- **A `derive`-driven link** so one control procedurally shapes geometry — e.g.
  `derive(p)` computes a value from `od` (such as a chamfer or bore clearance) that
  `build` reads, demonstrating one input driving a dependent dimension.
- Keep the existing **presets + Advanced** as the progressive-disclosure example.
- The geometry must remain valid (watertight, sensible). Keep changes tasteful and
  realistic for a spacer.

The new guidance section references `demo.js` as the worked example.

## Verification

- **Docs accuracy:** prose/snippets match shipped B/A behavior (click popover, sanitized
  Markdown, `hidden` keeps the param, automatic relevance hide/dim). Reviewer checks for
  contradictions with the code.
- **`demo.js` still builds and is sound:**
  - `nvm use && npx vitest run` — full suite green (modulo the known `cli-occt`
    parallel-run flake).
  - `nvm use && npx partforge measure src/parts/demo.js` — exits 0 (watertight; expected
    holes for the bore).
  - App smoke: `nvm use && node scripts/check-app.mjs demo.html` — booted, 0 console
    errors (the upgraded demo, with descriptions/hidden/derive, renders and the popover
    code path loads). Best-effort if Playwright/Chromium absent.
- No framework code files change (controls.js/param-deps.js/markdown.js/mount.js/app.css
  untouched).

## Files touched (anticipated)

| File | Change |
|---|---|
| `docs/AUTHORING-PARTS.md` | document `description`/`hidden`; new "Designing the control panel" section |
| `src/parts/demo.js` | upgrade into the living best-practice example (descriptions, `hidden`, `derive` link) |
| `README.md` | optional one-line pointer to the new guidance section |
