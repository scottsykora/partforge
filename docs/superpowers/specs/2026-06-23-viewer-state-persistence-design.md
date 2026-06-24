# Viewer state persistence — design

**Date:** 2026-06-23
**Status:** Approved (design); pending implementation plan
**Scope:** Persist viewer UI state across browser reloads (notably Vite dev
auto-refresh) so play/pause, camera transform, and the active view tab stick
between launches.

## Motivation

During development, Vite triggers a full-page reload on most edits. Today that
resets the viewer: auto-rotation resumes, the camera re-frames to its default
angle, and the active view tab returns to the page default. Only the light/dark
theme survives (already persisted in `localStorage`). This is friction when
iterating on a part — you lose your viewing angle and tab on every save.

This change persists three more pieces of viewer state in `localStorage` so they
survive reloads and dev-server restarts.

## Storage mechanism

`localStorage` (not cookies, not the URL):

- **Cookie** — sent to the server every request, ~4KB cap, awkward API; no
  server-side need here.
- **URL** — good for *shareable* view links but clutters the URL and needs
  throttled `history.replaceState` on every orbit; sharing is not a goal.
- **`localStorage`** — client-only, survives reload + tab close + dev-server
  restart, simple API, and already the established pattern (theme uses it).

All keys are **global** (shared across the different part pages), by explicit
choice. A global camera is coherent because the **active view tab is persisted
too** — the camera restored on load was last framed for the tab restored on load.

## In scope

- Persist & restore **play/pause** (auto-rotation on/off).
- Persist & restore the **camera transform** (orbit state: position + target).
- Persist & restore the **active view tab**.
- A new pure persistence module with unit tests.

## Out of scope

- **Theme** — already persisted under the `theme` key; left untouched.
- Per-part / per-page scoping (explicitly chose global).
- Shareable-URL view links.
- Persisting control-panel parameter values.

---

## Component 1 — `src/framework/view-state.js` (pure module)

Wraps `localStorage` with safe access and global namespaced keys. All persistence
logic lives here so it is unit-testable in Node; the three.js/DOM glue stays thin.

Exports:

| Function | Key | Behaviour |
|---|---|---|
| `loadRotating()` | `partforge:rotating` | returns saved boolean, or `true` (today's default) if absent/invalid |
| `saveRotating(on)` | `partforge:rotating` | persists a boolean |
| `loadCamera()` | `partforge:camera` | returns `{ pos:[x,y,z], target:[x,y,z] }` if present **and all six values are finite numbers**, else `null` |
| `saveCamera(state)` | `partforge:camera` | persists `{ pos, target }` |
| `loadView()` | `partforge:view` | returns the saved view name string, or `null` if absent |
| `saveView(name)` | `partforge:view` | persists a view name string |

Rules:

- Every read and write is wrapped in `try/catch`. If `localStorage` is
  unavailable (private mode, disabled) or a value is corrupt/unparseable, reads
  return the documented default (`true` / `null`) and writes are silently
  no-ops. The viewer must never throw because of persistence.
- `loadCamera()` validates that `pos` and `target` are 3-element arrays of finite
  numbers (`Number.isFinite`) before returning; otherwise returns `null` so the
  caller falls back to the normal auto-frame.
- `loadView()` returns the raw stored string; **validation that the view still
  exists is the caller's responsibility** (mount.js checks it against the
  available `#part` buttons), since this module knows nothing about the DOM.

---

## Component 2 — `src/framework/viewer.js` (camera accessors)

Add two methods to the object returned by `createViewer`, so `mount.js` owns all
storage and the viewer stays unaware of `localStorage`:

- `getCameraState()` → `{ pos: [x,y,z], target: [x,y,z] }` — reads
  `camera.position` and `controls.target`.
- `setCameraState({ pos, target })` → sets `camera.position` and
  `controls.target` from the arrays and calls `controls.update()`.

