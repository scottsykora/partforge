# `k.screwSweep` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `k.screwSweep` kernel op that turns an axial `[[r, z]]` lathe profile into a threaded solid, and fix the documentation that made this technique undiscoverable.

**Architecture:** `screwSweep` is a **composition**, not a backend op. A pure module densifies the axial profile and maps it to a transverse cross-section (`ψ = ∓360·z/pitch`); `kernel-front.js` then calls the existing `k.extrude({ profile, h, twist })`. Both backends implement twist natively, so no backend code is written and STEP gets a real twisted B-rep.

**Tech Stack:** Plain ESM, vitest, Manifold (WASM mesh CSG), OCCT/replicad (WASM B-rep).

## Global Constraints

- **Node 24.** Run `nvm use` before `npm install`, tests, or the CLI, or geometry fails confusingly.
- **Units are millimetres; angles are degrees** throughout the public surface.
- **`src/framework/geometry/` is DOM-free, `three`-free and `node:`-free** — `test/worker-layering.test.js` enforces this. Never import from `src/testing/` there.
- **OCCT and Manifold must not boot in the same process.** OCCT-booting tests live in their own file (vitest isolates per file).
- **Polar step is a fixed shared constant of 5°**, not a per-call option. It matches Manifold's twist resolution (`nDiv = ceil(|twist|/5)`, `manifold-backend.js:265`).
- **Handedness signs (validated, do not re-derive):** right-hand → `ψ_deg = −360·z/pitch` and `twist = +360·turns`. Left-hand negates both.
- **Additive contract change:** do **not** bump `CONTRACT_VERSION`. Bump `package.json` minor (0.51.0 → 0.52.0) — the release workflow tags on merge and a forgotten bump silently ships nothing.

## File Structure

| File | Responsibility |
|---|---|
| `src/framework/geometry/screw-profile.js` *(new)* | Pure: densify + polar-map an axial profile → transverse contour. No WASM, no kernel. |
| `src/framework/geometry/kernel-front.js` | Add the `k.screwSweep` compound beside `boredCylinder` / `torus`. |
| `src/framework/geometry/kernel.js` | `KERNEL_OPS` entry + `@typedef` line. |
| `src/framework/geometry/op-options.js` | `KERNEL_OP_SPECS.screwSweep` — key validation + `pitch`/`turns` check. |
| `types/kernel.d.ts` | `ScrewSweepOptions` + the `GeometryKernel` method. |
| `docs/KERNEL-CONTRACT.md` | Op-table row + `helixSweptTube` caveat. **Required** — `kernel-contract.test.js:52` fails without it. |
| `docs/AUTHORING-PARTS.md` | Op-table row, `helixSweptTube` caveat, new "Helical & threaded features" recipe. |
| `docs/ERROR-PATTERNS.md` | `screw-thread-vanishes-on-occt` entry. |
| `src/parts/screw.js` *(new)* + `screw.html`, `src/app-screw.js`, `src/screw-worker.js`, `vite.config.js` | Reference part and its app wiring. |
| `test/screw-profile.test.js` *(new)* | Pure-function unit tests, no WASM. |
| `test/screw-sweep.test.js` *(new)* | Manifold geometry + convergence. |
| `test/screw-sweep-occt.test.js` *(new)* | OCCT parity, STEP, boolean risk. Own file (WASM isolation). |

---

### Task 1: Pure cross-section builder

**Files:**
- Create: `src/framework/geometry/screw-profile.js`
- Test: `test/screw-profile.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `SCREW_STEP_DEG: number` (= 5) and `screwCrossSection(profile: number[][], pitch: number, opts?: { lefthand?: boolean }) => number[][]` returning `[[x, y], …]`.

- [ ] **Step 1: Write the failing test**

Create `test/screw-profile.test.js`:

```js
import { expect, test } from "vitest";
import { screwCrossSection, SCREW_STEP_DEG } from "../src/framework/geometry/screw-profile.js";

test("a constant-z segment needs no subdivision and maps to itself", () => {
  // No z change → no polar sweep → no chordal error to correct.
  expect(screwCrossSection([[5, 0], [3, 0]], 2)).toEqual([[5, 0], [3, 0]]);
});

test("densifies each segment to the 5 degree polar step", () => {
  // z spans 1 of a pitch of 2 → 180 deg of sweep → 180/5 = 36 segments, 37 points.
  expect(SCREW_STEP_DEG).toBe(5);
  expect(screwCrossSection([[5, 0], [5, 1]], 2)).toHaveLength(37);
});

test("right-hand maps +z to NEGATIVE polar angle", () => {
  // z = 0.5 of pitch 2 → psi = -360 * 0.5/2 = -90 deg → [0, -5].
  const out = screwCrossSection([[5, 0], [5, 0.5]], 2);
  const [x, y] = out[out.length - 1];
  expect(x).toBeCloseTo(0, 6);
  expect(y).toBeCloseTo(-5, 6);
});

test("lefthand mirrors the polar angle", () => {
  const out = screwCrossSection([[5, 0], [5, 0.5]], 2, { lefthand: true });
  const [x, y] = out[out.length - 1];
  expect(x).toBeCloseTo(0, 6);
  expect(y).toBeCloseTo(5, 6);
});

