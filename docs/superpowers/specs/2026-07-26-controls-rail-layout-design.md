# Controls rail layout — full-height right rail, cloud look and feel — design

**Date:** 2026-07-26
**Status:** Approved (brainstorming)
**Targets:** partforge 0.28.0
**Builds on:** `partforge-cloud/docs/superpowers/specs/2026-07-17-shared-design-language-design.md`
(the shared `--pf-*` palette) and
`partforge-cloud/docs/superpowers/specs/2026-07-22-editor-split-layout-design.md`
(the chat pane's resize seam, replicated here)

## Goal

The framework's control panel stops being a floating rounded card over the 3D
view and becomes a full-height rail on the right edge of the window, set back
from the viewer, resizable by the same seam affordance as partforge-cloud's chat
pane. Section boxes go full-bleed so parameters get the rail's real width. Type,
shape, and shadow adopt partforge-cloud's values — with **no dependency on
partforge-cloud in either direction**.

partforge is almost always nested inside a partforge-cloud editor, so the two
should read as one product. The palette is already shared via
`partforge/tokens.css`; this closes the remaining gaps.

## Decisions made during brainstorming

- **Chrome ownership:** the viewer column owns its floating chrome. `#app`
  becomes the flex viewer column and the chrome moves inside it, so nothing
  needs to know the rail's width.
- **Accordion:** the existing two-level disclosure is **unchanged** — sections
  stay always-open and the inner `Advanced ▾` fold survives. Only the section
  *container* changes (boxes → full-bleed rows).
- **Fonts:** `tokens.css` declares Geist-first stacks; the demo entries
  self-host via `devDependencies`. The published library ships no font files
  and no runtime font dependency.
- **Repo scope:** partforge only. The reusable layout is factored into a
  class-based `partforge/chrome.css` export so partforge-cloud can later delete
  its duplicated positioning; that cloud change is **out of scope here** and is
  recorded in §9.
- **Resize:** full collapse with a `#viewbar` toggle, cloud's seam affordance
  and hover states, partforge-appropriate width limits (240 / 288 / 560).

## 1. Layout

### 1.1 Structure

The floating chrome moves *inside* `#app`. `viewer.js` only does
`container.appendChild(renderer.domElement)` and sizes from
`clientWidth`/`clientHeight` — it never clears the container — so
absolutely-positioned siblings of the canvas are safe.

```html
<body>                        <!-- display: flex; position: relative -->
  <div id="app">              <!-- flex: 1; position: relative; min-width: 0 -->
    <div id="topbar">…</div>   <!-- absolute, top-centre -->
    <div id="viewbar">…</div>  <!-- absolute, bottom-right  ← moved from top-right -->
    <div id="busy">…</div>     <!-- absolute, inset 0 -->
  </div>
  <div id="panel">…</div>     <!-- flex: none; width: var(--pf-rail-w) -->
</body>
```

`#app` was `position: fixed; inset: 0`; it becomes an in-flow flex child.
`#viewbar` moves to bottom-right, matching what `sandbox.css` already does in
the cloud editor, and because it is inside `#app` it is inset from the rail with
no offset arithmetic.

**No wrapper element is introduced.** `embed-test.html` already uses `#stage`
for an unrelated purpose and imports `app.css` through `mount`, so that id must
not be claimed.

### 1.2 Body-appended overlays

`#pf-pick-banner`, `#pf-pick`, `#pf-pick-toast`, `.popover` (controls.js),
`.pf-hover-tip` (tooltip.js) and the debug overlay are appended to
`document.body` by JS. They stay `position: fixed`. Only the top-centred pick
banner needs to account for the rail:

```css
#pf-pick-banner { left: calc(50% - var(--pf-rail-w) / 2); }
```

`#pf-pick` / `#pf-pick-toast` are bottom-**left** and need no change. Tooltips
and popovers are positioned from computed coordinates and need no change.

### 1.3 The rail

```
#panel  flex: none; width: var(--pf-rail-w); height: 100vh
        display: flex; flex-direction: column
        background: var(--pf-surface)
        border-left: 1px solid var(--pf-border)
        box-shadow: var(--pf-shadow-rail)     /* inset — see §2.4 */
        border-radius: 0                       /* square: it is an edge, not a card */
├── .pf-rail-head   flex: none   part name + eyebrow, hairline below
├── .pf-rail-body   flex: 1; overflow-y: auto; overscroll-behavior: contain
└── .pf-rail-foot   flex: none   download row + #status, hairline above
```

The head/foot are flex-fixed rather than `position: sticky` so the scroll
container is exactly `.pf-rail-body`. On a full-height rail the export buttons
must never scroll out of reach.

Default width **288px** (from 256px).

### 1.4 Responsive

Below **720px** there is no room for a 288px rail plus a usable viewer. `body`
flips to `flex-direction: column`: viewer on top, rail below as a full-width
pane with `border-top` replacing `border-left` and a `height` of `45vh`. The
seam is hidden and resize is absent at that width (the cloud does the same below
its own breakpoint); the `#viewbar` toggle still collapses and restores the
rail.

The existing `@media (max-width: 680px)` block, which moved `#viewbar` to
bottom-centre, is removed — `#viewbar` is already bottom-right inside the viewer
column at every width.

## 2. Visual language

The palette needs no changes. The gaps are type, shape, and shadow.

### 2.1 New tokens (`tokens.css`)

| Token | Value | Notes |
|---|---|---|
| `--pf-sans` | `"Geist Variable", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` | new |
| `--pf-mono` | `"Geist Mono Variable", ` + existing stack | prepend only |
| `--pf-rail-w` | `288px` | default; overwritten at runtime by the resizer |
| `--pf-radius-control` | `7px` | cloud's `--r-control` |
| `--pf-radius-pill` | `12px` | cloud's `--r-pill` |
| `--pf-shadow-float` | `0 0 6px rgb(0 0 0 / .04), 0 2px 14px rgb(0 0 0 / .072)` | cloud's `--shadow-editor` |
| `--pf-shadow-rail` | dark: `inset 9px 0 16px -10px rgb(0 0 0 / .38)`<br>light: `inset 9px 0 14px -10px rgb(0 0 0 / .12)` | per-theme |
| `--pf-rail-pad` | `14px` | the rail's own horizontal padding |

`html, body` switch from the `-apple-system, system-ui` literal to
`var(--pf-sans)`.

### 2.2 Fonts

`@fontsource-variable/geist` and `@fontsource-variable/geist-mono` are added as
**devDependencies** and imported from the demo app entries (`src/app-*.js`).
The published library therefore carries no font files and no runtime font
dependency; inside the cloud editor the faces are already loaded by
`main.jsx`, so the Geist-first stacks resolve for free. Standalone demos match
the product because they self-host. A consumer that loads neither falls back
through the stack to `system-ui` / `ui-monospace` and stays legible.

### 2.3 Shape

Controls normalize onto `--pf-radius-control` (7px), replacing today's mix of
6px (`.row .num`, `.text-input`), 8px (`.seg button`, `button.action`,
`.dl-row button`, `select.preset`) and 10px (`#viewbar button`, `.seg`). The two
floating pills (`#topbar .seg`, `#viewbar`) take `--pf-radius-pill` (12px),
replacing 14px. The rail itself has no radius.

Because the rail is square-cornered, the concentric-corner arithmetic in
`sandbox.css` (`--r-pane = --r-control + --g-pane + 1px`) has no analogue here
and is deliberately not ported — there is no rounded parent corner for a child
to nest into.

### 2.4 Shadow, and what "set back" means

The rail's shadow is **inset on its left edge**: the viewer casts onto the rail,
which is what makes the rail read as set back. An outer shadow would make the
rail read as floating *above* the viewer — the opposite. Paired with the
`border-left` hairline. Tuned per theme, because a black shadow on a dark
surface reads much weaker than on a light one.

The floating pills take `--pf-shadow-float`, replacing today's downward-biased
`shadow-lg` (`0 10px 15px -3px …, 0 4px 6px -4px …`). Cloud's value is larger
and near-even, so the pills don't pool weight at the bottom.

## 3. Full-bleed sections

Behavior is unchanged — sections stay always-open, the inner `Advanced ▾` fold
survives, `sectionRenders`/`visibleAdvanced`/`applyRelevance` are untouched.
Only the container changes.

- `.section` drops `border`, `border-radius`, `background: var(--pf-surface-2)`,
  and `margin-bottom`. It becomes `padding: 11px var(--pf-rail-pad)` with
  `border-top: 1px solid var(--pf-border)`, and `:first-child` drops the rule.
  The divider is full-bleed; the content sits at the rail's own padding, so each
  slider gains roughly 22px of usable width (10px section padding + 1px border,
  both sides).
- `.feat-group`'s left rule thins from `2px` to `1px`, keeping its 10px indent.
  It communicates real nesting rather than decorative inset, so it stays.
- `input[type="range"]` thumb borders currently key off `--pf-surface-2` (the
  old section background). With sections transparent they must key off
  `--pf-surface`, or the thumb draws a mismatched ring.

That last item is the one non-obvious consequence of removing the section
background and is easy to miss.

## 4. Resizable rail

Replicates partforge-cloud's chat-pane seam. The cloud's `splitPane.js` is
already React-free, but importing it would invert the dependency, so the state
machine is re-implemented here.

### 4.1 The seam overlays the boundary

The cloud's seam is a real 12px flex item, because its card is inset from the
window and there is a gutter for the seam to live in. partforge's rail is flush
against the viewer with only a hairline between them, so a 12px flex item would
open a visible stripe of page background. The seam is therefore an overlay:

```css
.pf-rail-seam {
  position: absolute; top: 0; bottom: 0; z-index: 20;
  right: max(0px, calc(var(--pf-rail-w) - 6px));
  width: 12px; touch-action: none; cursor: ew-resize;
  display: flex; align-items: center; justify-content: center;
}
.pf-rail-seam[data-collapsed] { cursor: w-resize; }  /* only legal direction is left */
.pf-rail-seam > span {                                /* the affordance */
  pointer-events: none; width: 3px; height: 100px; border-radius: 999px;
  background: transparent; transition: background-color .12s ease;
}
.pf-rail-seam:hover > span,
.pf-rail-seam:focus-visible > span,
[data-dragging] .pf-rail-seam > span { background: var(--pf-muted); }
.pf-rail-seam:focus-visible { outline: none; }
```

`max(0px, …)` is what parks the seam flush at the window edge when collapsed, so
a fresh drag can pull the rail back out — the same recovery path the cloud has.
`body` gains `position: relative` to be the seam's containing block.

### 4.2 Created by JS, not markup

`attachRail(...)` creates and inserts the seam itself. The eight part demo pages do
not declare it, and the cloud gets it for free when it adopts `.pf-rail`.
`attachRail` no-ops and returns a no-op dispose when there is no rail element —
`embed-test.html` passes explicit `elements`, has no panel, and must keep
working.

### 4.3 Geometry and thresholds

Rail width is `shellRect.right - clientX`, corrected for the grab offset within
the seam (where inside the 12px the pointer went down).

| Constant | Value | Cloud's equivalent |
|---|---|---|
| `RAIL_MIN_WIDTH` | 240 | 280 |
| `RAIL_DEFAULT_WIDTH` | 288 | 380 |
| `RAIL_MAX_WIDTH` | 560 | 640 |
| `RAIL_COLLAPSE_AT` | 140 | 160 |
| `RAIL_REOPEN_AT` | 200 | 240 |
| `NARROW_BREAKPOINT` | 720 | 900 |

`railMaxWidth(shellWidth) = max(MIN, min(560, floor(shellWidth / 2)))` — the
rail can never take more space than the viewer, mirroring the cloud's rule that
the card can't be squeezed narrower than the column. Floored at `MIN` so the
function stays total (and `max >= min`) for a transient zero-width measurement.

The hysteresis band is kept **proportionally** rather than literally: 140–200
against a 240px floor is 58–83% of the minimum, the same shape as the cloud's
160–240 against 280. Snap table, where `w` is the pointer's intended rail width:

| `w` | Open → | Collapsed → |
|---|---|---|
| < 140 | **collapse** (keep last open width) | stay collapsed |
| 140–200 | hold at 240 | stay collapsed |
| 200–240 | hold at 240 | **open at 240** |
| ≥ 240 | follow pointer | **open**, follow pointer |

### 4.4 Drag path

1. `pointerdown` on the seam → `setPointerCapture(e.pointerId)`, set
   `data-dragging` on the shell.
2. `pointermove` → `resolveRailDrag(...)`, write `--pf-rail-w` on
   `document.documentElement` directly. **No state layer, no re-render.**
3. `pointerup` / `pointercancel` → release capture, clear `data-dragging`,
   commit once to `localStorage`.

`setPointerCapture` is load-bearing for the same reason as in the cloud: without
it, in the cloud editor the pointer crosses into the sandbox iframe's document
and the drag dies at the moment it reaches the thing being resized.
`data-dragging` is the second belt — it applies `pointer-events: none` to `#app`
and `cursor: ew-resize; user-select: none` to the shell, so the cursor stays
correct while the pointer is out over the viewer.

`--pf-rail-w` is written on `:root` (not `body`) so body-appended overlays
inherit it — §1.2's pick-banner centring depends on that.

**Cost.** Each drag frame resizes `#app`, which trips the viewer's
`ResizeObserver` and reallocates the WebGL drawing buffer. One reallocation per
frame is inherent to live resizing and is exactly what the cloud accepted;
writing the custom property directly keeps the cost to that one item.

### 4.5 Collapse, keyboard, animation

Collapsed sets `--pf-rail-w: 0px` and the `inert` attribute on the rail (mirrors
the cloud's `inert={collapsed}`), removing it from the accessibility tree and
from hit-testing while keeping the seam mounted.

The seam is `role="separator"`, `aria-orientation="vertical"`,
`aria-label="Resize controls"`, `tabIndex=0`, with live
`aria-valuenow`/`valuemin`/`valuemax` (valuenow = 0 when collapsed).

| Key | Action |
|---|---|
| ← / → | move the separator ±16px (±64px with Shift) — ← widens the rail |
| Home / End | jump to min / max |
| Enter, Space | toggle collapse |
| double-click | reset to 288 |

Arrow keys move the **separator**, not the pane. That is standard
`role="separator"` semantics and the only self-consistent reading for a
right-hand pane; the cloud's left-hand pane grows on `→` under the same rule.

Width animates 150ms on discrete changes (toggle, Home/End, double-click) and
**never** during a drag — an animated width fights the pointer and costs an
extra buffer reallocation per frame. Held arrow-key repeat suppresses the
transition for the whole debounce window, not just the keydown instant, for the
same reason.

### 4.6 `#rail-toggle`

A new `#viewbar` button, resolved through mount's existing optional-chrome
pattern:

```js
chrome: { …, railToggle: elements.chrome?.railToggle ?? byId("rail-toggle") }
```

Glyph is `⇥` when the rail is open (push it away) and `⇤` when collapsed (pull it
back); `aria-expanded` and `title` track state. Added to the eight part demo
HTML pages. It stays optional, so a host that would rather drive the rail from
its own chrome can omit it — the cloud already hides `#theme` from the viewbar
for exactly that reason.

### 4.7 Persistence

`partforge:rail` holding `{ width, collapsed }` — a sibling of the existing
`partforge:theme`, and deliberately **not** `pfc.split`, so a standalone demo
and the cloud editor never fight over one value. There is only one rail, so no
per-screen `collapsed` map is needed.

Read once on attach and re-clamped against the current shell width, so a width
saved on a wide monitor cannot leave a laptop with a 560px rail and no viewer.
Absent, corrupt, or throwing storage falls back to
`{ width: 288, collapsed: false }`. All access wrapped in try/catch, matching
`theme.js` in the cloud and partforge's own theme handling.

## 5. New and changed files

**New**

- `src/framework/chrome.css` — the reusable layout, **class-based**
  (`.pf-stage`, `.pf-rail`, `.pf-rail-head/-body/-foot`, `.pf-rail-seam`,
  `.pf-float-tabs`, `.pf-float-viewbar`), exported as `partforge/chrome.css`.
  Class-based rather than keyed to partforge's demo ids because the cloud host
  uses `#viewer` / `#pfc-controls` and could never reuse an id-keyed sheet.
  Selector lists cover both the classes and the legacy ids, so flat markup
  keeps working.
- `src/framework/rail-state.js` — pure: `railMaxWidth`, `clampRailWidth`,
  `resolveRailDrag`, `readRailPref`, `writeRailPref`. No DOM.
- `src/framework/rail.js` — `attachRail({ shell, rail, viewer, toggle })`:
  creates the seam, wires pointer/keyboard/toggle, returns `dispose()`.
- `test/rail-state.test.js`, `test/framework/rail.test.js`.

**Changed**

- `src/framework/tokens.css` — §2.1 tokens.
- `src/framework/app.css` — imports `chrome.css`; §1 layout, §2.3/2.4 shape and
  shadow, §3 sections, the `input[type="range"]` thumb border fix, removal of
  the 680px media block.
- `src/framework/mount.js` — resolve `chrome.railToggle`; call `attachRail` and
  register its dispose with the existing `cleanup.defer` pattern.
- `package.json` — the two `devDependencies`; `"./chrome.css"` export; version
  0.28.0.
- The eight part demo pages (`bracket`, `demo`, `faceted-vase`, `filleted-box`,
  `hull-sweep`, `nameplate`, `planter`, `text-smoke`) — chrome moves inside
  `#app`, rail classes, `#rail-toggle`. `index.html` is the standalone landing
  page and `embed-test.html` carries its own harness markup with no rail;
  neither changes.
- The eight matching `src/app-<part>.js` entries — the two fontsource imports.
  `app-embed-test.js` is a bare lifecycle harness and does not need them.
- `scripts/check-app.mjs` — §6.
- `docs/AUTHORING-PARTS.md` — the app-wiring section documents the new markup
  convention and `#rail-toggle`.

## 6. Testing

**`test/rail-state.test.js`** — pure functions, table-driven.

- `railMaxWidth` / `clampRailWidth`: floor, ceiling, the `shellWidth / 2` rule
  on a narrow shell, zero-width shell staying total.
- `resolveRailDrag`: one case per cell of §4.3's table, including **both
  directions of travel** through the 140–200 band, and that collapsing preserves
  the last open width.
- `readRailPref` / `writeRailPref`: defaults, absent key, corrupt JSON, a
  throwing `localStorage`, re-clamping an over-wide stored value.

**`test/framework/rail.test.js`** — DOM wiring on happy-dom.

- Seam exposes `role="separator"` with `aria-valuenow/min/max` tracking width.
- ←/→/Home/End/Enter update both the aria value and `--pf-rail-w`.
- Collapsed sets `inert` on the rail and keeps the seam mounted.
- `#rail-toggle` toggles, and `aria-expanded` follows.
- `attachRail` no-ops without a rail element, and `dispose()` removes the seam
  and its listeners.

happy-dom implements neither `setPointerCapture` nor `releasePointerCapture`;
`test/setup` gains no-op stubs (the cloud needed the same).

**`scripts/check-app.mjs`** — real Chromium, geometric.

- The existing `#viewbar` / `#panel` overlap assertion is kept and now guards
  the new layout.
- The rail spans the full viewport height and is flush to the right edge.
- `#topbar` and `#viewbar` are inside the viewer column's bounds.
- **A real drag** on the seam across the viewer, asserting the rail followed —
  this proves the pointer-capture path. The cloud's spec records this as a
  manual check only, because no headless DOM models an iframe consuming pointer
  events; partforge's smoke check drives a real canvas, so here it can be
  automated.

**`test/tokens.test.js`** — extended for `--pf-sans`, `--pf-rail-w`,
`--pf-radius-control`, `--pf-shadow-rail`, and that `--pf-mono` still resolves
to a mono stack.

## 7. Out of scope

- **Moving `#status` to a bottom-centre pill over the viewer.** That is the
  cloud's placement, but it is a markup and smoke-test change that was not
  asked for. `#status` stays in the rail foot.
- **Concentric-corner radii.** No rounded parent corner exists on a square
  rail (§2.3).
- **Any change to accordion behavior** (§3).
- **Any change in partforge-cloud** (§9).

## 8. Risks

- **Eight HTML pages change shape.** partforge is pre-1.0 and
  `docs/AUTHORING-PARTS.md` tells authors to copy the demo markup, so this is a
  documented convention change rather than a break. `chrome.css`'s selector
  lists keep flat markup rendering, and `mount` gains no *required* element —
  `#rail-toggle` and the rail itself are both optional.
- **Two seams in the cloud editor** once the cloud adopts this: the chat/card
  seam on the left and the rail seam on the right. They resize genuinely
  different things, so this is intended, but it is a change in feel worth
  watching.
- **The `--pf-surface-2` → `--pf-surface` thumb-border fix (§3)** is the kind of
  thing that only shows up visually. The smoke check screenshots the app, so a
  mismatched ring is at least reviewable.

## 9. Follow-up (partforge-cloud, separate PR)

Once `partforge/chrome.css` ships, the cloud can:

- add `class="pf-stage"` to `#viewer` and `class="pf-rail"` to `#pfc-controls`,
  import `partforge/chrome.css`, and delete `sandbox.css`'s duplicated
  positioning for `#pfc-controls`, `#viewbar`, and `#part`;
- decide whether to keep partforge's `#rail-toggle` in the viewbar or hide it
  (as it already does for `#theme`) and drive the rail from `EditorTopBar`.

Not required for this change to land, and not attempted here.