No change to `frameTo` / `showAssembly` / `setAutoRotate` / `setTheme` internals.

---

## Component 3 — `src/framework/mount.js` (wiring)

### Restore on load

- **Tab:** compute the initial `view` as: `loadView()` **if** a `#part`
  `button[data-part=<saved>]` exists, else today's default
  (`partSeg.querySelector("button.on")?.dataset.part ?? first button`). When the
  saved view is used, also set the `.on` class on its button (and clear it from
  the page default) so the segmented control reflects the restored tab.
- **Rotating:** initialize a `rotating` variable from `loadRotating()`; apply it
  via `viewer.setAutoRotate(rotating)` and set the pause-button label/title to
  match, on load.
- **Camera:** the **first** time a view is framed on load, override that
  auto-frame with `loadCamera()` if it returns non-null — applied **once** via a
  `cameraRestored` guard. Implemented at the existing frame site in `refreshView`
  (`if (frame) framedView = view`): on that first framing, if `!cameraRestored`
  and `loadCamera()` is non-null, call `viewer.setCameraState(saved)` and set
  `cameraRestored = true`.

### Saves

- **Camera:** save `viewer.getCameraState()` on the OrbitControls `end` event
  (fires once when a user drag finishes) and on `window` `pagehide` (captures the
  latest state — including auto-rotation drift — immediately before a Vite
  reload). `pagehide` fires on a full page reload.
- **Rotating:** `saveRotating(rotating)` inside the existing pause-button click
  handler.
- **View:** `saveView(view)` inside the existing `partSeg` click handler.

### Interactions (unchanged behaviour preserved)

- **Tab switch** keeps today's behaviour: `view !== framedView` ⇒ `refreshView`
  frames the new view. The saved camera is **not** re-applied on tab switches
  (the `cameraRestored` guard is already set after load), so switching tabs
  re-frames as before. The new view name is saved.
- **Reframe button** frames the current view as today; the reframed camera is
  persisted on the next `end`/`pagehide`.

To register the `end` listener, `mount.js` needs access to the controls. Expose
it minimally: `viewer.getCameraState`/`setCameraState` cover read/write, and a
new `viewer.onCameraEnd(cb)` (registers a listener on `controls` `end`) keeps the
controls object encapsulated. (Alternative considered: returning `controls`
directly — rejected to keep the viewer's surface intentional.)

---

## Error handling

- All `localStorage` access is `try/catch`-guarded in `view-state.js`; failures
  degrade to defaults / no-ops.
- A stale saved view that no longer matches any tab → falls back to the page
  default (validated in mount.js).
- A corrupt or non-finite saved camera → `loadCamera()` returns `null` → normal
  auto-frame runs.

## Testing

- **Unit tests for `view-state.js`** (Vitest, Node) against a mock `localStorage`
  (a minimal in-memory `getItem`/`setItem`, plus a throwing variant):
  - round-trip `rotating` (true/false), `camera`, `view`;
  - missing-key defaults (`loadRotating()===true`, `loadCamera()===null`,
    `loadView()===null`);
  - corrupt JSON → defaults, no throw;
  - non-finite / wrong-shape camera → `loadCamera()===null`;
  - storage that throws on access → all loads return defaults, all saves no-op.
- The three.js/DOM wiring in `viewer.js`/`mount.js` is not unit-tested (no jsdom
  in the suite today); it is covered by the existing `npm run check` Playwright
  smoke (app boots, kernel runs) plus manual verification of the reload behaviour.

## Files touched (anticipated)

| File | Change |
|---|---|
| `src/framework/view-state.js` | **new** — pure localStorage persistence module |
| `src/framework/viewer.js` | add `getCameraState`, `setCameraState`, `onCameraEnd` |
| `src/framework/mount.js` | restore tab/rotating/camera on load; save on toggle/tab/end/pagehide |
| `test/view-state.test.js` | **new** — unit tests for the persistence module |
