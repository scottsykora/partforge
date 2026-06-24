# Geometry Caching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop recomputing geometry that didn't change — skip rebuilding sub-parts whose params are untouched (main thread), and resume a sub-part's build from the first operation a changed param actually affects (worker).

**Architecture:** Two independent cache layers. **Layer 1** (main thread, `mount.js` + `param-deps.js`): per-sub-part relevance hash decides whether to even message the worker. **Layer 2** (worker, `manifold-backend.js`): content-hash memoization (hash-consing) of the preview kernel's operations, with retention bounded to the current build's graph per sub-part. The layers share no state and either can be reverted without touching the other.

**Tech Stack:** Plain ESM JavaScript, Vitest, Manifold (manifold-3d) WASM kernel, Vite workers.

## Global Constraints

- **Node ≥ 24** (`engines.node`, `.nvmrc`). Run all commands with the repo's Node.
- **No new dependencies.** Hashing is hand-rolled (FNV-1a); no hash library.
- **Layer 2 is preview-kernel only.** The export ("print", 480-segment) kernel must never cache or pin solids — verified by the fact that only the `generate` path brackets builds.
- **Determinism contract:** part `build` functions must be pure functions of `(k, p, d)` — no `Math.random`, no clock, no module-level mutable state. Memoization makes a violation silent (stale geometry). Document this in the authoring guide.
- **Removability:** Layer 2 lives in `solid-hash.js` + `solid-cache.js` + wiring in `manifold-backend.js`/`jobs.js`; Layer 1 in `param-deps.js` + wiring in `mount.js`. Each reverts independently to today's behavior.
- **Test boot pattern** (every Manifold test): `const wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" });` inside `beforeAll`.
- Manifold solids are immutable WASM objects with no GC; they must be freed via `.delete()` / `cleanup()`. A cached solid must survive `cleanup()`.

---

### Task 1: Content-hash helper

**Files:**
- Create: `src/framework/geometry/solid-hash.js`
- Test: `test/solid-hash.test.js`

**Interfaces:**
- Produces: `h(...parts: (string|number|boolean|array|object)[]) => string` — a short, stable base36 hash. Operands that are themselves solids are passed as their precomputed `_hash` string, keeping composition O(1) and length-bounded.

- [ ] **Step 1: Write the failing test**

```js
// test/solid-hash.test.js
import { expect, test } from "vitest";
import { h } from "../src/framework/geometry/solid-hash.js";

test("same inputs hash equal, different inputs hash differently", () => {
  expect(h("cylinder", 5, 5, 20)).toBe(h("cylinder", 5, 5, 20));
  expect(h("cylinder", 5, 5, 20)).not.toBe(h("cylinder", 5, 5, 21));
});

test("composes from operand hashes (order of args matters)", () => {
  const a = h("cylinder", 5, 5, 20);
  const b = h("cylinder", 2, 2, 30);
  expect(h("cut", a, b)).not.toBe(h("cut", b, a));
  expect(h("cut", a, b)).toBe(h("cut", a, b));
});

test("canonicalizes arrays and option objects (key order independent)", () => {
  expect(h("box", [0, 0, 0], [1, 2, 3])).toBe(h("box", [0, 0, 0], [1, 2, 3]));
  expect(h("p", { center: true, twist: 0 })).toBe(h("p", { twist: 0, center: true }));
  expect(h("p", { center: true })).not.toBe(h("p", { center: false }));
});

test("returns a short string", () => {
  expect(typeof h("cylinder", 5, 5, 20)).toBe("string");
  expect(h("cylinder", 5, 5, 20).length).toBeLessThanOrEqual(8);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- solid-hash`
Expected: FAIL — cannot resolve `../src/framework/geometry/solid-hash.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/framework/geometry/solid-hash.js
// Stable content hash for cached solids. Serializes scalar args canonically and
// folds via FNV-1a → base36. Solid operands are passed as their own (already
// computed) short `_hash` string, so composing two solids stays O(1) and the
// resulting key length stays bounded no matter how deep the build graph is.
export function h(...parts) {
  return fnv(parts.map(canon).join("|"));
}

function canon(x) {
  if (Array.isArray(x)) return "[" + x.map(canon).join(",") + "]";
  if (x && typeof x === "object") return "{" + Object.keys(x).sort().map((k) => k + ":" + canon(x[k])).join(",") + "}";
  return String(x);
}

function fnv(s) {
  let hsh = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { hsh ^= s.charCodeAt(i); hsh = Math.imul(hsh, 0x01000193); }
  return (hsh >>> 0).toString(36);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- solid-hash`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/solid-hash.js test/solid-hash.test.js