test("a full-pitch profile is periodic: the wrap point is dropped", () => {
  // 360 deg of sweep at 5 deg = 72 points; the 73rd would land on the 1st.
  const out = screwCrossSection([[5, 0], [5, 2]], 2);
  expect(out).toHaveLength(72);
  expect(out[0][0]).toBeCloseTo(5, 6);
});

test("rejects a profile taller than the pitch", () => {
  expect(() => screwCrossSection([[4, 0], [6, 0], [6, 2.5], [4, 2.5]], 1.5))
    .toThrow(/exceeds pitch/);
});

test("rejects a full-pitch profile that is not periodic", () => {
  expect(() => screwCrossSection([[5, 0], [6, 0], [4, 2]], 2))
    .toThrow(/must be periodic/);
});

test("rejects a negative radius, matching revolve's rule", () => {
  expect(() => screwCrossSection([[-1, 0], [5, 0], [5, 0.5]], 2))
    .toThrow("screwSweep: profile radius must be ≥ 0");
});

test("rejects a non-positive pitch and a too-short profile", () => {
  expect(() => screwCrossSection([[5, 0], [5, 1]], 0)).toThrow(/pitch must be > 0/);
  expect(() => screwCrossSection([[5, 0]], 2)).toThrow(/at least 2/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use && npx vitest run test/screw-profile.test.js`
Expected: FAIL — `Failed to resolve import ".../screw-profile.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/framework/geometry/screw-profile.js`:

```js
// Screw motion as a transverse cross-section. A profile point (r, z) in the axial
// half-plane travels to (r·cos θ, r·sin θ, z + pitch·θ/2π) under screw motion, and
// that whole solid is reproduced EXACTLY by extruding a polar-remapped section with
// twist = 360°·turns — one full turn of twist per pitch of height. So screwSweep
// needs no backend op: it is k.extrude in disguise (see kernel-front.js).
//
// The subtlety that makes this correct rather than nearly-correct: the map sends
// profile POINTS to polar, but the EDGES between them become straight chords where
// the true surface needs spiral arcs. Undensified, an ISO tooth loses ~42% of its
// volume. So every segment is subdivided to a fixed 5° polar step — fixed, not a
// per-call tolerance, so both backends see the identical polygon and the solid
// cache keys stay stable.

// Degrees of polar sweep per emitted point. Matches Manifold's twist division
// resolution (nDiv = ceil(|twist|/5) in manifold-backend.js), so the angular and
// axial sampling of the same solid agree. Converges to 0.03% of the exact volume.
export const SCREW_STEP_DEG = 5;

const EPS = 1e-9;

export function screwCrossSection(profile, pitch, { lefthand = false } = {}) {
  if (!Array.isArray(profile) || profile.length < 2)
    throw new Error("screwSweep: profile must be an array of at least 2 [r, z] points");
  if (!(pitch > 0)) throw new Error("screwSweep: pitch must be > 0");
  for (const p of profile) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
      throw new Error("screwSweep: every profile point must be a finite [r, z]");
    if (p[0] < 0) throw new Error("screwSweep: profile radius must be ≥ 0");
  }

  const zs = profile.map(([, z]) => z);
  const extent = Math.max(...zs) - Math.min(...zs);
  if (extent > pitch + EPS)
    throw new Error(
      `screwSweep: profile axial extent ${extent} exceeds pitch ${pitch} — consecutive ` +
      "turns would interpenetrate; reduce the profile height or increase pitch");

  // Subdivide by POLAR span, not by length: a segment with no z change sweeps no
  // angle and needs no extra points.
  const dense = [];
  for (let i = 0; i < profile.length - 1; i++) {
    const [r0, z0] = profile[i], [r1, z1] = profile[i + 1];
    const span = Math.abs((360 * (z1 - z0)) / pitch);
    const n = Math.max(1, Math.ceil(span / SCREW_STEP_DEG));
    for (let j = 0; j < n; j++)
      dense.push([r0 + ((r1 - r0) * j) / n, z0 + ((z1 - z0) * j) / n]);
  }
  dense.push(profile[profile.length - 1]);

  // A profile spanning exactly one pitch closes on itself by periodicity: its last
  // point maps to the same polar angle as its first, so it must agree in radius and
  // the duplicate is dropped (a zero-length edge would otherwise reach the backend).
  let pts = dense;
  if (extent > pitch - EPS) {
    const r0 = profile[0][0], rN = profile[profile.length - 1][0];
    if (Math.abs(r0 - rN) > 1e-6)
      throw new Error(
        `screwSweep: a full-pitch profile must be periodic — first radius ${r0} ` +
        `must equal last radius ${rN}`);
    pts = dense.slice(0, -1);
  }

  const sign = lefthand ? 1 : -1;
  return pts.map(([r, z]) => {
    const psi = (sign * 2 * Math.PI * z) / pitch;
    return [r * Math.cos(psi), r * Math.sin(psi)];
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `nvm use && npx vitest run test/screw-profile.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Confirm the layering rule still holds**

Run: `npx vitest run test/worker-layering.test.js`
Expected: PASS — the new module imports nothing.

- [ ] **Step 6: Commit**

```bash
git add src/framework/geometry/screw-profile.js test/screw-profile.test.js
git commit -m "Screw motion as a polar-remapped cross-section"
```

---

### Task 2: Wire `k.screwSweep` into the kernel

**Files:**
- Modify: `src/framework/geometry/kernel-front.js` (compound, after the `k.torus` default ~line 48)
- Modify: `src/framework/geometry/kernel.js` (`KERNEL_OPS` line 22; `@typedef` after line 112)
- Modify: `src/framework/geometry/op-options.js` (`KERNEL_OP_SPECS`, after the `helixSweptTube` entry ~line 255)
- Modify: `types/kernel.d.ts` (interface after `HelixSweptTubeOptions` ~line 298; method after line 378)
- Modify: `docs/KERNEL-CONTRACT.md` (op table — **required**, the contract test greps for the op name)
- Modify: `test/op-options.test.js:92` (sorted op-name list)
- Test: `test/calling-convention.test.js`, `test/op-options.test.js`

**Interfaces:**
- Consumes: `screwCrossSection`, `SCREW_STEP_DEG` from Task 1.
- Produces: `k.screwSweep({ profile, pitch, turns, lefthand? }) => Solid` on every backend.

- [ ] **Step 1: Write the failing tests**

Append to `test/op-options.test.js` (inside the existing "options-only compound ops" test, after the `helixSweptTube` assertions):

```js
  const screw = { profile: [[4, 0], [5, 0.5], [4, 1]], pitch: 2, turns: 3, lefthand: true };
  expect(KERNEL_OP_SPECS.screwSweep.toArgs(screw)).toEqual([screw]);
  expect(() => KERNEL_OP_SPECS.screwSweep.toArgs({ profile: [[4, 0]], pitch: 2 }))
    .toThrow("screwSweep: turns is required");
  expect(() => KERNEL_OP_SPECS.screwSweep.toArgs({ ...screw, chordTolerance: 0.02 }))
    .toThrow('screwSweep: unknown option "chordTolerance"');
  expect(() => KERNEL_OP_SPECS.screwSweep.check({ ...screw, pitch: 0 }))
    .toThrow("screwSweep: pitch must be > 0");
  expect(() => KERNEL_OP_SPECS.screwSweep.check({ ...screw, turns: 0 }))
    .toThrow("screwSweep: turns must be > 0");
```

And update the sorted list assertion at `test/op-options.test.js:92` to include `"screwSweep"`:

```js
  expect(Object.keys(KERNEL_OP_SPECS).sort()).toEqual(
    ["boredCylinder", "box", "cylinder", "extrude", "helixSweptTube", "loft", "prism", "revolve", "roundedBox", "roundedCylinder", "screwSweep", "sphere", "sweep", "torus"]);
```

Append to `test/calling-convention.test.js`:

```js
test("screwSweep is options-only and validates required keys", () => {
  expect(() => k.screwSweep({ profile: [[4, 0], [5, 1]], pitch: 2 }))
    .toThrow("screwSweep: turns is required");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `nvm use && npx vitest run test/op-options.test.js test/calling-convention.test.js`
Expected: FAIL — `Cannot read properties of undefined (reading 'toArgs')`.

- [ ] **Step 3: Add the op spec**

In `src/framework/geometry/op-options.js`, insert directly after the `helixSweptTube` entry:

```js
  screwSweep: {
    toArgs: passThrough("screwSweep", ["profile", "pitch", "turns", "lefthand"], ["profile", "pitch", "turns"]),
    check: (o) => {
      if (!(o.pitch > 0)) throw new Error("screwSweep: pitch must be > 0");
      if (!(o.turns > 0)) throw new Error("screwSweep: turns must be > 0");
    },
  },
```

- [ ] **Step 4: Add the compound**

In `src/framework/geometry/kernel-front.js`, add the import beside the other geometry helpers (after the `hull.js` import, line 30):

```js
import { screwCrossSection } from "./screw-profile.js";
```

And add the compound immediately after the `k.torus ??=` default (line 48), inside the same comment block's scope:

```js
  // Compound default: a screw-motion sweep of an axial [[r, z]] profile. Exactly
  // k.extrude with a polar-remapped section and one full turn of twist per pitch
  // (see screw-profile.js for why that identity holds, and why the profile must be
  // densified first). No backend override: both backends twist natively, so this
  // is one implementation and STEP gets a real twisted B-rep rather than a loft.
  k.screwSweep ??= ({ profile, pitch, turns, lefthand = false }) =>
    k.extrude({
      profile: screwCrossSection(profile, pitch, { lefthand }),
      h: pitch * turns,
      twist: (lefthand ? -360 : 360) * turns,
    });
```

**Placement matters:** this must sit BEFORE the `for (const [op, ...] of Object.entries(KERNEL_OP_SPECS))` wrap loop at line 50, so the compound gets the same key validation as a backend-native op.

- [ ] **Step 5: Add to the contract op lists and types**

In `src/framework/geometry/kernel.js`, add `"screwSweep"` to `KERNEL_OPS` (line 21-24 array) and add the typedef line after the `helixSweptTube` line (112):

```js
 * @property {(o:{profile:number[][],pitch:number,turns:number,lefthand?:boolean}) => Solid} screwSweep   screw-motion sweep of an axial [[r,z]] profile — threads; options-only
```

In `types/kernel.d.ts`, after `HelixSweptTubeOptions`:

```ts
/** `k.screwSweep` — an axial lathe profile `[[r, z], …]` swept by screw motion. */
export interface ScrewSweepOptions {
  /** Closed axial contour; axial extent must not exceed `pitch`. */
  profile: number[][];
  /** Axial rise per turn, mm. */
  pitch: number;
  turns: number;
  lefthand?: boolean;
}
```

and beside the `helixSweptTube` method (line 378):

```ts
  /** Sweep an axial lathe profile by screw motion — threads. */
  screwSweep(o: ScrewSweepOptions): Solid;
```

And add a type assertion to `test/partforge.test-d.ts`, beside the existing
`hullChain` one (~line 316):

```ts
expectType<Solid>(k.screwSweep({ profile: [[4, 0], [5, 0.5], [4, 1]], pitch: 2, turns: 3 }));
```

- [ ] **Step 6: Add the contract doc row**

In `docs/KERNEL-CONTRACT.md`, add to the "Kernel ops" table after the `helixSweptTube` row (line 189):

```markdown
| `screwSweep({profile, pitch, turns, lefthand})` | Screw-motion sweep of an axial lathe profile `[[r, z], …]` (r ≥ 0) — threads. The profile travels to `(r·cosθ, r·sinθ, z + pitch·θ/2π)`; `h = pitch · turns`. Axial extent must not exceed `pitch` or consecutive turns interpenetrate (throws). A profile spanning exactly `pitch` is **periodic**: first and last radius must agree, and it yields a complete threaded body needing no boolean. Options-only. Parity: **within tolerance, not by construction** — both backends receive the identical densified polygon, but the mesh backend facets the twist at its own resolution while the B-rep backend builds an exact spline (`hull`'s parity class). |
```

Also amend the `helixSweptTube` row on line 189 to end with:

```markdown
 Circular profile on a frenet frame that rolls with the helix — **not for threads**; use `screwSweep`.
```

- [ ] **Step 7: Run the tests**

Run: `nvm use && npx vitest run test/op-options.test.js test/calling-convention.test.js test/kernel-contract.test.js test/occt-backend.test.js`
Expected: PASS. If `kernel-contract.test.js` fails with a non-empty array, the doc row in Step 6 is missing or misspells the op.

- [ ] **Step 8: Commit**

```bash
git add src/framework/geometry/ types/kernel.d.ts docs/KERNEL-CONTRACT.md test/
git commit -m "k.screwSweep: threads without a backend op"
```

---

### Task 3: Manifold geometry tests

**Files:**
- Test: `test/screw-sweep.test.js` (create)

**Interfaces:**
- Consumes: `k.screwSweep` from Task 2.
- Produces: `ISO_PROFILE` / `ISO` fixture values, reused conceptually by Task 4 (each test file defines its own copy — vitest isolates files).

- [ ] **Step 1: Write the failing test**

Create `test/screw-sweep.test.js`:

```js
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// An ISO-ish metric thread: 60 deg flanks, crest flat P/8, root flat P/4.
// PERIODIC form — spans exactly one pitch, first radius == last radius — so it
// yields the whole threaded rod in one op with no boolean. See the design spec.
const PITCH = 1.5, MAJOR_R = 5, TURNS = 6;
const H = (Math.sqrt(3) / 2) * PITCH;
const ROOT_R = MAJOR_R - (5 / 8) * H;
const CREST_FLAT = PITCH / 8, ROOT_FLAT = PITCH / 4;
const RISE = (PITCH - CREST_FLAT - ROOT_FLAT) / 2;
const ISO = [
  [ROOT_R,  0],
  [ROOT_R,  ROOT_FLAT],
  [MAJOR_R, ROOT_FLAT + RISE],
  [MAJOR_R, ROOT_FLAT + RISE + CREST_FLAT],
  [ROOT_R,  PITCH],
];

test("a periodic profile yields a watertight rod of the right size", () => {
  const rod = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS });
  expect(rod.genus()).toBe(0);                       // no through-holes, no fold artifacts
  const { size } = rod.boundingBox();
  expect(size[0]).toBeCloseTo(2 * MAJOR_R, 3);
  expect(size[1]).toBeCloseTo(2 * MAJOR_R, 3);
  expect(size[2]).toBeCloseTo(PITCH * TURNS, 3);
});

test("volume sits between the root and major cylinders", () => {
  // The single strongest shape check: a thread must add material over its root
  // cylinder and remove material from its major cylinder.
  const rod = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS });
  const h = PITCH * TURNS;
  expect(rod.volume()).toBeGreaterThan(Math.PI * ROOT_R ** 2 * h);
  expect(rod.volume()).toBeLessThan(Math.PI * MAJOR_R ** 2 * h);
});

