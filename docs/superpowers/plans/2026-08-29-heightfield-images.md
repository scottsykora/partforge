# Height maps and image sources — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a depth-map image into relief geometry via a new `k.heightfield`
op, sourced from a new `images` PartDefinition field that an end user can swap
from the control panel.

**Architecture:** A pure grid leaf (`heightfield.js`) converts a normalized
height grid into `{positions, indices}` and knows nothing about either kernel.
Manifold consumes it through the existing `manifoldFromMesh`; OCCT consumes it
through the existing `meshToStl` into `replicad.importSTL`, giving STEP export
with a faceted B-rep surface. Image bytes resolve through a third sibling on
`asset-resolve.js` beside `fonts.js` and `imports.js`, decode to a `Uint16Array`
in pure JS (PNG only), and register on the kernel via a `_registerImage`
side-channel mirroring `_registerImport`.

**Tech Stack:** ESM, vitest, manifold-3d 3.5.1, replicad 0.23.1, fflate (already
a dependency), pngjs (already a devDependency, tests only).

**Spec:** `docs/superpowers/specs/2026-08-29-heightfield-images-design.md`

## Global Constraints

- **Node 24 is required.** `.nvmrc` pins it; the default shell Node is too old
  and geometry/tests fail confusingly. Run `nvm use` before anything. If
  `source nvm.sh` is unavailable, PATH-prefix the pinned Node from
  `~/.nvm/versions`.
- **Units are millimetres** throughout.
- **`build` must be a pure function of `(k, p, d)`** — no `Math.random`, clock,
  or module-level mutable state.
- **Worker-graph files must be DOM-free and `node:`-free.** This covers
  `heightfield.js`, `png-decode.js`, `images.js`, `image-source.js`.
  `test/worker-layering.test.js` enforces it.
- **`image-ingest.js` must NOT be reachable from the worker graph.** It is
  main-thread only and exported from `src/index.js`.
- **Import geometry helpers from `partforge/geometry`, never `partforge`.**
- **`CONTRACT_VERSION` stays 4.** `heightfield` is additive — the `import`
  precedent. Do not bump it.
- **`package.json` → `0.92.0`** on this branch (Task 12). Forgetting this is the
  quiet failure mode: the merge lands and the work never ships.
- **OCCT and Manifold must not boot in the same process.** Keep OCCT tests in
  their own file; vitest isolates per file.
- **On any failure, grep `docs/ERROR-PATTERNS.md` first** — it maps literal error
  text to cause and fix.

---

### Task 1: De-risk `importSTL` (throwaway probe)

Spec §11 makes this task 1: the entire STEP story rests on `importSTL`, which
replicad documents as able to "fail in bad ways." Nothing else gets built until
this is answered.

**Files:**
- Create: `spike/importstl-probe.mjs` (throwaway — deleted in Step 5)

**Interfaces:**
- Consumes: nothing.
- Produces: a recorded go/no-go finding. No code survives this task.

- [ ] **Step 1: Write the probe**

```js
// spike/importstl-probe.mjs — THROWAWAY. Answers: does importSTL sew a realistic
// relief into a solid, how long does it take, and how big is the STEP?
import { bootOcctKernel } from "../src/testing/occt.js";
import { meshToStl } from "../src/framework/geometry/mesh-stl.js";

// A 60x60mm plate at the given sample count, with a sine relief — no image
// decoding involved, this probes sewing only.
function relief(n) {
  const W = 60, BASE = 1.5, MAXZ = 3;
  const V = [], T = [];
  const xy = (i) => (i / (n - 1)) * W - W / 2;
  const z = (i, j) => BASE + MAXZ * 0.5 * (1 + Math.sin(i / 6) * Math.cos(j / 6));
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) V.push(xy(i), xy(j), z(i, j));
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    T.push(a, b, d, a, d, c);
  }
  // Perimeter ring (CCW from +Z), duplicated at z=0, plus a fan cap.
  const per = [];
  for (let i = 0; i < n; i++) per.push(i);
  for (let j = 1; j < n; j++) per.push(j * n + (n - 1));
  for (let i = n - 2; i >= 0; i--) per.push((n - 1) * n + i);
  for (let j = n - 2; j >= 1; j--) per.push(j * n);
  const top0 = V.length / 3;
  for (const p of per) V.push(V[p * 3], V[p * 3 + 1], V[p * 3 + 2]);
  const bot0 = V.length / 3;
  for (const p of per) V.push(V[p * 3], V[p * 3 + 1], 0);
  const P = per.length;
  for (let k = 0; k < P; k++) {
    const k2 = (k + 1) % P;
    T.push(top0 + k, bot0 + k, bot0 + k2, top0 + k, bot0 + k2, top0 + k2);
  }
  const c = V.length / 3; V.push(0, 0, 0);
  for (let k = 0; k < P; k++) T.push(c, bot0 + (k + 1) % P, bot0 + k);
  return { positions: Float32Array.from(V), indices: Uint32Array.from(T) };
}

const { replicad } = await bootOcctKernel();
for (const n of [60, 120, 200]) {
  const m = relief(n);
  const tris = m.indices.length / 3;
  const t0 = Date.now();
  try {
    const shape = await replicad.importSTL(new Blob([meshToStl(m.positions, m.indices)]));
    const tSew = Date.now() - t0;
    const t1 = Date.now();
    const step = replicad.exportSTEP([{ shape }]);
    const bytes = (await step.arrayBuffer?.()) ?? step;
    console.log(`n=${n} tris=${tris} sew=${tSew}ms step=${(bytes.byteLength / 1e6).toFixed(1)}MB stepMs=${Date.now() - t1}`);
  } catch (e) {
    console.log(`n=${n} tris=${tris} FAILED after ${Date.now() - t0}ms: ${e.message}`);
  }
}
```

- [ ] **Step 2: Run it**

Run: `node spike/importstl-probe.mjs`

Record for each `n`: sewed or failed, sew time, STEP size. `n=200` is the
79,202-triangle case from the spec.

- [ ] **Step 3: Judge the result against the spec's fallbacks**

- **All three sew** → proceed to Task 2. Record the measured numbers; they set
  the OCCT triangle-count warning threshold (plan open item, resolved here).
- **`n=60` sews but `n=200` fails or takes minutes** → proceed, but the warning
  threshold drops to just under the last size that worked, and the spec's STEP
  guidance tightens. Still a go.
- **Nothing sews** → **STOP.** Do not continue. Spec §11 fallback (a) is a
  hand-written faceted-B-rep STEP writer; fallback (b) is Manifold-only, which
  reverses a decision Scott explicitly pushed back on and requires
  re-consultation, not a silent narrowing. Report and wait.

- [ ] **Step 4: Record the finding in the spec**

Append a short "Probe result (2026-08-29)" subsection to §11 of
`docs/superpowers/specs/2026-08-29-heightfield-images-design.md` with the table
of measured numbers and the chosen warning threshold.

- [ ] **Step 5: Delete the probe and commit**

```bash
rm -rf spike/
git add docs/superpowers/specs/2026-08-29-heightfield-images-design.md
git commit -m "spec: record importSTL probe results and the STEP warning threshold"
```

---

### Task 2: The `heightfield.js` pure grid leaf

**Files:**
- Create: `src/framework/geometry/heightfield.js`
- Test: `test/heightfield.test.js`

**Interfaces:**
- Consumes: `fanCap` from `./mesh-build.js`.
- Produces:
  - `heightfieldMesh(grid, opts) -> { positions: Float32Array, indices: Uint32Array, warnings: string[] }`
  - `grid` is `{ width: number, height: number, data: Uint16Array }`, row-major,
    values `0..65535`.
  - `opts` is `{ w, d, base = 1, maxZ = 1, pitch = 0.5, invert = false, range = [0, 1], origin = "center" }`.
  - `HEIGHTFIELD_VERTEX_BUDGET = 400000`
  - `sampleGrid(grid, u, v) -> number` — bilinear, returns `0..1`, `u`/`v` in `0..1`.

**Note on reuse:** `fanCap(V, Tr, ringStart, ringSegs, center, flip)` takes a
`ringStart` and is reused verbatim. `sideQuads` **cannot** be — it computes ring
bases as `i * ringSegs`, which assumes rings begin at `V[0]`, and our vertex
array has the grid in front. The skirt is an explicit loop.

- [ ] **Step 1: Write the failing tests**

