# `k.loftSmooth` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Graduate the spike's `k.loftSmooth` (spline-interpolated loft of sparse control sections) into a tested, documented, normative kernel op with a reference part.

**Architecture:** The spike already landed the working core on this branch: `src/framework/geometry/loft-smooth.js` (pure-JS Catmull-Rom densifier), the `kernel-front.js` compound default (mesh path lofts densified rings; B-rep path lofts sparse control wires with `ruled:false`), op lists/specs/d.ts wiring, and a spike part. This plan adds the one spec'd behavioral refinement (knot-aligned station distribution), locks everything with tests, renames the spike part into the `propeller.js` reference part, and replaces the SPIKE markers with normative docs.

**Tech Stack:** plain ESM + vitest; Manifold & OCCT WASM kernels via `src/testing.js` boots; partforge CLI for part-level verification.

**Spec:** `docs/superpowers/specs/2026-08-24-loft-smooth-design.md` — read it first; every constant below comes from it.

## Global Constraints

- Node 24 required. The sandbox blocks `source nvm.sh`; prefix instead: `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"` before any npm/npx/node command.
- OCCT and Manifold must never boot in the same test file/process. OCCT tests get their own file and boot via `bootOcctKernel()`.
- Never `npm publish`, never tag. The version bump (0.83.0 → **0.84.0**, already published: 0.83.0) happens in `package.json` in Task 8 of this plan; publish is automatic on merge.
- Existing error strings in `loft-smooth.js` are frozen by the spec — do not reword them.
- `build` functions and everything under `src/framework/geometry/` stay pure, DOM-free, `node:`-free (`test/worker-layering.test.js` enforces).
- On any confusing failure, grep `docs/ERROR-PATTERNS.md` for the symptom first.

---

### Task 1: Densifier regression tests (lock spike behavior)

**Files:**
- Create: `test/loft-smooth.test.js`
- Reads: `src/framework/geometry/loft-smooth.js` (no changes)

**Interfaces:**
- Consumes: `smoothLoftRings(sections, {stations?, samples?})` and `resampleClosedSpline(pts, n)` from `src/framework/geometry/loft-smooth.js`. Sections are `{polygon|sides+radius, z, rotate?, scale?}`; output is `[{polygon: [[x,y],…], z}]`.
- Produces: the test file Task 2 extends.

These are regression locks on already-working spike code, so they should pass on first run — a failure means a real spike bug: fix the *code* minimally, never loosen the test.

- [ ] **Step 1: Write the test file**