git commit -m "feat: add content-hash helper for solid memoization"
```

---

### Task 2: Solid cache (WASM-agnostic)

**Files:**
- Create: `src/framework/geometry/solid-cache.js`
- Test: `test/solid-cache.test.js`

**Interfaces:**
- Consumes: nothing (stores opaque values; the caller supplies `make()`).
- Produces: `createSolidCache() => { begin(name), end(), lookup(hash, make), isPinned(pin), stats(), resetStats() }` where:
  - `make()` is called only on a miss and must return `{ value, pin, dispose }` — `value` is the wrapped solid to return, `pin` is the underlying object to track (the Manifold `_m`), `dispose` frees it (`() => _m.delete()`).
  - `begin(name)`/`end()` bracket one sub-part's build. `end()` evicts (calls `dispose`) any of that sub-part's previously-cached entries not re-used this round, then commits the round.
  - Outside a `begin`/`end` bracket, `lookup` computes via `make()` and does NOT cache (used by the uncached export kernel).
  - `isPinned(pin)` tells the backend's `cleanup()` to skip a still-cached solid.

- [ ] **Step 1: Write the failing test**

```js
// test/solid-cache.test.js
import { expect, test, vi } from "vitest";
import { createSolidCache } from "../src/framework/geometry/solid-cache.js";

const make = (value) => () => ({ value, pin: value, dispose: vi.fn() });

test("a repeated hash within a sub-part is a hit and does not recompute", () => {
  const c = createSolidCache();
  c.begin("a");
  const v1 = c.lookup("h1", make({ id: 1 }));
  c.end();

  c.begin("a");
  const second = vi.fn(() => ({ value: { id: 99 }, pin: {}, dispose: vi.fn() }));
  const v2 = c.lookup("h1", second);
  c.end();

  expect(v2).toBe(v1);            // carried over from the previous round
  expect(second).not.toHaveBeenCalled();
  expect(c.stats()).toEqual({ hits: 1, misses: 1 });
});

test("an entry not re-used next round is disposed (evicted)", () => {
  const c = createSolidCache();
  const dispose = vi.fn();
  c.begin("a");
  c.lookup("old", () => ({ value: {}, pin: {}, dispose }));
  c.end();

  c.begin("a");
  c.lookup("new", make({}));      // different hash → "old" not re-used
  c.end();

  expect(dispose).toHaveBeenCalledTimes(1);
});

test("sub-parts are isolated — A's eviction never touches B", () => {
  const c = createSolidCache();
  const disposeB = vi.fn();
  c.begin("b"); c.lookup("hb", () => ({ value: {}, pin: {}, dispose: disposeB })); c.end();
  c.begin("a"); c.lookup("ha", make({})); c.end();      // rebuild A only
  c.begin("a"); c.lookup("ha2", make({})); c.end();     // A changes; evicts A's old
  expect(disposeB).not.toHaveBeenCalled();              // B untouched
});

test("isPinned reflects live cached pins", () => {
  const c = createSolidCache();
  const pin = { id: 1 };
  c.begin("a");
  c.lookup("h1", () => ({ value: {}, pin, dispose: vi.fn() }));
  expect(c.isPinned(pin)).toBe(true);
  c.end();
  expect(c.isPinned(pin)).toBe(true);   // still cached after commit
});