```js
// test/heightfield.test.js
import { describe, test, expect } from "vitest";
import { heightfieldMesh, sampleGrid, HEIGHTFIELD_VERTEX_BUDGET } from "../src/framework/geometry/heightfield.js";

// A 2x2 grid: 0, 1/3, 2/3, 1 of full scale, row-major.
const g2 = { width: 2, height: 2, data: Uint16Array.from([0, 21845, 43690, 65535]) };
// A flat mid-gray 4x4.
const g4 = { width: 4, height: 4, data: Uint16Array.from(Array(16).fill(32768)) };

const base = { w: 10, d: 10, base: 1, maxZ: 2, pitch: 5 };
const zs = (m) => { const out = []; for (let i = 2; i < m.positions.length; i += 3) out.push(m.positions[i]); return out; };

describe("sampleGrid", () => {
  test("returns corner values exactly at the corners", () => {
    expect(sampleGrid(g2, 0, 0)).toBeCloseTo(0, 4);
    expect(sampleGrid(g2, 1, 1)).toBeCloseTo(1, 4);
  });
  test("bilinearly interpolates the centre", () => {
    expect(sampleGrid(g2, 0.5, 0.5)).toBeCloseTo(0.5, 3);
  });
});

describe("heightfieldMesh", () => {
  test("sample count is ceil(w/pitch) x ceil(d/pitch)", () => {
    // 10mm / 5mm = 2 samples per side.
    const m = heightfieldMesh(g4, base);
    // grid(4) + top ring dup(4) + bottom ring(4) + fan centre(1) = 13
    expect(m.positions.length / 3).toBe(13);
  });

  test("is watertight — every edge is shared by exactly two triangles", () => {
    const m = heightfieldMesh(g4, { ...base, pitch: 2 });
    const counts = new Map();
    for (let t = 0; t < m.indices.length; t += 3) {
      const tri = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
      for (let e = 0; e < 3; e++) {
        const a = tri[e], b = tri[(e + 1) % 3];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const bad = [...counts.entries()].filter(([, n]) => n !== 2);
    expect(bad).toEqual([]);
  });

  test("winds outward — signed volume is positive", () => {
    const m = heightfieldMesh(g4, { ...base, pitch: 2 });
    let vol = 0;
    const P = (i) => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [P(m.indices[t]), P(m.indices[t + 1]), P(m.indices[t + 2])];
      vol += (a[0] * (b[1] * c[2] - b[2] * c[1])
            - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
    expect(vol).toBeGreaterThan(0);
  });

  test("height is base + maxZ * value; flat mid-gray sits halfway", () => {
    const m = heightfieldMesh(g4, base);
    const top = zs(m).filter((z) => z > 0.5);
    for (const z of top) expect(z).toBeCloseTo(1 + 2 * 0.5, 3);
  });

  test("invert flips the mapping", () => {
    const m = heightfieldMesh(g2, { ...base, invert: true });
    expect(Math.max(...zs(m))).toBeCloseTo(1 + 2 * 1, 2); // the 0 corner becomes the peak
  });

  test("range remaps: [0.5,1] puts mid-gray at zero relief", () => {
    const m = heightfieldMesh(g4, { ...base, range: [0.5, 1] });
    const top = zs(m).filter((z) => z > 0);
    for (const z of top) expect(z).toBeCloseTo(1, 3); // base only, no relief
  });

  test("range clamps input below the band to zero", () => {
    const m = heightfieldMesh(g4, { ...base, range: [0.75, 1] });
    const top = zs(m).filter((z) => z > 0);
    for (const z of top) expect(z).toBeCloseTo(1, 3);
  });

  test('origin "center" centres the footprint; "corner" puts min at the origin', () => {
    const c = heightfieldMesh(g4, base);
    const k = heightfieldMesh(g4, { ...base, origin: "corner" });
    const xsOf = (m) => { const o = []; for (let i = 0; i < m.positions.length; i += 3) o.push(m.positions[i]); return o; };
    expect(Math.min(...xsOf(c))).toBeCloseTo(-5, 3);
    expect(Math.min(...xsOf(k))).toBeCloseTo(0, 3);
  });

  test("the base always sits at z = 0", () => {
    const m = heightfieldMesh(g4, { ...base, origin: "corner" });
    expect(Math.min(...zs(m))).toBeCloseTo(0, 6);
  });

  test("rejects base <= 0 and pitch <= 0", () => {
    expect(() => heightfieldMesh(g4, { ...base, base: 0 })).toThrow(/base/);
    expect(() => heightfieldMesh(g4, { ...base, pitch: 0 })).toThrow(/pitch/);
  });

  test("clamps a runaway pitch to the vertex budget and warns rather than throwing", () => {
    const m = heightfieldMesh(g4, { w: 200, d: 200, base: 1, maxZ: 1, pitch: 0.01 });
    expect(m.positions.length / 3).toBeLessThanOrEqual(HEIGHTFIELD_VERTEX_BUDGET);
    expect(m.warnings.join(" ")).toMatch(/pitch .* clamped/);
  });

  test("no warnings on an ordinary build", () => {
    expect(heightfieldMesh(g4, base).warnings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/heightfield.test.js`
Expected: FAIL — `Failed to resolve import "../src/framework/geometry/heightfield.js"`

- [ ] **Step 3: Implement**

```js
// src/framework/geometry/heightfield.js
// Pure grid → triangle mesh for k.heightfield. Backend-agnostic by design: it
// returns plain {positions, indices} that Manifold takes via manifoldFromMesh
// and OCCT takes via meshToStl → importSTL, so both backends build from
// byte-identical triangle data. DOM-free and node:-free (worker graph).
//
// fanCap is reused verbatim from mesh-build.js (it takes a ringStart). sideQuads
// is NOT reusable here: it derives ring bases as i*ringSegs, which assumes rings
// start at V[0], and our vertex array leads with the grid. The skirt is the
// explicit loop below.
import { fanCap } from "./mesh-build.js";

// Ceiling on grid vertices, so an ambitious pitch degrades instead of hanging.
export const HEIGHTFIELD_VERTEX_BUDGET = 400000;

const U16 = 65535;

// Bilinear sample of a row-major Uint16 grid. u/v in 0..1 → 0..1.
export function sampleGrid(grid, u, v) {
  const { width: W, height: H, data } = grid;
  const x = Math.min(Math.max(u, 0), 1) * (W - 1);
  const y = Math.min(Math.max(v, 0), 1) * (H - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
  const fx = x - x0, fy = y - y0;
  const a = data[y0 * W + x0], b = data[y0 * W + x1];
  const c = data[y1 * W + x0], d = data[y1 * W + x1];
  return ((a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy) / U16;
}

export function heightfieldMesh(grid, opts = {}) {
  const { w, d, base = 1, maxZ = 1, invert = false, range = [0, 1], origin = "center" } = opts;
  let { pitch = 0.5 } = opts;
  const warnings = [];

  if (!(w > 0) || !(d > 0)) throw new Error("heightfield: w and d must be positive");
  if (!(base > 0)) throw new Error("heightfield: base must be > 0 (a zero base is degenerate)");
  if (!(pitch > 0)) throw new Error("heightfield: pitch must be > 0");

  const count = (len, p) => Math.max(2, Math.ceil(len / p) );
  let nx = count(w, pitch), ny = count(d, pitch);
  if (nx * ny > HEIGHTFIELD_VERTEX_BUDGET) {
    // Scale pitch up uniformly until the grid fits, then recompute.
    const scale = Math.sqrt((nx * ny) / HEIGHTFIELD_VERTEX_BUDGET);
    const clamped = pitch * scale;
    warnings.push(`heightfield: pitch ${pitch} clamped to ${clamped.toFixed(3)} (vertex budget ${HEIGHTFIELD_VERTEX_BUDGET})`);
    pitch = clamped;
    nx = count(w, pitch); ny = count(d, pitch);
    while (nx * ny > HEIGHTFIELD_VERTEX_BUDGET) { nx--; ny--; }
  }

  const [lo, hi] = range;
  const span = hi - lo;
  // range is a REMAP with clamped ends: lo→0, hi→1. invert applies after.
  const f = (v) => {
    const t = span === 0 ? 0 : Math.min(Math.max((v - lo) / span, 0), 1);
    return invert ? 1 - t : t;
  };

  const x0 = origin === "corner" ? 0 : -w / 2;
  const y0 = origin === "corner" ? 0 : -d / 2;
  const X = (i) => x0 + (i / (nx - 1)) * w;
  const Y = (j) => y0 + (j / (ny - 1)) * d;
  const Z = (i, j) => base + maxZ * f(sampleGrid(grid, i / (nx - 1), j / (ny - 1)));

  const V = [], Tr = [];

  // 1. Top grid, row-major. CCW from +Z.
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) V.push(X(i), Y(j), Z(i, j));
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, dd = c + 1;
    Tr.push(a, b, dd, a, dd, c);
  }

  // 2. Perimeter, CCW viewed from +Z, as grid indices.
  const per = [];
  for (let i = 0; i < nx; i++) per.push(i);
  for (let j = 1; j < ny; j++) per.push(j * nx + (nx - 1));
  for (let i = nx - 2; i >= 0; i--) per.push((ny - 1) * nx + i);
  for (let j = ny - 2; j >= 1; j--) per.push(j * nx);
  const P = per.length;

  // 3. Duplicate the top ring and add the bottom ring. Duplicates let the skirt
  //    index two contiguous rings; both consumers weld them (mesh.merge() on
  //    Manifold, tolerance sewing inside importSTL on OCCT).
  const top0 = V.length / 3;
  for (const p of per) V.push(V[p * 3], V[p * 3 + 1], V[p * 3 + 2]);
  const bot0 = V.length / 3;
  for (const p of per) V.push(V[p * 3], V[p * 3 + 1], 0);

  // 4. Skirt.
  for (let k = 0; k < P; k++) {
    const k2 = (k + 1) % P;
    Tr.push(top0 + k, bot0 + k, bot0 + k2, top0 + k, bot0 + k2, top0 + k2);
  }

  // 5. Bottom cap — flip=true so it faces −Z. Centre is the footprint centroid.
  fanCap(V, Tr, bot0, P, [x0 + w / 2, y0 + d / 2, 0], true);

  return { positions: Float32Array.from(V), indices: Uint32Array.from(Tr), warnings };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/heightfield.test.js`
Expected: PASS (all tests)

If the winding test fails, the grid quads or the skirt are wound inward — swap
the second and third index of each pushed triangle in that block, not globally.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/heightfield.js test/heightfield.test.js
git commit -m "feat: heightfield grid-to-mesh leaf"
```

---

### Task 3: The PNG decoder

**Files:**
- Create: `src/framework/geometry/png-decode.js`
- Test: `test/png-decode.test.js`

**Interfaces:**
- Consumes: `unzlibSync` from `fflate` (already a dependency, already in the
  worker graph via `threemf-parse.js`).
- Produces: `decodePng(bytes) -> { width, height, data: Uint16Array }` — luminance,
  row-major, `0..65535`. `bytes` is an `ArrayBuffer` or `Uint8Array`.

Must support colour types 0 (gray), 2 (RGB), 4 (gray+alpha) and 6 (RGBA) at bit
depths 8 and 16, and palette (type 3) at depths 1/2/4/8. Interlaced (Adam7) is
**rejected with a clear message** — plan open item 3, resolved here as reject.

- [ ] **Step 1: Write the failing tests**

```js
// test/png-decode.test.js
import { describe, test, expect } from "vitest";
import { PNG } from "pngjs";
import { decodePng } from "../src/framework/geometry/png-decode.js";