```js
// Kernel-free unit tests for the loftSmooth densifier (loft-smooth.js). Locks the
// spec'd behavior: planar equal-count rings, exact end interpolation, differing
// section counts reconciled, centripetal no-overshoot, determinism, frozen errors.
// Spec: docs/superpowers/specs/2026-08-24-loft-smooth-design.md
import { expect, test } from "vitest";
import { smoothLoftRings, resampleClosedSpline } from "../src/framework/geometry/loft-smooth.js";

const ngon = (m, r) => Array.from({ length: m }, (_, i) =>
  [r * Math.cos((2 * Math.PI * i) / m), r * Math.sin((2 * Math.PI * i) / m)]);

const SECTIONS = [
  { polygon: ngon(8, 10), z: 0 },
  { polygon: ngon(12, 14), z: 15 },   // differing vertex counts on purpose
  { polygon: ngon(10, 10), z: 30 },
];

test("output rings are equal-count, planar, and span the control z range", () => {
  const rings = smoothLoftRings(SECTIONS, { stations: 17, samples: 48 });
  expect(rings.length).toBe(17);
  for (const r of rings) {
    expect(r.polygon.length).toBe(48);
    expect(Number.isFinite(r.z)).toBe(true);
  }
  expect(rings[0].z).toBeCloseTo(0, 9);
  expect(rings[rings.length - 1].z).toBeCloseTo(30, 9);
  for (let i = 1; i < rings.length; i++) expect(rings[i].z).toBeGreaterThan(rings[i - 1].z);
});

test("end sections are interpolated exactly (reflection-phantom clamping)", () => {
  const rings = smoothLoftRings(SECTIONS, { stations: 17, samples: 48 });
  for (const [ring, section] of [[rings[0], SECTIONS[0]], [rings[16], SECTIONS[2]]]) {
    const want = resampleClosedSpline(section.polygon, 48);
    ring.polygon.forEach((p, j) => {
      expect(p[0]).toBeCloseTo(want[j][0], 9);
      expect(p[1]).toBeCloseTo(want[j][1], 9);
    });
  }
});

test("sides+radius shorthand sections work", () => {
  const rings = smoothLoftRings(
    [{ sides: 6, radius: 8, z: 0 }, { sides: 6, radius: 8, z: 10 }],
    { samples: 32 });
  expect(rings[0].polygon.length).toBe(32);
});

test("no overshoot: circle controls stay in a tight radial band (centripetal CR)", () => {
  const rings = smoothLoftRings(
    [{ polygon: ngon(12, 10), z: 0 }, { polygon: ngon(12, 10), z: 10 }],
    { stations: 3, samples: 96 });
  for (const [x, y] of rings[1].polygon) {
    const r = Math.hypot(x, y);
    expect(r).toBeLessThan(10.5);
    expect(r).toBeGreaterThan(9.0);
  }
});

test("no overshoot on clustered spacing (cosine-clustered ellipse controls)", () => {
  // Airfoil-style uneven spacing — the case uniform CR overshoots on (spec finding 2).
  const clustered = Array.from({ length: 16 }, (_, i) => {
    const a = (2 * Math.PI * i) / 16;
    const t = (1 - Math.cos(a)) / 2;                       // cluster near a=0
    const th = 2 * Math.PI * t;
    return [20 * Math.cos(th), 6 * Math.sin(th)];
  });
  const rings = smoothLoftRings(
    [{ polygon: clustered, z: 0 }, { polygon: clustered, z: 10 }],
    { stations: 2, samples: 128 });
  for (const [x, y] of rings[0].polygon) {
    expect(Math.abs(x)).toBeLessThan(20 * 1.05);
    expect(Math.abs(y)).toBeLessThan(6 * 1.05);
  }
});

test("deterministic: two identical calls produce identical output", () => {
  const a = smoothLoftRings(SECTIONS, { stations: 9, samples: 24 });
  const b = smoothLoftRings(SECTIONS, { stations: 9, samples: 24 });
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});

test('internal "controls" mode emits one ring per section at its exact z', () => {
  const rings = smoothLoftRings(SECTIONS, { stations: "controls", samples: 32 });
  expect(rings.map((r) => r.z)).toEqual([0, 15, 30]);
  expect(rings.every((r) => r.polygon.length === 32)).toBe(true);
});

test("validation errors are exact (frozen by the spec)", () => {
  expect(() => smoothLoftRings([], {}))
    .toThrow("loftSmooth: sections must be an array of at least 2 control sections");
  expect(() => smoothLoftRings([{ polygon: ngon(8, 5) }, { polygon: ngon(8, 5), z: 5 }], {}))
    .toThrow("loftSmooth: section 0 needs a finite z");
  expect(() => smoothLoftRings([{ polygon: [[0, 0], [1, 0]], z: 0 }, { polygon: ngon(8, 5), z: 5 }], {}))
    .toThrow("loftSmooth: section 0 needs polygon:[[x,y],…] (≥3 points) or sides+radius shorthand");
  expect(() => smoothLoftRings(SECTIONS, { stations: 1.5 }))
    .toThrow('loftSmooth: stations must be 2…1024 (or "controls")');
  expect(() => smoothLoftRings(SECTIONS, { samples: 4 }))
    .toThrow("loftSmooth: samples must be 8…2048");
});
```

- [ ] **Step 2: Run the file**

Run: `npx vitest run test/loft-smooth.test.js`
Expected: ALL PASS. If any test fails, read the failure, fix `loft-smooth.js` minimally (it is a spike bug), re-run.

- [ ] **Step 3: Commit**

```bash
git add test/loft-smooth.test.js
git commit -m "test(loft-smooth): lock densifier behavior — planarity, ends, reconciliation, determinism, errors"
```

---

