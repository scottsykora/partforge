# Control metadata UX (descriptions, tooltips, hidden) — design

**Date:** 2026-06-23
**Status:** Approved (design); pending implementation plan
**Sub-project:** B of 3 (sequence **B → A → C**). A = relevance-aware panel
(hide/dim controls that don't affect on-screen parts); C = authoring-guidance docs.
This spec covers **B only**.

## Motivation

The control panel has no way for a part author to (a) explain what a control does,
or (b) keep author-only parameters out of the end-user UI. This sub-project adds
per-control and per-section **descriptions** — authored in Markdown and surfaced via
a click-open popover (so they can carry diagrams, links, and richer detail) — and a
**`hidden`** flag that removes a control/section from the panel while leaving its
parameter in `defaults` so it still drives geometry. Together these let an LLM/author
build a self-documenting panel and present a simple interface without losing
parameters the geometry depends on.

## In scope

- Schema fields: `description` (Markdown) and `hidden` (boolean).
- A Markdown render+sanitize module.
- An info-glyph + click-popover affordance in the control panel.
- Hidden-control / empty-section handling.
- happy-dom test environment for the panel, scoped per-file.

## Out of scope (later sub-projects)

- **A:** relevance-aware show/hide and dimming of controls by whether they affect the
  parts in the active view (needs a param-dependency probe).
- **C:** authoring-guide docs (procedural design, progressive disclosure, writing
  descriptions, using `hidden`). C documents B's features, so it comes last.
- Section-level *presets* changes; export behavior; any worker/geometry change.

---

## Component 1 — Schema additions

Optional fields, all backward-compatible (absent = today's behavior):

| Field | Allowed on | Meaning |
|---|---|---|
| `description?: string` | section object, control def (in `advanced[]` and feature `sliders[]`), feature object (in `features[]`) | CommonMark string; rendered in a popover opened from an info glyph. |
| `hidden?: boolean` | section object, control def, feature object | When true, the item is omitted from the panel. Its parameter key remains in `defaults` and still feeds `build` (author-only / effectively a fixed value the UI doesn't expose). |

Notes:
- A control def is the existing `{ key, label, unit?, min, max, step, control? }` object;
  `description`/`hidden` are added to it.
- A feature object is the existing `{ label, key, on, sliders }`; a `hidden` feature
  omits its checkbox **and** its sliders; a feature `description` shows a glyph by its
  checkbox label.
- Every `key` referenced by a hidden control must still exist in `defaults` (already a
  rule); hidden simply means "no UI", not "no parameter".

## Component 2 — Markdown module (`src/framework/markdown.js`)

A small, pure, main-thread module. **Must not be imported by the geometry worker**
(it touches the DOM via the sanitizer) — same discipline as the viewer/controls code.

- Export: `renderMarkdown(src: string) => string` — returns sanitized HTML.
- Pipeline: `marked.parse(src)` → `DOMPurify.sanitize(html, config)`.
- Sanitizer/link policy:
  - Allow standard formatting, lists, code, blockquotes, tables, `<a>`, `<img>`.
  - Forbid scripts, event-handler attributes, `<iframe>`/`<object>`/`<embed>`, and
    inline styles.
  - Allowed URL schemes: links → `http`, `https`, `mailto`; images → `https`, `data`.
  - All links get `target="_blank"` and `rel="noopener noreferrer"` (via a DOMPurify
    `afterSanitizeAttributes` hook on `<a>` nodes).
- Rationale: descriptions are author-authored (trusted part-module code), but sanitizing
  is cheap defense-in-depth and the new-tab/rel policy is correct regardless.

Dependencies added (runtime): `marked`, `dompurify`. Both are browser-ESM and
Vite-bundled. They load only in the main-thread panel path.

## Component 3 — Info glyph + click popover (`src/framework/controls.js`)

- For any section title or control/feature label whose def has a `description`, render a
  focusable info glyph (`ⓘ`) immediately after the label text:
  `<button type="button" class="info" aria-label="More info" aria-expanded="false">`.
- Clicking the glyph toggles a **popover** anchored near the glyph whose body is
  `renderMarkdown(def.description)` (inserted as sanitized HTML). The popover is a
  single shared element reused across glyphs (only one open at a time).
- Dismissal: clicking the glyph again, clicking outside the popover, or pressing
  `Escape`. On open set `aria-expanded="true"` and move focus into/!near the popover;
  on close restore `aria-expanded="false"`.
- Interaction: because the popover is pinned (not hover-only), links inside are
  clickable and images/diagrams are viewable.
- A helper `attachInfo(labelEl, description)` encapsulates glyph creation + popover
  wiring so both `makeSlider` and the section-title / feature-label paths reuse it.

### CSS (`src/framework/app.css`)
- `.info` glyph: small, muted, inline after the label, visible focus ring.
- `.popover`: constrained `max-width` (~280px) and `max-height` with `overflow:auto`;
  `img { max-width: 100%; height: auto; }`; readable padding; positioned so it stays
  within the viewport (anchored to the glyph, flipping above/below as needed). Sits
  above panel content (`z-index`) and is not clipped by the panel's vertical scroll.

## Component 4 — Hidden + empty-section handling (`controls.js`)

Pure predicates (unit-tested directly), consumed by `buildControls`:
- `visibleAdvanced(sec)` → `sec.advanced.filter(d => !d.hidden)`.
- `visibleFeatures(sec)` → `sec.features.filter(f => !f.hidden)`.
- `sectionRenders(sec)` → false if `sec.hidden`; for a preset section, true iff it has
  presets **or** at least one visible advanced control; for a feature section, true iff
  it has at least one visible feature.

Rendering rules:
- `buildControls` skips a section when `!sectionRenders(sec)`.
- Preset section: build sliders only for `visibleAdvanced(sec)`. If that list is empty,
  omit the "Advanced ▾" toggle/block (presets, if any, still render).
- Feature section: build only `visibleFeatures(sec)`; within a visible feature, build
  only its non-hidden sliders.
- Hidden items never create DOM and never read/write beyond their pre-existing
  `defaults` value.

## Error handling / edge cases

- `description` absent → no glyph (unchanged layout).
- `renderMarkdown` on empty/whitespace string → empty popover body; the glyph is only
  rendered when `description` is a non-empty string.
- A `hidden` control whose `key` is missing from `defaults` is an existing authoring
  error (unchanged); hidden doesn't change that contract.
- Malicious/markup payloads in a description are neutralized by DOMPurify (covered by a
  test).

## Testing

Add `happy-dom` (devDependency). Scope it per-file with a `// @vitest-environment
happy-dom` docblock on the DOM test files, so the WASM/geometry suites keep running in
plain Node (unchanged).

- **`test/framework/markdown.test.js`** (happy-dom):
  - `**b**`/`*i*`/list/`code` → `<strong>`/`<em>`/`<ul><li>`/`<code>`.
  - `[t](https://x)` → `<a href="https://x" target="_blank" rel="noopener noreferrer">`.
  - `![alt](https://x/i.png)` → `<img>` with that src and alt.
  - `<script>alert(1)</script>` and `[x](javascript:alert(1))` and
    `<img src=x onerror=alert(1)>` → script/handler/disallowed-scheme stripped.
- **`test/framework/controls.test.js`** (extend; happy-dom for the new DOM tests):
  - keep the existing pure `clampToRange` tests.
  - `visibleAdvanced` / `visibleFeatures` / `sectionRenders` predicate tests (pure).
  - `buildControls`: a `hidden` advanced control / hidden feature is absent from the DOM;
    a section with all controls hidden (and no presets) renders nothing; a control with a
    `description` renders an `.info` glyph and one without renders none; a section
    `description` renders a glyph by the title.
  - popover: clicking `.info` inserts the popover with the rendered description; pressing
    Escape and clicking outside both remove it; opening a second glyph closes the first.

## Files touched (anticipated)

| File | Change |
|---|---|
| `src/framework/markdown.js` | **new** — `renderMarkdown` (marked + DOMPurify) |
| `src/framework/controls.js` | glyph + popover (`attachInfo`), `hidden` filtering, visibility predicates |
| `src/framework/app.css` | `.info` glyph + `.popover` styles |
| `package.json` | add `marked`, `dompurify` (deps); `happy-dom` (devDep) |
| `vitest.config.js` | (no global env change; per-file docblock used) — touched only if a shared setup is needed |
| `test/framework/markdown.test.js` | **new** |
| `test/framework/controls.test.js` | extend with predicate + DOM + popover tests |
