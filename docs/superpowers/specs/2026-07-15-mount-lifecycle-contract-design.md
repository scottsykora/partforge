# Mount lifecycle contract (`elements`, `ready`, `dispose`, `onBuild`, `onPick`) — design

**Date:** 2026-07-15
**Status:** Approved (design); pending implementation plan
**Target release:** 0.12.0
**Driven by:** partforge-cloud's maintainability architecture doc
(`partforge-cloud/docs/plans/2026-07-09-partforge-cloud-maintainability-architecture.md`,
§3.3 "Viewer lifecycle needs a real upstream API" and Phase 4), plus the
selection-chip feature (partforge-cloud Spec 2, separate document) which needs a
programmatic pick callback.

## Motivation

`mount()` today is fire-and-forget: it returns nothing, looks up host elements by
global ID (`#app`, `#controls`, `#status`, `#busy`, `#phase`, `#part`,
`#download`, `#download-step`, `#download-3mf`, `#pause`, `#reframe`, `#theme`),
sizes the viewer from `innerWidth`/`innerHeight` with a window `resize` listener,
installs document-level listeners (controls popover) and a `pagehide` camera
save, and offers no teardown. That is fine for a standalone part page that owns
the whole window, but partforge-cloud mounts and unmounts the viewer as a React
component inside a sandboxed iframe. To cope, it overrides
`window.innerWidth`/`innerHeight` (a viewport shim), leaks a `ResizeObserver`,
and cannot stop render loops or listeners on teardown.

Separately, selection mode's `Selection` + `formatSelection` (the LLM-readable
click description) is only reachable via the clipboard (`?pick`) or the local
pick-server (`?pickserver`). There is no programmatic path for an embedding app
to receive picks. partforge-cloud's click-to-chip chat feature needs one.

Both problems are contract problems on the same function, so they ship together
in one release rather than churning `mount()`'s signature twice.

## Scope

In scope (0.12.0):

- `elements` option: element references for every host element, replacing
  global-ID lookups inside submodules.
- Container-based viewer sizing via a retained `ResizeObserver`.
- A returned runtime handle: `{ ready, dispose() }`.
- `onBuild` callback: per-build outcome notification.
- `onPick` callback: always-on programmatic click-to-select, delivering the raw
  `Selection` plus preformatted label/prompt/token strings.
- Backward compatibility: all `elements` default to the current global-ID
  lookups; the old `container`/`controls` options remain as deprecated aliases.

Deferred (explicitly not this spec):

- partforge-cloud's consumption of any of this: the sandbox RPC forwarding, the
  transactional viewer swap, the watchdog `pending`/`unverified` rework, and the
  chat chip UI (partforge-cloud Spec 2 / its Phase 4).
- A generation/token API for cross-mount build cancellation — `dispose()` +
  `ready` make it unnecessary (see Lifecycle).
- Any change to `?pick` / `?pickserver` behavior when `onPick` is absent.

## The contract

```js
const runtime = mount(part, {
  createWorker,                 // unchanged, required
  elements: {                   // all optional; defaults = current global IDs
    viewer,                     //   canvas host            (default #app)
    controls,                   //   param-panel host       (default #controls)
    status,                     //   { status, busy, phase } elements
                                //     (defaults #status, #busy, #phase)
    tabs,                       //   view-tab segmented control (default #part)
    exports,                    //   { stl, step, threeMf } buttons
                                //     (defaults #download, #download-step, #download-3mf)
    chrome,                     //   { pause, reframe, theme } buttons
                                //     (defaults #pause, #reframe, #theme)
  },
  onBuild,                      // optional; see Build outcomes
  onPick,                       // optional; see Programmatic selection
});

await runtime.ready;            // first successful build of the default view
runtime.dispose();              // full teardown
```

### Elements

Global-ID resolution happens exactly once, at the `mount()` boundary: each
missing `elements` entry falls back to its current `getElementById` lookup.
Every submodule (`status-ui`, `view-tabs`, `viewer-controls`, export wiring,
`buildControls`) changes to accept element references and performs no document
queries of its own. Missing optional chrome (e.g. no `#pause` button on the
host page) stays a silent no-op, exactly as today.

The existing `container` and `controls` top-level options are kept for one
release as deprecated aliases for `elements.viewer` / `elements.controls`
(explicit `elements` wins).

### Sizing

`createViewer` sizes from its host element, observed with a `ResizeObserver`
that the runtime retains and disconnects on dispose. `innerWidth`/`innerHeight`
reads and the window `resize` listener are removed (including the
`lineMaterial.resolution` update, which follows the observed size). This is
what lets partforge-cloud delete its viewport shim.