### Task 2: Knot-aligned station distribution (the spec's one behavioral refinement)

**Files:**
- Modify: `src/framework/geometry/loft-smooth.js` (the station loop in `smoothLoftRings`, currently `for (let s = 0; s < S; s++) { const t = (s / (S - 1)) * tEnd; …`)
- Test: `test/loft-smooth.test.js`

**Interfaces:**
- Consumes: Task 1's file and helpers (`ngon`, `SECTIONS`).
- Produces: `smoothLoftRings` now guarantees every control section appears as an output ring at its exact z; `stations` below the section count is silently raised to it. Signature unchanged.

- [ ] **Step 1: Write the failing test** (append to `test/loft-smooth.test.js`)

```js
test("every control section appears as an actual output ring (knot-aligned stations)", () => {
  const uneven = [
    { polygon: ngon(8, 10), z: 0 },
    { polygon: ngon(8, 12), z: 7 },    // uneven span lengths on purpose
    { polygon: ngon(8, 10), z: 30 },
  ];
  const rings = smoothLoftRings(uneven, { stations: 10, samples: 32 });
  expect(rings.length).toBe(10);
  for (const s of uneven) {
    const ring = rings.find((r) => Math.abs(r.z - s.z) < 1e-9);
    expect(ring, `no output ring at control z=${s.z}`).toBeTruthy();
    const want = resampleClosedSpline(s.polygon, 32);
    ring.polygon.forEach((p, j) => {
      expect(p[0]).toBeCloseTo(want[j][0], 6);
      expect(p[1]).toBeCloseTo(want[j][1], 6);
    });
  }
});

test("stations below the section count is raised to the section count", () => {
  const five = [0, 5, 10, 15, 20].map((z) => ({ polygon: ngon(8, 10), z }));
  expect(smoothLoftRings(five, { stations: 2, samples: 16 }).length).toBe(5);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/loft-smooth.test.js -t "knot-aligned"`
Expected: FAIL — with uniform station sampling and uneven spans, no output ring lands at z=7.

- [ ] **Step 3: Implement per-span station distribution**

In `smoothLoftRings`, replace the station loop (`const out = []; const tEnd = …; for (let s = 0; s < S; s++) { const t = (s / (S - 1)) * tEnd; let seg = 0; …`) so the parameter list is built first, then evaluated. Keep the whole loop *body* (segment search, `z1d`, per-vertex `crPoint`) unchanged — only where `t` values come from changes:

```js
  // 3. Station parameter list: every control knot is always emitted, plus interior
  //    stations distributed per span proportionally to knot length (largest-
  //    remainder apportionment; ties to the lower index — deterministic), so each
  //    control section appears as an actual output ring, not just a point the
  //    underlying spline passes through. `stations` below the section count is
  //    raised to it (the knots alone already cost n rings).
  const tEnd = knots[n - 1];
  const S2 = Math.max(S, n);
  const extra = S2 - n;
  const spans = [];
  for (let i = 0; i < n - 1; i++) spans.push(knots[i + 1] - knots[i]);
  const exact = spans.map((len) => (extra * len) / tEnd);
  const alloc = exact.map(Math.floor);
  let left = extra - alloc.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => [e - alloc[i], i]).sort((p, q) => q[0] - p[0] || p[1] - q[1]);
  for (let j = 0; j < left; j++) alloc[order[j][1]]++;
  const ts = [];
  for (let i = 0; i < n - 1; i++) {
    ts.push(knots[i]);
    for (let m = 1; m <= alloc[i]; m++) ts.push(knots[i] + (spans[i] * m) / (alloc[i] + 1));
  }
  ts.push(tEnd);

  // 4. Evaluate the stations. z uses the same segment/knots as every vertex,
  //    evaluated once per station (1-D Barry–Goldman via crPoint).
  const out = [];
  for (const t of ts) {
    let seg = 0;
    while (seg < n - 2 && t > knots[seg + 1]) seg++;
    // …existing body unchanged (t0..t3, z1d, per-vertex crPoint, out.push)…
  }
  return out;
```

Also update the function's JSDoc `stations` line: "output ring count along the spine (default 8 per span + 1, ≥ 2; raised to the section count when lower; every control knot is always emitted)".

