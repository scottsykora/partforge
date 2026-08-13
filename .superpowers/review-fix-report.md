# Review fix report — measurement-mode fix wave

Branch: `claude/3d-measurements-mode-5114cc` (PR #120)
All 10 findings addressed in one commit.

## 1. (correctness) Colon-label chip-id collision

`Solid.label()` text may contain colons, so parsing `data-dim-id` back into an
item id (via `startsWith`) could collide. Replaced with a structured item ref
carried through the whole pipeline instead of any string parsing.

- `src/framework/measure/dim-layout.js:29,46` — `linearDim` now takes and
  emits `itemId` on every label it pushes (bboxItem, planeItem, cylinderItem's
  linear dims all pass `itemId: item.id`).
- `src/framework/measure/dim-layout.js:166,234` — cylinderItem's own leader
  label and the offscreen-pinned fallback label also carry `itemId`.
- `src/framework/measure/dim-overlay.js:23-34,74-79` — chips get a
  `data-item-id` attribute alongside `data-dim-id`; `onChipClick` is invoked as
  `(chip.dataset.itemId, chip.dataset.dimId)`.
- `src/framework/measure/measure-mode.js:302-310` — `onChipClick(itemId)`:
  hover branch is `itemId === "hover"`; pin branch resolves via
  `buildItems(rect).find((i) => i.id === itemId)` — exact equality, no prefix
  matching.

**Tests:**
- `test/framework/measure/dim-overlay.test.js` — labels fixture carries
  `itemId`; "renders lines..." asserts `data-item-id`; "linked chip..."
  asserts `onChipClick` is called with `(itemId, dimId)`.
- `test/framework/measure/measure-mode.test.js` — replaced the string-level
  "chip ids resolve on boundaries, not prefixes" test with
  "clicking a pinned chip resolves it by its structured item id and unpins":
  pins a real feature, queries the rendered SVG for
  `g[data-item-id^="pin:"]`, dispatches a real click, asserts `pinCount()`
  goes back to 0.

**Command:** `npx vitest run test/framework/measure/dim-overlay.test.js test/framework/measure/measure-mode.test.js`
**Output:** all green (see combined run below).

## 2. (correctness) Escape dead with focus on cutaway's buttons

Cutaway's Flip/Reset buttons live in `#viewbar`, as canvas *siblings*, not
descendants — so measure's Escape listener on `viewer.domElement` alone never
saw a keydown that started on those buttons.

- `src/framework/measure/measure-controls.js:20,78` —
  `attachMeasureControls(viewer, mode, { measure }, { tooltip, escapeScope })`:
  when `escapeScope` is supplied, the keydown listener attaches to it
  *instead of* `viewer.domElement` (`escapeTargets = [escapeScope ?? viewer.domElement, button, clearButton]`).
- `src/framework/mount.js:318-320` — `mount.js` now passes
  `escapeScope: els.viewer` (the whole stage, a shared ancestor of the canvas
  and `#viewbar`).

**Test:** `test/framework/measure/measure-controls.test.js` —
"escapeScope: Escape from a canvas-sibling button still closes measure": puts
a canvas and a foreign button as siblings inside a scope div, attaches with
`escapeScope: scope`, dispatches Escape from the foreign button, asserts
`mode.setEnabled` was last called with `false`.

**Command:** `npx vitest run test/framework/measure/measure-controls.test.js`
**Output:** 13 tests passed.

## 3. (correctness) Ruler chrome desyncs when driven via runtime.measure.setEnabled

- `src/framework/measure/measure-controls.js:74` — subscribes
  `const offMode = mode.onModeChange(sync);` alongside the existing
  `onPinsChange` subscription, and releases it in `detach()`.

**Test:** `test/framework/measure/measure-controls.test.js` — `fakeMode` gained
`onModeChange` plumbing (a `Set` fired from `setEnabled`); new test "chrome
syncs when the mode is enabled externally, not via the button" calls
`mode.setEnabled(true)` directly (not `button.click()`) and asserts
`aria-pressed`/`.on`/actions-row visibility all update.

**Command:** `npx vitest run test/framework/measure/measure-controls.test.js`
**Output:** 13 tests passed.

## 4 + 7. (correctness + efficiency) Pinned dims behind camera / double projection

Combined restructure of `src/framework/measure/dim-layout.js` as instructed —
projection now happens exactly once per item per `layout()` pass, and behind-
camera handling is per-primitive instead of per-item.

- `projectSpec(item)` (new) projects every anchor of an item's spec exactly
  once, returning `{ kind, ...projected points }`.
- `pointsOf(proj)` (new) flattens that into the array used for the
  onscreen/offscreen test — this replaces the old `specPoints()`, which used
  to project the SAME anchors a second time.
- `bboxItem(out, item, corners, ...)` now takes the 8 already-projected
  corners. Dropped the blanket `if (corners.some(c => c.behind)) return`;
  the screen center is now the mean of only the non-behind corners, and per
  axis an edge is skipped (sentinel score `-1`) if either endpoint is behind —
  the axis itself is only skipped if all 4 candidate edges are unusable.
- `planeItem(out, item, proj)` now takes precomputed `{widthA, widthB,
  heightA, heightB}`. Dropped the blanket some-behind return; each of the two
  dims is emitted independently, skipped only when its own pair has a behind
  endpoint.
- `cylinderItem(out, item, proj, ...)` takes precomputed `{center, bottom,
  top}`; kept the `center.behind` gate for the leader (unchanged semantics),
  the depth dim already guarded its own endpoints and is unaffected.
- `layout()`'s offscreen-pinned fallback: replaced `const p = pts[0]; if
  (p.behind) continue;` with `const p = pts.find(pt => !pt.behind); if (!p)
  continue;` so a pinned item whose first anchor happens to be behind the
  camera (but another anchor is in front, just offscreen) still gets an edge
  chip instead of vanishing.
- `src/framework/measure/measure-mode.js:63-75,139-175,302-310` —
  `projectorFor(node, rect)` takes the canvas rect as a parameter (falling
  back to `viewer.domElement.getBoundingClientRect()` for a stray caller);
  `buildItems(rect)` threads it through to every `projectorFor(...)` call;
  `renderNow()` measures the rect once and passes it to `buildItems`;
  `onChipClick` measures its own rect once for its own `buildItems` call.

**Tests:**
- `test/framework/measure/dim-layout.test.js` — two new tests:
  - "a corner behind the camera drops only the axes that depend on it": marks
    every min-X corner behind; asserts D and H dims still render, W does not.
  - "pinned offscreen item still produces a chip when its first anchor (only)
    is behind": box corner 0 is marked behind while other corners are merely
    offscreen (not behind); asserts a chip is still produced (the old
    `pts[0]`-only check would have dropped it).
  - All 9 pre-existing tests in the file still pass unmodified.

**Command:** `npx vitest run test/framework/measure/dim-layout.test.js test/framework/measure/measure-mode.test.js`
**Output:** all green.

## 5. (correctness) Stale hover survives visibility-only changes

`src/framework/measure/measure-mode.js:191-208` — the frame dirty-check's
hover invalidation now also checks mesh visibility, not just geometry
identity:

```js
const m = viewer._subMeshes[hover?.subPart];
if (hover && (!m || !m.visible || hover.geometry !== m.geometry)) {
  hover = null;
  highlight.clear();
}
```

(Previously only `hover.geometry !== viewer._subMeshes[hover.subPart]?.geometry`
was checked — a visibility-only toggle, e.g. from a cutaway/view change,
left the hover pointing at a hidden mesh's still-identical geometry.)

**Test:** `test/framework/measure/measure-mode.test.js` — "stale hover is
dropped when its mesh goes invisible, even with the same geometry": hovers a
feature, sets `mesh.visible = false`, fires `viewer.frame()`, asserts the
hover dim text is gone from the overlay. Verified this test actually
exercises the fix (fails without it, since `hover.item` was previously pushed
into `buildItems()` unconditionally regardless of mesh visibility).

**Command:** `npx vitest run test/framework/measure/measure-mode.test.js`
**Output:** 15 tests passed.

## 6 + 10. (correctness + reuse) Shared teardown helpers + feature-highlight dispose isolation

- `src/framework/teardown.js` (new) — `runCleanupSteps(steps, message)`,
  `captureAttributes(element, names)`, `restoreAttributes(element,
  attributes)`, lifted verbatim from `cutaway-controls.js`'s originals
  (message is now a parameter instead of hardcoded).
- `src/framework/cutaway-controls.js` — imports the three helpers, deleted
  its local copies, call site passes `"cutaway control cleanup failed"`.
- `src/framework/measure/measure-controls.js` — same, message
  `"measure control cleanup failed"`.
- `src/framework/selection/hover.js` — imports `runCleanupSteps` (it never
  had its own `captureAttributes`/`restoreAttributes`), message
  `"feature hover cleanup failed"`.
- `src/framework/selection/feature-highlight.js:76-93` — `dispose()` rebuilt
  on `runCleanupSteps` so every step is isolated: overlay hide, overlayParent
  remove, each cached subset geometry's `dispose()` as its OWN step, subsets
  clear, `emptyOverlayGeometry` dispose, `unregisterCutaway`, `material.dispose()`.
  This supersedes the old `try { unregisterCutaway() } finally { material.dispose() }`
  (which only isolated those two specific steps, and didn't isolate subset
  geometry disposal from any of the rest).

**Tests:**
- `test/selection-hover.test.js` — "detach completes hover cleanup before
  reporting aggregated failures" (pre-existing) stays green: still resolves to
  an `AggregateError` with exactly `[hideError, unregisterError]`, since
  `feature-highlight.dispose()`'s own internal `runCleanupSteps` collapses to
  a single re-thrown error when only 1 of its steps fails (matching the old
  try/finally's effective behavior for that single-failure case), and
  `hover.js`'s outer `runCleanupSteps` still sees exactly 2 failing steps
  overall (`hide` and `highlight.dispose()`).
- `test/framework/measure/feature-highlight.test.js` — new test "dispose
  isolates a throwing cached subset from the rest of teardown": makes one
  cached subset geometry's `dispose()` throw, asserts the OTHER cached
  subset's `dispose()`, `material.dispose()`, and the cutaway `unregister`
  all still ran, and an error still propagated.

**Command:** `npx vitest run test/selection-hover.test.js test/framework/measure/feature-highlight.test.js test/framework/cutaway-controls.test.js test/framework/measure/measure-controls.test.js`
**Output:** all green.

## 8. (altitude) readsFor memo keyed on JSON.stringify

- `src/framework/mount.js:300-311` — passes `getParamsVersion: () =>
  loop.version()` into `createMeasureMode`, the same late-bound thunk idiom
  already used for `createMeshCache`/`createPoseFastPath` (`loop` is declared
  further down in `mount()`, so this is a closure over a not-yet-assigned
  `const`, same pattern as the existing `getParamsVersion` thunks — verified
  `loop.version` is exported from `regen-loop.js` via `version: () =>
  paramsVersion`).
- `src/framework/measure/measure-mode.js:92-99` — `readsFor` now keys on
  `` `${view}|${getParamsVersion ? getParamsVersion() : JSON.stringify(params)}` ``.
  Falls back to the old content-hash behavior when `getParamsVersion` is
  omitted (every existing direct test of `measure-mode.js`, which doesn't
  pass it).

**Command:** `npx vitest run test/framework/measure/measure-mode.test.js test/framework/mount.test.js`
**Output:** all green (no behavior change observable from existing tests,
since they don't pass `getParamsVersion` and hit the fallback path — this is
a real-mount performance fix, verified structurally and via `npm run check`
against the live demo app).

## 9. (reuse) Drag-threshold machine duplicated with divergent thresholds

- `src/framework/selection/drag-tracker.js` (new) —
  `createDragTracker({ thresholdSquared = 16 } = {})` returning
  `{ onDown, onMove, onUp, onCancel, consumeClick }`, the exact state machine
  lifted from `selection/pick.js`.
- `src/framework/selection/pick.js` — refactored to use it (default
  threshold 16 = 4px, same as before).
- `src/framework/measure/measure-mode.js:211,252-254,287-294,312-317,358-361` —
  refactored to use it too, dropping its own `DRAG_THRESHOLD_SQUARED = 5 ** 2`
  (25/5px) in favor of the shared default (16/4px).

**Tests:** pre-existing `test/selection-pick.test.js` (drag/no-drag/multi-
pointer cases) and `test/framework/measure/measure-mode.test.js`'s "drag does
not pin" (moves 30px, well above either old or new threshold — unaffected)
both stay green unmodified.

**Command:** `npx vitest run test/selection-pick.test.js test/framework/measure/measure-mode.test.js`
**Output:** all green.

## Verification gates

```
$ source ~/.nvm/nvm.sh && nvm use   # Node 24.16.0

$ npx vitest run test/framework/measure/ test/selection-pick.test.js \
    test/selection-hover.test.js test/framework/cutaway-controls.test.js \
    test/framework/mount.test.js test/worker-layering.test.js
 Test Files  14 passed (14)
      Tests  165 passed (165)

$ npm test
 Test Files  206 passed (206)
      Tests  2051 passed (2051)

$ npm run check
check http://localhost:5179/demo.html
  booted: true   hovered: true   cutaway: true   status: "928 triangles · 0.0 s"   errors: 0

# Additionally ran the other CI-listed apps for extra confidence (not part of
# the mandated gate, but measure mode touches shared mount/cutaway wiring):
$ CHECK_PORT=5180 node scripts/check-app.mjs planter.html
  booted: true   hovered: true   cutaway: true   errors: 0
$ CHECK_PORT=5181 node scripts/check-app.mjs filleted-box.html
  booted: true   hovered: true   cutaway: true   errors: 0
$ CHECK_PORT=5182 node scripts/check-app.mjs text-smoke.html --allow-no-cutaway
  booted: true   hovered: true   cutaway: false (expected)   errors: 0
$ CHECK_PORT=5183 node scripts/check-app.mjs hinged-box.html
  booted: true   hovered: true   cutaway: true   errors: 0
$ CHECK_PORT=5184 node scripts/check-app.mjs screw.html
  booted: true   hovered: true   cutaway: true   errors: 0
```

## Files touched

New:
- `src/framework/teardown.js`
- `src/framework/selection/drag-tracker.js`

Modified:
- `src/framework/measure/dim-layout.js`
- `src/framework/measure/dim-overlay.js`
- `src/framework/measure/measure-controls.js`
- `src/framework/measure/measure-mode.js`
- `src/framework/mount.js`
- `src/framework/cutaway-controls.js`
- `src/framework/selection/hover.js`
- `src/framework/selection/feature-highlight.js`
- `src/framework/selection/pick.js`
- `test/framework/measure/dim-layout.test.js`
- `test/framework/measure/dim-overlay.test.js`
- `test/framework/measure/feature-highlight.test.js`
- `test/framework/measure/measure-controls.test.js`
- `test/framework/measure/measure-mode.test.js`

No refactoring beyond what the 10 findings required; no scope creep.

## Follow-up: finding 7 residual (hover projector still measuring rect per anchor)

Re-review flagged that finding 7 was only partially addressed: `hitToHover()`
created the hover item with `project: projectorFor(hit.mesh)` — no rect — and
that item was built outside `buildItems`, at hover time. Since the hover item
is pushed into every `buildItems()` result while hovering (the hottest path —
every render frame during continuous hover), its projector kept calling
`viewer.domElement.getBoundingClientRect()` once per anchor per render,
missing the "measure the rect once per pass" fix applied to the overall/pinned
items.

**Fix** — `src/framework/measure/measure-mode.js`:
- `hitToHover()` (~line 227) now also stores `mesh: hit.mesh` on the returned
  hover record. `hover.item.project` still falls back to
  `projectorFor(hit.mesh)` (no rect) for a caller that reads `hover.item`
  directly outside a `buildItems(rect)` pass.
- `buildItems(rect)` (~line 165) now rebinds the hover item's projector
  against the shared rect when pushing it:
  ```js
  if (hover) items.push({ ...hover.item, project: projectorFor(hover.mesh, rect) });
  ```
  So on the render path, the hover item's anchors are projected against the
  SAME rect measured once for the whole pass, same as the overall/pinned
  items — no more per-anchor `getBoundingClientRect()` calls while hovering.

**Tests:** no new test added (the existing `dim-layout.test.js`/
`measure-mode.test.js` suites don't assert `getBoundingClientRect` call
counts — see the original report's note on this); the pre-existing hover
tests in `measure-mode.test.js` (hover rendering, click-to-pin from hover,
regen re-anchor, cutaway-handle suppression) all still exercise the hover
item end to end and stay green, confirming the rebind doesn't change
hover behavior.

**Command:** `npx vitest run test/framework/measure/measure-mode.test.js test/framework/measure/dim-layout.test.js`
**Output:**
```
 Test Files  2 passed (2)
      Tests  21 passed (21)
```

Also reran the broader gate for safety:
```
$ npx vitest run test/framework/measure/ test/selection-pick.test.js \
    test/selection-hover.test.js test/framework/cutaway-controls.test.js \
    test/framework/mount.test.js test/worker-layering.test.js
 Test Files  14 passed (14)
      Tests  165 passed (165)
```

Committed separately as `Thread the shared rect into the hover projector`
(not pushed).
