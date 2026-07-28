# Viewer-Side Pose Fast Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A param change that only re-poses a subpart (e.g. the Hinged Box's `openAngle`) updates three.js matrices synchronously on the main thread — zero worker jobs, zero GPU re-uploads — and the mounted app gains `setParams(partial)` so a future animation system can drive params at frame rate.

**Architecture:** A geometry-free *pose probe* runs each visible subpart's `build`+`place` against a stub kernel whose token solids accumulate a content-hash chain (shared `h()`) plus pending rigid pose steps. At mesh delivery each subpart is stamped with its probe result; on a param change, if a subpart's base hash is unchanged, the viewer applies the *delta matrix* `compose(newPose) · invert(compose(deliveredPose))` to that subpart's objects and the mesh cache re-stamps it current. Everything else falls through to the existing regen loop. No worker, backend, or mesh-protocol changes.

**Tech Stack:** Plain ESM, three.js viewer, vitest (`happy-dom` for framework tests). Node 24 (`nvm use` before anything).

**Spec:** `docs/superpowers/specs/2026-07-27-pose-fast-path-design.md`

## Global Constraints

- Branch: `claude/pose-fast-path` (already created, based on `claude/occt-solid-cache` / PR #73 — `geometry/pose.js` comes from there).
- Run `nvm use` in every shell before npm/npx/node (default shell Node is too old; failures are confusing otherwise).
- TDD per task: write the failing test, watch it fail, implement, watch it pass, commit.
- Part modules and everything the probe imports must stay DOM-free and side-effect-free.
- Viewer matrices are presentational only — never feed them into exports, verify, or collision paths.
- One deliberate deviation from the spec, decided during planning: the probe marks a subpart untrusted whenever **any query op** (`boundingBox`, `volume`, …) is called during its build — not only when NaN reaches a pose step. NaN-flow tracking misses the case where a query result feeds a *geometry* arg (probe hash would stay stable while real geometry changes). Query-taint is strictly safer; note it in the spec's Query taint paragraph when finishing Task 2.
- Commit messages end with:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WyriSU5txZ2ZDVnjq2jD1S
```

---

### Task 1: Rigid inverse + pose delta in `geometry/pose.js`

**Files:**
- Modify: `src/framework/geometry/pose.js`
- Test: `test/pose.test.js` (extend; pure, no kernel boot)

**Interfaces:**
- Consumes: existing `composePose(steps)` / `transformPositions(positions, m)` (column-major mat4 as a 16-element array).
- Produces: `invertRigid(m: number[16]) => number[16]` and `poseDelta(newSteps, oldSteps) => number[16]`, where steps are `{t:"translate", v:[x,y,z]}` / `{t:"rotate", deg, center:[x,y,z], axis:[x,y,z]}`. Task 4 calls `poseDelta`; Task 3's `setSubPose` consumes the resulting column-major array via three.js `Matrix4.fromArray` (also column-major).

- [ ] **Step 1: Write the failing tests** — append to `test/pose.test.js`:

```js
import { composePose, transformPositions, invertRigid, poseDelta } from "../src/framework/geometry/pose.js";
// (replace the existing import line — same module, two more names)

test("invertRigid round-trips: M · M⁻¹ applied to a point is identity", () => {
  const m = composePose([
    { t: "rotate", deg: 37, center: [5, -2, 1], axis: [0, 0, 1] },
    { t: "translate", v: [3, 4, 5] },
  ]);
  const inv = invertRigid(m);
  const p = Float32Array.from([1.5, -2.25, 7]);
  transformPositions(p, m);
  transformPositions(p, inv);
  expect(p[0]).toBeCloseTo(1.5, 5);
  expect(p[1]).toBeCloseTo(-2.25, 5);
  expect(p[2]).toBeCloseTo(7, 5);
});

test("poseDelta re-poses a delivered point to the new pose", () => {
  // delivered at 30°, new params ask 75°: delta must equal a further 45° about the same axis
  const at = (deg) => [{ t: "rotate", deg, center: [0, 0, 5], axis: [1, 0, 0] }];
  const delivered = Float32Array.from([2, 3, 0]);
  transformPositions(delivered, composePose(at(30)));   // what the worker baked
  transformPositions(delivered, poseDelta(at(75), at(30))); // what the viewer applies
  const expected = Float32Array.from([2, 3, 0]);
  transformPositions(expected, composePose(at(75)));
  for (let i = 0; i < 3; i++) expect(delivered[i]).toBeCloseTo(expected[i], 5);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pose.test.js`
Expected: FAIL — `invertRigid` is not exported.

- [ ] **Step 3: Implement** — append to `src/framework/geometry/pose.js`:

```js
// Invert a rigid mat4 (rotation + translation only): Rᵀ, t' = −Rᵀ·t.
export function invertRigid(m) {
  const r0 = m[0], r1 = m[1], r2 = m[2],
        r4 = m[4], r5 = m[5], r6 = m[6],
        r8 = m[8], r9 = m[9], r10 = m[10],
        tx = m[12], ty = m[13], tz = m[14];
  return [
    r0, r4, r8, 0,
    r1, r5, r9, 0,
    r2, r6, r10, 0,
    -(r0 * tx + r1 * ty + r2 * tz),
    -(r4 * tx + r5 * ty + r6 * tz),
    -(r8 * tx + r9 * ty + r10 * tz),
    1,
  ];
}

// The matrix that carries a mesh delivered at `oldSteps` to the pose `newSteps`:
// compose(new) · compose(old)⁻¹. Both step lists come from the pose probe.
export const poseDelta = (newSteps, oldSteps) => {
  const target = composePose(newSteps);
  const inv = invertRigid(composePose(oldSteps));
  // reuse the module's column-major multiply
  return mulMat4(target, inv);
};
```

The existing internal `mul` function must be callable here — rename it `mulMat4` (or export nothing new; just make `poseDelta` use it). Keep it module-private.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/pose.test.js`
Expected: PASS (all pose tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/pose.js test/pose.test.js
git commit -m "feat(pose): invertRigid + poseDelta for viewer-side re-posing"
```

---

### Task 2: The pose probe — `src/framework/pose-probe.js`

**Files:**
- Create: `src/framework/pose-probe.js`
- Test: `test/pose-probe.test.js` (pure — no kernel boot, no DOM)
- Modify (doc note only): `docs/superpowers/specs/2026-07-27-pose-fast-path-design.md` — amend the Query taint paragraph per the Global Constraints deviation.

**Interfaces:**
- Consumes: `h` from `./geometry/solid-hash.js`; `addSugar` from `./geometry/solid-sugar.js`; `SOLID_OPS, SOLID_OPTIONAL_OPS, SHAPE2D_OPS, OCCT_ONLY_OPS` from `./geometry/kernel.js`; `MAX_PROBE_OPS, ProbeRunawayError` from `./geometry/probe.js`; `viewSubParts, resolveParams` from `./jobs.js`.
- Produces: `probePoses(part, view, params) => Map<name, {baseHash?: string, pose?: Step[], trusted: boolean}>` — one entry per `viewSubParts(part, view, params)` member. `trusted: false` entries carry no other fields and must never enter fast-path comparison. Task 4 consumes this.

Background for the implementer: real backends give each solid a content-hash chain (see `occt-backend.js`) and treat `translate`/`rotate` as *pending pose steps* that "fold" into the hash when a non-rigid op consumes the solid. The probe mirrors exactly that bookkeeping with no geometry. All the transform sugar (`rotateAbout`, `along`, `at`, `rotateX/Y/Z`) comes from `addSugar`, which composes onto the token's own `rotate`/`translate` — so the token must be a plain object run through `addSugar`, not a catch-all Proxy (the older `geometry/probe.js` proxy can't track per-solid state). Op coverage can't drift: every op name is generated from the kernel-contract lists.

- [ ] **Step 1: Write the failing tests** — create `test/pose-probe.test.js`:

```js
// The pose probe: geometry-free per-subpart {baseHash, pose} extraction.
// Pure main-thread module — no kernel boot, no DOM.
import { expect, test } from "vitest";
import { probePoses } from "../src/framework/pose-probe.js";

// Minimal hinged-box shape: expensive base, then a pose rotation from a param.
const posedPart = {
  defaults: { w: 10, bore: 3, angle: 0 },
  views: { v: { label: "V" } },
  parts: {
    a: {
      views: ["v"],
      build: (k, p) =>
        k.box({ min: [0, 0, 0], max: [p.w, 10, 5] })
          .fillet({ r: 1, edges: { dir: "Z" } })
          .cut(k.cylinder({ r: p.bore / 2, h: 7 }).at([5, 5, -1]))
          .rotateAbout({ axis: "X", deg: p.angle, through: [0, 0, 5] }),
    },
  },
};

test("a pose-only param change keeps baseHash stable and changes only the pose", () => {
  const a0 = probePoses(posedPart, "v", { angle: 0 }).get("a");
  const a45 = probePoses(posedPart, "v", { angle: 45 }).get("a");
  expect(a0.trusted).toBe(true);
  expect(a45.trusted).toBe(true);
  expect(a45.baseHash).toBe(a0.baseHash);
  expect(a45.pose).not.toEqual(a0.pose);
  // the recorded steps are the rotateAbout sugar's underlying rotate
  expect(a45.pose.at(-1)).toEqual({ t: "rotate", deg: 45, center: [0, 0, 5], axis: [1, 0, 0] });
});

test("a geometry param change changes baseHash", () => {
  const a = probePoses(posedPart, "v", { bore: 3 }).get("a");
  const b = probePoses(posedPart, "v", { bore: 4 }).get("a");
  expect(a.baseHash).not.toBe(b.baseHash);
});

test("a transform buried under later booleans folds into baseHash (pose stays empty)", () => {
  const part = {
    defaults: { off: 1 },
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (k, p) =>
      k.box({ min: [0, 0, 0], max: [4, 4, 4] })
        .union(k.sphere({ r: 2 }).translate([p.off, 0, 0])) } },
  };
  const a1 = probePoses(part, "v", { off: 1 }).get("a");
  const a2 = probePoses(part, "v", { off: 2 }).get("a");
  expect(a1.trusted).toBe(true);
  expect(a1.pose).toEqual([]);                 // the translate was consumed by the union
  expect(a1.baseHash).not.toBe(a2.baseHash);   // …so it must live in the hash
});

test("place() is part of the probed pose", () => {
  const part = {
    defaults: { lift: 2 },
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"],
      build: (k) => k.box({ min: [0, 0, 0], max: [2, 2, 2] }),
      place: (s, { p }) => s.translate([0, 0, p.lift]) } },
  };
  const a = probePoses(part, "v", { lift: 3 }).get("a");
  expect(a.trusted).toBe(true);
  expect(a.pose).toEqual([{ t: "translate", v: [0, 0, 3] }]);
});