- [ ] **Step 4: Run the whole file**

Run: `npx vitest run test/loft-smooth.test.js`
Expected: ALL PASS (the Task 1 locks must survive — ring counts and end behavior are unchanged by construction: `S2 = S` whenever `S ≥ n`, and knot evaluation is exact CR interpolation).

- [ ] **Step 5: Sanity-check the spike part still builds**

Run: `npx partforge measure src/parts/propeller-spike.js`
Expected: watertight ✓, all verify gates pass, volume within a few % of 22.80 cm³.

- [ ] **Step 6: Commit**

```bash
git add src/framework/geometry/loft-smooth.js test/loft-smooth.test.js
git commit -m "feat(loft-smooth): knot-aligned station distribution — control sections are real output rings"
```

---

### Task 3: Graduate the spike part into the `propeller.js` reference part

**Files:**
- Rename (git mv): `src/parts/propeller-spike.js` → `src/parts/propeller.js`; `propeller-spike.html` → `propeller.html`; `src/app-propeller-spike.js` → `src/app-propeller.js`; `src/propeller-spike-worker.js` → `src/propeller-worker.js`
- Modify: all four renamed files (labels/paths), `AGENTS.md` (parts list)

**Interfaces:**
- Produces: `src/parts/propeller.js` default-exporting the PartDefinition; sub-part name stays `propeller`; `defaults` keys unchanged (`blades, span, rootChord, tipChord, twistRoot, twistTip, thickness, camber, hubD, hubH, boreD, smooth, stations, samples, sectionPts`). Tasks 4–5 import it as `import propeller from "../src/parts/propeller.js"`.

- [ ] **Step 1: Rename the four files**

```bash
git mv src/parts/propeller-spike.js src/parts/propeller.js
git mv propeller-spike.html propeller.html
git mv src/app-propeller-spike.js src/app-propeller.js
git mv src/propeller-spike-worker.js src/propeller-worker.js
```

- [ ] **Step 2: De-spike the part module** (`src/parts/propeller.js`)

- Replace the header comment block (starts `// SPIKE — THROWAWAY.`) with:

```js
// The k.loftSmooth reference part: a boat propeller — bored hub + N airfoil
// blades, each blade a spline-interpolated loft of 5 sparse control sections.
// The "Surface" section keeps the didactic A/B: untick **Smooth** to see the raw
// k.loft of the same control sections. Spec:
// docs/superpowers/specs/2026-08-24-loft-smooth-design.md
```

- `meta.title`: `"Propeller (loftSmooth spike)"` → `"Propeller"`.
- The second parameters section: `id: "spike"` → `id: "surface"`, `title: "Spike"` → `title: "Surface"`, and its `description` → `"**Smooth** interpolates the 5 sparse control sections with `loftSmooth`; off shows the raw `k.loft` of the same sections. **Stations/Samples** are the densifier resolution; **Section points** is how sparse the control sections are."`
- Delete the word THROWAWAY anywhere it remains.

- [ ] **Step 3: Fix the glue files**

- `src/app-propeller.js`: update both comment lines (drop SPIKE/THROWAWAY, say "reference part"), `import part from "./parts/propeller.js"`, worker URL → `"./propeller-worker.js"`.
- `src/propeller-worker.js`: comment + `import part from "./parts/propeller.js"`.
- `propeller.html`: `<title>Propeller — partforge</title>`; head comment → dev-only page for the propeller reference part, open `/propeller.html`; rail subtitle `loftSmooth spike · THROWAWAY` → `loftSmooth reference part`; hint paragraph → `A/B: toggle <b>Smooth</b> in the Surface section.`; script src → `/src/app-propeller.js`.

- [ ] **Step 4: Update AGENTS.md's parts list**

In the `src/parts/` sentence: `now has fourteen:` → `now has fifteen:`, and insert before the `lofted-bottle.js` entry:

```
`propeller.js` (the `k.loftSmooth` reference part - spline-interpolated
airfoil blades with a live smooth/raw A/B toggle), and
```

(adjusting the existing `, and` before `lofted-bottle.js` so the list reads correctly).