### Lifecycle

`runtime.ready` is a promise for the first build of the default view:

- resolves on the first successful `meshes` result;
- rejects with the build error on a first-build `error` result;
- never times out — hang detection remains the consumer's job.

`runtime.dispose()` tears down everything `mount()` created:

- the RAF render loop and orbit controls;
- the sizing `ResizeObserver`;
- window listeners (`pagehide` camera save) and document-level listeners
  (controls popover `click`/`keydown`);
- regen-loop timers;
- the geometry workers spawned via `createWorker`;
- three.js GPU resources (renderer, geometries, materials);
- DOM nodes partforge created (controls panel, popover, hover label, status
  content) — host-owned elements are emptied, not removed;
- the pick listener, hover labels, and any pick-server client connection.

Disposing mid-build discards in-flight worker results: the stale-result gate in
`regen-loop` already ignores superseded builds; dispose makes that state
terminal and terminates the workers. Because a disposed runtime can never
surface a late result, cross-mount stale-build races are handled by
`dispose()` + `ready` alone — no generation-token API is exposed.

Calling `dispose()` twice is a no-op. Acceptance mirrors partforge-cloud
Phase 4: repeated mount/dispose cycles leave no workers, render loops,
observers, listeners, or timers alive.

### Build outcomes (`onBuild`)

When provided, `onBuild` fires once per completed build attempt:

```js
onBuild({ status: "success" | "error", ms, error? })
```

- `success`: a `meshes` result was accepted (not discarded as stale); `ms` is
  the worker-reported build time.
- `error`: the worker reported a build error; `error` is the message string.

Discarded stale results do not fire `onBuild`. `ready` is derived from the
same events (first `success` resolves it, first `error` rejects it), so a
consumer may use either or both.

### Programmatic selection (`onPick`)

When `onPick` is provided, `mount()` arms the existing `attachPicker`
permanently (always-on). The picker already distinguishes clicks from orbit
drags and ignores empty space; raycasting runs per click, not per frame. Each
pick still flashes the picked point in the viewer, so the user gets visual
confirmation independent of the host.

```js
onPick({
  selection,  // { subPart, point, normal, params, feature? } — raw Selection
  label,      // short text: feature label if present, else the sub-part label
              //   (part.parts[name].label ?? name) — e.g. "Drainage hole", "planter"
  prompt,     // formatSelection(selection, { style: "prompt" }) — the LLM sentence
  token,      // formatSelection(selection, { style: "token" })  — compact form
})
```

Formatting and label-precedence knowledge stays in partforge; embedding apps
never import the selection module.

**Precedence:** to preserve the "only one click listener is ever live"
invariant, `onPick` > `?pick` > `?pickserver`. If the host passes `onPick`, the
URL flags are ignored. Hover labels remain always-on regardless. `onPick` is
the first permanently-armed picker (`?pickserver` arms per request, `?pick`
via toggle); this is mechanically identical, just always active.

## Testing

Unit tests (vitest, existing module-test patterns):

- `elements` defaults resolve the current global IDs; explicit refs are
  honored and no `getElementById` runs when all refs are supplied.
- `ready` resolves on the first `meshes` message and rejects on a first-build
  `error`.
- `onBuild` fires with correct status/ms and skips stale results.
- `dispose()` removes the window/document listeners, disconnects the
  ResizeObserver, stops the RAF loop, terminates workers, and is idempotent.
- `onPick` receives `{ selection, label, prompt, token }`; label precedence is
  feature label, then sub-part label, then sub-part name.
- URL pick flags are ignored when `onPick` is set.

Existing selection tests (`selection-pick`, `selection-format`,
`selection-resolve`, `selection-hover`, pick-server suites) are untouched.

Manual checks before publishing 0.12.0: partforge's own dev app (default IDs,
no options) and a Drum Machine smoke (pins ≥0.10.0, uses default IDs).

## Consumers and sequencing

1. **partforge 0.12.0** (this spec) — publish to npm.
2. **partforge-cloud Spec 2** (separate document, separate cycle): bump the
   dependency, replace the viewport shim and mountManager teardown with
   `elements`/`ready`/`dispose`, forward `onPick` payloads over the sandbox
   RPC, and build the chat chip composer (marker-in-text messages).
3. partforge-cloud's transactional swap and watchdog rework continue as its
   Phase 4, unblocked by this contract.