test("a build that queries geometry is untrusted (query results can't be probed)", () => {
  const part = {
    defaults: {},
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (k) => {
      const s = k.box({ min: [0, 0, 0], max: [4, 4, 4] });
      return s.translate([0, 0, s.boundingBox().size[2]]);
    } } },
  };
  expect(probePoses(part, "v", {}).get("a").trusted).toBe(false);
});

test("a throwing build is untrusted, and other subparts still probe", () => {
  const part = {
    defaults: {},
    views: { v: { label: "V" } },
    parts: {
      bad: { views: ["v"], build: () => { throw new Error("boom"); } },
      good: { views: ["v"], build: (k) => k.sphere({ r: 3 }) },
    },
  };
  const m = probePoses(part, "v", {});
  expect(m.get("bad").trusted).toBe(false);
  expect(m.get("good").trusted).toBe(true);
});

test("only subparts of the requested view are probed", () => {
  const part = {
    defaults: {},
    views: { v: { label: "V" }, w: { label: "W" } },
    parts: {
      a: { views: ["v"], build: (k) => k.sphere({ r: 1 }) },
      b: { views: ["w"], build: (k) => k.sphere({ r: 2 }) },
    },
  };
  const m = probePoses(part, "v", {});
  expect([...m.keys()]).toEqual(["a"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pose-probe.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `src/framework/pose-probe.js`:

```js
// Geometry-free pose probe: run a subpart's build()+place() against a stub kernel
// whose token solids carry (a) a content-hash chain built with the shared h() and
// (b) pending rigid pose steps, mirroring the backends' pose-lazy bookkeeping.
// The fast path compares probe results ACROSS PARAM CHANGES ONLY — probe hashes
// are never compared to backend hashes, so they only need to be stable and to
// fold every geometry-affecting argument.
//
// Trust model: any query op (boundingBox/volume/…) during a build marks that
// subpart untrusted — a query result could feed geometry OR pose, and the probe
// returns dummies, so neither hash stability nor pose values can be believed.
// Untrusted subparts simply take the normal regen path.
import { h } from "./geometry/solid-hash.js";
import { addSugar } from "./geometry/solid-sugar.js";
import { SOLID_OPS, SOLID_OPTIONAL_OPS, SHAPE2D_OPS, OCCT_ONLY_OPS } from "./geometry/kernel.js";
import { MAX_PROBE_OPS, ProbeRunawayError } from "./geometry/probe.js";
import { viewSubParts, resolveParams } from "./jobs.js";

const NAN3 = () => [NaN, NaN, NaN];

function makeProbeSession() {
  const state = { count: 0, queried: false };
  const tick = () => { if (++state.count > MAX_PROBE_OPS) throw new ProbeRunawayError(`pose probe exceeded ${MAX_PROBE_OPS} ops`); };

  // Queries return dummies AND poison trust (see module comment).
  const QUERY_DUMMIES = {
    boundingBox: () => ({ min: NAN3(), max: NAN3() }), // addSugar derives center/size
    volume: () => NaN,
    genus: () => NaN,
    isEmpty: () => false,
    area: () => NaN,
    toRegions: () => [],
    simple: () => ({ outer: [[NaN, NaN]], holes: [] }),
    toMesh: () => ({ positions: new Float32Array(9), normals: new Float32Array(0), triangles: 1, edges: new Float32Array(0) }),
    toSTL: () => new ArrayBuffer(0),
    toIndexedMesh: () => ({ positions: new Float32Array(9), indices: new Uint32Array(3) }),
  };

  // Operand tokens fold into a hash key by their own (pose-folded) hash; plain
  // data canonicalizes via h(); functions stringify (deterministic per source).
  const argKey = (a) => (a && a.__poseToken ? a.__folded() : typeof a === "function" ? String(a) : a);

  function token(hash, pose) {
    const folded = () => (pose.length ? h("posed", hash, pose) : hash);
    const foldOp = (op) => (...args) => { tick(); return token(h(op, folded(), ...args.map(argKey)), []); };
    const t = {
      __poseToken: true,
      __folded: folded,
      _hash: hash,
      _pose: pose,
      // The rigid vocabulary stays out of the hash: recorded as pending steps,
      // exactly like the OCCT backend's pose-lazy wrap. All transform sugar
      // (rotateAbout/along/at/rotateX…) composes onto these via addSugar.
      translate: (v) => { tick(); return token(hash, [...pose, { t: "translate", v }]); },
      rotate: (deg, center, axis) => { tick(); return token(hash, [...pose, { t: "rotate", deg, center, axis }]); },
      clone: () => t, // tokens are immutable — sharing is safe
      regions: () => { tick(); return [token(h("regions", folded()), [])]; },
    };
    for (const [op, dummy] of Object.entries(QUERY_DUMMIES))
      t[op] = (...a) => { tick(); state.queried = true; return dummy(...a); };
    // Every other contract op folds pose + args into a fresh hash. Generated from
    // the kernel-contract lists so new ops can never silently drift out of the probe.
    for (const op of [...SOLID_OPS, ...SOLID_OPTIONAL_OPS, ...SHAPE2D_OPS, ...OCCT_ONLY_OPS])
      t[op] ??= foldOp(op);
    return addSugar(t);
  }

  // Kernel: catch-all factory — any op makes a fresh token hashed from its args.
  const kernelQueries = {
    toSTEP: () => Promise.resolve(new ArrayBuffer(0)),
    cleanup: () => {}, beginSubPart: () => {}, endSubPart: () => {},
    cacheStats: () => ({ hits: 0, misses: 0 }), resetCacheStats: () => {},
  };
  const ignore = (key) => typeof key !== "string" || key === "then" || key === "toJSON" || key[0] === "_";
  const kernel = new Proxy({}, {
    get(_t, key) {
      if (ignore(key)) return undefined;
      if (key in kernelQueries) return kernelQueries[key];
      return (...args) => { tick(); return token(h(key, ...args.map(argKey)), []); };
    },
  });

  return { kernel, state };
}

const finiteVec = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const stepsFinite = (steps) => steps.every((st) =>
  st.t === "translate"
    ? finiteVec(st.v)
    : Number.isFinite(st.deg) && finiteVec(st.center) && finiteVec(st.axis));

// Probe every subpart the view shows. Never throws; a failing/queried/weird
// subpart yields { trusted: false } and the others still probe.
export function probePoses(part, view, params) {
  const out = new Map();
  let resolved;
  try { resolved = resolveParams(part, params); }
  catch {
    for (const name of viewSubParts(part, view, params)) out.set(name, { trusted: false });
    return out;
  }
  const { p, d } = resolved;
  for (const name of viewSubParts(part, view, params)) {
    try {
      const { kernel, state } = makeProbeSession(); // fresh op budget + trust per subpart
      const sp = part.parts[name];
      let s = sp.build(kernel, p, d);
      if (sp.place) s = sp.place(s, { view, purpose: "display", p, d });
      const ok = s && s.__poseToken && !state.queried && stepsFinite(s._pose);
      out.set(name, ok ? { baseHash: s._hash, pose: s._pose, trusted: true } : { trusted: false });
    } catch {
      out.set(name, { trusted: false });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/pose-probe.test.js`
Expected: PASS (7 tests). If `rotateAbout` records nothing: check that `addSugar` is applied to the token (the sugar supplies it) and that `translate`/`rotate` are defined BEFORE the `??=` loop so the loop doesn't overwrite them.

- [ ] **Step 5: Amend the spec's Query taint paragraph** (per Global Constraints deviation) — in `docs/superpowers/specs/2026-07-27-pose-fast-path-design.md`, replace the "Query taint" paragraph body with: any query op during a subpart's build marks it untrusted (NaN dummies remain as belt-and-suspenders via the `stepsFinite` check), because a query result may feed geometry args where NaN-flow tracking can't see it.

- [ ] **Step 6: Run the full suite** (probe imports jobs.js — make sure nothing else broke)

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/framework/pose-probe.js test/pose-probe.test.js docs/superpowers/specs/2026-07-27-pose-fast-path-design.md
git commit -m "feat(probe): geometry-free pose probe — per-subpart {baseHash, pose}"
```

---

### Task 3: Viewer pose matrices — `setSubPose` + posed framing

**Files:**
- Modify: `src/framework/viewer.js`

**Interfaces:**
- Consumes: column-major mat16 arrays from `poseDelta` (Task 1).
- Produces: `viewer.setSubPose(name, mat16 | null)` — applies (or clears, on `null`) a transform on the named subpart's mesh AND edge lines. Exposed on the viewer's returned API object next to `setSubGeometry`. Task 4 calls it (via `?.` so the mount-test fake viewer without it still works until extended); `setSubGeometry` implicitly resets the pose from Task 5's `recordDelivered`.

No isolated unit test: `viewer.js` is WebGL-bound (no existing unit-test precedent — it's exercised through the mocked mount tests and the real-browser `npm run check`). The math is covered by Task 1's tests, the wiring by Task 5's mount tests, and the rendering by Task 7's smoke checks.

- [ ] **Step 1: Add `setSubPose`** — in `viewer.js`, after the `setSubGeometry` function (~line 219):

```js
  // Presentational rigid pose for one sub-part (the pose fast path): applied to
  // the mesh and its edge lines. `null` clears. Column-major mat16 (pose.js /
  // three.js Matrix4 convention). Never affects exports or geometry — the worker
  // owns real placement; this only re-poses the delivered mesh.
  function setSubPose(name, mat16) {
    for (const obj of [subMesh[name], subLines[name]]) {
      if (!obj) continue;
      obj.matrixAutoUpdate = false;
      if (mat16) obj.matrix.fromArray(mat16);
      else obj.matrix.identity();
      obj.matrixWorldNeedsUpdate = true;
    }
  }
```

- [ ] **Step 2: Reset the pose when fresh geometry lands** — first line of `setSubGeometry`:

```js
  function setSubGeometry(name, payload) {
    setSubPose(name, null); // fresh worker mesh is baked at current params — clear any fast-path pose
    const prev = subCache[name];
    ...
```

- [ ] **Step 3: Make framing respect poses** — in `frameTo`, the per-name union currently reads `subCache[name].boundingBox` directly. Replace the loop body:

```js
  const _posedBox = new THREE.Box3();
  function frameTo(visibleNames) {
    _box.makeEmpty();
    for (const name of visibleNames) {
      if (!subCache[name]) continue;
      _posedBox.copy(subCache[name].boundingBox).applyMatrix4(subMesh[name].matrix);
      _box.union(_posedBox);
    }
    ...rest unchanged
```

- [ ] **Step 4: Export it** — add `setSubPose,` to the viewer's returned API object (next to `setSubGeometry` in the `return {...}` around line 455).

- [ ] **Step 5: Sanity-run the suite and one smoke check**

Run: `npx vitest run && node scripts/check-app.mjs demo.html`
Expected: suite green; smoke prints `booted: true … errors: 0`.

- [ ] **Step 6: Commit**

```bash
git add src/framework/viewer.js
git commit -m "feat(viewer): per-subpart presentational pose (setSubPose) + posed framing"
```

---

### Task 4: Fast-path decision module — `src/framework/pose-fast-path.js`

**Files:**
- Create: `src/framework/pose-fast-path.js`
- Test: `test/framework/pose-fast-path.test.js` (stub viewer + real mesh-cache-shaped stubs; no DOM)

**Interfaces:**
- Consumes: `probePoses` (Task 2), `poseDelta` (Task 1), `viewSubParts` from `./jobs.js`; a `viewer` with `hasSubMesh(name)` and `setSubPose(name, mat16)`; a `cache` with `isCurrent(name)` / `record(name)` (the `createMeshCache` surface).
- Produces: `createPoseFastPath(part, viewer, cache, { params, getView, getParamsVersion }) => { recordDelivered(name), repair() => number }`. `recordDelivered` stamps a subpart's probe result at delivery time; `repair()` re-poses every stale-but-pose-only subpart, re-stamps it current via `cache.record`, and returns how many it repaired. Task 5 wires both into mount.

- [ ] **Step 1: Write the failing tests** — create `test/framework/pose-fast-path.test.js`:

```js
// The pose fast path's decision layer: stamps at delivery, repairs on edit.
// Probe and delta math run for real; viewer and mesh-cache are minimal stubs.
import { expect, test } from "vitest";
import { createPoseFastPath } from "../../src/framework/pose-fast-path.js";

const posedPart = {
  defaults: { w: 10, angle: 0 },
  views: { v: { label: "V" } },
  parts: {
    a: {
      views: ["v"],
      build: (k, p) =>
        k.box({ min: [0, 0, 0], max: [p.w, 10, 5] })
          .rotateAbout({ axis: "X", deg: p.angle, through: [0, 0, 5] }),
    },
  },
};

function harness(part) {
  const params = { ...part.defaults };
  let version = 0;
  const poses = {};   // name -> last mat16 or null
  const current = new Set();
  const viewer = {
    hasSubMesh: (n) => n in poses,
    setSubPose: (n, m) => { poses[n] = m; },
  };
  const cache = {
    isCurrent: (n) => current.has(n),
    record: (n) => current.add(n),
  };
  const fp = createPoseFastPath(part, viewer, cache, {
    params, getView: () => "v", getParamsVersion: () => version,
  });
  return {
    params, poses, current, fp,
    edit(partial) { Object.assign(params, partial); version++; current.clear(); },
    deliver(name) { poses[name] = null; current.add(name); fp.recordDelivered(name); },
  };
}

test("a pose-only edit repairs the subpart: pose set, re-stamped current, count 1", () => {
  const hx = harness(posedPart);
  hx.deliver("a");
  hx.edit({ angle: 45 });
  expect(hx.fp.repair()).toBe(1);
  expect(hx.current.has("a")).toBe(true);
  expect(Array.isArray(hx.poses.a)).toBe(true);
  expect(hx.poses.a).toHaveLength(16);
});

test("a geometry edit does not repair (base hash changed)", () => {
  const hx = harness(posedPart);
  hx.deliver("a");
  hx.edit({ w: 12 });
  expect(hx.fp.repair()).toBe(0);
  expect(hx.current.has("a")).toBe(false);
});

test("an already-current subpart is left alone", () => {
  const hx = harness(posedPart);
  hx.deliver("a"); // current, delivered
  expect(hx.fp.repair()).toBe(0);
  expect(hx.poses.a).toBe(null); // untouched since delivery reset
});

test("no repair before any delivery (nothing stamped, no mesh)", () => {
  const hx = harness(posedPart);
  hx.edit({ angle: 30 });
  expect(hx.fp.repair()).toBe(0);
});

test("an untrusted subpart (geometry query in build) never repairs", () => {
  const queryPart = {
    defaults: { angle: 0 },
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (k, p) => {
      const s = k.box({ min: [0, 0, 0], max: [4, 4, 4] });
      return s.rotateAbout({ axis: "X", deg: p.angle, through: [0, 0, s.volume()] });
    } } },
  };
  const hx = harness(queryPart);
  hx.deliver("a");
  hx.edit({ angle: 45 });
  expect(hx.fp.repair()).toBe(0);
});

test("repair applies the delta against the DELIVERED pose, not the previous frame", () => {
  const hx = harness(posedPart);
  hx.deliver("a");           // delivered at angle 0
  hx.edit({ angle: 30 });
  hx.fp.repair();
  const at30 = hx.poses.a;
  hx.edit({ angle: 60 });
  hx.fp.repair();
  const at60 = hx.poses.a;
  // both deltas are absolute w.r.t. delivery: 60° is NOT 30° applied twice —
  // recompute 30° and check it matches the first repair exactly
  hx.edit({ angle: 30 });
  hx.fp.repair();
  expect(hx.poses.a).toEqual(at30);
  expect(at60).not.toEqual(at30);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/framework/pose-fast-path.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `src/framework/pose-fast-path.js`:

```js
// Decision layer of the pose fast path (no DOM, no three.js — viewer/cache are
// injected). At mesh delivery each subpart is STAMPED with its probe result at
// the delivered params; on a later edit, a stale subpart whose baseHash is
// unchanged gets its delivered mesh re-posed in the viewer (delta vs. the
// delivered pose) and is re-stamped current — no worker job. Everything else
// falls through to the normal regen loop.
import { viewSubParts } from "./jobs.js";
import { probePoses } from "./pose-probe.js";
import { poseDelta } from "./geometry/pose.js";

export function createPoseFastPath(part, viewer, cache, { params, getView, getParamsVersion }) {
  const stamps = {}; // name -> probe entry captured when that subpart's mesh was delivered

  // Memoize the probe per (paramsVersion, view) — same discipline as
  // createMeshCache's readsFor; params is the live in-place-mutated object.
  let probeKey = null, probeMap = null;
  const probeFor = () => {
    const key = `${getParamsVersion()}|${getView()}`;
    if (probeKey !== key) { probeKey = key; probeMap = probePoses(part, getView(), params); }
    return probeMap;
  };

  return {
    // Stamp a freshly delivered mesh with its probe result at the current params.
    // (The caller only records on non-stale builds — buildDone() guarantees the
    // live params are the ones the worker built with.)
    recordDelivered(name) {
      stamps[name] = probeFor().get(name);
    },

    // Re-pose every visible stale subpart whose base geometry is unchanged.
    // Returns how many were repaired (0 = nothing pose-only to do).
    repair() {
      let posed = 0;
      const poses = probeFor();
      for (const name of viewSubParts(part, getView(), params)) {
        if (cache.isCurrent(name) || !viewer.hasSubMesh(name)) continue;
        const now = poses.get(name), was = stamps[name];
        if (!now?.trusted || !was?.trusted || now.baseHash !== was.baseHash) continue;
        viewer.setSubPose(name, poseDelta(now.pose, was.pose));
        cache.record(name); // current again at these params — regen loop sees nothing missing
        posed++;
      }
      return posed;
    },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/framework/pose-fast-path.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/pose-fast-path.js test/framework/pose-fast-path.test.js
git commit -m "feat(fast-path): pose-only edits re-pose the delivered mesh, no rebuild"
```

---

### Task 5: Mount wiring + debug overlay count

**Files:**
- Modify: `src/framework/mount.js`
- Modify: `src/framework/debug-overlay.js:47-52`
- Test: `test/framework/mount.test.js` (extend — its fake viewer needs `setSubPose`)

**Interfaces:**
- Consumes: `createPoseFastPath` (Task 4); viewer `setSubPose` (Task 3).
- Produces: pose-only param edits never reach `service.send`; `lastGen.posed` count surfaces in the `?debug` overlay. No new public API (that's Task 6).

- [ ] **Step 1: Write the failing test** — in `test/framework/mount.test.js`. First extend the fake viewer factory (top of file) with `setSubPose: vi.fn(),` next to `setSubGeometry`. The fake part needs a pose param; extend `makePart`'s build and defaults:

```js
const makePart = () => ({
  meta: { title: "Test Part", backend: "manifold" }, // pinned backend: no probe run
  defaults: { h: 4, tilt: 0 },
  views: { main: { label: "Main" } },
  parts: { body: { label: "Body", views: ["main"], build: (k, p) =>
    k.box({ min: [0, 0, 0], max: [p.h, p.h, p.h] })
      .rotateAbout({ axis: "X", deg: p.tilt, through: [0, 0, 0] }) } },
  parameters: [{ id: "size", title: "Size",
    advanced: [
      { key: "h", label: "Height", min: 1, max: 10, step: 1 },
      { key: "tilt", label: "Tilt", min: 0, max: 90, step: 1 },
    ] }],
});
```

(Check the existing tests still describe this part correctly — the old `build: (k, p) => k.box?.(p.h, p.h, p.h)` used optional-chaining against a null kernel; the pose probe now runs this build for real against its stub kernel, so the build must be written like a real part. Run the file after editing and fix any assertion the richer part invalidates.)

Then add the tests (reusing the file's `makeWorkers`/`makeElements`/`finishFirstBuild` helpers and its timer handling — the file mocks debounce timing where needed; follow the existing pattern for advancing the 180 ms debounce, e.g. `vi.useFakeTimers()` + `vi.advanceTimersByTime(250)` as the neighboring tests do):

```js
test("a pose-only param edit re-poses in the viewer and sends no build job", async () => {
  vi.useFakeTimers();
  const { workers, createWorker } = makeWorkers();
  const handle = mount(makePart(), { createWorker, elements: makeElements() });
  finishFirstBuild(workers);
  const jobsBefore = workers.manifold.postMessage.mock.calls.length;

  // drive the tilt slider like a user drag
  const tilt = document.querySelectorAll('input[type="range"]')[1];
  tilt.value = "45";
  tilt.dispatchEvent(new Event("input", { bubbles: true }));
  vi.advanceTimersByTime(250); // let the regen debounce fire — it must find nothing missing

  expect(fakeViewers[0].setSubPose).toHaveBeenCalledWith("body", expect.any(Array));
  expect(workers.manifold.postMessage.mock.calls.length).toBe(jobsBefore); // no new job
  handle.dispose();
  vi.useRealTimers();
});

test("a geometry param edit still sends a build job", async () => {
  vi.useFakeTimers();
  const { workers, createWorker } = makeWorkers();
  const handle = mount(makePart(), { createWorker, elements: makeElements() });
  finishFirstBuild(workers);
  const jobsBefore = workers.manifold.postMessage.mock.calls.length;

  const height = document.querySelectorAll('input[type="range"]')[0];
  height.value = "6";
  height.dispatchEvent(new Event("input", { bubbles: true }));
  vi.advanceTimersByTime(250);

  const jobs = workers.manifold.postMessage.mock.calls.slice(jobsBefore).map(([m]) => m);
  expect(jobs.some((m) => m.type === "generate")).toBe(true);
  handle.dispose();
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/framework/mount.test.js`
Expected: the pose-only test FAILS (`setSubPose` never called; a generate job IS sent). The geometry test may already pass — that's fine, it pins the fallback.

- [ ] **Step 3: Wire mount** — in `src/framework/mount.js`:

1. Import: `import { createPoseFastPath } from "./pose-fast-path.js";`
2. After the `createRegenLoop` block (the `loop` const, ~line 206), create the fast path (same lazy-getter pattern as `createMeshCache` above it):

```js
    // Pose fast path (Layer 0): a param edit that only re-poses a subpart is
    // repaired synchronously in the viewer — no debounce, no worker job.
    const fastPath = createPoseFastPath(part, viewer, cache, {
      params, getView: view, getParamsVersion: () => loop.version(),
    });
```

3. In the `meshes` handler, after `cache.record(m.name);` add:

```js
              fastPath.recordDelivered(m.name);
```

4. In `onParamChange`:

```js
    function onParamChange() {
      loop.markDirty(); // bump the version first: refreshView below must see the parts as stale
      lastGen.posed = fastPath.repair(); // pose-only edits: re-posed + re-stamped current, no job
      if (lastGen.posed) dbg?.update({ posed: lastGen.posed });
      refreshView();    // keep showing the now-stale mesh (no flicker); disable export
      updateRelevance();
    }
```

5. `lastGen` initialization gains the field: `let lastGen = { skipped: 0, rebuilt: 0, posed: 0 };` and the meshes-handler `dbg?.update({ ... })` call passes `posed: lastGen.posed` alongside `skipped`/`rebuilt` (then resets `lastGen.posed = 0`).

- [ ] **Step 4: Show it in the overlay** — `src/framework/debug-overlay.js` `update()`:

```js
    update({ ms, hits = 0, misses = 0, skipped = 0, rebuilt = 0, posed = 0 } = {}) {
      const l2 = cb.checked ? `${hits} hit / ${misses} miss` : "off";
      // …existing lines…
        `L1 parts: ${skipped} skipped / ${rebuilt} rebuilt / ${posed} posed`;
```

(Adapt to the exact surrounding template in the file; only the `posed` addition is new. Check `test/debug-overlay.test.js` for assertions on this string and update them.)

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/framework/mount.test.js test/debug-overlay.test.js`
Expected: PASS.

- [ ] **Step 6: Full suite**

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/framework/mount.js src/framework/debug-overlay.js test/framework/mount.test.js
git commit -m "feat(mount): wire the pose fast path — pose-only edits skip the worker"
```

---

### Task 6: `setParams(partial)` public hook + controls sync

**Files:**
- Modify: `src/framework/controls.js` (expose `syncValues`)
- Modify: `src/framework/mount.js` (`setParams`, `makeHandle`)
- Test: `test/framework/controls.test.js` (extend), `test/framework/mount.test.js` (extend)

**Interfaces:**
- Consumes: `onParamChange` and the fast path from Task 5.
- Produces: `buildControls(...)` return gains `syncValues(keys?: string[])` — re-reads `params` into the control widgets (all keys, or just the named ones). The mount handle gains `setParams(partial: object): void` — merge params, sync UI, run the normal change path (which includes the fast path). `makeHandle` signature becomes `makeHandle({ ready, dispose, viewer, setParams })`.

- [ ] **Step 1: Write the failing tests.**

In `test/framework/controls.test.js` (follow the file's existing setup style for building a panel):

```js
test("syncValues re-reads params into the widgets", () => {
  const params = { h: 4 };
  const root = document.createElement("div");
  const panel = buildControls(root, [
    { id: "s", title: "S", advanced: [{ key: "h", label: "H", min: 1, max: 10, step: 1 }] },
  ], params, () => {});
  params.h = 7; // programmatic change (setParams path)
  panel.syncValues(["h"]);
  expect(root.querySelector('input[type="range"]').value).toBe("7");
  expect(root.querySelector('input[type="number"]').value).toBe("7");
  panel.dispose();
});
```

In `test/framework/mount.test.js`:

```js
test("setParams applies the fast path synchronously and syncs the panel", () => {
  const { workers, createWorker } = makeWorkers();
  const els = makeElements();
  const handle = mount(makePart(), { createWorker, elements: els });
  finishFirstBuild(workers);
  const jobsBefore = workers.manifold.postMessage.mock.calls.length;

  handle.setParams({ tilt: 60 });

  expect(fakeViewers[0].setSubPose).toHaveBeenCalledWith("body", expect.any(Array));
  expect(workers.manifold.postMessage.mock.calls.length).toBe(jobsBefore); // synchronous, no job
  expect(els.controls.querySelectorAll('input[type="range"]')[1].value).toBe("60"); // UI synced
  handle.dispose();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/framework/controls.test.js test/framework/mount.test.js`
Expected: FAIL — `syncValues` / `setParams` are not functions.

- [ ] **Step 3: Implement `syncValues`** — in `src/framework/controls.js`:

1. In `buildControls`, collect syncs across sections:

```js
  const syncFns = []; // { key, sync } for every widget that can re-read params
```

and extend the per-section `register` to accept one: `const register = (key, node, sync) => { controls.push({ key, el: node }); keys.add(key); if (sync) syncFns.push({ key, sync }); };`

2. Pass a sync at each register site:
   - `buildPresetSection` toggles: `register(t.key, row, () => { box.checked = params[t.key] > 0; });`
   - `buildPresetSection` advanced sliders: `register(def.key, s.wrap, s.sync);`
   - `buildFeatureSection` feature checkbox: `register(feat.key, checkRow, () => { box.checked = params[feat.key] > 0; group.classList.toggle("hidden", !box.checked); });`
   - `buildFeatureSection` sliders: `register(def.key, s.wrap, s.sync);`

3. Return it:

```js
  return {
    applyRelevance: (relevant) => applyRelevance(relevant, controls, sections),
    // Re-read params into the widgets — all of them, or just `keys`. The
    // programmatic twin of a user edit (setParams); never fires onDirty.
    syncValues: (keys) => {
      const only = keys && new Set(keys);
      for (const { key, sync } of syncFns) if (!only || only.has(key)) sync();
    },
    dispose: () => { info.dispose(); root.replaceChildren(); },
  };
```

- [ ] **Step 4: Implement `setParams`** — in `src/framework/mount.js`:

1. After `onParamChange` is defined:

```js
    // Programmatic param entry point — the animation-system hook. Same change
    // path as a slider edit: pose-only changes repair synchronously (no worker
    // job, no debounce); geometry changes fall through to the regen loop.
    function setParams(partial) {
      Object.assign(params, partial);
      panel.syncValues(Object.keys(partial));
      onParamChange();
    }
```

2. `return makeHandle({ ready, dispose, viewer, setParams });` and:

```js
export function makeHandle({ ready, dispose, viewer, setParams }) {
  return { ready, dispose, setParams, captureViews: (viewNames) => viewer.captureCanonicalViews(viewNames) };
}
```

(Check for an existing `makeHandle` shape test in the suite — `grep -rn makeHandle test/` — and extend it.)

3. Update the mount() doc comment (lines ~55-64) with one line: `//   runtime.setParams({ openAngle: 45 }); // programmatic edit; pose-only changes apply instantly`

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/framework/controls.test.js test/framework/mount.test.js`
Expected: PASS.

- [ ] **Step 6: Full suite**

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/framework/controls.js src/framework/mount.js test/framework/controls.test.js test/framework/mount.test.js
git commit -m "feat(mount): setParams(partial) — programmatic edits with the pose fast path"
```

---

### Task 7: End-to-end verification + docs

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (one sentence), `docs/superpowers/specs/2026-07-27-pose-fast-path-design.md` (status)

- [ ] **Step 1: Full suite**

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 2: All three real-browser smoke checks**

Run: `node scripts/check-app.mjs demo.html && node scripts/check-app.mjs planter.html && node scripts/check-app.mjs filleted-box.html`
Expected: each prints `booted: true … errors: 0`.

- [ ] **Step 3: Manual fast-path verification against the real Hinged Box part.** The part source lives in the session scratchpad from the earlier investigation (`<scratchpad>/hinged-box/part.js`); if missing, re-fetch via `curl "https://partforge-cloud.vercel.app/api/part?id=c7cc71e9-e334-4c98-9ac6-a6b0ceb4d092"` (the `head.tree.files["part.js"]` field). Wire it as a dev app (copy the three glue files from `filleted-box`), run `npm run dev`, open `?debug`, and drag "Lid open angle": the overlay must show `posed` counts with NO generate spinner, and the lid must visibly swing. Drag "Wall thickness": normal regenerate. Delete the temporary glue files afterwards (they must not land in the commit).

- [ ] **Step 4: Docs.** In `docs/AUTHORING-PARTS.md`, the "Caching & determinism" section's pose paragraph (added by PR #73) gets one closing sentence: `In the app, such pose-only edits skip the worker entirely — the viewer re-poses the cached mesh — so they stay smooth even at animation rates (see runtime.setParams).` In the spec, flip `**Status:** approved` to `**Status:** implemented`.

- [ ] **Step 5: Commit + push + PR**

```bash
git add docs/AUTHORING-PARTS.md docs/superpowers/specs/2026-07-27-pose-fast-path-design.md
git commit -m "docs: pose fast path — authoring note + spec status"
git push -u origin claude/pose-fast-path
```

Then open a PR with `gh pr create --base main` (title: "Instant pose drags: viewer-side fast path + setParams hook"), noting in the body that it stacks on PR #73 and should merge after it (or be retargeted onto main once #73 lands). PR description per the user's GitHub-tone preferences: plain-language summary, "what this means in practice" list, dependencies note at the end.