- [ ] **Step 5: Verify with the CLI**

Run: `npx partforge lint src/parts/propeller.js && npx partforge measure src/parts/propeller.js`
Expected: `lint: clean`; watertight ✓; gates pass (`holes 1`, `overlaps 0`, bbox within `[300,300,300]`).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(parts): propeller — the k.loftSmooth reference part (graduated from the spike)"
```

---

### Task 4: Manifold backend + parity test

**Files:**
- Create: `test/loft-smooth-manifold.test.js`

**Interfaces:**
- Consumes: `bootManifoldKernel` from `src/testing.js`; `src/parts/propeller.js` (Task 3).
- Produces: the shared parity anchor both backend files pin: **`PARITY_CM3 = 22.85` ± 2%** (midpoint of the spike's measured 22.80 Manifold / 22.90 OCCT). Task 5 repeats the same literal.

- [ ] **Step 1: Write the test file**

```js
// Manifold-side loftSmooth tests. Parity with OCCT is asserted the loft way (see
// test/loft-shape2d-occt.test.js's header): both backend files pin the SAME shared
// anchor at the same tolerance — here the propeller reference part's recorded
// volume, 22.85 cm³ ± 2% (loftSmooth is the screwSweep parity class: the backends
// interpolate across stations differently, so tolerance, not construction).
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import propeller from "../src/parts/propeller.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const ngon = (m, r) => Array.from({ length: m }, (_, i) =>
  [r * Math.cos((2 * Math.PI * i) / m), r * Math.sin((2 * Math.PI * i) / m)]);
const BULGE = [
  { polygon: ngon(24, 10), z: 0 },
  { polygon: ngon(24, 14), z: 15 },
  { polygon: ngon(24, 10), z: 30 },
];

test("loftSmooth of a 3-section bulge is a positive watertight solid in the expected band", () => {
  const s = k.loftSmooth({ sections: BULGE });
  const v = s.volume();
  // Bounded by the r=10 and r=14 cylinders (24-gon area factor ≈ 0.9886·πr²).
  expect(v).toBeGreaterThan(Math.PI * 10 * 10 * 30 * 0.95);
  expect(v).toBeLessThan(Math.PI * 14 * 14 * 30);
  const { size } = s.boundingBox();
  expect(size[2]).toBeCloseTo(30, 6);
  expect(size[0]).toBeGreaterThan(27.5);  // the r=14 waist is interpolated, ±overshoot bound
  expect(size[0]).toBeLessThan(28.7);
});

test("density convergence: default resolution is within 1% of a much denser run", () => {
  const lo = k.loftSmooth({ sections: BULGE }).volume();
  const hi = k.loftSmooth({ sections: BULGE, stations: 97, samples: 256 }).volume();
  expect(Math.abs(lo - hi) / hi).toBeLessThan(0.01);
});