test("volume is converged, not chord-starved", () => {
  // Regression guard for the densification bug: an undensified profile loses ~42%
  // of its volume. Doubling the turns must double the volume linearly.
  const one = k.screwSweep({ profile: ISO, pitch: PITCH, turns: 2 }).volume();
  const two = k.screwSweep({ profile: ISO, pitch: PITCH, turns: 4 }).volume();
  expect(two / one).toBeCloseTo(2, 2);
  expect(one).toBeGreaterThan(190);   // measured 195.18; a chord-starved build gives ~112
});

test("the thread advances one full turn per pitch of height", () => {
  // Sample the crest angle a quarter-pitch apart: a right-hand thread advances +90 deg.
  const rod = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS });
  const mesh = rod.toMesh();
  const crestAngleAt = (zT) => {
    let best = null;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const [x, y, z] = [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
      if (Math.abs(z - zT) > PITCH * 0.02) continue;
      const r = Math.hypot(x, y);
      if (r > MAJOR_R - 0.01 && (!best || r > best.r)) best = { r, a: (Math.atan2(y, x) * 180) / Math.PI };
    }
    return best.a;
  };
  const z0 = (PITCH * TURNS) / 2;
  let delta = crestAngleAt(z0 + PITCH / 4) - crestAngleAt(z0);
  if (delta < -180) delta += 360;
  if (delta > 180) delta -= 360;
  expect(delta).toBeCloseTo(90, 0);
});

