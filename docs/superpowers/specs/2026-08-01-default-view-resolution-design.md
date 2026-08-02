# Default view resolution (`views[…].default`, most-parts fallback) — design

**Date:** 2026-08-01
**Status:** Approved (design); pending implementation plan
**Target release:** 0.40.0

## Motivation

A part with an assembly view — one that fits every sub-part together — almost
always wants that view to be the one the viewer opens on. Today the only lever an
author has is key order in the `views` map: `view-tabs.js` marks index 0 `on`,
so the assembly view is the default if and only if it is declared first. That
couples display order to default selection, and it means an author who wants the
assembly tab to sit *last* in the bar (after the individual parts, which reads
more naturally) cannot also have it open first.

The persisted override makes this worse rather than better. `view-state.js`
stores the active view under `partforge:view` — a **global** key, not scoped to
the part. A view name saved while looking at part A silently becomes the initial
tab for part B whenever B has a view by the same name, and `main` / `assembly` /
`body` are exactly the names that collide.

## Scope

In scope:

- A `default: true` flag on a view, giving the author an explicit override that
  is independent of display order.
- Automatic detection when no view is flagged: the view that places the most
  sub-parts wins.
- Replacing the global persisted view key with a part-scoped `sessionStorage`
  one, so a dev hot reload keeps the current tab but nothing bleeds between
  parts or across browser sessions.

Out of scope:

- Headless defaults. `measure`, `verify`, and `renderViews` each independently
  default to `Object.keys(part.views)[0]` and **keep doing so**. They are CI and
  agent surfaces where a stable, mechanically obvious rule matters more than a
  convenient one, and changing them would silently retarget the verify gate on
  existing parts.
- Deep-linking a view via the URL. Considered (`?view=<name>` alongside the
  existing `?backend=` read) and rejected for now: it would make the framework
  start *writing* to the URL, which it never does today, forcing coordination
  with hosts that own their own routing. Revisit if deep-linking becomes a
  requirement in its own right.
- Re-resolving the default when parameters change. The default is computed once,
  at mount.

## Resolution rule

A new module, `src/framework/default-view.js`, exports one pure function — no
DOM, no kernel, no part build:

```js
resolveDefaultView(part) → string | null
```

Order:

1. **Author override.** The first key in `part.views` whose value has
   `default === true`.
2. **Most sub-parts placed.** For each view, count the entries in `part.parts`
   whose `views` array includes that view and which are enabled under
   `part.defaults` — `enabled` absent counts as enabled, `enabled(defaults)`
   truthy counts as enabled. Highest count wins.
3. **Tie, or every count zero.** Earliest key in `part.views` insertion order.
4. **`views` absent or empty.** `null` — the caller decides.

`part.parts` absent or empty leaves every count at zero, which step 3 resolves to
the first key. `part.defaults` absent is passed to `enabled` as `{}`.

Two deliberate choices:

- **A throwing `enabled` counts the sub-part as present.** This matches how
  `mount` already treats a throwing `derive` (swallow it, carry on with a safe
  value) and errs toward showing a view rather than silently demoting it because
  of an unrelated predicate bug.
- **Step 3 preserves today's behavior for every existing part.** Single-view
  parts resolve trivially; multi-view parts reach the same answer they do now
  whenever counts tie, because the current rule *is* first-key. All eight parts
  in `src/parts/` are single-view and are unaffected.

Counting uses declared membership plus `enabled(part.defaults)` rather than raw
membership because `defaults` is the state the part actually loads in. A part
with many optional sub-parts that are off by default would otherwise be credited
for geometry that is not on screen.

## Persistence

`view-state.js` keeps `loadView` / `saveView` but changes both their signature
and their backing store:

```js
loadView(partKey) → string | null      // sessionStorage
saveView(partKey, name)
```

- Key: `partforge:view:<meta.title>`.
- When `meta.title` is missing or empty, both functions **no-op** — no read, no
  write. Falling back to a shared key is the bug being removed.