test("parity anchor: propeller reference part volume (shared literal with the OCCT file)", () => {
  const PARITY_CM3 = 22.85;                         // spike-recorded midpoint; OCCT file pins the same
  const v = propeller.parts.propeller.build(k, propeller.defaults).volume() / 1000;
  expect(v).toBeGreaterThan(PARITY_CM3 * 0.98);
  expect(v).toBeLessThan(PARITY_CM3 * 1.02);
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/loft-smooth-manifold.test.js`
Expected: ALL PASS. If the bbox band fails by a hair, the overshoot bound is the suspect — verify the actual size printed, confirm it is interpolation (not a bug), and widen only with a comment recording the measured value.

- [ ] **Step 3: Commit**

```bash
git add test/loft-smooth-manifold.test.js
git commit -m "test(loft-smooth): Manifold backend geometry, convergence, and parity anchor"
```

---

### Task 5: OCCT backend + parity test (own file — never boot Manifold here)

**Files:**
- Create: `test/loft-smooth-occt.test.js`

**Interfaces:**
- Consumes: `bootOcctKernel` from `src/testing.js`; `src/parts/propeller.js`; the shared anchor `PARITY_CM3 = 22.85` from Task 4.

- [ ] **Step 1: Write the test file**

```js
// OCCT-only file (vitest isolates per file; never boot Manifold here). loftSmooth's
// B-rep path lofts the SPARSE control wires with the native smooth skin
// (ruled:false) — the spike showed the densified-wire alternative is both slow
// (23 s at 32×96) and abort-prone (48×128), so speed here is a contract, not a nicety.
// Parity: same shared anchor literal as test/loft-smooth-manifold.test.js.
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing.js";
import propeller from "../src/parts/propeller.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120_000);

const ngon = (m, r) => Array.from({ length: m }, (_, i) =>
  [r * Math.cos((2 * Math.PI * i) / m), r * Math.sin((2 * Math.PI * i) / m)]);
const BULGE = [
  { polygon: ngon(24, 10), z: 0 },
  { polygon: ngon(24, 14), z: 15 },
  { polygon: ngon(24, 10), z: 30 },
];

test("B-rep path: positive volume in the same band as the mesh backend", () => {
  const s = k.loftSmooth({ sections: BULGE });
  const v = s.volume();
  expect(v).toBeGreaterThan(Math.PI * 10 * 10 * 30 * 0.95);
  expect(v).toBeLessThan(Math.PI * 14 * 14 * 30);
});

test("high density stays fast — the control-wire path, not the dense-wire path", () => {
  const t0 = Date.now();
  const s = k.loftSmooth({ sections: BULGE, stations: 48, samples: 128 });
  expect(s.volume()).toBeGreaterThan(0);
  expect(Date.now() - t0).toBeLessThan(5000);   // spike measured ~0.2 s; dense wires ABORTED here
});

test("STEP export of a loftSmooth solid succeeds", async () => {
  const step = await k.toSTEP([{ name: "bulge", solid: k.loftSmooth({ sections: BULGE }) }]);
  expect(step.byteLength).toBeGreaterThan(1000);
});

test("parity anchor: propeller reference part volume (shared literal with the Manifold file)", () => {
  const PARITY_CM3 = 22.85;                        // same literal as loft-smooth-manifold.test.js
  const v = propeller.parts.propeller.build(k, propeller.defaults).volume() / 1000;
  expect(v).toBeGreaterThan(PARITY_CM3 * 0.98);
  expect(v).toBeLessThan(PARITY_CM3 * 1.02);
}, 60_000);
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/loft-smooth-occt.test.js`
Expected: ALL PASS (propeller case takes several seconds — that is why it carries a 60 s timeout).

- [ ] **Step 3: Commit**

```bash
git add test/loft-smooth-occt.test.js
git commit -m "test(loft-smooth): OCCT control-wire path — volume, speed contract, STEP, parity anchor"
```

---

### Task 6: Normative contract docs; de-spike the code comments

**Files:**
- Modify: `docs/KERNEL-CONTRACT.md` (replace the SPIKE blockquote), `src/framework/geometry/loft-smooth.js` (header), `src/framework/geometry/kernel.js` (KERNEL_OPS comment + typedef line), `src/framework/geometry/op-options.js` (spec comment), `src/framework/geometry/kernel-front.js` (composition comment), `types/kernel.d.ts` (two SPIKE comments)

- [ ] **Step 1: Replace the SPIKE blockquote in KERNEL-CONTRACT.md**

Delete the `> **SPIKE — `loftSmooth`…` blockquote entirely. In the compound-op table, insert after the `screwSweep` row:

```markdown
| `loftSmooth({sections, stations?, samples?, shading?})` | Spline-interpolated loft of ≥2 sparse control sections (loft-style ring specs `{polygon|sides+radius, z, rotate?, scale?}`; vertex counts **may differ** — point rings only; curve/`Shape2D` sections throw). Compound (`kernel-front.js` + `loft-smooth.js`): a shared centripetal Catmull-Rom reconciles every section to `samples` vertices (arc-length resample **from vertex 0** — authored correspondence: vertex `j` is the same material line on every section, so authored `rotate` twist sweeps instead of being re-seamed away). A mesh kernel lofts `stations` densified rings (every control knot emitted as a real ring; poly-exact path, smooth-shaded by default); a B-rep kernel lofts the sparse control wires with its native smooth skin (`ruled: false`) — the densified-wire alternative measured 23 s / WASM-abort territory. Options-only. Defaults `stations = (n−1)·8+1` (raised to the section count when lower), `samples = max(64, largest section)`; clamps 2…1024 / 8…2048. The surface interpolates every control section exactly. Parity: **within tolerance** (`screwSweep`'s class — the backends interpolate across stations differently; ~0.4% measured on the propeller reference part, test-gated at 2%). STEP is smooth across stations and faceted around rings at the `samples` LOD (the `extrude` `bevel` trade). |
```

- [ ] **Step 2: De-spike the code comments**

- `loft-smooth.js` header: first line `// SPIKE — throwaway candidate (see the loftSmooth note in docs/KERNEL-CONTRACT.md).` → `// The k.loftSmooth densifier (see the loftSmooth row in docs/KERNEL-CONTRACT.md and`
  `// docs/superpowers/specs/2026-08-24-loft-smooth-design.md).` Keep the rest of the header.
- `kernel.js`: the two-line `// SPIKE (throwaway candidate, unversioned — …` comment above `"loftSmooth"` in `KERNEL_OPS` → `// Additive in 0.84 (no CONTRACT_VERSION bump — the import-op precedent).`; the typedef line's `SPIKE: ` prefix → drop it.
- `op-options.js`: `// SPIKE (throwaway candidate): range checks live in loft-smooth.js…` → `// loftSmooth: range checks live in loft-smooth.js, next to the defaults they guard.`
- `kernel-front.js`: in the `loftSmooth` composition comment, drop `SPIKE compound default (throwaway candidate): ` (keep the substance — it documents the routing decision).
- `types/kernel.d.ts`: both `SPIKE` comment lines → `k.loftSmooth — spline-interpolated loft of sparse control sections.` / `Spline-interpolated loft of sparse control sections.`

- [ ] **Step 3: Run the doc-pinning tests**

Run: `npx vitest run test/kernel-contract.test.js test/occt-backend.test.js test/types-surface.test.js test/op-options.test.js`
Expected: ALL PASS (the op is named in the doc via the new row; nothing else moved).

- [ ] **Step 4: Commit**

```bash
git add docs/KERNEL-CONTRACT.md src/framework/geometry types/kernel.d.ts
git commit -m "docs(contract): loftSmooth normative row; de-spike code comments"
```

---

### Task 7: Authoring docs + error patterns

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (op table row + recipe), `docs/ERROR-PATTERNS.md` (two entries)

- [ ] **Step 1: Add the op-table row**

In AUTHORING-PARTS.md's kernel op table, after the `k.screwSweep` row (~line 326):

```markdown
| `k.loftSmooth({ sections, stations?, samples?, shading? })` | smooth organic loft: ≥2 sparse control sections (same ring spec as `k.loft`; vertex counts may differ, **point rings only**) interpolated with splines on both backends — the "here are 5 airfoil sections, make it smooth" op. The surface passes through every section exactly. Corners round at the `samples` LOD (sharp tags are future work); see the propeller reference part |
```

- [ ] **Step 2: Add the recipe**

Immediately after the section documenting `k.loft` usage (find it with `grep -n "k.loft" docs/AUTHORING-PARTS.md`), insert:

````markdown
**Smooth organic lofts.** When the silhouette should be a smooth curve rather
than faceted stations, don't densify rings by hand — hand `k.loftSmooth` the
few sections you can reason about and let it interpolate (both backends;
`k.loft` stays the right tool for deliberate facets and exact station control):

```js
const sections = [0, 0.3, 0.6, 0.85, 1].map((t) => ({
  polygon: airfoil(chord(t)),        // plain [[x,y],…] point rings; counts may differ
  z: span * t,
  rotate: pitch(t),                  // authored twist sweeps correctly — vertex j
}));                                 // is the same material line on every section
const blade = k.loftSmooth({ sections });
```

Raise `samples` if the cross-section shows facets, `stations` if banding runs
along the spine. Sections must be point rings — vertex order and the vertex-0
seam are how corresponding points line up across sections.
````

- [ ] **Step 3: Add the two error patterns**

In ERROR-PATTERNS.md's `# Core framework` namespace, following the entry-shape rules in its preamble (check an existing loft entry with `grep -n "arc profile" docs/ERROR-PATTERNS.md` and mirror how it leads with the indexed literal):

```markdown
## loftsmooth-sections-point-arrays

- **Symptom:** `is an arc profile — control sections must be point arrays (for now)` — a `loftSmooth` section was a curve contour (`roundedProfile`, `pathProfile`) or `Shape2D`.
- **Cause:** v1 interpolates through *points*; accepting a curve section would silently replace the authored curve with a nearby spline, so it is rejected (spec: `docs/superpowers/specs/2026-08-24-loft-smooth-design.md`, "The op").
- **Fix:** pass the section as a plain `[[x,y],…]` point ring (sample the curve yourself at the density you mean), or use `k.loft` with curve rings if you want the exact curve swept without spline interpolation.

## loftsmooth-looks-faceted

- **Symptom:** a `loftSmooth` solid shows flat facets around the cross-section, in preview or in STEP, even though nothing errored.
- **Cause:** `samples` is the around-ring LOD on **both** backends — the B-rep skin is smooth *across stations* only, so STEP is faceted around the ring at the `samples` count (see the `loftSmooth` row in [KERNEL-CONTRACT.md](KERNEL-CONTRACT.md)).
- **Fix:** raise `samples` (default `max(64, largest section)`, clamp ≤ 2048). If the banding runs along the spine instead, raise `stations`.
```

- [ ] **Step 4: Run the doc lints**

Run: `npx vitest run test/error-patterns.test.js test/kernel-contract.test.js`
Expected: ALL PASS (entry structure lint + doc/op cross-pins).

- [ ] **Step 5: Commit**

```bash
git add docs/AUTHORING-PARTS.md docs/ERROR-PATTERNS.md
git commit -m "docs: loftSmooth authoring row, organic-loft recipe, error patterns"
```

---

### Task 8: CI smoke entry, version bump, full verification

**Files:**
- Modify: `.github/workflows/ci.yml`, `package.json`, `AGENTS.md` (stale CI sentence)

- [ ] **Step 1: Add the smoke-check line**

In `.github/workflows/ci.yml`, after the `mixed-smoke.html` line:

```yaml
      - run: CHECK_PORT=5186 node scripts/check-app.mjs propeller.html
```

- [ ] **Step 2: Bump the version**

`package.json`: `"version": "0.83.0"` → `"version": "0.84.0"`. (0.83.0 is already published — `npm view partforge version` — and a merge without the bump silently ships nothing; see AGENTS.md "Releasing".)

- [ ] **Step 3: Fix AGENTS.md's stale smoke sentence**

The sentence `CI … runs npm test then the smoke check against four apps (demo, planter, filleted-box, text-smoke).` → `CI … runs npm test then the smoke check against the app list in ci.yml (demo through propeller).`

- [ ] **Step 4: Full verification**

```bash
npm test
```
Expected: ALL PASS (≈3260 tests).

```bash
node scripts/check-app.mjs propeller.html
```
Expected: smoke check passes (needs Playwright Chromium: `npx playwright install chromium` if missing).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml package.json AGENTS.md
git commit -m "chore: 0.84.0 — loftSmooth ships; propeller joins the smoke matrix"
```

---

## Self-review record

- **Spec coverage:** op semantics/defaults/clamps (Tasks 1–2), knot-aligned refinement (2), routing + parity class (4–5 pin it; composition landed in the spike), part graduation (3), contract/versioning + de-spiking (6), authoring/error docs (7), CI + release (8). The spec's v2 items (curve-native emission, sharp tags, closed loops, curve input sections) are deliberately absent — out of scope, and the cubic-orientation bug fix is a separate filed task.
- **Placeholder scan:** clean — every step carries its code, command, or verbatim doc text.
- **Type consistency:** `smoothLoftRings(sections, {stations, samples})`, `resampleClosedSpline(pts, n)`, `PARITY_CM3 = 22.85`, part path `src/parts/propeller.js`, sub-part `propeller` — consistent across Tasks 1–5.