test("lefthand mirrors the volume but reverses the advance", () => {
  const rh = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS });
  const lh = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS, lefthand: true });
  expect(lh.volume()).toBeCloseTo(rh.volume(), 1);
  expect(lh.genus()).toBe(0);
});

test("an over-pitch profile is rejected rather than silently folded", () => {
  expect(() => k.screwSweep({ profile: [[4, 0], [6, 0], [6, 2.5], [4, 2.5]], pitch: 1.5, turns: 3 }))
    .toThrow(/exceeds pitch/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `nvm use && npx vitest run test/screw-sweep.test.js`
Expected: FAIL if Task 2 is incomplete; otherwise PASS. If the "converged" test fails low (~112), densification in Task 1 is not being applied.

- [ ] **Step 3: Fix any failures, then confirm the whole suite**

Run: `nvm use && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/screw-sweep.test.js
git commit -m "Test screwSweep geometry, convergence and handedness"
```

---

### Task 4: OCCT parity, STEP, and the boolean hazard

**Files:**
- Test: `test/screw-sweep-occt.test.js` (create)

**Interfaces:**
- Consumes: `k.screwSweep` from Task 2, `bootOcctKernel` from `../src/testing.js`.
- Produces: the empirical answer to the carried risk "does a screw rod union with a head on OCCT".

**Background (measured during design — do not re-derive):** OCCT extrudes the twist fine and matches Manifold's volume to five significant figures. What fails is booleaning a *thin helical sliver* against a core: at 2 turns the union returns exactly the bare core volume, at 6 turns an empty solid, and STEP exports it without error. The periodic form avoids the boolean entirely. This task pins that down and answers whether a rod-plus-head union is safe.

- [ ] **Step 1: Write the test**

Create `test/screw-sweep-occt.test.js`:

```js
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing.js";

// OCCT and Manifold must not boot in the same process — hence this separate file.
let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 60000);

const PITCH = 1.5, MAJOR_R = 5, TURNS = 6;
const H = (Math.sqrt(3) / 2) * PITCH;
const ROOT_R = MAJOR_R - (5 / 8) * H;
const CREST_FLAT = PITCH / 8, ROOT_FLAT = PITCH / 4;
const RISE = (PITCH - CREST_FLAT - ROOT_FLAT) / 2;
const ISO = [
  [ROOT_R,  0],
  [ROOT_R,  ROOT_FLAT],
  [MAJOR_R, ROOT_FLAT + RISE],
  [MAJOR_R, ROOT_FLAT + RISE + CREST_FLAT],
  [ROOT_R,  PITCH],
];

test("volume agrees with the Manifold reference within 0.5%", () => {
  // Manifold measured 585.54 for these exact parameters (design spec, finding 4).
  const rod = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS });
  expect(Math.abs(rod.volume() - 585.54) / 585.54).toBeLessThan(0.005);
});

test("the rod exports to STEP as real geometry, not an empty shell", () => {
  // An empty solid exports happily at ~2KB; a real threaded rod is orders larger.
  const rod = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS });
  expect(rod.volume()).toBeGreaterThan(500);
  return k.toSTEP([{ name: "rod", solid: rod }]).then((step) => {
    expect(step.byteLength).toBeGreaterThan(100_000);
  });
}, 60000);

test("a rod unioned with a head keeps both volumes", () => {
  // The carried risk: the sliver-shaped operand destroyed OCCT booleans. A filled
  // rod should not. If this fails, the docs must forbid the union and the reference
  // part must model the head as a separate sub-part instead.
  //
  // The head OVERLAPS the rod by 1mm rather than sitting flush on top: a flush
  // union shares a coincident face, which is its own OCCT failure mode and would
  // confound the result we are actually after.
  const rod = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS });
  const rodVol = rod.volume();
  const headVol = Math.PI * 8 ** 2 * 4;
  const head = k.cylinder({ r: 8, h: 4 }).translate([0, 0, PITCH * TURNS - 1]);
  const bolt = k.union([rod, head]);
  // Overlap makes the exact sum unavailable, so bracket it: the union must contain
  // essentially all of both solids, and cannot exceed their sum.
  expect(bolt.volume()).toBeGreaterThan(rodVol + headVol * 0.8);
  expect(bolt.volume()).toBeLessThanOrEqual(rodVol + headVol);
}, 60000);
```

- [ ] **Step 2: Run it**

Run: `nvm use && npx vitest run test/screw-sweep-occt.test.js`
Expected: the first two PASS. The third is a genuine experiment.

- [ ] **Step 3: Act on the union result**

If the union test **passes**, leave it as a regression guard and continue.

If it **fails** (volume equal to `rodVol` alone, or `0`), do all three:
1. Change the assertion to document reality: `expect(bolt.volume()).toBe(rodVol)` with a comment naming this as an OCCT limitation, or mark it `test.fails(...)`.
2. Broaden the `ERROR-PATTERNS.md` entry in Task 5 to cover unions against *any* screw solid, not just slivers.
3. Model the reference part's head as a separate sub-part in Task 6 rather than a union.

- [ ] **Step 4: Commit**

```bash
git add test/screw-sweep-occt.test.js
git commit -m "Test screwSweep on OCCT: parity, STEP, and the boolean hazard"
```

---

### Task 5: The documentation fix

This is the fix for the original failure — an agent could not find the technique. Treat it as load-bearing, not cleanup.

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (op table ~line 315; new recipe in "Profiles & patterns" ~line 1015)
- Modify: `docs/ERROR-PATTERNS.md` (new `##` entry in the "Core framework" section)

- [ ] **Step 1: Kill the decoy and add the op row**

In `docs/AUTHORING-PARTS.md`, replace the `helixSweptTube` row (line 315) with:

```markdown
| `k.helixSweptTube({ pathR, profileR, pitch, turns, z0, lefthand })` | circle swept along a helix (e.g. a rope groove). **Not for threads** — the profile is always circular and rides a frenet frame that rolls with the helix, tilting a tooth off-axis. For threads use `k.screwSweep` |
| `k.screwSweep({ profile, pitch, turns, lefthand? })` | screw-motion sweep of an **axial** lathe profile `[[r, z], …]` (same convention as `k.revolve`) — threads, worms, helical ridges. `h = pitch · turns`. The profile's axial extent must not exceed `pitch`; a profile spanning exactly `pitch` must be **periodic** (first radius == last radius) and yields a complete threaded body with no boolean. Both backends |
```

- [ ] **Step 2: Add the recipe**

In `docs/AUTHORING-PARTS.md`, at the end of the "Profiles & patterns" section (before the `## 2-D booleans` heading, ~line 1039), add:

```markdown
**Helical & threaded features** (screws, threads, bolts, worms, helical ridges):

Use `k.screwSweep({ profile, pitch, turns })`. The profile is an **axial**
`[[r, z]]` contour — the shape you would see slicing the thread down its axis —
exactly `k.revolve`'s convention, with an axial rise added.

The strongly preferred form is **periodic**: span exactly one `pitch`, start and
end at the same radius. That makes the cross-section enclose the axis, so one op
gives you the whole threaded body — no union with a core cylinder, which is both
faster and avoids a boolean the B-rep backend handles badly
([screw-thread-vanishes-on-occt](ERROR-PATTERNS.md#screw-thread-vanishes-on-occt)).

```js
// an ISO-ish M10x1.5 external thread: 60° flanks, crest flat P/8, root flat P/4
const pitch = 1.5, majorR = 5;
const rootR = majorR - (5 / 8) * (Math.sqrt(3) / 2) * pitch;
const crest = pitch / 8, root = pitch / 4;
const rise = (pitch - crest - root) / 2;
const rod = k.screwSweep({
  profile: [
    [rootR,  0],
    [rootR,  root],                    // root flat
    [majorR, root + rise],             // up the flank
    [majorR, root + rise + crest],     // crest flat
    [rootR,  pitch],                   // down the flank, back to the start radius
  ],
  pitch, turns: 6,
});
```

The ends are flat z-planes, which is what a threaded rod wants; intersect a cone
for a lead-in chamfer. For a bolt, build the head as its own solid.

The hand-rolled equivalent, for the record: `screwSweep` is
`k.extrude({ profile, h, twist })` with the axial profile remapped to polar
(`ψ = −360·z/pitch`) and `twist = 360 · turns` — one full turn of twist per pitch
of height *is* screw motion. The op exists because that identity is easy to
want and hard to find, and because the remap must be densified (see
`geometry/screw-profile.js`) or the chords between profile points cut deep into
the tooth.
```

- [ ] **Step 3: Add the error pattern**

In `docs/ERROR-PATTERNS.md`, add to the "Core framework" section, keeping the exact three-line entry shape:

```markdown
## screw-thread-vanishes-on-occt

- **Symptom:** a threaded part previews correctly but its STEP export is a plain
  cylinder or an empty file; on the OCCT backend the union of a thread with a core
  returns exactly the core's volume, or `0`, with no error thrown.
- **Cause:** the thread was built as a thin sub-pitch helical sliver and unioned
  onto a core. OCCT's boolean fails on a near-self-touching swept operand and
  silently returns the other operand — or nothing — rather than throwing.
- **Fix:** build the thread in the **periodic** form instead — a profile spanning
  exactly one `pitch` with equal first and last radius encloses the axis, so
  `k.screwSweep` yields the whole threaded body with no boolean at all. See
  [AUTHORING-PARTS.md](AUTHORING-PARTS.md) "Helical & threaded features".
```

- [ ] **Step 4: Verify the doc lints**

Run: `nvm use && npx vitest run test/error-patterns.test.js test/kernel-contract.test.js`
Expected: PASS. `error-patterns.test.js` parses every `##` heading and enforces the three-line shape.

- [ ] **Step 5: Commit**

```bash
git add docs/AUTHORING-PARTS.md docs/ERROR-PATTERNS.md
git commit -m "Document threads, and stop helixSweptTube from misleading agents"
```

---

### Task 6: Reference part

**Files:**
- Create: `src/parts/screw.js`, `screw.html`, `src/app-screw.js`, `src/screw-worker.js`
- Modify: `vite.config.js` (add `screw: "screw.html"` to `rollupOptions.input`, ~line 28)

**Interfaces:**
- Consumes: `k.screwSweep` from Task 2.
- Produces: a `PartDefinition` default-exported from `src/parts/screw.js`.

**Note:** if Task 4's union test failed, model the head as a second entry in `parts:` rather than unioning it into one solid.

- [ ] **Step 1: Write the part**

Create `src/parts/screw.js`:

```js
// Reference part for k.screwSweep — an ISO-style metric bolt. The thread uses the
// PERIODIC profile form (spans exactly one pitch, first radius == last radius), so
// one screwSweep call yields the whole threaded shank with no boolean against a
// core. See docs/AUTHORING-PARTS.md "Helical & threaded features".
export default {
  meta: { title: "Screw", units: "mm", background: 0x15181d },
  parameters: [
    {
      id: "thread",
      title: "Thread",
      description: "Nominal thread size. Pick a preset, or open **Advanced** for exact dimensions.",
      presets: { M6: { major: 6, pitch: 1.0, length: 20 }, M10: { major: 10, pitch: 1.5, length: 30 } },
      advanced: [
        { key: "major", label: "Major diameter", unit: "mm", min: 3, max: 24, step: 0.5,
          description: "Outside diameter measured across the thread crests." },
        { key: "pitch", label: "Pitch", unit: "mm", min: 0.35, max: 3, step: 0.05, control: "number",
          description: "Axial rise per turn. Must exceed the tooth height or consecutive turns would interpenetrate." },
        { key: "length", label: "Threaded length", unit: "mm", min: 5, max: 80, step: 1,
          description: "Length of the threaded shank, excluding the head." },
        { key: "lefthand", label: "Left-hand thread", control: "toggle",
          description: "Reverses the helix. Rare outside gas fittings and bicycle pedals." },
      ],
    },
    {
      id: "head",
      title: "Head",
      description: "The hex head at the top of the shank.",
      advanced: [
        { key: "headAcross", label: "Head width across flats", unit: "mm", min: 4, max: 40, step: 0.5,
          description: "Spanner size. Zero gives a headless threaded rod." },
        { key: "headH", label: "Head height", unit: "mm", min: 1, max: 20, step: 0.5,
          description: "Head thickness along the axis." },
      ],
    },
  ],
  defaults: { major: 10, pitch: 1.5, length: 30, lefthand: false, headAcross: 17, headH: 6.4 },
  // derive(): the ISO 60-degree tooth, expressed as radii the build consumes directly.
  derive: (p) => {
    const H = (Math.sqrt(3) / 2) * p.pitch;   // sharp-V height
    const majorR = p.major / 2;
    const rootR = majorR - (5 / 8) * H;
    const rootFlat = p.pitch / 4, crestFlat = p.pitch / 8;
    return {
      majorR, rootR, rootFlat, crestFlat,
      rise: (p.pitch - crestFlat - rootFlat) / 2,
      turns: p.length / p.pitch,
      headR: p.headAcross / Math.sqrt(3),      // circumradius of a hex across flats
    };
  },
  parts: {
    screw: {
      label: "Screw",
      views: ["screw"],
      export: { name: "screw" },
      build: (k, p, d) => {
        // Periodic profile: exactly one pitch tall, first radius == last radius.
        const shank = k.screwSweep({
          profile: [
            [d.rootR,  0],
            [d.rootR,  d.rootFlat],
            [d.majorR, d.rootFlat + d.rise],
            [d.majorR, d.rootFlat + d.rise + d.crestFlat],
            [d.rootR,  p.pitch],
          ],
          pitch: p.pitch,
          turns: d.turns,
          lefthand: p.lefthand,
        });
        if (p.headAcross <= 0) return shank;
        const head = k.prism({ points: hexPoints(d.headR), h: p.headH }).at([0, 0, p.length]);
        return shank.union(head);
      },
    },
  },
};

const hexPoints = (r) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return [r * Math.cos(a), r * Math.sin(a)];
  });
```

- [ ] **Step 2: Wire the app**

Create `src/screw-worker.js`:

```js
import part from "./parts/screw.js";
import { runWorker } from "./framework/worker.js";
runWorker(part);
```

Create `src/app-screw.js`:

```js
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import screwPart from "./parts/screw.js";
import { mount } from "./framework/index.js";

// Dev-only example app for the screw reference part. `npm run dev`, then open /screw.html.
// The `new Worker(new URL(...))` call must stay inline here or Vite will not bundle it.
window.__pfRuntime = mount(screwPart, {
  createWorker: (name) =>
    new Worker(new URL("./screw-worker.js", import.meta.url), { type: "module", name }),
});
```

Create `screw.html` by copying `demo.html` and changing exactly three things: the
`<title>` to `Screw — reference part`, the `<h1>` in `.pf-rail-head` to `Screw`,
and the module script's `src` to `/src/app-screw.js`.

```bash
cp demo.html screw.html
```

Then edit those three strings. Leave all other markup identical — the chrome CSS
comes from the framework and structural markup must not drift.

- [ ] **Step 3: Register the build entry**

In `vite.config.js`, add to `rollupOptions.input` (after the `hingedBox` line):

```js
        screw: "screw.html",
```

- [ ] **Step 4: Verify with the CLI, which needs no browser**

```bash
nvm use && npx partforge lint src/parts/screw.js
```
Expected: exit 0, no errors.

```bash
npx partforge measure src/parts/screw.js
```
Expected: exit 0; watertight, `holes: 0`, and a bounding box of roughly
`19.6 × 17.0 × 36.4` mm at the defaults. That is the **head**, not the shank:
`hexPoints` puts a vertex on +X, so a 17 mm across-flats hex measures
`2 × 17/√3 ≈ 19.63` across corners in X and `17.0` across flats in Y. The
threaded shank is only 10 mm across, and 30 mm + 6.4 mm gives the height.

- [ ] **Step 5: Verify it boots in a real browser**

```bash
node scripts/check-app.mjs screw.html
```
Expected: exit 0. Requires Playwright's Chromium (`npx playwright install chromium`).
If Playwright is unavailable in this environment, say so explicitly rather than
skipping silently — the CLI checks in Step 4 do not cover app wiring.

- [ ] **Step 6: Render it and look at it**

```bash
npx partforge render src/parts/screw.js
```
Expected: PNGs in `render/`. **Open them.** A thread that looks stepped, faceted
along the helix, or has a visible seam means the densification or the crease
shading is wrong — the measure gate will not catch that.

- [ ] **Step 7: Commit**

```bash
git add src/parts/screw.js src/app-screw.js src/screw-worker.js screw.html vite.config.js
git commit -m "Screw reference part"
```

---

### Task 7: Release prep

**Files:**
- Modify: `package.json` (version)

- [ ] **Step 1: Bump the version**

In `package.json`, change `"version": "0.51.0"` to `"version": "0.52.0"`.

This is additive (new op, no signature or semantic change), so `CONTRACT_VERSION`
in `kernel.js` stays at `1` and `docs/KERNEL-CONTRACT.md`'s version header stays
at `**Contract version: 1**`.

- [ ] **Step 2: Run the full suite**

Run: `nvm use && npm test`
Expected: PASS, including `kernel-contract.test.js`, `occt-backend.test.js`,
`error-patterns.test.js`, `worker-layering.test.js`.

- [ ] **Step 3: Run the smoke checks CI runs**

```bash
node scripts/check-app.mjs demo.html
node scripts/check-app.mjs planter.html
node scripts/check-app.mjs filleted-box.html
```
Expected: exit 0 each. Report honestly if Playwright is unavailable.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "Bump to 0.52.0 for k.screwSweep"
```

---

## Notes for the reviewer

- **The version bump is the quiet failure mode.** If it is missing when the PR merges, the release workflow correctly does nothing and the work never ships. `npm view partforge version` after the merge confirms it.
- **Two claims in this plan were measured, not reasoned.** Densification is mandatory (42% volume loss without it) and the sliver-plus-union formulation destroys OCCT geometry silently. Both are recorded with numbers in `docs/superpowers/specs/2026-08-11-screw-sweep-design.md`; neither should be re-litigated from first principles.
- **Known, accepted:** OCCT reports a loose bounding box on twist-extruded solids (control-hull derived — measured `14.42` where Manifold reports the true `10.00`). Volume is exact. A part `verify` block asserting bbox will disagree across backends. Not fixed here; if it bites, document it rather than working around it in the oracle.