- `sessionStorage`, not `localStorage`: the tab survives a Vite dev hot reload
  and same-tab navigation, and is gone when the browser tab closes. Leaving a
  part and coming back in a new session lands on the resolved default, which is
  the intended behavior.
- Reads and writes stay wrapped in try/catch, so the module's documented
  "persistence never throws" contract holds unchanged.
- `rotating`, `camera`, and `theme` stay on `localStorage` and are untouched.
  The module header gains a line explaining why `view` differs.
- No migration for `partforge:view` values already in users' `localStorage`.
  Nothing reads that key after this change, so the leftover string is inert.

`meta.title` is the part key because `PartDefinition` has no part id, and
`meta.title` is required and lint-enforced (`missing-meta-title`). Two parts
sharing a title share a key; accepted as a known, low-consequence limitation.

## Tab wiring

`view-tabs.js` resolves its initial view as:

1. The session-stored name, **if** it still matches a tab in this part.
2. Otherwise `resolveDefaultView(part)`.
3. Otherwise the hand-written-markup fallback — the page's own `button.on`, else
   its first button.

Button generation is otherwise unchanged; the `on` class goes to the resolved
default instead of index 0. The click handler saves under the part key. The
`detach()` contract — remove the listener, empty the host element only when the
buttons were generated — is unchanged. A page that hard-codes its own buttons
(no `part.views`) behaves exactly as it does today.

## Lint

One new warning in `rules-shape.js`, beside `view-unused`:

- **`default-view-ambiguous`** — more than one view sets `default: true`. The
  message names the claiming views and states that the first wins. A warning,
  not an error: the part still builds and still resolves deterministically.

No rule is needed for an unknown view name, because the flag lives on the view
itself and cannot name a view that does not exist.

## Docs

- `AUTHORING-PARTS.md`: add `default?` to the `views` line of the
  `PartDefinition` contract block; add a Rules bullet giving the full resolution
  order; state explicitly that headless `measure` / `verify` / `render` stay on
  first-key; add `default-view-ambiguous` to the lint rule list (~line 1006).
- `AUTHORING-PARTS.md` (~line 705): the `#part` row currently implies
  first-button; point it at the resolution order instead.

## Testing

- **`test/framework/default-view.test.js`** (new): author override wins over a
  larger view; most-parts wins with no override; `enabled(defaults)` is honored;
  a throwing `enabled` counts as present; tie falls back to first key; absent
  and empty `views` return `null`.
- **`test/framework/view-tabs.test.js`**: replace the three `partforge:view`
  localStorage assertions with part-scoped sessionStorage equivalents; add a
  case asserting the resolved default is the button marked `on`; add a case for
  a part with no `meta.title` (no storage touched).
- **`test/view-state.test.js`**: update for the new `loadView` / `saveView`
  signatures and store; assert the no-op path when the part key is empty.
- **`test/lint-shape.test.js`**: a part with two views flagged `default: true`
  produces one `default-view-ambiguous` warning and no error.

No shipped part in `src/parts/` has more than one view, so the resolution rule
never runs against a real multi-view part in the Playwright smoke check
(`npm run check`) — that check only ever exercises the single-view,
first-key-by-default path. Coverage for the actual rule stops at
`test/framework/default-view.test.js` and the tab-bar cases in
`test/framework/view-tabs.test.js`. Adding a second view to one of the demo
parts purely to give the smoke check something to click was considered and
rejected: it would turn an example app into test fixture rather than
something an author would plausibly ship. This gap is accepted for now; a
future multi-view demo part (should one arise for its own reasons) would pick
up smoke coverage for free.

## Risks

- **Hot-reload behavior depends on `meta.title` being present.** A part missing
  it loses tab persistence entirely rather than falling back. Lint already
  errors on that case, so it should not survive to the viewer.
- **UI and headless now disagree about "the default view"** for any part where
  the biggest view is not the first. This is intentional but is a thing an agent
  reading a `measure` result could misread; the docs change calls it out
  explicitly.
