# Viewer-side pose fast path — design

**Date:** 2026-07-27
**Status:** implemented
**Depends on:** PR #73 (`claude/occt-solid-cache` — OCCT solid cache + `src/framework/geometry/pose.js`)

## Problem

A param change whose only effect is a rigid pose (the Hinged Box's `openAngle`,
an exploded-view offset) still pays the full preview pipeline per tick: debounce →
worker job → build → mesh copy + transfer → new `BufferGeometry` → GPU upload.
PR #73 made the worker-side build ~free on OCCT (~0.5 ms), but the round trip and
re-upload remain — too slow and too janky for the planned animation system, which
wants to drive pose params at 60 fps.

## Decisions (made with Scott)

1. **Driver: params only.** No separate pose API. Params stay the single source of
   truth (verify gates, exports, share links all keyed off params); the future
   animation system animates params and inherits the fast path.
2. **Pose source: geometry-free probe** on the main thread. No part-contract
   changes — existing parts (incl. cloud parts like the Hinged Box, which poses
   inside `build`) get the fast path as authored.
3. **Application: delta matrix** against the delivered mesh. No worker, backend,
   or mesh-protocol changes; works on Manifold and OCCT alike.
4. **API surface: one small public hook**, `setParams(partial)` on the mounted
   app. Sliders route through it; the animation system will call it per frame.

## Architecture

### 1. Pose probe — new `src/framework/pose-probe.js` (main thread, pure)

Per visible subpart, run `build` + `place` (purpose `"display"`, current view)
against a stub kernel, in the style of the existing backend-detection probe
(`geometry/probe.js`):

- Geometry ops return token solids carrying a content-hash chain built with the
  shared `h()` from `geometry/solid-hash.js`, mirroring the backends' key
  discipline (every geometry-affecting arg folds into the hash).
- Trailing `translate`/`rotate` calls (incl. all `solid-sugar` compositions:
  `rotateAbout`, `along`, `at`, …) append recorded pose steps
  (`{t:"translate",v}` / `{t:"rotate",deg,center,axis}`) instead of hashing.
  A non-rigid op applied *after* a transform folds the pending pose into the
  hash chain (the probe's analogue of materialization) and clears the steps.
- Output per subpart: `{ baseHash, pose }`.

**The hash is only compared probe-to-probe** (new params vs. the params the
delivered mesh was built at), never to worker/backend hashes — so it needs
stability across param changes, not cross-backend agreement.

**Query taint:** *any* query op (`boundingBox`, `volume`, `area`, `genus`,
`isEmpty`, Shape2D queries, mesh/STL exports, …) called during a subpart's build
marks that subpart *untrusted* → it opts out of the fast path and takes the
normal regen path. NaN-filled dummy return values stay in place as
belt-and-suspenders (a non-finite number in a recorded pose step is rejected by
the `stepsFinite` check), but they cannot be the primary defense: a queried value
may feed a *geometry* argument rather than a pose one, where it is folded into
the hash and NaN-flow tracking can no longer see it. Tainting on the query call
itself covers both directions.

A probe that throws marks the whole part untrusted for that params version
(fall back to regen — today's behavior).

Memoized per `(paramsVersion, view)` exactly like `subPartReadKeys` in
`mesh-cache.js`.

### 2. Viewer pose matrices — `viewer.js`

- Each subpart's render objects (mesh + edge lines) get one per-subpart
  transform; `setSubPose(name, mat4)` applies it (`matrixAutoUpdate = false`).
  Identity by default; **reset to identity whenever a fresh worker mesh lands**
  for that subpart.
- Raycasting (hover/pick) and `Box3`-based framing/floor placement already
  respect object matrices; verify with tests rather than new code where possible.

### 3. Fast-path decision — `mount.js` + `mesh-cache.js`

- At mesh delivery, stamp each subpart with the probe result at the delivered
  params: `{ deliveredBaseHash, deliveredPose }`.
- On a param change, probe at the new params. Per visible subpart:
  - `baseHash === deliveredBaseHash` and subpart trusted → compute
    `delta = compose(newPose) · compose(deliveredPose)⁻¹`
    (`geometry/pose.js` gains `invertRigid`), call `viewer.setSubPose`, and
    treat the mesh as **current** — no regen, no debounce.
  - Otherwise → existing Layer-1 staleness → regen loop, unchanged.
- The pose repair runs synchronously before `missingParts()` counts stale
  subparts, so a pose-only change never reaches the regen loop at all.
- Debug overlay: extend `lastGen` with a posed-count so `?debug` shows fast-path
  activity (nice-to-have, small).

### 4. Public hook — `setParams(partial)` on the mounted app

- Merge into live params, sync the control panel UI, then run the fast path
  synchronously; any non-pose remainder kicks the normal (debounced) regen loop.
- The slider/controls input path routes through the same function — one code path.
- No debounce on the fast path → `requestAnimationFrame`-driven param animation
  renders at frame rate.

## Correctness boundaries

- Viewer matrices are **presentational only**. Exports, `verify`/`inspect`, and
  collision checks always run real builds from the same param values, so what's
  on screen and what's built/exported can never disagree.
- Structural changes (`enabled()` flips, view switches, part hot-reload) always
  take the regen path.
- The display-placement invariant ("display placement must not depend on the
  active view") is unchanged and is what makes the delivered-pose stamp valid
  across views.

## Testing

- **pose-probe unit tests** (pure, no kernel): stable `baseHash` across a
  pose-only param change with pose steps captured; changed `baseHash` on a
  geometry param change; NaN-taint opt-out when a pose derives from a query;
  pose folding when a boolean follows a transform.
- **pose math**: `invertRigid` round-trips (`M · M⁻¹ = I`) incl. rotation about
  an off-origin center.
- **mount-level fast path** (stub geometry service, existing framework-test
  style): a pose-only `setParams` sends zero generate jobs and sets a viewer
  pose; a geometry `setParams` sends one; a fresh mesh resets the pose.
- **Real-app smoke**: existing `npm run check` across the three demo apps.

## Out of scope

- The animation system itself (keyframes/timelines/easing) — separate upcoming
  project; this provides its fast entry point.
- A declarative `pose()` part-contract field — revisit only if the animation
  system wants named, addressable poses.
- Worker/backend/mesh-protocol changes — deliberately none.

## Implementation notes

Two contract details that differ from the design text above, settled while
building it:

- **`repair()` returns repaired NAMES (`string[]`), not a count.** A slider drag
  re-repairs the same subpart on every input event, so a running total is
  meaningless ("247 posed" for a one-subpart view). `mount.js` unions the names
  into a `Set` across the drag and reports its size, so the `?debug` overlay's
  posed figure counts distinct sub-parts, not repair calls.
- **`onBuild` does not fire for pose-only edits.** It is documented as
  per-completed-build, and a pose-only edit completes no build. Embedders that
  need to observe pose-only changes should watch their own `setParams` calls
  rather than `onBuild`.
