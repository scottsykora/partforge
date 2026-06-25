# Cache debug overlay — design

**Date:** 2026-06-24
**Status:** Approved (design); pending implementation plan
**Builds on:** the geometry caching feature (`docs/superpowers/specs/2026-06-24-geometry-cache-design.md`, implemented on the `geometry-cache` branch).

## Motivation

The two-layer geometry cache makes interactive edits faster, but the speedup is
invisible — there's no way to feel the difference or measure it. This adds a
developer-facing **debug overlay** that:

1. toggles the whole cache (both layers) on/off live, for an A/B comparison, and
2. shows the most recent build time plus what the cache actually did (Layer 2 op
   hits/misses, Layer 1 sub-parts skipped vs rebuilt).

It lives in partforge's `mount`, so it works in the Drum Machine, the demo, and any
part-app, and it is gated by `?debug` so normal app loads are completely unaffected.

## Design goal: isolation / removability

Matches the caching feature's removability pattern. The overlay is one
self-contained module (`framework/debug-overlay.js`); `mount.js` activates it only
under `?debug` and threads a single `cachingOn` flag into two existing gates.
Deleting the module and its `?debug` guard reverts the app to exactly today's
behavior. The overlay knows nothing about geometry; the flag-threading is a handful
of conditionals.

## Exposure

- **`?debug`** in the URL shows the overlay. Without it: no overlay, no extra DOM,
  no behavior change, caching always on (today's behavior).
- **`?debug&nocache`** additionally starts with caching off.

## One toggle, both layers

"Caching" means the whole system, so the single checkbox flips one `cachingOn` flag
that gates both layers:

- **Layer 1 (main thread):** when off, `isCurrent(n)` always returns false, so every
  visible sub-part regenerates on every edit (no skip).
- **Layer 2 (worker):** when off, the generate message carries `cache: false` and
  `jobs.js` skips the `beginSubPart`/`endSubPart` brackets. Unbracketed builds use
  the kernel's existing "not bracketed → compute, don't cache" path, so every op
  recomputes — a true cold build each time.

"Off" is therefore an honest uncached baseline on both axes; "on" is today's
behavior.

**Toggling forces an immediate regenerate** of the active view (`forceRegen()`), so
the readout updates for the *same* design right away — flip the checkbox and watch
the same part's build time jump between cached and uncached without touching a
parameter.

**Accepted caveat:** flipping caching *off* mid-session leaves the previously-pinned
solids in the worker cache (not freed until caching is re-enabled and eviction
resumes). Bounded to one prior design's worth of memory, harmless for a dev tool,
and not worth a cache-clear round-trip.

## Worker changes (`jobs.js`, generate path)

1. `kernel.resetCacheStats?.()` at the start of each generate job, so hit/miss counts
   reflect only this build.
2. `const useCache = msg.cache !== false;` guards the `beginSubPart`/`endSubPart`
   calls. The `try/finally` and `kernel.cleanup?.()` stay unconditional (preserving
   the error-path bracket-close fix).
3. The result message carries the numbers:
   `post({ type: "meshes", meshes, ms: Date.now() - t0, cache: kernel.cacheStats?.() })`.
   `ms` already exists; `cache` is `{ hits, misses }`.

## Main-thread changes (`mount.js`)

- Read `?debug` and `?nocache`; hold `let cachingOn = !(debug && nocache)`.
- Gate Layer 1: `isCurrent(n) = cachingOn && !!viewer._subCache[n] && cacheHash[n] === hashFor(n)`.
- Gate Layer 2: add `cache: cachingOn` to the generate message.
- On each `meshes` message, derive Layer-1 counts from what was sent for that build
  (`rebuilt = missing.length`, `skipped = needed.length − missing.length`) and feed
  the overlay `{ ms, hits, misses, skipped, rebuilt }`.
- `forceRegen()` (called by the toggle): delete `cacheHash[n]` for the active view's
  sub-parts, then `refreshView()` + `maybeGenerate()`, so the same design rebuilds
  under the new setting.
- Activate the overlay only under `?debug`:
  `const dbg = debug ? createDebugOverlay({ initialCachingOn: cachingOn, onToggle: (on) => { cachingOn = on; forceRegen(); } }) : null;`
  and call `dbg?.update({ ms, hits, misses, skipped, rebuilt })` on each `meshes`
  message.

## Overlay module (`framework/debug-overlay.js`, new)

`createDebugOverlay({ initialCachingOn, onToggle }) → { update(metrics) }`.

- Creates a fixed-corner `<div id="pf-debug">` appended to `document.body`, minimal
  inline styles (semi-transparent dark box, monospace) — no host-page DOM required.
- Contains a **Caching** checkbox (checked = `initialCachingOn`) and a readout area.
- Checkbox `change` → `onToggle(checkbox.checked)`.
- `update({ ms, hits, misses, skipped, rebuilt })` writes:
  ```
  build: 123 ms
  L2 ops: 12 hit / 3 miss
  L1 parts: 1 skipped / 1 rebuilt
  ```
  When caching is off, the L2 line reads "off".

## Module boundaries

- **`framework/debug-overlay.js`** — *new, self-contained.* Panel DOM, styles, and
  readout rendering. No geometry, no part/view knowledge. Interface:
  `createDebugOverlay({ initialCachingOn, onToggle }) → { update(metrics) }`.
- **`jobs.js`** — `resetCacheStats` + stats in the message + `useCache`-gated
  bracketing.
- **`mount.js`** — `?debug`/`?nocache` parsing, the `cachingOn` flag in the two gates,
  `forceRegen()`, and overlay wiring (guarded by `?debug`).

## Testing

- **`jobs.js` flag** (extend `test/cache-jobs.test.js`): a repeat generate with
  `cache: false` yields 0 cache hits (unbracketed = no caching); the default
  (`cache` omitted/true) shows hits on repeat. Assert the `meshes` message carries
  `ms` (number) and `cache: { hits, misses }`.
- **`debug-overlay.js`** (new `test/debug-overlay.test.js`, happy-dom — the project's
  test env): creating the overlay adds `#pf-debug` to the document; ticking the
  checkbox calls `onToggle` with the new boolean; `update()` writes the expected
  readout text (including the "off" L2 line when caching is off).
- **`mount.js` wiring** (the `?debug` guard, `isCurrent` gate, `forceRegen`): browser-
  only — verified by the existing `npm run check` smoke (default load has no
  `?debug`, so the overlay stays absent → no regression) plus manual A/B in the Drum
  Machine.

## Out of scope

- Persisting the toggle across reloads.
- Clearing/freeing the worker cache when caching is toggled off (accepted caveat
  above).
- Per-sub-part or per-op timing breakdowns (just the whole-build `ms` + counts).
- Any debug surface beyond the cache (FPS, memory, triangle history, etc.).
