# Cache Debug Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `?debug` overlay to partforge with a live caching on/off toggle and a readout of the last build time + cache hits/misses + sub-parts skipped/rebuilt, so the geometry cache's effect can be felt and measured.

**Architecture:** A self-contained `debug-overlay.js` owns the panel DOM and readout. `mount.js` activates it only under `?debug` and threads one `cachingOn` flag into the cache: Layer 1 is disabled by making each sub-part's cache key the global edit counter (so any edit invalidates everything), and Layer 2 by sending `cache: false` so the worker skips the cache brackets. The worker returns build `ms` + `{ hits, misses }` in its result message.

**Tech Stack:** Plain ESM JavaScript, Vitest (+ happy-dom for the DOM test), Manifold WASM kernel, Vite workers.

## Global Constraints

- **Node ≥ 24** (`.nvmrc`). Run commands on Node 24 (`source ~/.nvm/nvm.sh && nvm use` if `node -v` isn't 24).
- **No new dependencies.** `happy-dom` is already a devDependency.
- **`?debug`-gated.** Without `?debug`: no overlay, no extra DOM, no behavior change, caching always on (today's behavior).
- **One flag, both layers.** A single `cachingOn` boolean disables Layer 1 (main-thread skip) and Layer 2 (worker memoization) together.
- **Preserve the error-path fix.** The per-sub-part `try/finally` and unconditional `kernel.cleanup?.()` in `jobs.js` must stay; only the `beginSubPart`/`endSubPart` calls become conditional.
- **Removability.** The overlay is one module + a `?debug` guard + small flag-threading; deleting them reverts to today's behavior.
- **Builds on the geometry-cache branch** — implement on `geometry-cache` (the kernel's `beginSubPart`/`endSubPart`/`cacheStats`/`resetCacheStats` and the `jobs.js` bracketing already exist there).

---

### Task 1: Worker — cache flag + build stats in the generate result

**Files:**
- Modify: `src/framework/jobs.js` (the `generate` branch of `handle`)
- Test: `test/cache-jobs.test.js` (append)

**Interfaces:**
- Consumes: `kernel.beginSubPart`/`endSubPart`/`cacheStats`/`resetCacheStats` (already on the Manifold kernel).
- Produces: the `generate` branch honors `msg.cache` (default true; `false` → don't bracket → no caching) and its `meshes` result message now carries `ms: number` and `cache: { hits, misses }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/cache-jobs.test.js`:

```js
test("the generate result carries build ms and cache stats", async () => {
  const post = vi.fn();
  await handle(k, part, { type: "generate", subparts: ["spacer"], view: "spacer", params: { od: 8, h: 10, flange_d: 16, bore: 3.4 } }, post);
  const msg = post.mock.calls.map(([m]) => m).find((m) => m.type === "meshes");
  expect(typeof msg.ms).toBe("number");
  expect(msg.cache).toEqual(expect.objectContaining({ hits: expect.any(Number), misses: expect.any(Number) }));
});

test("cache:false bypasses the cache — a repeat generate reports no hits", async () => {
  const gen = (extra) => {
    const post = vi.fn();
    return handle(k, part, { type: "generate", subparts: ["spacer"], view: "spacer", params: { od: 8, h: 10, flange_d: 16, bore: 3.4 }, ...extra }, post)
      .then(() => post.mock.calls.map(([m]) => m).find((m) => m.type === "meshes"));
  };
  await gen({ cache: false });            // unbracketed
  const m2 = await gen({ cache: false });  // repeat, still unbracketed
  expect(m2.cache).toEqual({ hits: 0, misses: 0 }); // nothing was cached → no hits
});

test("default (cache on) reuses across repeats — hits on the repeat generate", async () => {
  const gen = () => {
    const post = vi.fn();
    return handle(k, part, { type: "generate", subparts: ["spacer"], view: "spacer", params: { od: 8, h: 10, flange_d: 16, bore: 3.4 } }, post)
      .then(() => post.mock.calls.map(([m]) => m).find((m) => m.type === "meshes"));
  };
  await gen();             // (cold or already-warm from earlier tests)
  const m2 = await gen();  // repeat
  expect(m2.cache.hits).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- cache-jobs`
Expected: FAIL — `msg.cache` is `undefined` (the message has no `cache` field yet), and the `cache:false` test fails because bracketing isn't conditional.

- [ ] **Step 3: Implement the jobs.js changes**

In `src/framework/jobs.js`, replace the `generate` branch (currently):

```js
    if (msg.type === "generate") {
      const t0 = Date.now();
      const meshes = [];
      for (const name of msg.subparts) {
        kernel.beginSubPart?.(name); // open the per-sub-part cache round
        try {
          const m = buildPosed(name, "display", msg.view).toMesh({ quality: "preview" });
          meshes.push({ name, positions: m.positions, normals: m.normals, indices: m.indices, triangles: m.triangles, edges: m.edges });
        } finally {
          kernel.endSubPart?.(); // always close the bracket — a throw mid-build must not strand pinned solids
          kernel.cleanup?.();    // free this round's transients (cached/pinned solids survive)
        }
      }
      post({ type: "meshes", meshes, ms: Date.now() - t0 });
    } else if (msg.type === "export-stl") {
```

with:

```js
    if (msg.type === "generate") {
      const t0 = Date.now();
      const useCache = msg.cache !== false; // ?debug toggle can disable caching (cache:false)
      const meshes = [];
      kernel.resetCacheStats?.(); // count hits/misses for just this job
      for (const name of msg.subparts) {
        if (useCache) kernel.beginSubPart?.(name); // open the per-sub-part cache round
        try {
          const m = buildPosed(name, "display", msg.view).toMesh({ quality: "preview" });
          meshes.push({ name, positions: m.positions, normals: m.normals, indices: m.indices, triangles: m.triangles, edges: m.edges });
        } finally {
          if (useCache) kernel.endSubPart?.(); // always close the bracket — a throw mid-build must not strand pinned solids
          kernel.cleanup?.();                  // free this round's transients (cached/pinned solids survive)
        }
      }
      post({ type: "meshes", meshes, ms: Date.now() - t0, cache: kernel.cacheStats?.() });
    } else if (msg.type === "export-stl") {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- cache-jobs`
Expected: PASS (all cache-jobs tests, including the three new ones).

- [ ] **Step 5: Commit**

```bash
git add src/framework/jobs.js test/cache-jobs.test.js
git commit -m "feat: honor a cache flag and return build ms + hit/miss stats from generate"
```

---

### Task 2: The debug overlay module

**Files:**
- Create: `src/framework/debug-overlay.js`
- Test: `test/debug-overlay.test.js`

**Interfaces:**
- Produces: `createDebugOverlay({ initialCachingOn = true, onToggle }) => { update({ ms, hits, misses, skipped, rebuilt }) }`.
  - Creates a fixed-corner `<div id="pf-debug">` appended to `document.body` with a **Caching** checkbox and a readout.
  - Checkbox `change` → `onToggle(checkbox.checked)`.
  - `update(metrics)` rewrites the readout. The L2 line reads `"off"` when the checkbox is unchecked, regardless of the passed hits/misses.

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { createDebugOverlay } from "../src/framework/debug-overlay.js";

afterEach(() => { document.getElementById("pf-debug")?.remove(); });

test("creating the overlay adds #pf-debug with a checkbox reflecting initialCachingOn", () => {
  createDebugOverlay({ initialCachingOn: true, onToggle: () => {} });
  const box = document.getElementById("pf-debug");
  expect(box).toBeTruthy();
  expect(box.querySelector("input[type=checkbox]").checked).toBe(true);
});

test("ticking the checkbox calls onToggle with the new value", () => {
  const onToggle = vi.fn();
  createDebugOverlay({ initialCachingOn: true, onToggle });
  const cb = document.querySelector("#pf-debug input[type=checkbox]");
  cb.checked = false;
  cb.dispatchEvent(new Event("change"));
  expect(onToggle).toHaveBeenCalledWith(false);
});

test("update() writes the build time and counts", () => {
  const o = createDebugOverlay({ initialCachingOn: true, onToggle: () => {} });
  o.update({ ms: 123, hits: 12, misses: 3, skipped: 1, rebuilt: 2 });
  const text = document.getElementById("pf-debug").textContent;
  expect(text).toContain("123 ms");
  expect(text).toContain("12 hit / 3 miss");
  expect(text).toContain("1 skipped / 2 rebuilt");
});

test("when caching is off, the L2 line reads 'off'", () => {
  const o = createDebugOverlay({ initialCachingOn: false, onToggle: () => {} });
  o.update({ ms: 50, hits: 0, misses: 0, skipped: 0, rebuilt: 1 });
  const text = document.getElementById("pf-debug").textContent;
  expect(text).toContain("L2 ops: off");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- debug-overlay`
Expected: FAIL — cannot resolve `../src/framework/debug-overlay.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/framework/debug-overlay.js
// A dev-only overlay (shown under ?debug) with a caching on/off toggle and a
// readout of the last build's time + what the cache did. Self-contained: it
// creates its own DOM and knows nothing about geometry — mount.js wires it in.
export function createDebugOverlay({ initialCachingOn = true, onToggle } = {}) {
  const box = document.createElement("div");
  box.id = "pf-debug";
  Object.assign(box.style, {
    position: "fixed", bottom: "12px", left: "12px", zIndex: "9999",
    font: "12px ui-monospace, monospace", background: "rgba(0,0,0,0.7)",
    color: "#e6e6e6", padding: "8px 10px", borderRadius: "6px",
    lineHeight: "1.5", whiteSpace: "pre",
  });

  const label = document.createElement("label");
  label.style.cssText = "display:block;cursor:pointer;margin-bottom:4px";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = initialCachingOn;
  cb.style.marginRight = "6px";
  label.append(cb, document.createTextNode("Caching"));

  const readout = document.createElement("div");
  readout.textContent = "build: —";

  box.append(label, readout);
  document.body.appendChild(box);

  cb.addEventListener("change", () => onToggle?.(cb.checked));

  return {
    update({ ms, hits = 0, misses = 0, skipped = 0, rebuilt = 0 } = {}) {
      const l2 = cb.checked ? `${hits} hit / ${misses} miss` : "off";
      readout.textContent =
        `build: ${ms != null ? Math.round(ms) + " ms" : "—"}\n` +
        `L2 ops: ${l2}\n` +
        `L1 parts: ${skipped} skipped / ${rebuilt} rebuilt`;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- debug-overlay`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/debug-overlay.js test/debug-overlay.test.js
git commit -m "feat: add the cache debug overlay module"
```

---

### Task 3: Wire the overlay + caching toggle into mount.js

**Files:**
- Modify: `src/framework/mount.js`

**Interfaces:**
- Consumes: `createDebugOverlay` (Task 2); the `cache` flag + `{ hits, misses }` result (Task 1).
- Produces: under `?debug`, an active overlay whose checkbox flips `cachingOn` (disabling both cache layers) and whose readout updates on every generate.

> No new unit test: this is browser-only wiring. Verified by the full unit suite (Tasks 1–2 + existing) and the headless smoke check, plus manual A/B in the Drum Machine. The logic it threads is already unit-tested upstream.

- [ ] **Step 1: Add the import**

In `src/framework/mount.js`, after the line `import { detectBackend } from "./geometry/probe.js";` add:

```js
import { createDebugOverlay } from "./debug-overlay.js";
```

- [ ] **Step 2: Parse `?debug`/`?nocache`, hold the flag, create the overlay**

In `src/framework/mount.js`, immediately after the `backendFor` definition (the line `const backendFor = () => forcedBackend ?? detectBackend(part, params);`) add:

```js
  // ?debug shows the cache debug overlay; ?debug&nocache starts with caching off.
  const qs = new URLSearchParams(location.search);
  const debug = qs.has("debug");
  let cachingOn = !(debug && qs.has("nocache"));
  let lastGen = { skipped: 0, rebuilt: 0 }; // Layer-1 counts for the most recent generate
  const dbg = debug
    ? createDebugOverlay({ initialCachingOn: cachingOn, onToggle: (on) => { cachingOn = on; forceRegen(); } })
    : null;
```

(`forceRegen` and `maybeGenerate` are function declarations defined later in `mount`, so they're hoisted and safe to reference from this closure.)

- [ ] **Step 3: Disable Layer 1 when caching is off**

In `src/framework/mount.js`, replace the `hashFor` definition (currently):

```js
  const hashFor = (n) => {
    const reads = readsFor();
    const keys = reads === RELEVANT_ALL ? Object.keys(params) : [...(reads.get(n) ?? Object.keys(params))];
    return relevanceHash(keys, params);
  };
```

with:

```js
  const hashFor = (n) => {
    if (!cachingOn) return `v${paramsVersion}`; // caching off: any edit invalidates every sub-part (Layer 1 off)
    const reads = readsFor();
    const keys = reads === RELEVANT_ALL ? Object.keys(params) : [...(reads.get(n) ?? Object.keys(params))];
    return relevanceHash(keys, params);
  };
```

This reverts Layer 1 to the old global-version behavior when caching is off (every edit rebuilds every visible sub-part) while keeping `isCurrent`/export-enable correct after a rebuild.

- [ ] **Step 4: Send the cache flag + record Layer-1 counts in maybeGenerate**

In `src/framework/mount.js`, replace the `maybeGenerate` function (currently):

```js
  function maybeGenerate() {
    if (!kernelReady || generating) return; // retried when the current build finishes
    const missing = missingParts();
    if (missing.length === 0) return;
    generating = true;
    genVersion = paramsVersion;
    showBusy("generating");
    service.generate({ type: "generate", subparts: missing, view, params }, backendFor());
  }
```

with:

```js
  function maybeGenerate() {
    if (!kernelReady || generating) return; // retried when the current build finishes
    const needed = viewSubParts(part, view, params);
    const missing = needed.filter((n) => !isCurrent(n));
    if (missing.length === 0) return;
    generating = true;
    genVersion = paramsVersion;
    lastGen = { skipped: needed.length - missing.length, rebuilt: missing.length }; // for the overlay
    showBusy("generating");
    service.generate({ type: "generate", subparts: missing, view, params, cache: cachingOn }, backendFor());
  }
```

- [ ] **Step 5: Add forceRegen (called by the toggle)**

In `src/framework/mount.js`, immediately after the `maybeGenerate` function add:

```js
  // Re-run the active view under the current caching setting, so toggling the
  // ?debug switch updates the readout for the same design without a param change.
  function forceRegen() {
    for (const n of viewSubParts(part, view, params)) delete cacheHash[n];
    refreshView();
    maybeGenerate();
  }
```

- [ ] **Step 6: Feed the overlay on each generate result**

In `src/framework/mount.js`, in `onWorkerMessage`'s `case "meshes":` block, replace:

```js
        hideBusy();
        refreshView();
        if (data.ms && missingParts().length === 0) {
          setStatus(`${statusEl.textContent} · ${(data.ms / 1000).toFixed(1)} s`);
        }
        maybeGenerate(); // active view may still need parts (tab switched during build)
        break;
```

with:

```js
        hideBusy();
        refreshView();
        if (data.ms && missingParts().length === 0) {
          setStatus(`${statusEl.textContent} · ${(data.ms / 1000).toFixed(1)} s`);
        }
        dbg?.update({ ms: data.ms, hits: data.cache?.hits ?? 0, misses: data.cache?.misses ?? 0, skipped: lastGen.skipped, rebuilt: lastGen.rebuilt });
        maybeGenerate(); // active view may still need parts (tab switched during build)
        break;
```

- [ ] **Step 7: Verify — unit suite + smoke check**

Run: `npm test`
Expected: PASS (all, including Tasks 1–2; ~177 tests).

Run: `npm run check`
Expected: the demo app boots in Chromium with no errors (default load has no `?debug`, so the overlay is absent — no regression).

Manual confirmation (optional, the Drum Machine dev server already runs against this branch): open `/index.html?debug`, switch to the **Large Drum** tab, and drag **Big-drum features → Load socket → Pipe diameter** — the readout should show a small build time with `L2 ops` mostly hits. Untick **Caching** and drag it again — the time should jump and `L2 ops` read `off`. Changing **Rope diameter** (caching on) rebuilds the groove field (more misses, larger time).

- [ ] **Step 8: Commit**

```bash
git add src/framework/mount.js
git commit -m "feat: wire the ?debug cache overlay and caching toggle into mount"
```

---

## Notes for the implementer

- **The `cachingOn` flag drives both layers.** Layer 1 via `hashFor` (version key when off → every sub-part stale on any edit); Layer 2 via the `cache: cachingOn` field on the generate message (Task 1 makes the worker skip its brackets on `cache:false`).
- **`forceRegen` clears `cacheHash` for the active view** so the toggle reliably triggers a rebuild in both directions (the format of `hashFor`'s return changes between on/off, but clearing is unconditional and explicit).
- **No host-page DOM is required** for the overlay — `mount` creates `#pf-debug` itself, so the Drum Machine, demo, and any part-app get it under `?debug` with no markup changes.
- **Accepted caveat (from the spec):** toggling caching off mid-session leaves the previously-pinned worker solids in memory until caching is re-enabled and eviction resumes — bounded and harmless for a dev tool; do not add a cache-clear round-trip.