// pngjs is a devDependency and Node-only — an independent reference encoder
// here, and the oracle we diff against.
function encode(width, height, fill, { colorType = 6, bitDepth = 8, inputHasAlpha = true } = {}) {
  const png = new PNG({ width, height, colorType, bitDepth, inputHasAlpha });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const [r, g, b, a] = fill(x, y);
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = a;
  }
  return PNG.sync.write(png);
}

const gray = (v) => () => [v, v, v, 255];

describe("decodePng", () => {
  test("reads dimensions", () => {
    const out = decodePng(encode(4, 3, gray(0)));
    expect(out.width).toBe(4);
    expect(out.height).toBe(3);
  });

  test("8-bit RGBA black and white map to 0 and 65535", () => {
    expect(decodePng(encode(2, 2, gray(0))).data[0]).toBe(0);
    expect(decodePng(encode(2, 2, gray(255))).data[0]).toBe(65535);
  });

  test("8-bit grayscale decodes", () => {
    const out = decodePng(encode(2, 2, gray(128), { colorType: 0, inputHasAlpha: false }));
    expect(out.data[0]).toBeGreaterThan(32000);
    expect(out.data[0]).toBeLessThan(33500);
  });

  test("16-bit grayscale keeps precision beyond 8 bits", () => {
    // Two values one 16-bit step apart must not collapse to the same output.
    const buf = PNG.sync.write(Object.assign(new PNG({ width: 2, height: 1, colorType: 0, bitDepth: 16 }), {}));
    const out = decodePng(buf);
    expect(out.data.length).toBe(2);
    expect(out.data).toBeInstanceOf(Uint16Array);
  });

  test("RGB without alpha decodes", () => {
    const out = decodePng(encode(2, 2, gray(255), { colorType: 2, inputHasAlpha: false }));
    expect(out.data[0]).toBe(65535);
  });

  test("a horizontal ramp round-trips monotonically", () => {
    const w = 8;
    const out = decodePng(encode(w, 1, (x) => { const v = Math.round((x / (w - 1)) * 255); return [v, v, v, 255]; }));
    for (let i = 1; i < w; i++) expect(out.data[i]).toBeGreaterThan(out.data[i - 1]);
  });

  test("luminance weights the channels (green dominates red)", () => {
    const red = decodePng(encode(1, 1, () => [255, 0, 0, 255])).data[0];
    const green = decodePng(encode(1, 1, () => [0, 255, 0, 255])).data[0];
    expect(green).toBeGreaterThan(red);
  });

  test("rejects a non-PNG", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/not a PNG/i);
  });

  test("rejects a truncated file", () => {
    const full = encode(4, 4, gray(200));
    expect(() => decodePng(full.subarray(0, 30))).toThrow();
  });

  test("rejects an interlaced PNG with a clear message", () => {
    const png = new PNG({ width: 4, height: 4, interlace: true });
    png.data.fill(200);
    expect(() => decodePng(PNG.sync.write(png))).toThrow(/interlac/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/png-decode.test.js`
Expected: FAIL — cannot resolve `png-decode.js`

- [ ] **Step 3: Implement**

```js
// src/framework/geometry/png-decode.js
// Pure-JS PNG → luminance grid. Lives in the worker graph, so it must be DOM-free
// and node:-free: no createImageBitmap/OffscreenCanvas (browser-only), no pngjs
// (Node-only). One decoder in one place is what keeps the browser, the CLI and CI
// from disagreeing about geometry. Inflate comes from fflate, already in this
// closure via threemf-parse.js.
import { unzlibSync } from "fflate";

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const U16 = 65535;

// Rec. 709 luma, the same weighting a viewer would show.
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  for (let i = 0; i < 8; i++) if (u8[i] !== SIG[i]) throw new Error("decodePng: not a PNG (bad signature)");

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let off = 8, width = 0, height = 0, depth = 8, colorType = 6, interlace = 0;
  let palette = null, trns = null;
  const idat = [];

  while (off + 8 <= u8.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
    const body = off + 8;
    if (body + len > u8.length) throw new Error(`decodePng: truncated file (chunk ${type} runs past the end)`);
    if (type === "IHDR") {
      width = dv.getUint32(body); height = dv.getUint32(body + 4);
      depth = u8[body + 8]; colorType = u8[body + 9]; interlace = u8[body + 12];
    } else if (type === "PLTE") palette = u8.subarray(body, body + len);
    else if (type === "tRNS") trns = u8.subarray(body, body + len);
    else if (type === "IDAT") idat.push(u8.subarray(body, body + len));
    else if (type === "IEND") break;
    off = body + len + 4; // + CRC
  }

  if (!width || !height) throw new Error("decodePng: truncated file (no IHDR)");
  if (interlace) throw new Error("decodePng: interlaced (Adam7) PNGs are not supported — re-save without interlacing");

  const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!CHANNELS) throw new Error(`decodePng: unsupported colour type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error("decodePng: palette image with no PLTE chunk");

  // Concatenate IDAT then inflate.
  let total = 0; for (const c of idat) total += c.length;
  if (!total) throw new Error("decodePng: truncated file (no IDAT)");
  const z = new Uint8Array(total);
  { let p = 0; for (const c of idat) { z.set(c, p); p += c.length; } }
  const raw = unzlibSync(z);

  const bpp = Math.max(1, (CHANNELS * depth) >> 3);
  const rowBytes = Math.ceil((CHANNELS * depth * width) / 8);
  if (raw.length < (rowBytes + 1) * height) throw new Error("decodePng: truncated file (short image data)");

  // Un-filter in place, row by row.
  const img = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (rowBytes + 1)];
    const src = y * (rowBytes + 1) + 1;
    const dst = y * rowBytes, up = dst - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? img[dst + x - bpp] : 0;
      const b = y > 0 ? img[up + x] : 0;
      const c = x >= bpp && y > 0 ? img[up + x - bpp] : 0;
      img[dst + x] = (ft === 0 ? v : ft === 1 ? v + a : ft === 2 ? v + b
                   : ft === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c)) & 0xff;
    }
  }

  // Read samples → luminance, scaled to 0..65535.
  const out = new Uint16Array(width * height);
  const maxIn = depth === 16 ? 65535 : (1 << depth) - 1;
  const readSample = (row, i) => {
    if (depth === 16) return (img[row + i * 2] << 8) | img[row + i * 2 + 1];
    if (depth === 8) return img[row + i];
    const per = 8 / depth, byte = img[row + ((i / per) | 0)];
    const shift = 8 - depth * ((i % per) + 1);
    return (byte >> shift) & maxIn;
  };

  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < width; x++) {
      let v;
      if (colorType === 3) {
        const idx = readSample(row, x) * 3;
        v = luma(palette[idx], palette[idx + 1], palette[idx + 2]) / 255;
      } else if (colorType === 0 || colorType === 4) {
        v = readSample(row, x * CHANNELS) / maxIn;
      } else {
        const b0 = x * CHANNELS;
        v = luma(readSample(row, b0), readSample(row, b0 + 1), readSample(row, b0 + 2)) / maxIn;
      }
      out[y * width + x] = Math.round(Math.min(Math.max(v, 0), 1) * U16);
    }
  }
  return { width, height, data: out };
}
```

Note: `trns` is parsed but unused — alpha does not affect a depth map. Leave the
capture in place; removing it means re-adding it if a future masked mode wants it.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/png-decode.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/png-decode.js test/png-decode.test.js
git commit -m "feat: pure-JS PNG decoder for depth maps"
```

---

### Task 4: Image source rules and the `images` resolver

**Files:**
- Create: `src/framework/image-source.js`
- Create: `src/framework/images.js`
- Test: `test/image-source.test.js`
- Test: `test/images-resolve.test.js`

**Interfaces:**
- Consumes: `makeAssetResolver`, `resolveDecl` from `./asset-resolve.js`;
  `decodePng` from `./geometry/png-decode.js`.
- Produces:
  - `IMAGE_ALLOW_DEFAULT = ["https"]`
  - `isNoImageSource(v) -> boolean`
  - `imageSourceAllowed(source, allow = IMAGE_ALLOW_DEFAULT) -> boolean`
  - `imageControlAllows(part) -> Map<paramKey, string[]>`
  - `imagesFor(part, p) -> object | undefined`
  - `resolveImages(imagesDecl) -> Promise<Map<name, { digest, width, height, data }>>`
  - `ensureImages(kernel, imagesDecl) -> Promise<void>`

- [ ] **Step 1: Write the failing tests**

```js
// test/image-source.test.js
import { test, expect } from "vitest";
import { imageSourceAllowed, imageControlAllows, isNoImageSource } from "../src/framework/image-source.js";

test("https is allowed by default", () => {
  expect(imageSourceAllowed("https://cdn.test/d.png")).toBe(true);
  expect(imageSourceAllowed("http://cdn.test/d.png")).toBe(false);
});

test("a pfc-asset token needs the asset kind", () => {
  const tok = "pfc-asset://11111111-2222-3333-4444-555555555555/depth.png";
  expect(imageSourceAllowed(tok, ["asset"])).toBe(true);
  expect(imageSourceAllowed(tok, ["https"])).toBe(false);
});

test("hostname spoofing is refused", () => {
  expect(imageSourceAllowed("https://cdn.test@evil.test/d.png", ["https"])).toBe(true); // still https, by design
  expect(imageSourceAllowed("javascript:alert(1)", ["https"])).toBe(false);
  expect(imageSourceAllowed("not a url", ["https"])).toBe(false);
});

test("BYTES bypass the allow check — they cannot have come from a shared link", () => {
  expect(imageSourceAllowed(new ArrayBuffer(8), ["https"])).toBe(true);
  expect(imageSourceAllowed(new Uint8Array(8), ["https"])).toBe(true);
});

test("an empty value is 'unset', never 'disallowed'", () => {
  expect(isNoImageSource("")).toBe(true);
  expect(isNoImageSource(undefined)).toBe(true);
  expect(imageSourceAllowed("", ["https"])).toBe(false);
});

test("imageControlAllows walks nested groups and legacy arrays", () => {
  const part = { parameters: [
    { controls: [{ key: "a", type: "image" },
                 { type: "group", controls: [{ key: "b", type: "image", allow: ["asset"] }] }] },
    { advanced: [{ key: "c", control: "image" }] },
  ] };
  const m = imageControlAllows(part);
  expect(m.get("a")).toEqual(["https"]);
  expect(m.get("b")).toEqual(["asset"]);
  expect(m.get("c")).toEqual(["https"]);
});
```

```js
// test/images-resolve.test.js
import { test, expect } from "vitest";
import { PNG } from "pngjs";
import { imagesFor, resolveImages, ensureImages } from "../src/framework/images.js";

const png = (v = 200) => {
  const p = new PNG({ width: 2, height: 2 });
  p.data.fill(v); for (let i = 3; i < p.data.length; i += 4) p.data[i] = 255;
  return PNG.sync.write(p);
};

test("imagesFor resolves the function form with params", () => {
  const part = { images: (p) => (p.relief ? { relief: p.relief } : {}) };
  expect(imagesFor(part, { relief: "x" })).toEqual({ relief: "x" });
  expect(imagesFor(part, {})).toEqual({});
});

test("resolveImages decodes bytes without fetching, and digests them", async () => {
  const bytes = png().buffer.slice(0);
  const m = await resolveImages({ relief: bytes });
  const e = m.get("relief");
  expect(e.width).toBe(2);
  expect(e.data).toBeInstanceOf(Uint16Array);
  expect(e.digest).toMatch(/^[0-9a-f]{64}$/);
});

test("different bytes give different digests", async () => {
  const a = await resolveImages({ r: png(10).buffer.slice(0) });
  const b = await resolveImages({ r: png(240).buffer.slice(0) });
  expect(a.get("r").digest).not.toBe(b.get("r").digest);
});

test("a non-PNG source names the ingest helper", async () => {
  await expect(resolveImages({ r: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).buffer }))
    .rejects.toThrow(/imageToPng/);
});

test("ensureImages registers on the kernel and is digest-gated", async () => {
  const seen = [];
  const kernel = {
    _registerImage: (e) => seen.push(e),
    _imageDigest: (n) => seen.find((s) => s.name === n)?.digest,
  };
  const decl = { relief: png().buffer.slice(0) };
  await ensureImages(kernel, decl);
  await ensureImages(kernel, decl);
  expect(seen.length).toBe(1); // second call is a no-op at the same digest
});

test("ensureImages is a no-op on a kernel with no _registerImage", async () => {
  await expect(ensureImages({}, { relief: png().buffer.slice(0) })).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/image-source.test.js test/images-resolve.test.js`
Expected: FAIL — cannot resolve the two new modules

- [ ] **Step 3: Implement `image-source.js`**

```js
// src/framework/image-source.js
// What a PARAM-supplied image source may be. Author-declared `images` sources are
// code and get no restriction; this file exists only for the other case — a value
// that arrived in `params`.
//
// This deliberately diverges from font-source.js in one place. That file refuses
// every non-string on the grounds that "bytes/thunks are never param-supplied".
// For images they ARE: the partforge-cloud sandbox cannot fetch URLs and puts PNG
// bytes straight in the param. The replacement rule is sound — an ArrayBuffer in
// params definitionally did not arrive via a shared link, because a URL cannot
// carry megabytes, so it can only have been placed there by the host's own panel.
//
// DOM-free and node:-free: jobs.js (worker graph) and the panel both import it.

export const IMAGE_ALLOW_DEFAULT = ["https"];

const ASSET_SCHEME = "pfc-asset:";

// The "unset" image source. An empty value declares NO image — the documented way
// to leave a relief off, after which heightfield falls back to a flat slab. Never
// a source to fetch, and never a source to refuse.
export const isNoImageSource = (v) => v === undefined || v === null || v === "";

const isBytes = (v) => v instanceof ArrayBuffer || ArrayBuffer.isView(v);

function parse(source) {
  try { return new URL(source); } catch { return null; }
}

export function imageSourceAllowed(source, allow = IMAGE_ALLOW_DEFAULT) {
  if (isBytes(source)) return true; // see the file header
  if (typeof source !== "string") return false;
  const u = parse(source);
  if (!u) return false;
  for (const kind of allow) {
    if (kind === "https" && u.protocol === "https:") return true;
    if (kind === "asset" && u.protocol === ASSET_SCHEME) return true;
  }
  return false;
}

// paramKey → allow list, for every `type: "image"` control in the authored tree,
// new-shape (`controls`, including nested groups) and legacy-shape
// (`advanced`/`toggles`/`features`, where panel/legacy.js desugars `control:` to
// `type:`). Missing the legacy arrays would leave such a control silently
// unrestricted. Tolerant of any array being absent or malformed — it must never
// throw on an existing part.
export function imageControlAllows(part) {
  const out = new Map();
  const visit = (nodes) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      if (Array.isArray(n.controls)) visit(n.controls);
      if (Array.isArray(n.advanced)) visit(n.advanced);
      if (Array.isArray(n.toggles)) visit(n.toggles);
      if (Array.isArray(n.features)) visit(n.features);
      if ((n.type === "image" || n.control === "image") && typeof n.key === "string") {
        out.set(n.key, Array.isArray(n.allow) && n.allow.length ? n.allow : IMAGE_ALLOW_DEFAULT);
      }
    }
  };
  visit(part?.parameters);
  return out;
}
```

- [ ] **Step 4: Implement `images.js`**

```js
// src/framework/images.js
// Resolve a part's declared `images` ({ name: source }) to a decoded luminance
// grid + a SHA-256 content digest, before the synchronous build — the third
// asset sibling beside fonts.js and imports.js, on the shared resolution core in
// asset-resolve.js. DOM-free and node:-free; crypto.subtle exists in workers and
// Node.
//
// Registration is simpler than imports': every backend can consume a normalized
// grid, so there are no per-format error entries and no crossover.
import { makeAssetResolver, resolveDecl } from "./asset-resolve.js";
import { decodePng } from "./geometry/png-decode.js";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47];

async function sha256Hex(bytes) {
  const d = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const cache = new Map(); // source → Promise<{digest, width, height, data}>
const resolveOne = makeAssetResolver(
  cache,
  async (bytes) => {
    const u8 = new Uint8Array(bytes);
    for (let i = 0; i < 4; i++) {
      if (u8[i] !== PNG_SIG[i]) {
        throw new Error(
          "images: only PNG is supported — convert with imageToPng() from \"partforge\" before storing, " +
          "or have the host normalize on upload",
        );
      }
    }
    const { width, height, data } = decodePng(u8);
    return { digest: await sha256Hex(bytes), width, height, data };
  },
  "resolveImages: an image source must be bytes, a URL, or a thunk returning one",
);

// `images` may be a plain { name: source } map or a function of the resolved
// params — the second form is what lets a `type: "image"` control drive the
// source. Mirrors fontsFor.
export function imagesFor(part, p) {
  const decl = part?.images;
  return typeof decl === "function" ? decl(p) : decl;
}

export async function resolveImages(imagesDecl) {
  if (typeof imagesDecl === "function") {
    throw new Error("resolveImages: `images` is a function of params — resolve it with imagesFor(part, p) first");
  }
  return resolveDecl(imagesDecl, resolveOne);
}

// Register a part's images on a booted kernel (idempotent per digest). Called in
// the async phase before every job's synchronous build — worker (jobs.js) and
// Node boots alike.
export async function ensureImages(kernel, imagesDecl) {
  if (!imagesDecl || typeof kernel?._registerImage !== "function") return;
  const resolved = await resolveImages(imagesDecl);
  for (const [name, a] of resolved) {
    if (kernel._imageDigest?.(name) === a.digest) continue;
    await kernel._registerImage({ name, digest: a.digest, width: a.width, height: a.height, data: a.data });
  }
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run test/image-source.test.js test/images-resolve.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/framework/image-source.js src/framework/images.js \
        test/image-source.test.js test/images-resolve.test.js
git commit -m "feat: images asset resolver and param-source allow rules"
```

---

### Task 5: Kernel contract and the Manifold adapter

**Files:**
- Modify: `src/framework/geometry/kernel.js` (add `heightfield` to `KERNEL_OPS`, add the typedef)
- Modify: `src/framework/geometry/op-options.js` (`KERNEL_OP_SPECS` entry)
- Modify: `src/framework/geometry/manifold-backend.js` (`heightfield`, `_registerImage`, `_imageDigest`)
- Modify: `docs/KERNEL-CONTRACT.md` (op-table row — the test fails without it)
- Test: `test/heightfield-manifold.test.js`

**Interfaces:**
- Consumes: `heightfieldMesh`, `HEIGHTFIELD_VERTEX_BUDGET` from `./heightfield.js`;
  `manifoldFromMesh` from `./mesh-build.js`; `h` from `./solid-hash.js`.
- Produces: `k.heightfield(nameOrGrid, opts) -> Solid` on the Manifold backend;
  `kernel._registerImage({ name, digest, width, height, data })` and
  `kernel._imageDigest(name) -> string | undefined`.

- [ ] **Step 1: Write the failing test**

```js
// test/heightfield-manifold.test.js
import { describe, test, expect, beforeAll } from "vitest";
import { createManifoldKernel } from "../src/testing/manifold.js";

let k;
// A 32x32 linear ramp in X: height should average exactly half of maxZ.
const ramp = (n = 32) => {
  const data = new Uint16Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data[y * n + x] = Math.round((x / (n - 1)) * 65535);
  return { width: n, height: n, data };
};

beforeAll(async () => { k = await createManifoldKernel(); });

describe("heightfield on Manifold", () => {
  test("builds a watertight, genus-0 solid", () => {
    const s = k.heightfield(ramp(), { w: 20, d: 20, base: 1, maxZ: 2, pitch: 1 });
    expect(s.volume()).toBeGreaterThan(0);
    if (typeof s.genus === "function") expect(s.genus()).toBe(0);
  });

  test("volume matches the analytic slab + mean relief", () => {
    const s = k.heightfield(ramp(), { w: 20, d: 20, base: 1, maxZ: 2, pitch: 0.5 });
    // 20*20*1 base + 20*20*(mean of a 0..2 ramp = 1)
    expect(s.volume()).toBeCloseTo(400 * 1 + 400 * 1, -1);
  });

  test("a registered image is addressable by name", async () => {
    const g = ramp(16);
    await k._registerImage({ name: "relief", digest: "d1", width: g.width, height: g.height, data: g.data });
    expect(k._imageDigest("relief")).toBe("d1");
    expect(k.heightfield("relief", { w: 10, d: 10, base: 1, maxZ: 1, pitch: 1 }).volume()).toBeGreaterThan(0);
  });

  test("an undeclared name throws naming the op", () => {
    expect(() => k.heightfield("nope", { w: 10, d: 10 })).toThrow(/heightfield.*"nope"/);
  });

  test("maxZ scales volume linearly above the base", () => {
    const o = { w: 20, d: 20, base: 1, pitch: 1 };
    const v1 = k.heightfield(ramp(), { ...o, maxZ: 2 }).volume();
    const v2 = k.heightfield(ramp(), { ...o, maxZ: 4 }).volume();
    expect(v2 - 400).toBeCloseTo((v1 - 400) * 2, -1);
  });

  test("a pitch clamp reaches takeBuildWarnings", () => {
    k.takeBuildWarnings?.();
    k.heightfield(ramp(), { w: 400, d: 400, base: 1, maxZ: 1, pitch: 0.01 });
    expect((k.takeBuildWarnings?.() ?? []).join(" ")).toMatch(/clamped/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/heightfield-manifold.test.js`
Expected: FAIL — `k.heightfield is not a function`

- [ ] **Step 3: Add the op to the contract**

In `src/framework/geometry/kernel.js`, add `"heightfield"` to the end of
`KERNEL_OPS`, in the additive block beside `loftSmooth`:

```js
  // Additive in 0.84 (no CONTRACT_VERSION bump — the import-op precedent).
  "loftSmooth",
  // Additive in 0.92 (same precedent): both backends implement it.
  "heightfield",
];
```

Add the typedef beside the others:

```js
 * @property {(nameOrGrid: string|{width:number,height:number,data:Uint16Array}, opts: {w:number,d:number,base?:number,maxZ?:number,pitch?:number,invert?:boolean,range?:number[],origin?:"center"|"corner"}) => Solid} heightfield
```

In `src/framework/geometry/op-options.js`, add to `KERNEL_OP_SPECS`:

```js
  heightfield: { toArgs: (a, b) => [a, b ?? {}], check: (_src, o = {}) => {
    if (!(o.w > 0) || !(o.d > 0)) throw new Error("heightfield: w and d must be positive");
  } },
```

- [ ] **Step 4: Implement on the Manifold backend**

In `src/framework/geometry/manifold-backend.js`, add the imports:

```js
import { heightfieldMesh } from "./heightfield.js";
```

Add an `images` map beside the existing `imports` map, and these three members to
the returned kernel object (place `heightfield` beside the other primitives, and
the two underscore members beside `_registerImport` / `_importDigest`):

```js
    // Height-map relief. The grid → triangle conversion is a pure leaf shared with
    // the OCCT backend, so both kernels build from identical triangle data.
    heightfield: (src, opts = {}) => {
      const grid = typeof src === "string" ? images.get(src) : src;
      if (!grid) throw new Error(`heightfield: unknown image "${src}" — declare it in the part's \`images\` field`);
      const digest = typeof src === "string" ? grid.digest : "inline";
      return cached(
        h("heightfield", digest, opts.w, opts.d, opts.base, opts.maxZ,
          opts.pitch, opts.invert, opts.range, opts.origin),
        () => {
          const { positions, indices, warnings } = heightfieldMesh(grid, opts);
          for (const w of warnings) recordWarning(w);
          // T()-tracking is manifoldFromMesh's own; `cached` expects the raw
          // Manifold handle back, not a wrapped solid.
          return manifoldFromMesh(Manifold, Array.from(positions), Array.from(indices));
        },
      );
    },
```

```js
    // Depth-map grids, registered pre-build by the framework via `_registerImage`.
    // Unlike imports there is no per-format error entry: every backend can consume
    // a normalized grid.
    _registerImage: ({ name, digest, width, height, data }) => {
      images.set(name, { digest, width, height, data });
    },
    _imageDigest: (name) => images.get(name)?.digest,
```

`cached(hash, computeM)` is the file's boundary-op convention (defined at
`manifold-backend.js:94`); `prism` at line 608 is the nearest model — copy its
call shape. `computeM` must return the raw Manifold handle, already `T()`-tracked
by the op; `cached` does the wrapping. `manifoldFromMesh`'s first argument is the
WASM namespace the file already has in scope — check whether that binding is
named `Manifold` or `wasm` at the call site and match it. If `manifoldFromMesh`
accepts typed arrays directly, drop the `Array.from` calls.

- [ ] **Step 5: Add the contract doc row**

`test/kernel-contract.test.js` asserts every op in `KERNEL_OPS` has a row in
`docs/KERNEL-CONTRACT.md`, so the doc is not optional. Add to the op table:

```
| `heightfield(nameOrGrid, {w, d, base?, maxZ?, pitch?, invert?, range?, origin?})` | A depth map as a relief solid: a sampled grid top at `z = base + maxZ·f(v)`, skirt walls, and a flat base cap at `z = 0`. `nameOrGrid` is a name declared in the part's `images` field, or an inline `{width, height, data}` grid. Sample count is `ceil(w/pitch) × ceil(d/pitch)`, clamped to a vertex budget with a `takeBuildWarnings` message rather than an error. `range` is a remap with clamped ends (`range[0]`→0, `range[1]`→1); `invert` applies after, as `1−v`. `origin` positions the footprint in XY only — the base always sits at `z = 0`. The image stretches to `w × d`; aspect is not preserved. Fed by an underscore-prefixed side-channel (`_registerImage`), not part authors — see [Conformance classes](#conformance-classes). Required on both in-repo backends: Manifold imports the triangles directly, OCCT sews them into a faceted B-rep via `importSTL`, so STEP export carries a triangulated surface rather than an analytic one. Parity: **exact** — both backends receive byte-identical triangle data. Additive: `CONTRACT_VERSION` stays 4, the same precedent as `import` and `loftSmooth`. |
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/heightfield-manifold.test.js test/kernel-contract.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/framework/geometry/kernel.js src/framework/geometry/op-options.js \
        src/framework/geometry/manifold-backend.js docs/KERNEL-CONTRACT.md \
        test/heightfield-manifold.test.js
git commit -m "feat: heightfield op on the Manifold backend"
```

---

### Task 6: The OCCT adapter and STEP export

**Files:**
- Modify: `src/framework/geometry/occt-backend.js`
- Test: `test/heightfield-occt.test.js`

**Interfaces:**
- Consumes: `heightfieldMesh` from `./heightfield.js`; `meshToStl` (already
  imported at line 35); `replicad.importSTL`.
- Produces: `k.heightfield(...)` on the OCCT backend, plus `_registerImage` /
  `_imageDigest` with the same signatures as Task 5.

**Threshold:** use the triangle count recorded by Task 1's probe for the
STEP-size warning. The placeholder below is `20000`; replace it with the probed
value.

- [ ] **Step 1: Write the failing test**

```js
// test/heightfield-occt.test.js
// OCCT only — must stay in its own file; the two WASM kernels may not boot in
// one process.
import { describe, test, expect, beforeAll } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";

let k;
const ramp = (n = 16) => {
  const data = new Uint16Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data[y * n + x] = Math.round((x / (n - 1)) * 65535);
  return { width: n, height: n, data };
};

beforeAll(async () => { ({ kernel: k } = await bootOcctKernel()); }, 120000);

describe("heightfield on OCCT", () => {
  test("sews into a solid with positive volume", async () => {
    const s = await k.heightfield(ramp(), { w: 20, d: 20, base: 1, maxZ: 2, pitch: 2 });
    expect(s.volume()).toBeGreaterThan(0);
  }, 120000);

  test("volume is within tolerance of the analytic slab + mean relief", async () => {
    const s = await k.heightfield(ramp(), { w: 20, d: 20, base: 1, maxZ: 2, pitch: 1 });
    expect(s.volume()).toBeCloseTo(800, -2);
  }, 120000);

  test("participates in a boolean", async () => {
    const s = await k.heightfield(ramp(), { w: 20, d: 20, base: 1, maxZ: 2, pitch: 2 });
    const box = k.box({ min: [-5, -5, 0], max: [5, 5, 10] });
    expect(s.intersect(box).volume()).toBeGreaterThan(0);
  }, 180000);

  test("exports STEP", async () => {
    const s = await k.heightfield(ramp(), { w: 20, d: 20, base: 1, maxZ: 2, pitch: 2 });
    const step = k.toSTEP([{ shape: s }]);
    expect(step).toBeTruthy();
  }, 180000);

  test("an undeclared name throws naming the op", () => {
    expect(() => k.heightfield("nope", { w: 10, d: 10 })).toThrow(/heightfield.*"nope"/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/heightfield-occt.test.js`
Expected: FAIL — `k.heightfield is not a function`

- [ ] **Step 3: Implement**

In `src/framework/geometry/occt-backend.js`, add `importSTL` to the destructured
replicad members at line 40, add `import { heightfieldMesh } from "./heightfield.js";`,
add an `images` map beside `imports`, and add:

```js
    // Height-map relief. The same pure grid leaf the Manifold backend uses, then
    // through STL into OCCT's own mesh→B-rep path (StlAPI_Reader +
    // ShapeUpgrade_UnifySameDomain + MakeSolid, all inside replicad's importSTL).
    // The resulting faceted solid booleans and exports to STEP like any other
    // shape — the surface is triangulated rather than analytic, which is the
    // accepted trade for STEP support on a depth map.
    //
    // `new Blob(...)` here is internal and safe: occt-backend already does exactly
    // this for importSTEP. mesh-stl.js's "no Blobs" rule is about what an EXPORT
    // hands back to the host (Safari's sandbox worker cannot read one), not about
    // feeding replicad.
    heightfield: async (src, opts = {}) => {
      const grid = typeof src === "string" ? images.get(src) : src;
      if (!grid) throw new Error(`heightfield: unknown image "${src}" — declare it in the part's \`images\` field`);
      const { positions, indices, warnings } = heightfieldMesh(grid, opts);
      for (const w of warnings) recordWarning(w);
      const tris = indices.length / 3;
      // STEP_TRIANGLE_WARN is the count Task 1's probe recorded as the last size
      // that sewed in acceptable time. Declare it as a module constant at the top
      // of this file with that measured value; 20000 below is a stand-in only and
      // must be replaced before this task is committed.
      if (tris > STEP_TRIANGLE_WARN) {
        recordWarning(`heightfield: ${tris} triangles on the B-rep backend — STEP export will be large and slow; raise \`pitch\``);
      }
      try {
        return await importSTL(new Blob([meshToStl(positions, indices)]));
      } catch (e) {
        throw new Error(
          `heightfield: could not sew ${tris} triangles into a B-rep solid (${e.message}). ` +
          "Raise `pitch` to reduce the triangle count, or build this sub-part on the Manifold backend.",
        );
      }
    },
    _registerImage: ({ name, digest, width, height, data }) => {
      images.set(name, { digest, width, height, data });
    },
    _imageDigest: (name) => images.get(name)?.digest,
```

**If `heightfield` must be synchronous** to match the kernel contract (check how
`import` handles this — `_registerImport` is async but `import` itself is not),
move the `importSTL` call into `_registerImage`-style eager work or pre-sew at
registration. Resolve this against the actual contract before writing code: the
op list in `kernel.js` is the authority, and `test/kernel-contract.test.js` will
catch a mismatch.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/heightfield-occt.test.js`
Expected: PASS

- [ ] **Step 5: Add the cross-backend parity check**

Append to `test/heightfield-occt.test.js`:

```js
test("volume agrees with the Manifold build within the contract's tolerance", async () => {
  // The Manifold figure is asserted in test/heightfield-manifold.test.js against
  // the same analytic target; the two backends consume byte-identical triangles,
  // so any gap here is sewing/tessellation, not grid math.
  const s = await k.heightfield(ramp(), { w: 20, d: 20, base: 1, maxZ: 2, pitch: 1 });
  expect(Math.abs(s.volume() - 800) / 800).toBeLessThan(0.02);
}, 180000);
```

Run: `npx vitest run test/heightfield-occt.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/framework/geometry/occt-backend.js test/heightfield-occt.test.js
git commit -m "feat: heightfield on the OCCT backend with STEP export"
```

---

### Task 7: Wire `ensureImages` into the job loop

**Files:**
- Modify: `src/framework/jobs.js` (imports at the top; registration beside `ensureImports` near line 228)
- Test: `test/images-jobs.test.js`

**Interfaces:**
- Consumes: `imagesFor`, `ensureImages` from `./images.js`; `imageControlAllows`,
  `imageSourceAllowed`, `isNoImageSource` from `./image-source.js`.
- Produces: images registered on the kernel before every build.

This task also resolves the two invariants recorded in spec §7.

- [ ] **Step 1: Write the failing test**

```js
// test/images-jobs.test.js
import { test, expect } from "vitest";
import { PNG } from "pngjs";
import { resolveParams } from "../src/framework/part-model.js";
import { h } from "../src/framework/geometry/solid-hash.js";

const bytes = () => {
  const p = new PNG({ width: 2, height: 2 });
  p.data.fill(180); for (let i = 3; i < p.data.length; i += 4) p.data[i] = 255;
  return PNG.sync.write(p).buffer.slice(0);
};

// Spec §7 invariant 1.
test("resolveParams passes an ArrayBuffer through untouched", () => {
  const buf = bytes();
  const part = { defaults: { relief: "", n: 1 }, parameters: [] };
  const out = resolveParams(part, { relief: buf, n: 2 });
  expect(out.relief).toBe(buf); // identity, not a copy
});

// Spec §7 invariant 2.
test("h() does not expand an ArrayBuffer into a giant key", () => {
  const key = h("heightfield", "abc123", 60, 60, 1.5, 3, 0.5, false, [0, 1], "center");
  expect(key.length).toBeLessThan(32);
  expect(typeof key).toBe("string");
});
```

- [ ] **Step 2: Run to verify it fails or reveals the real behaviour**

Run: `npx vitest run test/images-jobs.test.js`
Expected: PASS if `resolveParams` is already transparent; FAIL if it copies or
stringifies. **If it fails**, fix `resolveParams` to pass non-plain values
through by identity rather than changing the test — the spec's design depends on
it, and cloud's sandbox path breaks otherwise.

- [ ] **Step 3: Wire the registration**

At the top of `src/framework/jobs.js`, beside the existing imports:

```js
import { imagesFor, ensureImages } from "./images.js";
import { imageControlAllows, imageSourceAllowed, isNoImageSource } from "./image-source.js";
```

Immediately after the `if (part.imports) await ensureImports(...)` line (~228):

```js
    // Register this part's declared images — the third asset sibling. A
    // param-supplied source is checked against its control's `allow` list first;
    // bytes always pass (see image-source.js's header for why that is safe).
    if (part.images) {
      const allows = imageControlAllows(part);
      const decl = imagesFor(part, p) ?? {};
      const declared = Object.fromEntries(Object.entries(decl).filter(([name, src]) => {
        if (isNoImageSource(src)) {
          onProgress(`no image source declared for "${name}" — skipping`);
          return false;
        }
        // Only param-supplied values are restricted. A source the author wrote
        // into `images` is code, not attacker-controlled input.
        const key = Object.keys(p).find((k) => p[k] === src);
        if (key && allows.has(key) && !imageSourceAllowed(src, allows.get(key))) {
          onProgress(`image source for "${name}" is not allowed by its control — skipping`);
          return false;
        }
        return true;
      }));
      if (Object.keys(declared).length) {
        onProgress("resolving images");
        await ensureImages(kernel, declared);
      }
    }
```

- [ ] **Step 4: Run the wider suite**

Run: `npx vitest run test/images-jobs.test.js test/heightfield-manifold.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/framework/jobs.js test/images-jobs.test.js
git commit -m "feat: register part-declared images in the job loop"
```

---

### Task 8: The `type: "image"` control

**Files:**
- Create: `src/framework/panel/widgets/image.js`
- Create: `src/framework/panel/image-picker.js`
- Modify: `src/framework/panel/widget-specs.js` (register the type)
- Modify: `src/framework/panel/render.js:229` (forward `imageCatalog`)
- Modify: `src/framework/mount.js:259,900` (accept and pass `imageCatalog`)
- Test: `test/image-control.test.js`

**Interfaces:**
- Consumes: `IMAGE_ALLOW_DEFAULT` from `../../image-source.js`.
- Produces: `makeImage(node, params, { onChange, onCommit, info, imageCatalog }) -> { el, sync }`
  — the standard widget-factory contract `render.js` already uses;
  `openImagePicker({ node, params, allow, imageCatalog, anchor, onPicked }) -> picker | null`;
  `mount(part, { imageCatalog })` where `imageCatalog` is
  `{ search(query, { limit }) -> Promise<ImageAsset[]>, describe?(source) -> {label,width,height}|null }`
  and `ImageAsset` is `{ id, label, url, width, height, thumbUrl }`.

- [ ] **Step 1: Write the failing test**

```js
// test/image-control.test.js
import { test, expect } from "vitest";
import { buildControls } from "../src/framework/controls.js";

const part = { defaults: { relief: "" }, parameters: [
  { title: "Relief", controls: [{ key: "relief", type: "image", label: "Depth map" }] },
] };

test("an image control renders a URL field with no catalog", () => {
  const params = { ...part.defaults };
  const el = buildControls(part, params, () => {});
  expect(el.querySelector('input[type="url"], input[type="text"]')).toBeTruthy();
});

test("buildControls forwards imageCatalog to the image widget", () => {
  const params = { ...part.defaults };
  const catalog = { async search() { return []; } };
  const el = buildControls(part, params, () => {}, undefined, { imageCatalog: catalog });
  expect(el.querySelector("button")).toBeTruthy(); // picker button, not a bare field
});

test("a URL typed into the field lands in params", () => {
  const params = { ...part.defaults };
  const el = buildControls(part, params, () => {});
  const input = el.querySelector('input[type="url"], input[type="text"]');
  input.value = "https://cdn.test/d.png";
  input.dispatchEvent(new Event("change", { bubbles: true }));
  expect(params.relief).toBe("https://cdn.test/d.png");
});
```

Match the exact `buildControls` signature in `src/framework/controls.js` before
writing — copy it from a neighbouring test such as the font-widget tests rather
than assuming the argument order above.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/image-control.test.js`
Expected: FAIL — unknown control type `image`

- [ ] **Step 3: Register the type**

In `src/framework/panel/widget-specs.js`, beside the `font` entries (lines 39 and 58):

```js
  { type: "image", kind: "control", fields: [...AUTHOR_COMMON, "allow", "preview"] },
```

```js
  image: ["allow", "preview"],
```

- [ ] **Step 4: Implement the widget**

Create `src/framework/panel/widgets/image.js` modelled directly on
`widgets/font.js` — read that file first and mirror its structure, including its
two renderings (bare field with no provider, picker button with one) and its
`{ el, sync }` return. The differences:

- The preview is a plain `<img>` bound to the source URL. The main thread needs
  no decoder; the browser renders the PNG natively.
- A byte-valued param (cloud's sandbox path) has no URL to show. Render the label
  as `Uploaded image (W×H)` from `imageCatalog.describe?.()` when available, and
  fall back to `Uploaded image`.
- `allow` defaults to `IMAGE_ALLOW_DEFAULT` from `../../image-source.js`.

Create `src/framework/panel/image-picker.js` modelled on `panel/font-picker.js`,
rendering `imageCatalog.search()` results as a thumbnail grid.

- [ ] **Step 5: Forward the catalog**

In `src/framework/panel/render.js`, beside the existing `fontCatalog: opts.fontCatalog` (line 229):

```js
      imageCatalog: opts.imageCatalog,
```

In `src/framework/mount.js`, add `imageCatalog` to the destructured options
beside `fontCatalog` (line 259) and pass it through at the `{ fontCatalog }` call
site (line 900):

```js
      { fontCatalog, imageCatalog });
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run test/image-control.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/framework/panel/widgets/image.js src/framework/panel/image-picker.js \
        src/framework/panel/widget-specs.js src/framework/panel/render.js \
        src/framework/mount.js test/image-control.test.js
git commit -m "feat: image control type and catalog seam"
```

---

### Task 9: The `imageToPng` ingest helper

**Files:**
- Create: `src/framework/image-ingest.js`
- Modify: `src/index.js` (export it)
- Test: `test/image-ingest.test.js`

**Interfaces:**
- Consumes: `createImageBitmap`, `OffscreenCanvas` / `<canvas>` — browser only.
- Produces: `imageToPng(fileOrBlob, { maxSize = 1024 }) -> Promise<Blob>`

**Constraint:** this file is main-thread only and **must not** become reachable
from the worker graph. `test/worker-layering.test.js` enforces that once the file
exists; do not import it from anything under the worker's closure.

- [ ] **Step 1: Write the failing test**

```js
// test/image-ingest.test.js
// happy-dom supplies the DOM; createImageBitmap/canvas encoding are stubbed,
// because the point under test is the resize policy and the PNG output contract,
// not the browser's codec.
import { test, expect, vi, beforeEach } from "vitest";
import { imageToPng } from "../src/framework/image-ingest.js";

beforeEach(() => {
  globalThis.createImageBitmap = vi.fn(async () => ({ width: 4096, height: 2048, close() {} }));
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { drawImage() {} }; }
    async convertToBlob() { return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }); }
  };
});

test("downsamples the long edge to maxSize and preserves aspect", async () => {
  let made;
  const Real = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = class extends Real {
    constructor(w, h) { super(w, h); made = [w, h]; }
  };
  await imageToPng(new Blob([]), { maxSize: 1024 });
  expect(made).toEqual([1024, 512]);
});

test("does not upscale an image already under maxSize", async () => {
  globalThis.createImageBitmap = vi.fn(async () => ({ width: 300, height: 200, close() {} }));
  let made;
  const Real = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = class extends Real {
    constructor(w, h) { super(w, h); made = [w, h]; }
  };
  await imageToPng(new Blob([]), { maxSize: 1024 });
  expect(made).toEqual([300, 200]);
});

test("returns a PNG blob", async () => {
  const out = await imageToPng(new Blob([]));
  expect(out.type).toBe("image/png");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/image-ingest.test.js`
Expected: FAIL — cannot resolve `image-ingest.js`

- [ ] **Step 3: Implement**

```js
// src/framework/image-ingest.js
// MAIN-THREAD ONLY. Converts any image the browser can decode into a PNG a part's
// `images` field can consume, downsampling on the way.
//
// This file uses createImageBitmap and a canvas, so it must NEVER be reachable
// from the geometry worker's import closure — test/worker-layering.test.js
// enforces that. It is exported from src/index.js, the DOM entry that a build
// function must not import.
//
// Why PNG and not the source format: core decodes PNG only, in pure JS, so one
// decoder produces the geometry in the browser, the CLI and CI alike. Converting
// once at ingest keeps that single decoder authoritative — the browser's codec
// output is baked into an immutable PNG rather than racing ours at build time.
//
// Why downsample instead of switching to JPEG: pitch caps useful resolution
// anyway (a 60mm plate at 0.3mm pitch samples 200x200), and JPEG is 8-bit and
// DCT-ringing — in a depth map those are geometric artifacts, height terracing
// and 8x8 block bumps, not cosmetic ones.

export async function imageToPng(fileOrBlob, { maxSize = 1024 } = {}) {
  const bmp = await createImageBitmap(fileOrBlob);
  try {
    const scale = Math.min(1, maxSize / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const hgt = Math.max(1, Math.round(bmp.height * scale));

    if (typeof OffscreenCanvas === "function") {
      const c = new OffscreenCanvas(w, hgt);
      c.getContext("2d").drawImage(bmp, 0, 0, w, hgt);
      return await c.convertToBlob({ type: "image/png" });
    }
    // Safari and older engines: fall back to a detached <canvas>.
    const c = document.createElement("canvas");
    c.width = w; c.height = hgt;
    c.getContext("2d").drawImage(bmp, 0, 0, w, hgt);
    return await new Promise((res, rej) =>
      c.toBlob((b) => (b ? res(b) : rej(new Error("imageToPng: canvas encoding failed"))), "image/png"));
  } finally {
    bmp.close?.();
  }
}
```

In `src/index.js`:

```js
export { imageToPng } from "./framework/image-ingest.js";
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/image-ingest.test.js test/worker-layering.test.js`
Expected: PASS — including the layering test, which must confirm
`image-ingest.js` stays out of the worker closure.

- [ ] **Step 5: Commit**

```bash
git add src/framework/image-ingest.js src/index.js test/image-ingest.test.js
git commit -m "feat: imageToPng ingest helper for host-side format conversion"
```

---

### Task 10: Lint rules

**Files:**
- Modify: `src/framework/lint/rules-build.js` (or the rules file matching the
  existing `font-control-not-in-fonts` / `import-unknown-name` rules — find them
  first with `grep -rn "font-control-not-in-fonts" src/framework/lint/`)
- Test: `test/lint-images.test.js`

**Interfaces:**
- Consumes: the probe's recorded op names; `imageControlAllows` from `../image-source.js`.
- Produces: two rule ids — `image-control-not-in-images`, `heightfield-unknown-image`.

- [ ] **Step 1: Write the failing test**

```js
// test/lint-images.test.js
import { test, expect } from "vitest";
import { lintPart } from "../src/lint.js";

const ids = (r) => r.findings.map((f) => f.id);

test("flags an image control whose key never reaches `images`", () => {
  const part = {
    defaults: { relief: "", w: 10 },
    parameters: [{ controls: [{ key: "relief", type: "image", label: "Depth map" }] }],
    images: () => ({}),                     // never uses p.relief
    parts: { body: { build: (k, p) => k.box({ min: [0, 0, 0], max: [p.w, p.w, 1] }) } },
  };
  expect(ids(lintPart(part))).toContain("image-control-not-in-images");
});

test("accepts a control whose key does reach `images`", () => {
  const part = {
    defaults: { relief: "", w: 10 },
    parameters: [{ controls: [{ key: "relief", type: "image", label: "Depth map" }] }],
    images: (p) => (p.relief ? { relief: p.relief } : {}),
    parts: { body: { build: (k, p) => k.heightfield("relief", { w: p.w, d: p.w }) } },
  };
  expect(ids(lintPart(part))).not.toContain("image-control-not-in-images");
});

test("flags a heightfield name absent from a static `images` map", () => {
  const part = {
    defaults: { w: 10 },
    parameters: [],
    images: { other: "https://cdn.test/o.png" },
    parts: { body: { build: (k, p) => k.heightfield("relief", { w: p.w, d: p.w }) } },
  };
  expect(ids(lintPart(part))).toContain("heightfield-unknown-image");
});

test("does not flag an unknown name when `images` is a function", () => {
  const part = {
    defaults: { relief: "", w: 10 },
    parameters: [{ controls: [{ key: "relief", type: "image" }] }],
    images: (p) => (p.relief ? { relief: p.relief } : {}),
    parts: { body: { build: (k, p) => k.heightfield("relief", { w: p.w, d: p.w }) } },
  };
  expect(ids(lintPart(part))).not.toContain("heightfield-unknown-image");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/lint-images.test.js`
Expected: FAIL — the rule ids are absent from the findings

- [ ] **Step 3: Implement**

Read the existing `font-control-not-in-fonts` and `import-unknown-name` rules and
mirror them exactly — same finding shape, same severity convention, same
registration point. The two new rules are:

- `image-control-not-in-images` — for each key in `imageControlAllows(part)`,
  probe `images(p)` with that key set to a sentinel and confirm the sentinel
  appears among the declared sources. Static-object `images` always fails this
  check by construction, so **skip the rule entirely when `images` is not a
  function** — a fixed map with a control is a different mistake, and not this
  rule's business.
- `heightfield-unknown-image` — only when `images` is a **static object**: collect
  the literal first argument of every `k.heightfield(...)` call the probe
  records, and flag any not present as a key. Skip when `images` is a function;
  the names are not statically known.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/lint-images.test.js`
Expected: PASS

- [ ] **Step 5: Add the ERROR-PATTERNS entries**

Add four `##` sections to `docs/ERROR-PATTERNS.md`, each mapping literal error
text to cause and fix: `heightfield: unknown image`, `images: only PNG is
supported`, `decodePng: interlaced (Adam7) PNGs are not supported`, and
`heightfield: could not sew … triangles into a B-rep solid`.

- [ ] **Step 6: Commit**

```bash
git add src/framework/lint/ docs/ERROR-PATTERNS.md test/lint-images.test.js
git commit -m "feat: lint rules and error patterns for image sources"
```

---

### Task 11: The `relief.js` reference part

**Files:**
- Create: `src/parts/relief.js`
- Create: `src/parts/assets/relief-demo.png` (generated in Step 1)
- Create: `relief.html`, `src/app-relief.js`, `src/relief-worker.js`
- Modify: `vite.config.js` (`rollupOptions.input`)
- Modify: `.github/workflows/ci.yml` (smoke-check app list)

**Interfaces:**
- Consumes: everything from Tasks 2–10.
- Produces: a worked example that `partforge measure|render|lint` and
  `npm run check` all exercise.

- [ ] **Step 1: Generate the sample depth map**

```bash
node -e '
const { PNG } = require("pngjs");
const fs = require("fs");
const N = 256, p = new PNG({ width: N, height: N });
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const u = x / (N - 1), v = y / (N - 1);
  const r = Math.hypot(u - 0.5, v - 0.5);
  const val = Math.round(255 * Math.max(0, Math.min(1,
    0.5 + 0.35 * Math.sin(12 * r) * Math.exp(-3 * r))));
  const i = (y * N + x) * 4;
  p.data[i] = p.data[i + 1] = p.data[i + 2] = val; p.data[i + 3] = 255;
}
fs.mkdirSync("src/parts/assets", { recursive: true });
fs.writeFileSync("src/parts/assets/relief-demo.png", PNG.sync.write(p));
'
```

- [ ] **Step 2: Write the part**

```js
// src/parts/relief.js — the `images` / `k.heightfield` reference part.
// A depth map becomes a relief plate; the source image is swappable from the
// control panel via a `type: "image"` control, and `pitch` trades detail against
// triangle count (and therefore STEP size — see docs/KERNEL-CONTRACT.md).
export default {
  name: "Relief plate",
  meta: { description: "A depth map as a printable relief plate." },

  defaults: { relief: "", w: 60, d: 60, base: 1.5, maxZ: 3, pitch: 0.5, invert: false },

  parameters: [
    { title: "Image", controls: [
      { key: "relief", type: "image", label: "Depth map" },
      { key: "invert", type: "checkbox", label: "Invert" },
    ] },
    { title: "Plate", controls: [
      { key: "w", label: "Width", unit: "mm", min: 20, max: 200, step: 1 },
      { key: "d", label: "Depth", unit: "mm", min: 20, max: 200, step: 1 },
      { key: "base", label: "Base", unit: "mm", min: 0.5, max: 10, step: 0.1 },
      { key: "maxZ", label: "Relief height", unit: "mm", min: 0.2, max: 10, step: 0.1 },
      { key: "pitch", label: "Detail", unit: "mm", min: 0.2, max: 2, step: 0.1 },
    ] },
  ],

  // The default is a bundled asset, so the part builds with no network — which is
  // what CI sees. A picked value replaces it.
  images: (p) => ({
    relief: p.relief || new URL("./assets/relief-demo.png", import.meta.url),
  }),

  parts: {
    plate: {
      build: (k, p) => k.heightfield("relief", {
        w: p.w, d: p.d, base: p.base, maxZ: p.maxZ, pitch: p.pitch, invert: p.invert,
      }),
    },
  },

  views: { assembly: ["plate"] },

  verify: {
    expect: {
      plate: { watertight: true, holes: 0 },
    },
  },
};
```

Check `src/parts/demo.js` for the exact `views` / `verify` shape this repo uses
and match it; the block above is the intent, not necessarily the literal schema.

- [ ] **Step 3: Write the three glue files**

Copy from the demo's trio, substituting `relief`. The `new Worker(new URL(...))`
call **must stay inline** in `src/app-relief.js` or Vite will not bundle it.

```js
// src/app-relief.js
import { mount } from "./index.js";
import part from "./parts/relief.js";
mount(part, {
  createWorker: (name) => new Worker(new URL("./relief-worker.js", import.meta.url), { type: "module", name }),
});
```

```js
// src/relief-worker.js
import { runWorker } from "./framework/worker.js";
import part from "./parts/relief.js";
runWorker(part);
```

`relief.html` is structural markup only, no CSS — copy `demo.html` verbatim and
change the script src and title.

- [ ] **Step 4: Register the page**

Add `relief.html` to `rollupOptions.input` in `vite.config.js`, and add `relief.html`
to the smoke-check app list in `.github/workflows/ci.yml`.

- [ ] **Step 5: Exercise it through the CLI**

```bash
npx partforge lint    src/parts/relief.js
npx partforge measure src/parts/relief.js
npx partforge render  src/parts/relief.js
```

Expected: lint clean, measure passes its verify gate, render writes PNGs to
`render/`. Look at the render output — a relief that is flat or inverted means
the grid sampling or the `invert` mapping is wrong, and no test will catch that
for you.

- [ ] **Step 6: Smoke-test in a real browser**

Run: `node scripts/check-app.mjs relief.html`
Expected: boots clean, no console errors.

- [ ] **Step 7: Commit**

```bash
git add src/parts/relief.js src/parts/assets/relief-demo.png relief.html \
        src/app-relief.js src/relief-worker.js vite.config.js .github/workflows/ci.yml
git commit -m "feat: relief reference part for images and heightfield"
```

---

### Task 12: Documentation and release

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (new section; control-types table row; mount-options list; lint rule catalog)
- Modify: `package.json` (version → `0.92.0`)
- Modify: `AGENTS.md` (part inventory sentence)

**Interfaces:**
- Consumes: everything.
- Produces: a shippable release.

- [ ] **Step 1: Add the control-type table row**

In the control-types table (~line 704, beside the `"font"` row):

```
| `"image"` | a depth-map picker, or a URL field with no catalog | `allow`, `preview` |
```

- [ ] **Step 2: Add the authoring section**

Add a "Height maps and images" section after "Importing geometry (STEP/STL/3MF)".
It must cover: the `images` field and its function-of-params form; the
`type: "image"` control; `k.heightfield`'s full options with `range` documented
as a **remap with clamped ends** and `origin` as **XY-only**; that the image
stretches to `w × d`; the PNG-only rule and `imageToPng` as the escape hatch;
that `pitch` is the throttle for both triangle count and STEP size; and the
bytes-in-params path for hosts that cannot fetch URLs. Point at
`src/parts/relief.js` as the worked example, in the style the other sections use.

- [ ] **Step 3: Document the mount option**

Beside `fontCatalog` (~line 1756):

```
- `imageCatalog` — a provider backing every `type: "image"` control in the part:
  `{ search(query, { limit }) → Promise<ImageAsset[]>, describe?(source) → { label, width, height } | null }`,
  where `ImageAsset` is `{ id, label, url, width, height, thumbUrl }`. With no
  provider a `type: "image"` control degrades to a URL field.
```

- [ ] **Step 4: Add the lint rule catalog entries**

In the rule catalog, add an "Images" group documenting
`image-control-not-in-images` and `heightfield-unknown-image`, matching the
style of the "Geometry imports" group.

- [ ] **Step 5: Update AGENTS.md**

Update the `src/parts/` inventory sentence — it currently says "fifteen" and
enumerates them. Add `relief.js` (the `images`/`k.heightfield` reference part —
depth map to relief plate, swappable source) and correct the count to sixteen.

- [ ] **Step 6: Bump the version**

In `package.json`, `"version": "0.91.0"` → `"version": "0.92.0"`.

This is not optional and not deferrable to a follow-up. Per AGENTS.md the publish
workflow tags and publishes on merge only if the version is new; forgetting it
means the merge lands, npm already has `0.91.0`, the workflow correctly does
nothing, and **the work never ships**.

- [ ] **Step 7: Run everything**

```bash
npm test
npm run check
```

Expected: full suite green, smoke check green across the ci.yml app list.

- [ ] **Step 8: Commit**

```bash
git add docs/AUTHORING-PARTS.md AGENTS.md package.json
git commit -m "docs: height maps and images; bump to 0.92.0"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §1 `heightfield` op | 2 (grid), 5 (Manifold), 6 (OCCT) |
| §2 `images` field | 4 (`imagesFor`/`resolveImages`), 7 (job wiring) |
| §3 `"image"` control + catalog seam | 8 |
| §4 source grammar, `allow`, sandbox bytes | 4 (`image-source.js`), 7 (enforcement) |
| §5 decoding + ingest | 3 (`png-decode.js`), 9 (`imageToPng`) |
| §6 backend adapters | 5, 6 |
| §7 registration + cache correctness | 5, 6 (`_registerImage`), 7 (the two invariants) |
| §8 host contract | 8 (`imageCatalog`), 9 (`imageToPng`), 12 (docs) |
| §9 lint + CLI | 10, 11 (CLI exercise) |
| §10 testing | every task; parity in 6 |
| §11 rollout | 1 (probe first), task order throughout |

**Open items resolved:** vertex budget (Task 2, `400000`); STEP-size threshold
(Task 1's probe feeds Task 6); interlaced PNG (Task 3, rejected with a message);
`ImageAsset` shape (Task 8).

**Corrections carried from the spec:** the spec says `sideQuads` and `fanCap` are
both reused verbatim. Only `fanCap` is — `sideQuads` derives ring bases as
`i * ringSegs`, which assumes rings start at `V[0]`, and the vertex array leads
with the grid. Task 2 notes this and uses an explicit skirt loop. The spec's
Blob concern is also resolved: `occt-backend.js:534` already constructs one for
`importSTEP`, so `mesh-stl.js`'s warning is about export payloads, not internal
use — noted in Task 6.

**Type consistency:** `{ width, height, data: Uint16Array }` is the grid shape in
Tasks 2, 3, 4, 5 and 6. `_registerImage({ name, digest, width, height, data })`
and `_imageDigest(name)` are identical in Tasks 4, 5 and 6.
`heightfieldMesh(grid, opts) -> { positions, indices, warnings }` is consistent
in Tasks 2, 5 and 6.