test("lookup outside a bracket computes without caching", () => {
  const c = createSolidCache();
  const v = c.lookup("h1", make({ id: 7 }));
  expect(v).toEqual({ id: 7 });
  expect(c.isPinned({ id: 7 })).toBe(false);
  expect(c.stats()).toEqual({ hits: 0, misses: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- solid-cache`
Expected: FAIL — cannot resolve `../src/framework/geometry/solid-cache.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/framework/geometry/solid-cache.js
// Worker-side cache of boundary-op solids, partitioned per sub-part. Retention is
// bounded to the CURRENT build's graph: each begin()/end() bracket rebuilds a
// sub-part's retained set from scratch, disposing any entry not re-used this round.
// WASM-agnostic — it stores opaque {value, pin, dispose} triples supplied by the
// caller (the Manifold backend), so it is unit-testable with plain objects.
export function createSolidCache() {
  const caches = new Map(); // name -> Map(hash -> { value, pin, dispose })
  const pinned = new Set();  // every live `pin` across all sub-parts
  let name = null, active = null, prev = null;
  let hits = 0, misses = 0;

  return {
    begin(n) { name = n; prev = caches.get(n) ?? new Map(); active = new Map(); },

    end() {
      if (name == null) return;
      for (const [hash, entry] of prev) {
        if (!active.has(hash)) { pinned.delete(entry.pin); entry.dispose(); } // evict
      }
      caches.set(name, active);
      name = null; active = prev = null;
    },

    lookup(hash, make) {
      if (name == null) return make().value; // not bracketed → no caching
      if (active.has(hash)) { hits++; return active.get(hash).value; }
      if (prev.has(hash)) { hits++; const e = prev.get(hash); active.set(hash, e); return e.value; }
      misses++;
      const entry = make();
      active.set(hash, entry);
      pinned.add(entry.pin);
      return entry.value;
    },

    isPinned: (pin) => pinned.has(pin),
    stats: () => ({ hits, misses }),
    resetStats: () => { hits = 0; misses = 0; },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- solid-cache`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/solid-cache.js test/solid-cache.test.js
git commit -m "feat: add per-sub-part solid cache with current-build-graph retention"
```

---

### Task 3: Wire memoization into the Manifold backend

**Files:**
- Modify: `src/framework/geometry/manifold-backend.js`
- Modify: `src/framework/geometry/kernel.js` (typedef note only)
- Test: `test/manifold-cache.test.js`

**Interfaces:**
- Consumes: `h` (Task 1), `createSolidCache` (Task 2).
- Produces, added to the object returned by `createManifoldKernel`:
  - `beginSubPart(name: string) => void`, `endSubPart() => void` — bracket one sub-part build.
  - `cacheStats() => { hits, misses }`, `resetCacheStats() => void`.
  - Every wrapped solid now carries `_hash: string`.
- **Boundary (cached) ops:** `cut`, `cutAll`, `intersect`, `union`, `revolve`, `prism`, `helixSweptTube`. **Folded-but-not-cached ops** (compute a `_hash`, no cache lookup): `cylinder`, `box`, `sphere`, `translate`, `rotate`, `mirror`, `scale`, `clone`.

- [ ] **Step 1: Write the failing test**

```js
// test/manifold-cache.test.js
import { beforeAll, beforeEach, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { meshVolume, bboxSize } from "../src/testing/mesh.js";

let k;
beforeAll(async () => { const wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" }); });
beforeEach(() => k.resetCacheStats());

// Two-boundary build: a flanged barrel (union) bored through (cut). `bore` feeds
// only the cut, so changing it must HIT the union and MISS only the cut.
const barrel = (od, h, flangeD, flangeH, boreR) => {
  let s = k.union([k.cylinder(od / 2, od / 2, h), k.cylinder(flangeD / 2, flangeD / 2, flangeH)]);
  return s.cut(k.cylinder(boreR, boreR, h + 4).translate([0, 0, -2]));
};

test("an identical rebuild is all hits, zero new misses", () => {
  k.beginSubPart("x"); barrel(8, 10, 16, 2, 1.7).toMesh(); k.endSubPart(); k.cleanup();
  const first = k.cacheStats().misses;
  expect(first).toBeGreaterThan(0); // union + cut were computed cold

  k.resetCacheStats();
  k.beginSubPart("x"); barrel(8, 10, 16, 2, 1.7).toMesh(); k.endSubPart(); k.cleanup();
  expect(k.cacheStats().misses).toBe(0);  // nothing recomputed
  expect(k.cacheStats().hits).toBeGreaterThan(0);
});

test("changing a late-stage param resumes — union hits, only the cut misses", () => {
  k.beginSubPart("y"); barrel(8, 10, 16, 2, 1.7).toMesh(); k.endSubPart(); k.cleanup();
  k.resetCacheStats();
  k.beginSubPart("y"); barrel(8, 10, 16, 2, 2.1).toMesh(); k.endSubPart(); k.cleanup(); // bore changed only
  expect(k.cacheStats()).toEqual({ hits: 1, misses: 1 }); // union hit, cut miss
});

test("a cached-resume mesh equals a cold-built mesh", async () => {
  k.beginSubPart("z"); barrel(8, 10, 16, 2, 1.7).toMesh(); k.endSubPart(); k.cleanup();
  k.beginSubPart("z"); const resumed = barrel(8, 10, 16, 2, 2.1).toMesh(); k.endSubPart(); k.cleanup();

  // Cold reference on a fresh kernel (no cache history).
  const m2 = await freshKernel().then((kk) => { const r = kk.barrel(2.1); return r; });
  expect(meshVolume(resumed.positions)).toBeCloseTo(m2.vol, 1);
  bboxSize(resumed.positions).forEach((s, i) => expect(s).toBeCloseTo(m2.bbox[i], 2));

  async function freshKernel() {
    const wasm = await Module(); wasm.setup();
    const kk = createManifoldKernel(wasm, { quality: "preview" });
    return {
      barrel: (boreR) => {
        let s = kk.union([kk.cylinder(4, 4, 10), kk.cylinder(8, 8, 2)]);
        const mesh = s.cut(kk.cylinder(boreR, boreR, 14).translate([0, 0, -2])).toMesh();
        return { vol: meshVolume(mesh.positions), bbox: bboxSize(mesh.positions) };
      },
    };
  }
});

test("determinism guard: building the same thing twice yields the same final hash", () => {
  const a = barrel(8, 10, 16, 2, 1.7)._hash;
  const b = barrel(8, 10, 16, 2, 1.7)._hash;
  expect(a).toBe(b);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- manifold-cache`
Expected: FAIL — `k.beginSubPart is not a function` / `k.resetCacheStats is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/framework/geometry/manifold-backend.js`, add imports at the top (after the existing imports):

```js
import { h } from "./solid-hash.js";
import { createSolidCache } from "./solid-cache.js";
```

Inside `createManifoldKernel`, after `const tracked = []; const T = ...; const unionRaw = ...;`, add the cache and a memo helper:

```js
  const cache = createSolidCache();
  // Boundary ops route through cache.lookup; on a miss `make` runs the WASM op,
  // tracks the result, and returns the triple the cache needs to pin/dispose it.
  const cached = (hash, computeM) => cache.lookup(hash, () => {
    const m = computeM();                 // already T()-tracked by the op
    return { value: wrap(m, hash), pin: m, dispose: () => m.delete?.() };
  });
```

Change `wrap` to take and carry a hash, and route boundary ops through `cached`. Replace the entire `const wrap = (m) => ({ ... });` block with:

```js
  const wrap = (m, hash) => ({
    _m: m,
    _hash: hash,
    cut: (t) => cached(h("cut", hash, t._hash), () => T(m.subtract(t._m))),
    cutAll: (tools) => cached(h("cutAll", hash, tools.map((t) => t._hash)),
      () => T(m.subtract(unionRaw(tools.map((t) => t._m))))),
    intersect: (t) => cached(h("intersect", hash, t._hash), () => T(m.intersect(t._m))),
    clone: () => wrap(m, hash),
    boundingBox: () => {
      const b = m.boundingBox();
      const min = [...b.min], max = [...b.max];
      return {
        min, max,
        center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
        size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      };
    },
    volume: () => m.volume(),
    genus: () => m.genus(),
    isEmpty: () => m.isEmpty(),
    translate: (v) => wrap(T(m.translate(v)), h("translate", hash, v)),
    rotate: (deg, center, axis) => {
      const euler = [axis[0] * deg, axis[1] * deg, axis[2] * deg];
      const a = T(m.translate([-center[0], -center[1], -center[2]]));
      const b = T(a.rotate(euler));
      return wrap(T(b.translate(center)), h("rotate", hash, deg, center, axis));
    },
    mirror: (plane) => wrap(T(m.mirror(PLANE_NORMAL[plane])), h("mirror", hash, plane)),
    scale: (factor, center = [0, 0, 0]) => {
      if (!(factor > 0)) throw new Error("scale: factor must be > 0");
      const a = T(m.translate([-center[0], -center[1], -center[2]]));
      const b = T(a.scale([factor, factor, factor]));
      return wrap(T(b.translate(center)), h("scale", hash, factor, center));
    },
    toMesh: () => meshOut(m, false),
    toSTL: () => Promise.resolve(meshOut(m, true)),
    toIndexedMesh: () => indexedMeshOut(m),
    fillet: () => { throw new KernelCapabilityError("fillet requires the OCCT backend"); },
    chamfer: () => { throw new KernelCapabilityError("chamfer requires the OCCT backend"); },
    shell: () => { throw new KernelCapabilityError("shell requires the OCCT backend"); },
  });
```

In the returned kernel object, update the primitives to pass a `_hash`, route the heavy primitives through `cached`, and add the cache controls. Replace the `return { ... };` block with:

```js
  return {
    cylinder: (rb, rt, h2, { center = false } = {}) =>
      wrap(T(Manifold.cylinder(h2, rb, rt, segs, center)), h("cylinder", rb, rt, h2, center, segs)),
    sphere: (r) => wrap(T(Manifold.sphere(r, segs)), h("sphere", r, segs)),
    box: (min, max) => {
      const cube = T(Manifold.cube([max[0] - min[0], max[1] - min[1], max[2] - min[2]]));
      return wrap(T(cube.translate(min)), h("box", min, max));
    },
    prism: (pts, height, { twist = 0, scaleTop = 1 } = {}) =>
      cached(h("prism", pts, height, twist, scaleTop, segs), () => {
        if (scaleTop < 0) throw new Error("prism: scaleTop must be ≥ 0");
        const cs = T(CrossSection.ofPolygons([pts]));
        if (twist === 0 && scaleTop === 1) return T(cs.extrude(height));
        const nDiv = Math.max(1, Math.ceil(Math.abs(twist) / 5));
        return T(cs.extrude(height, nDiv, twist, scaleTop));
      }),
    helixSweptTube: (o) => cached(h("helixSweptTube", o, tube), () => T(helixTube(wasm, { ...o, ...tube }))),
    revolve: (pts, { degrees = 360 } = {}) =>
      cached(h("revolve", pts, degrees, segs), () => {
        for (const [r] of pts) if (r < 0) throw new Error("revolve: profile radius must be ≥ 0");
        return T(Manifold.revolve([pts], segs, degrees));
      }),
    union: (solids) => cached(h("union", solids.map((s) => s._hash)), () => unionRaw(solids.map((s) => s._m))),
    toSTEP: () => { throw new Error("STEP export not supported by the Manifold backend"); },
    beginSubPart: (name) => cache.begin(name),
    endSubPart: () => cache.end(),
    cacheStats: () => cache.stats(),
    resetCacheStats: () => cache.resetStats(),
    // Free every WASM object created since the last cleanup EXCEPT solids the cache
    // still pins (they must survive for the next build to resume from them).
    cleanup: () => { for (const o of tracked) if (!cache.isPinned(o)) o.delete?.(); tracked.length = 0; },
  };
```

> Leave `meshOut`, `indexedMeshOut`, `creasedNormals`, and `stlFromMesh` unchanged. Note `cylinder`'s height param is renamed to `h2` inside the kernel object to avoid shadowing the imported `h` hash helper.

In `src/framework/geometry/kernel.js`, add one line to the `Solid` typedef block documenting the new field:

```js
 * @property {string} _hash   content hash (Manifold backend only; drives the worker solid cache)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- manifold-cache`
Expected: PASS (4 tests).

Then run the existing backend suite to confirm no regression:

Run: `npm test -- manifold-backend`
Expected: PASS (unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/manifold-backend.js src/framework/geometry/kernel.js test/manifold-cache.test.js
git commit -m "feat: memoize Manifold boundary ops via content hash"
```

---

### Task 4: Seed one compound op (`boredCylinder`) across backends

**Files:**
- Modify: `src/framework/geometry/manifold-backend.js`
- Modify: `src/framework/geometry/occt-backend.js`
- Modify: `src/framework/geometry/probe.js`
- Modify: `src/framework/geometry/kernel.js` (typedef)
- Modify: `docs/AUTHORING-PARTS.md` (determinism contract + compound note)
- Test: `test/compound-op.test.js`

**Interfaces:**
- Consumes: `h`, `cached` (Task 3).
- Produces: `boredCylinder({ od, h, bore }) => Solid` on every kernel — a cylinder of outer diameter `od`, height `h`, bored through-bore of diameter `bore`. On Manifold it is **one atomic cache node** (its internal cylinders are never retained); its `_hash` is `h("boredCylinder", od, h, bore, segs)`.

- [ ] **Step 1: Write the failing test**

```js
// test/compound-op.test.js
import { beforeAll, beforeEach, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { createProbeKernel } from "../src/framework/geometry/probe.js";
import { meshVolume } from "../src/testing/mesh.js";

let k;
beforeAll(async () => { const wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" }); });
beforeEach(() => k.resetCacheStats());

test("boredCylinder removes the bore volume", () => {
  const solid = k.boredCylinder({ od: 10, h: 20, bore: 4 });
  const plain = k.cylinder(5, 5, 20);
  expect(meshVolume(solid.toMesh().positions)).toBeLessThan(meshVolume(plain.toMesh().positions));
});

test("boredCylinder is a single atomic cache node", () => {
  k.beginSubPart("a"); k.boredCylinder({ od: 10, h: 20, bore: 4 }).toMesh(); k.endSubPart(); k.cleanup();
  expect(k.cacheStats().misses).toBe(1); // one node, not its internal cylinders+cut
  k.resetCacheStats();
  k.beginSubPart("a"); k.boredCylinder({ od: 10, h: 20, bore: 4 }).toMesh(); k.endSubPart(); k.cleanup();
  expect(k.cacheStats()).toEqual({ hits: 1, misses: 0 }); // whole compound reused
});

test("the probe kernel records boredCylinder (so builds using it stay analyzable)", () => {
  const { kernel, used } = createProbeKernel();
  kernel.boredCylinder({ od: 10, h: 20, bore: 4 });
  expect(used.has("boredCylinder")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- compound-op`
Expected: FAIL — `k.boredCylinder is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/framework/geometry/manifold-backend.js`, add to the returned kernel object (next to `cylinder`):

```js
    // Compound op: hashed ATOMICALLY from its own args, so it is a single cache
    // node — its internal cylinders/cut are never retained. The template for
    // future compounds: build internals with T(), return the final tracked solid.
    boredCylinder: ({ od, h: height, bore }) => cached(h("boredCylinder", od, height, bore, segs), () => {
      const body = T(Manifold.cylinder(height, od / 2, od / 2, segs, false));
      const tool0 = T(Manifold.cylinder(height + 4, bore / 2, bore / 2, segs, false));
      const tool = T(tool0.translate([0, 0, -2])); // raw ops: track each result
      return T(body.subtract(tool));
    }),
```

In `src/framework/geometry/occt-backend.js`, add to the returned kernel object (next to `cylinder`) — no cache, just composition using the file's existing local `cylinder` helper (which returns a wrapped solid with `.cut`/`.translate`):

```js
    boredCylinder: ({ od, h, bore }) =>
      cylinder(od / 2, od / 2, h).cut(cylinder(bore / 2, bore / 2, h + 4).translate([0, 0, -2])),
```

In `src/framework/geometry/probe.js`, add to the `kernel` object:

```js
    boredCylinder() { note("boredCylinder"); return proxy; },
```

In `src/framework/geometry/kernel.js`, add to the `GeometryKernel` typedef:

```js
 * @property {(o:{od:number,h:number,bore:number}) => Solid} boredCylinder   compound: bored-through cylinder (one cache node)
```

In `docs/AUTHORING-PARTS.md`, add a short subsection (under the kernel API section) — the determinism contract and how compounds control caching:

```markdown
### Caching & determinism

The preview kernel memoizes geometry by content hash, so editing a parameter only
re-runs the operations that parameter actually affects. For this to be sound, a
`build` must be a **pure function of `(k, p, d)`** — no `Math.random`, no clock, no
module-level mutable state. An impure build will silently return stale geometry.

Cache granularity follows the operations you call. Booleans and heavy primitives are
cached; cheap transforms are recomputed. To make a multi-step shape into a single
cache node, use (or add) a **compound op** like `k.boredCylinder({ od, h, bore })` —
it hashes from its own arguments and never exposes its internals to the cache.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- compound-op`
Expected: PASS (3 tests).

Confirm the OCCT path still builds (the compound exists on both backends):

Run: `npm test -- occt-backend`
Expected: PASS (unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/manifold-backend.js src/framework/geometry/occt-backend.js src/framework/geometry/probe.js src/framework/geometry/kernel.js docs/AUTHORING-PARTS.md test/compound-op.test.js
git commit -m "feat: add boredCylinder compound op (atomic cache node) on all kernels"
```

---

### Task 5: Bracket sub-part builds in the generate path

**Files:**
- Modify: `src/framework/jobs.js` (the `generate` branch of `handle`)
- Test: `test/cache-jobs.test.js`

**Interfaces:**
- Consumes: `beginSubPart`/`endSubPart`/`cacheStats` (Task 3).
- Produces: the `generate` path now brackets each sub-part build with `kernel.beginSubPart?.(name)` / `kernel.endSubPart?.()`. Export paths are unchanged, so the export kernel never caches.

- [ ] **Step 1: Write the failing test**

```js
// test/cache-jobs.test.js
import { beforeAll, expect, test, vi } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { handle } from "../src/framework/jobs.js";
import part from "../src/parts/demo.js";

let k;
beforeAll(async () => { const wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" }); });

// Demo spacer with the flange on → build is union(barrel, flange) then cut(bore).
const gen = (params) => handle(k, part, { type: "generate", subparts: ["spacer"], view: "spacer", params }, vi.fn());

test("re-generating after a bore-only change resumes the build (union hits, cut misses)", async () => {
  await gen({ od: 8, h: 10, flange_d: 16, bore: 3.4 }); // cold
  k.resetCacheStats();
  await gen({ od: 8, h: 10, flange_d: 16, bore: 4.0 }); // bore changed only
  const { hits, misses } = k.cacheStats();
  expect(hits).toBeGreaterThanOrEqual(1); // the flange union was reused
  expect(misses).toBeGreaterThanOrEqual(1); // the bore cut was redone
});

test("an identical re-generate recomputes nothing", async () => {
  await gen({ od: 8, h: 10, flange_d: 16, bore: 3.4 });
  k.resetCacheStats();
  await gen({ od: 8, h: 10, flange_d: 16, bore: 3.4 });
  expect(k.cacheStats().misses).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- cache-jobs`
Expected: FAIL — the second test's `misses` is non-zero, because without bracketing the cache never caches (every generate is cold).

- [ ] **Step 3: Write minimal implementation**

In `src/framework/jobs.js`, in the `generate` branch, bracket the build. Replace:

```js
      for (const name of msg.subparts) {
        const m = buildPosed(name, "display", msg.view).toMesh({ quality: "preview" });
        meshes.push({ name, positions: m.positions, normals: m.normals, indices: m.indices, triangles: m.triangles, edges: m.edges });
        kernel.cleanup?.();
      }
```

with:

```js
      for (const name of msg.subparts) {
        kernel.beginSubPart?.(name); // open the per-sub-part cache round
        const m = buildPosed(name, "display", msg.view).toMesh({ quality: "preview" });
        kernel.endSubPart?.();       // commit/evict before cleanup frees the transients
        meshes.push({ name, positions: m.positions, normals: m.normals, indices: m.indices, triangles: m.triangles, edges: m.edges });
        kernel.cleanup?.();
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- cache-jobs`
Expected: PASS (2 tests).

Run the full suite to confirm nothing regressed:

Run: `npm test`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/framework/jobs.js test/cache-jobs.test.js
git commit -m "feat: bracket sub-part builds so the generate path caches per sub-part"
```

---

### Task 6: Layer 1 — per-sub-part read keys + relevance hash

**Files:**
- Modify: `src/framework/param-deps.js`
- Test: `test/param-deps-subpart.test.js`

**Interfaces:**
- Consumes: existing `recorder`, `createProbeKernel`, `viewSubParts`, `RELEVANT_ALL` in `param-deps.js`.
- Produces:
  - `subPartReadKeys(part, view, params) => Map<name, Set<key>> | RELEVANT_ALL` — for each on-screen sub-part, the set of raw param keys it reads (mirrors `relevantParamKeys` but keyed per sub-part). Returns `RELEVANT_ALL` if analysis throws.
  - `relevanceHash(keys, params) => string` — a stable string of the given keys' values, for cache validity comparison.

- [ ] **Step 1: Write the failing test**

```js
// test/param-deps-subpart.test.js
import { expect, test } from "vitest";
import { subPartReadKeys, relevanceHash, RELEVANT_ALL } from "../src/framework/param-deps.js";

const view = { v: { label: "V" } };
const part = {
  defaults: { a: 1, b: 2 }, views: view,
  parts: {
    one: { views: ["v"], build: (k, p) => k.cylinder(p.a, p.a, p.a) },   // reads a only
    two: { views: ["v"], build: (k, p) => k.box([0, 0, 0], [p.b, p.b, p.b]) }, // reads b only
  },
};

test("each sub-part's read set contains only the params it reads", () => {
  const map = subPartReadKeys(part, "v", part.defaults);
  expect([...map.get("one")]).toEqual(["a"]);
  expect([...map.get("two")]).toEqual(["b"]);
});

test("relevanceHash is stable for equal values and differs when a value changes", () => {
  expect(relevanceHash(["a"], { a: 1, b: 2 })).toBe(relevanceHash(["a"], { a: 1, b: 9 }));
  expect(relevanceHash(["a"], { a: 1 })).not.toBe(relevanceHash(["a"], { a: 2 }));
});

test("an unanalyzable build yields RELEVANT_ALL (safe fallback)", () => {
  const bad = { defaults: {}, views: view, parts: { x: { views: ["v"], build: () => { throw new Error("nope"); } } } };
  expect(subPartReadKeys(bad, "v", {})).toBe(RELEVANT_ALL);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- param-deps-subpart`
Expected: FAIL — `subPartReadKeys`/`relevanceHash` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/framework/param-deps.js`:

```js
// Per-sub-part version of relevantParamKeys: which raw params each ON-SCREEN
// sub-part of the active view reads. Used by Layer 1 (mount.js) to skip
// regenerating sub-parts whose inputs are unchanged. Errs to RELEVANT_ALL on any
// analysis failure (caller then treats every param as relevant — safe, just slower).
export function subPartReadKeys(part, view, params) {
  try {
    const deriveInputs = new Set();
    const derived = part.derive ? (part.derive(recorder(params, deriveInputs)) ?? {}) : {};
    const { kernel } = createProbeKernel();
    const map = new Map();
    for (const name of viewSubParts(part, view, params)) {
      const sp = part.parts[name];
      const reads = new Set();
      const dSeen = new Set();
      if (sp.enabled) sp.enabled(recorder(params, reads)); // gate params change presence too
      sp.build(kernel, recorder(params, reads), recorder(derived, dSeen));
      if (dSeen.size > 0) for (const k of deriveInputs) reads.add(k);
      map.set(name, reads);
    }
    return map;
  } catch {
    return RELEVANT_ALL;
  }
}

// Stable string of the given param keys' current values — the cache-validity key
// for one sub-part. Sorted so key order never affects the result.
export function relevanceHash(keys, params) {
  return JSON.stringify(keys.slice().sort().map((k) => [k, params[k]]));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- param-deps-subpart`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/param-deps.js test/param-deps-subpart.test.js
git commit -m "feat: add per-sub-part read-key analysis and relevance hash"
```

---

### Task 7: Layer 1 — wire relevance-hash validity into mount.js

**Files:**
- Modify: `src/framework/mount.js`

**Interfaces:**
- Consumes: `subPartReadKeys`, `relevanceHash`, `RELEVANT_ALL` (Task 6).
- Produces: a sub-part's cached mesh is "current" iff its relevance hash is unchanged; unaffected sub-parts are never re-messaged to the worker.

> This task is wiring in a browser-only module. It is verified by the existing headless smoke check (`npm run check`, which boots the demo app in real Chromium) plus the full unit suite — the testable logic was already unit-tested in Task 6.

- [ ] **Step 1: Update the import**

In `src/framework/mount.js`, change:

```js
import { relevantParamKeys } from "./param-deps.js";
```

to:

```js
import { relevantParamKeys, subPartReadKeys, relevanceHash, RELEVANT_ALL } from "./param-deps.js";
```

- [ ] **Step 2: Replace version-based cache tracking with relevance hashing**

Replace this line:

```js
  const cacheVersion = Object.fromEntries(names.map((n) => [n, -1])); // params version each was built at
```

with:

```js
  const cacheHash = {}; // n -> relevance hash each sub-part's cached mesh was built at

  // Memoize the per-sub-part read-key map per (paramsVersion, view): subPartReadKeys
  // runs probe builds, so we compute it once per change, not per sub-part.
  let _readsKey = null, _readsMap = null;
  const readsFor = () => {
    const key = `${paramsVersion}|${view}`;
    if (_readsKey !== key) { _readsKey = key; _readsMap = subPartReadKeys(part, view, params); }
    return _readsMap;
  };
  // The relevance hash for one sub-part at the current params (RELEVANT_ALL → hash
  // over ALL params, so any edit invalidates it — the safe fallback).
  const hashFor = (n) => {
    const reads = readsFor();
    const keys = reads === RELEVANT_ALL ? Object.keys(params) : [...(reads.get(n) ?? Object.keys(params))];
    return relevanceHash(keys, params);
  };
```

- [ ] **Step 3: Update `isCurrent`**

Replace:

```js
  const isCurrent = (n) => viewer._subCache[n] && cacheVersion[n] === paramsVersion;
```

with:

```js
  const isCurrent = (n) => !!viewer._subCache[n] && cacheHash[n] === hashFor(n);
```

- [ ] **Step 4: Update the mesh-receive handler**

In `onWorkerMessage`, in the `case "meshes":` block, replace:

```js
          cacheVersion[m.name] = genVersion;
```

with:

```js
          cacheHash[m.name] = hashFor(m.name);
```

- [ ] **Step 5: Verify — unit suite + headless smoke**

Run: `npm test`
Expected: PASS (all, including Tasks 1–6).

Run: `npm run check`
Expected: the demo app boots in Chromium with the kernel ready and no errors (prints a success line). If Playwright's browser isn't installed: `npx playwright install chromium` first.

Manual confirmation (optional, `npm run dev` → open `/demo.html`): drag the **Bore** slider repeatedly — the spacer regenerates; toggling only the **Flange diameter** must not re-message the spacer when the spacer doesn't read it. (The demo is single-sub-part, so the strongest multi-part check is left to parts with several sub-parts.)

- [ ] **Step 6: Commit**

```bash
git add src/framework/mount.js
git commit -m "feat: skip regenerating sub-parts whose relevant params are unchanged"
```

---

## Notes for the implementer

- **Run order matters for Layer 2 in `jobs.js`:** `beginSubPart` → build → `endSubPart` → `cleanup`. `endSubPart` must run before `cleanup` so eviction/commit happens while the cache still knows what to pin.
- **Why `cylinder`'s height is `h2` in Task 3:** the file imports the hash helper as `h`; the kernel's `cylinder(rb, rt, h, …)` param would shadow it. Renamed locally to `h2` (and `height` in the compound) — purely to avoid the shadow.
- **The export kernel is never bracketed**, so `cache.lookup` runs in its uncached path and `cleanup()` frees everything — exactly today's behavior for STL/STEP/3MF.
- **If `npm run check` is flaky/unavailable** in the execution environment, Task 7 is still safe: its logic is unit-tested in Task 6 and the edits are mechanical substitutions. Note the skip in the task review.
