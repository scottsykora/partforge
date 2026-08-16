# Geometry Import (STEP / STL / 3MF) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parts can declare `imports: { name: source }` (STEP/STL/3MF files) and use `k.import(name)` in build as an ordinary `Solid` — for ghost references the oracle measures and deviation-gates, and for real bodies in booleans/transforms/exports.

**Architecture:** Fonts-style async asset resolution before the synchronous build; per-backend native parsing (STEP→B-rep on OCCT, STL/3MF→mesh on Manifold) registered into a kernel side-channel — registration is total and unusable formats become lazy error entries thrown at `k.import()` call time (spec: "Registration is total; errors are lazy"); a lazy `needs-import-mesh` → `tessellate-imports` → `prime-imports` crossover for STEP used on the Manifold backend (worker_threads in Node); deviation facts in measure() gated by three new `ref*` verify metrics.

**Tech Stack:** plain ESM, vitest, manifold-3d (`Manifold.ofMesh`), replicad (`importSTEP`), fflate (3MF zip), `node:worker_threads` (Node crossover only, in `src/testing/`).

**Spec:** `docs/superpowers/specs/2026-08-16-geometry-import-design.md` — read it first; this plan argues from it.

## Global Constraints

- **Node 24 required.** `source nvm.sh` is blocked in the sandbox; prefix PATH instead: `export PATH="$(ls -d ~/.nvm/versions/node/v24* | tail -1)/bin:$PATH"` before any npm/npx/node command.
- **Base branch prerequisite:** this work builds on per-sub-part backend routing (`detectBackends`, per-backend generate grouping — branch `claude/per-subpart-routing`, expected on main before execution). Rebase `claude/geometry-import-design` onto main first; if `src/framework/backend-select.js` lacks `detectBackends`, STOP and report.
- Units are millimetres everywhere.
- `src/framework/` (including `geometry/` and `oracle/`) stays DOM-free and `node:`-free — `test/worker-layering.test.js` enforces it. Node-only code goes in `src/testing/` or `bin/`.
- OCCT and Manifold must never boot in the same process/isolate: OCCT-booting tests live in their own test files; Node crossover uses `worker_threads`.
- `partforge/lint` stays pure (no I/O, no async, no kernel imports) — `test/lint-purity.test.js` enforces it.
- Never run `npm publish` or tag; the version bump in Task 16 is the release.
- On any build/test failure, grep `docs/ERROR-PATTERNS.md` for the symptom first.
- Commit after each task (feature branch `claude/geometry-import-design`).

---

### Task 1: Rebase + baseline

**Files:** none created; branch state only.

- [ ] **Step 1: Rebase onto main and verify the prerequisite**

```bash
git fetch origin && git rebase origin/main
grep -n "export function detectBackends" src/framework/backend-select.js
```

Expected: rebase succeeds (the branch has only docs commits); grep finds the function. If the grep fails, per-sub-part routing hasn't merged — STOP and report to the user.

- [ ] **Step 2: Install and baseline**

```bash
export PATH="$(ls -d ~/.nvm/versions/node/v24* | tail -1)/bin:$PATH"
npm install && npm test
```

Expected: full suite green. If not, report failures before proceeding.

---

### Task 2: Import resolution (`resolveImports`)

**Files:**
- Create: `src/framework/imports.js`
- Test: `test/imports.test.js`

**Interfaces:**
- Produces: `detectFormat(source, bytes) → "step"|"stl"|"3mf"` (throws on unrecognized); `resolveImports(importsDecl) → Promise<Map<name, { bytes: ArrayBuffer, digest: string, format: string }>>` (digest = SHA-256 hex). Also `ensureImports` — added in Task 8, same file.
- Consumes: the source grammar of `src/framework/fonts.js` (bytes | URL string | `URL` | thunk) — copy its `toBuffer`/module-shape handling.

- [ ] **Step 1: Write failing tests**

```js
// test/imports.test.js
import { describe, it, expect } from "vitest";
import { detectFormat, resolveImports } from "../src/framework/imports.js";

const enc = (s) => new TextEncoder().encode(s);

describe("detectFormat", () => {
  it("detects by extension from a URL", () => {
    expect(detectFormat(new URL("file:///a/scan.STEP"), null)).toBe("step");
    expect(detectFormat("https://x/y/part.stl?sig=abc", null)).toBe("stl");
    expect(detectFormat(new URL("file:///a/b.3mf"), null)).toBe("3mf");
  });
  it("falls back to magic bytes for byte sources", () => {
    expect(detectFormat(null, enc("ISO-10303-21;\nHEADER;"))).toBe("step");
    expect(detectFormat(null, Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe("3mf");
    expect(detectFormat(null, enc("solid cube\nfacet normal 0 0 1"))).toBe("stl");
    expect(detectFormat(null, new Uint8Array(100))).toBe("stl"); // binary STL default
  });
  it("throws on an unrecognizable empty source", () => {
    expect(() => detectFormat(null, new Uint8Array(0))).toThrow(/unrecognized import format/);
  });
});

describe("resolveImports", () => {
  it("resolves bytes and thunks, stamps digest + format", async () => {
    const stl = enc("solid t\nendsolid t\n");
    const m = await resolveImports({ a: stl, b: () => stl.slice() });
    expect(m.get("a").format).toBe("stl");
    expect(m.get("a").digest).toMatch(/^[0-9a-f]{64}$/);
    expect(m.get("a").digest).toBe(m.get("b").digest); // same content, same digest
  });
  it("memoizes by source identity", async () => {
    let calls = 0;
    const src = () => { calls++; return enc("solid m\nendsolid m\n"); };
    await resolveImports({ x: src });
    await resolveImports({ x: src });
    expect(calls).toBe(1);
  });
  it("returns an empty map for a missing decl", async () => {
    expect((await resolveImports(undefined)).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/imports.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// src/framework/imports.js
// Resolve a part's declared `imports` ({ name: source }) to bytes + a SHA-256
// content digest + a detected format, before the synchronous build — the exact
// sibling of fonts.js (same source grammar, same identity-memoization rule:
// import sources are content-stable for a session). DOM-free and node:-free;
// crypto.subtle exists in workers and Node.
const cache = new Map(); // source → Promise<{bytes, digest, format}>

function toBuffer(v) {
  if (v instanceof ArrayBuffer) return v;
  if (ArrayBuffer.isView(v)) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
  return null;
}

const EXT = { step: "step", stp: "step", stl: "stl", "3mf": "3mf" };

export function detectFormat(source, bytes) {
  const path = source instanceof URL ? source.pathname : typeof source === "string" ? source.split("?")[0] : null;
  const ext = path?.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
  if (ext && EXT[ext]) return EXT[ext];
  const u8 = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  if (u8 && u8.length > 0) {
    const head = String.fromCharCode(...u8.slice(0, 64));
    if (head.startsWith("ISO-10303-21")) return "step";
    if (u8[0] === 0x50 && u8[1] === 0x4b) return "3mf"; // zip signature
    return "stl"; // ascii "solid …" and binary STL both land here
  }
  throw new Error(`unrecognized import format${path ? ` for "${path}"` : ""} — use a .step/.stl/.3mf extension or non-empty bytes`);
}

async function sha256Hex(bytes) {
  const d = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function resolveOne(source) {
  if (cache.has(source)) return cache.get(source);
  const p = (async () => {
    let v = source;
    if (typeof v === "function") v = await v();
    if (v && typeof v === "object" && "default" in v && !toBuffer(v) && !(v instanceof URL)) v = v.default;
    let bytes = toBuffer(v);
    if (!bytes) {
      if (v instanceof URL || typeof v === "string") bytes = await (await fetch(v)).arrayBuffer();
      else throw new Error("resolveImports: an import source must be bytes, a URL, or a thunk returning one");
    }
    const format = detectFormat(source instanceof URL || typeof source === "string" ? source : v, bytes);
    return { bytes, digest: await sha256Hex(bytes), format };
  })();
  cache.set(source, p);
  return p;
}

export async function resolveImports(importsDecl) {
  const out = new Map();
  if (!importsDecl) return out;
  await Promise.all(Object.entries(importsDecl).map(async ([name, src]) => out.set(name, await resolveOne(src))));
  return out;
}
```

Note: `fetch` on `file:` URLs does not work in Node — that's handled by `nodeAssetSources` in Task 10, never here (this file must stay `node:`-free).

- [ ] **Step 4: Run to verify pass** — `npx vitest run test/imports.test.js` → PASS.
- [ ] **Step 5: Commit** — `git add src/framework/imports.js test/imports.test.js && git commit -m "feat: import asset resolution (bytes + digest + format)"`

---

### Task 3: STL parser

**Files:**
- Create: `src/framework/geometry/stl-parse.js`
- Test: `test/stl-parse.test.js`

**Interfaces:**
- Produces: `parseStl(bytes: ArrayBuffer|Uint8Array) → { positions: Float32Array, indices: Uint32Array }` — triangle soup (indices are 0..3n−1; welding happens later in `Manifold.Mesh.merge()`).
- Consumes: `meshToStl(positions, indices)` from `src/framework/geometry/mesh-stl.js` (round-trip tests).

- [ ] **Step 1: Write failing tests**

```js
// test/stl-parse.test.js
import { describe, it, expect } from "vitest";
import { parseStl } from "../src/framework/geometry/stl-parse.js";
import { meshToStl } from "../src/framework/geometry/mesh-stl.js";

const TRI = { // one right triangle in the z=0 plane
  positions: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0]),
  indices: Uint32Array.from([0, 1, 2]),
};

describe("parseStl", () => {
  it("round-trips the binary writer", () => {
    const bin = meshToStl(TRI.positions, TRI.indices);
    const { positions, indices } = parseStl(bin);
    expect(indices.length).toBe(3);
    expect([...positions]).toEqual([...TRI.positions]);
  });
  it("parses ascii STL", () => {
    const ascii = `solid tri
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 10 0 0
      vertex 0 10 0
    endloop
  endfacet
endsolid tri
`;
    const { positions, indices } = parseStl(new TextEncoder().encode(ascii));
    expect(indices.length).toBe(3);
    expect(positions[3]).toBe(10);
  });
  it("rejects a truncated binary file", () => {
    const bin = new Uint8Array(meshToStl(TRI.positions, TRI.indices)).slice(0, 100);
    expect(() => parseStl(bin)).toThrow(/truncated/i);
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run test/stl-parse.test.js` → FAIL.
- [ ] **Step 3: Implement**

```js
// src/framework/geometry/stl-parse.js
// Pure-JS STL reader (ascii + binary), the read twin of mesh-stl.js's writer.
// Returns triangle soup: positions x,y,z per vertex, indices 0..3n-1. Vertex
// welding is deliberately NOT done here — Manifold's Mesh.merge() welds at
// import (mesh-build.js), and the soup keeps this parser trivial and exact.
const u8of = (b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b);

function isAscii(u8) {
  // "solid" prefix is not enough (binary files sometimes start with it);
  // require an ascii "facet" token in the first 1 KB too.
  const head = String.fromCharCode(...u8.slice(0, 1024));
  return head.trimStart().startsWith("solid") && head.includes("facet");
}

export function parseStl(bytes) {
  const u8 = u8of(bytes);
  return isAscii(u8) ? parseAscii(u8) : parseBinary(u8);
}

function parseAscii(u8) {
  const text = new TextDecoder().decode(u8);
  const V = [];
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  for (let m; (m = re.exec(text)); ) V.push(Number(m[1]), Number(m[2]), Number(m[3]));
  if (V.length === 0 || V.length % 9 !== 0)
    throw new Error(`ascii STL parse failed: ${V.length / 3} vertices (not a multiple of 3)`);
  return soup(Float32Array.from(V));
}

function parseBinary(u8) {
  if (u8.length < 84) throw new Error("binary STL truncated: shorter than the 84-byte header");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = dv.getUint32(80, true);
  if (u8.length < 84 + n * 50) throw new Error(`binary STL truncated: header says ${n} triangles, file has ${Math.floor((u8.length - 84) / 50)}`);
  const positions = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12; // skip the facet normal
    for (let j = 0; j < 9; j++) positions[i * 9 + j] = dv.getFloat32(o + j * 4, true);
  }
  return soup(positions);
}

const soup = (positions) => ({
  positions,
  indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i),
});
```

- [ ] **Step 4: Verify pass** — `npx vitest run test/stl-parse.test.js` → PASS.
- [ ] **Step 5: Commit** — `git add src/framework/geometry/stl-parse.js test/stl-parse.test.js && git commit -m "feat: STL reader (ascii + binary)"`

---

### Task 4: 3MF parser

**Files:**
- Create: `src/framework/geometry/threemf-parse.js`
- Test: `test/threemf-parse.test.js`
- Read first: `src/framework/geometry/threemf.js` (the writer — mirror its zip layout and model XML shape).

**Interfaces:**
- Produces: `parse3MF(bytes) → { positions: Float32Array, indices: Uint32Array }` — all build items merged into one mesh, transforms applied, unit-scaled to mm.
- Consumes: `fflate`'s `unzipSync` (already a dependency via the writer); `meshTo3MF(meshes)` from `threemf.js` for round-trip tests.

- [ ] **Step 1: Write failing tests**

```js
// test/threemf-parse.test.js
import { describe, it, expect } from "vitest";
import { parse3MF } from "../src/framework/geometry/threemf-parse.js";
import { meshTo3MF } from "../src/framework/geometry/threemf.js";

const QUAD = { // unit square, two triangles
  name: "q",
  positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
};

describe("parse3MF", () => {
  it("round-trips the writer", () => {
    const { positions, indices } = parse3MF(meshTo3MF([QUAD]));
    expect(indices.length).toBe(6);
    expect(positions.length).toBe(12);
    expect(positions[3]).toBeCloseTo(1);
  });
  it("scales non-mm units to mm", () => {
    // Take the writer's output and rewrite unit="millimeter" → unit="centimeter".
    // Unzip/rezip via fflate inside the test, or regex the model bytes if the
    // writer stores uncompressed — read threemf.js to pick the simpler path.
    // Expected: every coordinate ×10.
  });
  it("throws when no 3D model part exists", () => {
    expect(() => parse3MF(new TextEncoder().encode("PK\x03\x04garbage"))).toThrow(/3mf/i);
  });
});
```

Fill in the unit test's body against the writer's real layout (it may store the model at `3D/3dmodel.model`; confirm by reading `threemf.js`).

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement**

```js
// src/framework/geometry/threemf-parse.js
// Minimal 3MF reader: unzip (fflate), find the .model XML, extract vertices,
// triangles, per-item transforms and the model unit; merge every build item
// into one soup-free indexed mesh in millimetres. Regex-based extraction, NOT
// a DOM parse — workers have no DOMParser and the worker graph must stay
// DOM-free. Scope: geometry only (materials/colors/beam lattices ignored).
import { unzipSync } from "fflate";

const UNIT_MM = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

export function parse3MF(bytes) {
  const u8 = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let files;
  try { files = unzipSync(u8); } catch (e) { throw new Error(`3mf import: not a readable zip archive (${e?.message || e})`); }
  const modelPath = Object.keys(files).find((f) => f.toLowerCase().endsWith(".model"));
  if (!modelPath) throw new Error("3mf import: archive has no 3D model part (*.model)");
  const xml = new TextDecoder().decode(files[modelPath]);

  const unit = xml.match(/<model\b[^>]*\bunit="([^"]+)"/)?.[1] ?? "millimeter";
  const scale = UNIT_MM[unit];
  if (!scale) throw new Error(`3mf import: unknown unit "${unit}"`);

  // objects: id → { positions:number[], indices:number[] }
  const objects = new Map();
  const objRe = /<object\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/object>/g;
  for (let m; (m = objRe.exec(xml)); ) {
    const [, id, body] = m;
    const P = [], I = [];
    const vRe = /<vertex\b[^>]*\bx="([^"]+)"[^>]*\by="([^"]+)"[^>]*\bz="([^"]+)"/g;
    for (let v; (v = vRe.exec(body)); ) P.push(+v[1] * scale, +v[2] * scale, +v[3] * scale);
    const tRe = /<triangle\b[^>]*\bv1="(\d+)"[^>]*\bv2="(\d+)"[^>]*\bv3="(\d+)"/g;
    for (let t; (t = tRe.exec(body)); ) I.push(+t[1], +t[2], +t[3]);
    if (I.length) objects.set(id, { P, I });
  }
  if (objects.size === 0) throw new Error("3mf import: model contains no mesh geometry");

  // build items: <item objectid="N" transform="m00 m01 … m32"/> (row-major 4×3,
  // translation in the last row, per the 3MF core spec). No <build> → all objects at identity.
  const items = [];
  const iRe = /<item\b[^>]*\bobjectid="(\d+)"[^>]*?(?:\btransform="([^"]+)")?[^>]*\/>/g;
  for (let m; (m = iRe.exec(xml)); ) items.push({ id: m[1], t: m[2]?.split(/\s+/).map(Number) ?? null });
  const chosen = items.length ? items : [...objects.keys()].map((id) => ({ id, t: null }));

  const V = [], Tr = [];
  for (const { id, t } of chosen) {
    const o = objects.get(id);
    if (!o) continue;
    const base = V.length / 3;
    for (let i = 0; i < o.P.length; i += 3) {
      let [x, y, z] = [o.P[i], o.P[i + 1], o.P[i + 2]];
      if (t) {
        const [x2, y2, z2] = [
          t[0] * x + t[3] * y + t[6] * z + t[9] * scale,
          t[1] * x + t[4] * y + t[7] * z + t[10] * scale,
          t[2] * x + t[5] * y + t[8] * z + t[11] * scale,
        ];
        x = x2; y = y2; z = z2;
      }
      V.push(x, y, z);
    }
    for (const idx of o.I) Tr.push(base + idx);
  }
  return { positions: Float32Array.from(V), indices: Uint32Array.from(Tr) };
}
```

Verify the transform element-order against the 3MF core spec while implementing (the 12 numbers are `m00 m01 m02 m10 … m30 m31 m32`, translation last row); adjust the indexing if the round-trip-with-transform test disagrees.

- [ ] **Step 4: Verify pass** — `npx vitest run test/threemf-parse.test.js`.
- [ ] **Step 5: Commit** — `git commit -m "feat: 3MF reader (geometry + units + build transforms)"`

---

### Task 5: Mesh repair + diagnostics

**Files:**
- Create: `src/framework/geometry/mesh-repair.js`
- Test: `test/mesh-repair.test.js`

**Interfaces:**
- Produces: `signedVolume(positions, indices) → number` (mm³, negative = inward-facing); `ensureOutward(positions, indices) → void` (reverses winding in place when signedVolume < 0); `openEdgeCount(positions, indices) → number` (boundary half-edges after positional weld — the diagnostic for "not a solid").
- Consumes: `reverseWinding(Tr)` from `src/framework/geometry/mesh-build.js`.

- [ ] **Step 1: Write failing tests** — a hand-built cube (8 verts, 12 tris): `signedVolume` ≈ +edge³ when outward; reverse all triangles → negative; `ensureOutward` flips it back; delete two triangles (one face) → `openEdgeCount` = 4; intact cube → 0. Also a triangle-soup cube (36 unindexed verts) → `openEdgeCount` 0 (the positional weld must connect it).
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** — `signedVolume` = Σ det(a,b,c)/6 over triangles (works on soup and indexed alike); `ensureOutward` calls `reverseWinding` when negative; `openEdgeCount` welds by exact coordinate key (`${x},${y},${z}` from the Float32 values — exact match is correct for soup from one file), then tallies directed edges in a Map and counts edges whose reverse is absent.
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat: mesh orientation fix + open-edge diagnostics for imports"`

---

### Task 6: Manifold backend `import` op + contract lists

**Files:**
- Modify: `src/framework/geometry/kernel.js` (add `"import"` to `KERNEL_OPS`; add the `@typedef` line for `GeometryKernel`: `@property {(name: string) => Solid} import   imported geometry declared in the part's imports field (registered pre-build by the framework)`)
- Modify: `src/framework/geometry/manifold-backend.js`
- Modify: `test/kernel-contract.test.js` (whatever pinning it does for op lists — read it and extend for `import`)
- Test: `test/import-manifold.test.js`

**Interfaces:**
- Produces (both backends must expose, contract-pinned):
  - `kernel.import(name) → Solid` — throws `import: unknown import "<name>" — declare it in the part's \`imports\` field` on a miss.
  - `kernel._registerImport({ name, digest, positions?, indices?, step?, error? }) → void|Promise<void>` — side-channel (underscore = off-contract, probe-invisible). Manifold accepts `{positions, indices}`; an `{error}` entry is stored verbatim and thrown by `k.import(name)` at call time — **registration itself never throws for an unusable format** (the lazy-error policy lives in `ensureImports`, Task 8; see the spec's "Registration is total; errors are lazy"). OCCT (Task 7) is the mirror image.
  - `kernel._importDigest(name) → string|undefined` — registration memo check. Answers only for **usable** entries: an error entry returns `undefined`, so a later registration with the same digest can upgrade it (the post-crossover retry depends on this).
  - `kernel._acceptsStep` — `true` only on OCCT. `kernel._acceptsMesh` — `true` only on Manifold.
- Consumes: `manifoldFromMesh` (mesh-build.js), `ensureOutward`/`openEdgeCount` (Task 5), `h` (solid-hash.js).

- [ ] **Step 1: Write failing tests**

```js
// test/import-manifold.test.js
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";

// 10mm cube as triangle soup (12 tris, outward winding) — build it in a helper.
import { cubeSoup } from "./helpers/cube-soup.js"; // create this tiny helper: returns {positions, indices} for an axis-aligned cube at origin, given edge length

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

describe("manifold import op", () => {
  it("registers a mesh and returns a real Solid", () => {
    k._registerImport({ name: "cube", digest: "d1", ...cubeSoup(10) });
    const s = k.import("cube");
    expect(s.volume()).toBeCloseTo(1000, 0);
    expect(s.cut(k.box({ size: [20, 20, 5] })).volume()).toBeLessThan(1000);
  });
  it("fixes inward-facing winding", () => {
    const soup = cubeSoup(10);
    for (let t = 0; t < soup.indices.length; t += 3) { const tmp = soup.indices[t + 1]; soup.indices[t + 1] = soup.indices[t + 2]; soup.indices[t + 2] = tmp; }
    k._registerImport({ name: "inv", digest: "d2", ...soup });
    expect(k.import("inv").volume()).toBeCloseTo(1000, 0);
  });
  it("throws with open-edge diagnostics on a non-solid mesh", () => {
    const soup = cubeSoup(10);
    const holed = { positions: soup.positions, indices: soup.indices.slice(0, soup.indices.length - 6) };
    expect(() => k._registerImport({ name: "bad", digest: "d3", ...holed })).toThrow(/not a solid.*open edge/i);
  });
  it("stores an error entry and throws it lazily at k.import", () => {
    const lazy = new Error(`import "s": STEP needs tessellation for the Manifold backend`);
    lazy.code = "NEEDS_IMPORT_MESH";
    k._registerImport({ name: "s", digest: "d4", error: lazy }); // registration never throws
    expect(k._importDigest("s")).toBeUndefined(); // error entries don't satisfy the memo — upgradable
    let err;
    try { k.import("s"); } catch (e) { err = e; }
    expect(err?.code).toBe("NEEDS_IMPORT_MESH");
  });
  it("an error entry upgrades to a real registration under the same digest", () => {
    k._registerImport({ name: "s", digest: "d4", ...cubeSoup(10) });
    expect(k.import("s").volume()).toBeCloseTo(1000, 0);
    expect(k._importDigest("s")).toBe("d4");
  });
  it("unknown name names the imports field", () => {
    expect(() => k.import("nope")).toThrow(/unknown import "nope"/);
  });
  it("re-registration with the same digest is a no-op; a new digest replaces", () => {
    expect(k._importDigest("cube")).toBe("d1");
    k._registerImport({ name: "cube", digest: "d1", positions: new Float32Array(0), indices: new Uint32Array(0) }); // ignored
    expect(k.import("cube").volume()).toBeCloseTo(1000, 0);
  });
});
```

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.** In `createManifoldKernel`, alongside the other kernel-level state:

```js
const imports = new Map(); // name → { m, digest, hash } — kernel-lifetime, NOT tracked/cleanup-freed
```

and in the kernel object:

```js
import: (name) => {
  const e = imports.get(name);
  if (!e) throw new Error(`import: unknown import "${name}" — declare it in the part's \`imports\` field`);
  if (e.error) throw e.error; // lazy: unusable-format entries fail at use, not at registration
  return wrap(e.m, e.hash); // master is untracked: survives cleanup(); wrap is free
},
_registerImport: ({ name, digest, positions, indices, error }) => {
  const prev = imports.get(name);
  if (!prev?.error && prev?.digest === digest) return; // error entries are always upgradable
  if (error) { imports.set(name, { error, digest }); return; }
  ensureOutward(positions, indices);
  let m;
  try { m = manifoldFromMesh(wasm, positions, indices); if (m.isEmpty()) throw new Error("empty result"); }
  catch (err) {
    const open = openEdgeCount(positions, indices);
    throw new Error(`import "${name}": mesh is not a solid after repair (${open} open edges) — repair it in a mesh tool or re-export watertight (${err?.message || err})`);
  }
  prev?.m?.delete?.(); // prev may be an error entry with no manifold
  imports.set(name, { m, digest, hash: h("import", name, digest) });
},
_importDigest: (name) => { const e = imports.get(name); return e?.error ? undefined : e?.digest; },
_acceptsMesh: true,
```

(`wasm` is in scope as the factory argument; `manifoldFromMesh` returns an **untracked** manifold, which is exactly what kernel-lifetime masters need. Note the un-`T()`-tracked master is intentional — mirror the comment style of the `tracked`/`T` block.) Also create `test/helpers/cube-soup.js`. Add `"import"` to `KERNEL_OPS` and update `test/kernel-contract.test.js`'s pinning (read the file; it asserts each backend exposes exactly the listed ops — OCCT side lands in Task 7, so if the contract test runs both backends from one list, do kernel.js + both-backend stubs in whichever order keeps the suite green at each commit; it is acceptable to land kernel.js's list change in Task 7's commit instead).
- [ ] **Step 4: Verify pass** — `npx vitest run test/import-manifold.test.js test/kernel-contract.test.js`.
- [ ] **Step 5: Commit** — `git commit -m "feat: manifold backend import op"`

---

### Task 7: OCCT backend `import` op

**Files:**
- Modify: `src/framework/geometry/occt-backend.js`
- Modify: `src/framework/geometry/kernel.js` + `test/kernel-contract.test.js` / `test/occt-backend.test.js` (finish the contract pinning started in Task 6)
- Test: `test/import-occt.test.js` (**own file** — OCCT process isolation)

**Interfaces:**
- Produces: OCCT `kernel.import(name)` (fresh `wrap(shape.clone(), [], hash)` per call — replicad consumes operands); async `kernel._registerImport({name, digest, step, error?})` via replicad `importSTEP(new Blob([step]))`; `{error}` entries are stored verbatim and thrown by `k.import` at call time (the mesh-on-OCCT error arrives this way from `ensureImports` — registration never throws for it, so a mixed-format part can't kill the `tessellate-imports` service job); `kernel._acceptsStep = true` (`_acceptsMesh` absent).
- Consumes: replicad's `importSTEP` (destructure it in `createOcctKernel` next to `exportSTEP`); `h`; the existing `wrap`.

- [ ] **Step 1: Write failing tests**

```js
// test/import-occt.test.js — OCCT only; never boot manifold here
import { describe, it, expect, beforeAll } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120000);

describe("occt import op", () => {
  it("round-trips STEP through toSTEP → import", async () => {
    const box = k.box({ size: [10, 10, 10] });
    const stepBytes = await k.toSTEP([{ name: "box", solid: box }]);
    await k._registerImport({ name: "ref", digest: "d1", step: stepBytes });
    const s = k.import("ref");
    expect(s.volume()).toBeCloseTo(1000, 0);
    // consume-safety: a second import call must be unaffected by transforming the first
    s.translate([5, 0, 0]);
    expect(k.import("ref").volume()).toBeCloseTo(1000, 0);
  });
  it("stores a mesh-on-OCCT error entry and throws it at k.import", async () => {
    await k._registerImport({ name: "m", digest: "d2", error: new Error(`import "m": STL/3MF imports need the Manifold backend`) });
    expect(k._importDigest("m")).toBeUndefined(); // error entries don't satisfy the memo
    expect(() => k.import("m")).toThrow(/Manifold backend/);
  });
  it("advertises STEP support", () => {
    expect(k._acceptsStep).toBe(true);
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run test/import-occt.test.js`.
- [ ] **Step 3: Implement** in `createOcctKernel` (destructure `importSTEP` from `replicad`):

```js
const imports = new Map(); // name → { shape, digest }
// …in the kernel object:
import: (name) => {
  const e = imports.get(name);
  if (!e) throw new Error(`import: unknown import "${name}" — declare it in the part's \`imports\` field`);
  if (e.error) throw e.error; // lazy: mesh-on-OCCT fails at use, not at registration
  return wrap(e.shape.clone(), [], h("import", name, e.digest)); // clone per call: replicad consumes operands
},
_registerImport: async ({ name, digest, step, error }) => {
  const prev = imports.get(name);
  if (!prev?.error && prev?.digest === digest) return; // error entries are always upgradable
  if (error) { imports.set(name, { error, digest }); return; }
  imports.set(name, { shape: await importSTEP(new Blob([step])), digest });
},
_importDigest: (name) => { const e = imports.get(name); return e?.error ? undefined : e?.digest; },
_acceptsStep: true,
```

Finish the contract pinning: `"import"` in `KERNEL_OPS` (if not landed in Task 6) and whatever `test/occt-backend.test.js` mirrors.
- [ ] **Step 4: Verify pass** — `npx vitest run test/import-occt.test.js test/kernel-contract.test.js test/occt-backend.test.js`.
- [ ] **Step 5: Commit** — `git commit -m "feat: occt backend import op (STEP via replicad importSTEP)"`

---

### Task 8: `ensureImports` + jobs/worker wiring

**Files:**
- Modify: `src/framework/imports.js` (add `ensureImports`)
- Modify: `src/framework/jobs.js` (call it in `handle()`; add `tessellate-imports` branch; add `needs-import-mesh` error branch)
- Modify: `src/framework/worker.js` (intercept `prime-imports`; thread `importMeshes` into `handle` opts)
- Modify: `src/framework/geometry-service.js` (`send(msg, backend, transfer = [])`)
- Test: `test/import-jobs.test.js` (Manifold-booting; own file)

**Interfaces:**
- Produces: `ensureImports(kernel, importsDecl, importMeshes?) → Promise<void>` where `importMeshes` is a `Map<name, {digest, positions, indices}>|null`; worker message types `prime-imports` (in, `{meshes: {name: {digest, positions, indices}}}`), `tessellate-imports` (in, `{jobId}`), `import-meshes` (out, `{jobId, meshes}`), `needs-import-mesh` (out, `{jobId, subparts}`).
- Consumes: `resolveImports` (Task 2), `parseStl` (3), `parse3MF` (4), `kernel._registerImport`/`_importDigest`/`_acceptsStep` (6/7), `toIndexedMesh` on the OCCT Solid.

- [ ] **Step 1: Write failing tests**

```js
// test/import-jobs.test.js
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handle } from "../src/framework/jobs.js";
import { meshToStl } from "../src/framework/geometry/mesh-stl.js";
import { cubeSoup } from "./helpers/cube-soup.js";

const stlBytes = () => { const c = cubeSoup(10); return meshToStl(c.positions, c.indices); };

const importingPart = {
  meta: { title: "t" },
  imports: { cube: () => stlBytes() },
  defaults: {},
  views: { main: {} },
  parts: {
    body: { views: ["main"], build: (k) => k.import("cube") },
  },
};

const stepPart = { ...importingPart, imports: { cube: { step: true, } } }; // replaced below

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(); });

const run = async (part, msg, opts) => {
  const posts = [];
  await handle(kernel, part, msg, (m) => posts.push(m), opts);
  return posts;
};

describe("jobs import wiring", () => {
  it("generate on an importing part produces meshes", async () => {
    const posts = await run(importingPart, { type: "generate", subparts: ["body"], view: "main", params: {} });
    const meshes = posts.find((p) => p.type === "meshes");
    expect(meshes.meshes[0].triangles).toBeGreaterThan(0);
  });
  it("a STEP import with no primed mesh posts needs-import-mesh", async () => {
    const part = { ...importingPart, imports: { cube: () => new TextEncoder().encode("ISO-10303-21;\nHEADER;\nENDSEC;") } };
    const posts = await run(part, { type: "generate", subparts: ["body"], view: "main", params: {}, jobId: 7 });
    expect(posts.some((p) => p.type === "needs-import-mesh" && p.jobId === 7)).toBe(true);
  });
  it("a primed STEP import builds", async () => {
    const part = { ...importingPart, imports: { cube: () => new TextEncoder().encode("ISO-10303-21;\nHEADER;\nENDSEC;") } };
    const soup = cubeSoup(10);
    // digest must match what resolveImports computes for those bytes — compute it via resolveImports
    const { resolveImports } = await import("../src/framework/imports.js");
    const digest = (await resolveImports(part.imports)).get("cube").digest;
    const primed = new Map([["cube", { digest, positions: soup.positions, indices: soup.indices }]]);
    const posts = await run(part, { type: "generate", subparts: ["body"], view: "main", params: {} }, { importMeshes: primed });
    expect(posts.some((p) => p.type === "meshes")).toBe(true);
  });
  it("a generate that never calls the STEP import triggers no crossover", async () => {
    // Lazy errors: the unusable/unprimed entry registers inertly; only a build
    // that actually calls k.import on it throws. body only imports "cube".
    const part = {
      ...importingPart,
      imports: { cube: () => stlBytes(), scan: () => new TextEncoder().encode("ISO-10303-21;\nHEADER;\nENDSEC;") },
    };
    const posts = await run(part, { type: "generate", subparts: ["body"], view: "main", params: {} });
    expect(posts.some((p) => p.type === "needs-import-mesh")).toBe(false);
    expect(posts.some((p) => p.type === "meshes")).toBe(true);
  });
});
```

(Drop the unused `stepPart` stub when writing the real file.)

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.** In `imports.js`:

```js
import { parseStl } from "./geometry/stl-parse.js";
import { parse3MF } from "./geometry/threemf-parse.js";

// Register a part's imports on a booted kernel (idempotent per digest). The
// framework calls this in the async phase before every job's synchronous
// build — worker (jobs.js) and Node boots (src/testing/) alike.
//
// Registration is total; errors are lazy (see the spec section of that name):
// every declared import registers on whichever kernel runs the job, and a
// format this kernel cannot use registers as an {error} entry that k.import
// throws at call time. That is what keeps a mixed-format declaration from
// poisoning unrelated jobs — the OCCT worker's tessellate-imports service
// job, or a per-backend generate group that never touches the unusable
// import. STEP on a mesh backend needs pre-tessellated triangles in
// `importMeshes`; absent, the entry carries code NEEDS_IMPORT_MESH and the
// first build to call k.import on it makes the host arrange tessellation
// (mount's needs-import-mesh flow in the browser, worker_threads in Node).
export async function ensureImports(kernel, importsDecl, importMeshes = null) {
  if (!importsDecl || typeof kernel._registerImport !== "function") return;
  const resolved = await resolveImports(importsDecl);
  for (const [name, a] of resolved) {
    if (kernel._importDigest?.(name) === a.digest) continue; // error entries answer undefined → always retried
    if (a.format === "step") {
      if (kernel._acceptsStep) { await kernel._registerImport({ name, digest: a.digest, step: a.bytes }); continue; }
      const m = importMeshes?.get?.(name);
      if (m && m.digest === a.digest) {
        await kernel._registerImport({ name, digest: a.digest, positions: m.positions, indices: m.indices });
      } else {
        const e = new Error(`import "${name}": STEP needs tessellation for the Manifold backend`);
        e.code = "NEEDS_IMPORT_MESH";
        await kernel._registerImport({ name, digest: a.digest, error: e });
      }
    } else if (kernel._acceptsMesh) {
      const { positions, indices } = a.format === "3mf" ? parse3MF(a.bytes) : parseStl(a.bytes);
      await kernel._registerImport({ name, digest: a.digest, positions, indices });
    } else {
      // No parse for a kernel that can't take the mesh — error entry directly.
      await kernel._registerImport({ name, digest: a.digest, error: new Error(
        `import "${name}": STL/3MF imports need the Manifold backend — this build routes to OCCT (fillet/chamfer/shell or meta.backend); use the mesh import from a Manifold-routed build`) });
    }
  }
}
```

In `jobs.js` `handle()`, right after the fonts block:

```js
if (part.imports) await ensureImports(kernel, part.imports, opts.importMeshes ?? null);
```

New job branch (after `export-3mf`):

```js
} else if (msg.type === "tessellate-imports") {
  // OCCT-worker service job for the STEP-on-Manifold crossover: answer with
  // print-quality triangle meshes for every STEP import, transferable.
  const resolved = await resolveImports(part.imports ?? {});
  const meshes = {};
  for (const [name, a] of resolved) {
    if (a.format !== "step") continue;
    const { positions, indices } = kernel.import(name).toIndexedMesh({ quality: "print" });
    meshes[name] = { digest: a.digest, positions, indices };
  }
  post({ type: "import-meshes", jobId: msg.jobId, meshes },
       Object.values(meshes).flatMap((m) => [m.positions.buffer, m.indices.buffer]));
}
```

(`resolveImports` needs importing in jobs.js; the `ensureImports` call above the branch has already registered the STEP masters on this OCCT kernel — and any mesh imports in the same part registered as inert error entries rather than killing this service job, which is exactly what the lazy-error policy is for.) Error branch, next to `NEEDS_OCCT`:

```js
if (err?.code === "NEEDS_IMPORT_MESH") post({ type: "needs-import-mesh", jobId: msg.jobId, subparts: msg.subparts });
else if (err?.code === "NEEDS_OCCT") …
```

In `worker.js`, before the lint intercept:

```js
const importMeshes = new Map(); // name → {digest, positions, indices} — primed by the host for STEP-on-manifold
// …in self.onmessage:
if (e.data?.type === "prime-imports") {
  for (const [name, m] of Object.entries(e.data.meshes)) importMeshes.set(name, m);
  return;
}
```

and pass `{ isStale, importMeshes }` / `{ importMeshes }` in both `handle(...)` calls. In `geometry-service.js`: `send: (msg, backend = "manifold", transfer = []) => workers[backend].postMessage(msg, transfer)`.
- [ ] **Step 4: Verify pass** — `npx vitest run test/import-jobs.test.js` plus the whole suite's worker-layering test.
- [ ] **Step 5: Commit** — `git commit -m "feat: import registration in the job loop + crossover worker protocol"`

---

### Task 9: Mount crossover flow (browser)

**Files:**
- Modify: `src/framework/mount.js` (the `switch (data.type)` block near line 505 and the send sites)
- Test: extend whichever mount/service unit test exists (`grep -l "needs-occt" test/*.test.js`); if none covers message handling, add `test/import-crossover.test.js` driving `onWorkerMessage` with a stubbed service.

**Interfaces:**
- Consumes: `needs-import-mesh` / `import-meshes` / `prime-imports` / `tessellate-imports` message types (Task 8); `service.send(msg, backend, transfer)`.
- Produces: mount behavior — on `needs-import-mesh`: send `{type:"tessellate-imports", jobId}` to `"occt"` once per part-lifetime digest set; on `import-meshes`: forward as `{type:"prime-imports", meshes}` to `"manifold"` **with** the transfer list, then trigger a regenerate (the same path `needs-occt` uses to rebuild).

- [ ] **Step 1: Write the failing test** — stub `createGeometryService` (capture `send` calls), feed `onWorkerMessage({data:{type:"needs-import-mesh", jobId:1, subparts:["body"]}})`, assert a `tessellate-imports` send to `"occt"`; feed the `import-meshes` reply, assert a `prime-imports` send to `"manifold"` carrying the same meshes and a follow-up generate. Mirror however the existing tests fake the service for `needs-occt` (read those first; follow their harness).
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** in the message switch:

```js
case "needs-import-mesh": {
  // STEP import on the Manifold worker: tessellate on the OCCT worker, prime, retry.
  // Guard: one request in flight, and never twice for the same part instance —
  // a second needs-import-mesh AFTER priming means tessellation didn't satisfy
  // the digest (a genuinely broken state): surface it as a build error instead
  // of looping.
  if (importMeshState === "primed") { showError("STEP import tessellation failed to satisfy the import — see console"); break; }
  if (importMeshState !== "requested") {
    importMeshState = "requested";
    service.send({ type: "tessellate-imports", jobId: nextJobId() }, "occt");
  }
  break;
}
case "import-meshes": {
  importMeshState = "primed";
  service.send({ type: "prime-imports", meshes: data.meshes }, "manifold",
    Object.values(data.meshes).flatMap((m) => [m.positions.buffer, m.indices.buffer]));
  regenerate(); // same rebuild trigger the needs-occt case uses — reuse its exact call
  break;
}
```

Declare `let importMeshState = null;` beside the backend-policy state and reset it wherever the part is rebound. Adapt names (`showError`, `nextJobId`, `regenerate`) to what mount actually has in the `needs-occt` case — read that case and copy its idioms; `jobId` on tessellate-imports may be unnecessary if replies are matched by type.
- [ ] **Step 4: Verify pass**, then a live check: `npm run dev`, open a scratch page with a STEP-importing part (reuse the Task 11 fixture; a scratch `*.html` is dev-only by default) and confirm preview renders after the crossover round-trip. Delete the scratch page unless it earns a place as `import-step-demo.html` (dev-only, not in `rollupOptions.input`).
- [ ] **Step 5: Commit** — `git commit -m "feat: mount-side STEP tessellation crossover"`

---

### Task 10: Node boots + CLI wiring (and the fonts gap fix)

**Files:**
- Create: `src/testing/assets.js`
- Modify: `src/testing/manifold.js`, `src/testing/occt.js` (accept `imports`, use `nodeAssetSources` for both `fonts` and `imports`)
- Modify: `bin/cli.js` (`bootKernel` passes `{ fonts, imports }`)
- Test: `test/cli-assets.test.js` (Manifold-booting; includes a spawned-CLI regression)

**Interfaces:**
- Produces: `nodeAssetSources(decl) → decl'` — maps `file:` URL / `file:`-string sources to `ArrayBuffer`s via `node:fs`, passes everything else through; boots' options gain `imports` (and `importMeshes`, threaded to `ensureImports` — used by Task 11).
- Consumes: `ensureImports` (Task 8), `resolveFonts`.

- [ ] **Step 1: Write failing tests**

```js
// test/cli-assets.test.js
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { meshToStl } from "../src/framework/geometry/mesh-stl.js";
import { cubeSoup } from "./helpers/cube-soup.js";

describe("node asset wiring", () => {
  it("boots resolve file: URL imports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-import-"));
    const c = cubeSoup(10);
    writeFileSync(join(dir, "cube.stl"), Buffer.from(meshToStl(c.positions, c.indices)));
    const k = await bootManifoldKernel({ imports: { cube: new URL(`file://${join(dir, "cube.stl")}`) } });
    expect(k.import("cube").volume()).toBeCloseTo(1000, 0);
  });
  it("partforge measure works end-to-end on an importing part", () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-cli-"));
    const c = cubeSoup(10);
    writeFileSync(join(dir, "cube.stl"), Buffer.from(meshToStl(c.positions, c.indices)));
    writeFileSync(join(dir, "part.js"), `
      export default {
        meta: { title: "imported" },
        imports: { cube: new URL("./cube.stl", import.meta.url) },
        defaults: {}, views: { main: {} },
        parts: { body: { views: ["main"], build: (k) => k.import("cube") } },
      };`);
    const out = execFileSync(process.execPath, ["bin/cli.js", "measure", join(dir, "part.js"), "--json"], { encoding: "utf8" });
    const report = JSON.parse(out);
    expect(report.subparts[0].volume).toBeCloseTo(1000, 0);
  }, 120000);
  it("boots resolve fonts too (the shipped gap)", async () => {
    // A part-declared font as bytes reaches kernel._fonts through the boot.
    const k = await bootManifoldKernel({ fonts: { f: new Uint8Array(0) } }).catch(() => null);
    // opentype.parse on empty bytes throws — asserting the ERROR proves the boot
    // actually forwarded the font instead of silently dropping it.
    expect(k).toBeNull();
  });
});
```

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.**

```js
// src/testing/assets.js
// Node-side source mapping for part asset declarations (fonts + imports):
// framework resolvers use global fetch, which cannot read file: URLs in Node,
// so map those to bytes here before handing the decl down. Everything else
// (http(s) strings, bytes, thunks) passes through untouched.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function nodeAssetSources(decl) {
  if (!decl) return decl;
  const out = {};
  for (const [name, src] of Object.entries(decl)) {
    const u = src instanceof URL ? src : typeof src === "string" && src.startsWith("file:") ? new URL(src) : null;
    if (u?.protocol === "file:") {
      const b = readFileSync(fileURLToPath(u));
      out[name] = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    } else out[name] = src;
  }
  return out;
}
```

Boots (`manifold.js` shown; `occt.js` identical shape):

```js
import { ensureImports } from "../framework/imports.js";
import { nodeAssetSources } from "./assets.js";

export async function bootManifoldKernel({ quality = "preview", fonts, imports, importMeshes } = {}) {
  const wasm = await Module();
  wasm.setup();
  const kernel = createManifoldKernel(wasm, { quality });
  if (fonts) { const opentype = (await import("opentype.js")).default;
    for (const [name, buf] of await resolveFonts(nodeAssetSources(fonts))) kernel._fonts.set(name, opentype.parse(buf)); }
  if (imports) await ensureImports(kernel, nodeAssetSources(imports), importMeshes ?? null);
  return kernel;
}
```

CLI: `const bootKernel = (part) => { const opts = { fonts: part.fonts, imports: part.imports }; return detectBackend(part) === "occt" ? bootOcctKernel(opts) : bootManifoldKernel(opts); };` — but see Task 11 for the STEP-on-manifold branch it also needs; land the plain version here.
- [ ] **Step 4: Verify pass** — `npx vitest run test/cli-assets.test.js`.
- [ ] **Step 5: Commit** — `git commit -m "feat: node boots + CLI resolve imports (and finally fonts)"`

---

### Task 11: Node STEP tessellation (worker_threads) + STEP fixture

**Files:**
- Create: `src/testing/step-mesh.js`, `src/testing/step-mesh-thread.js`, `scripts/make-step-fixture.mjs`
- Create (generated + committed): `test/fixtures/box-10mm.step`
- Modify: `src/testing/manifold.js` (use it when `imports` contains STEP and no `importMeshes` given), `bin/cli.js` (no change beyond Task 10 if the boot owns it — keep it in the boot)
- Test: `test/step-mesh-thread.test.js` (this **is** the coexistence spike)

**Interfaces:**
- Produces: `tessellateStepAssets(entries: {name, bytes: ArrayBuffer, digest}[]) → Promise<Map<name, {digest, positions, indices}>>`.
- Consumes: `bootOcctKernel` (inside the thread), `_registerImport`/`import`/`toIndexedMesh`.

- [ ] **Step 1: Generate and commit the fixture**

```bash
node scripts/make-step-fixture.mjs   # writes test/fixtures/box-10mm.step
```

```js
// scripts/make-step-fixture.mjs — regenerate the checked-in STEP fixture (10mm cube).
import { writeFileSync } from "node:fs";
import { bootOcctKernel } from "../src/testing/occt.js";
const k = await bootOcctKernel();
const bytes = await k.toSTEP([{ name: "box", solid: k.box({ size: [10, 10, 10] }) }]);
writeFileSync("test/fixtures/box-10mm.step", Buffer.from(bytes));
console.log("wrote test/fixtures/box-10mm.step");
process.exit(0);
```

- [ ] **Step 2: Write the failing coexistence test**

```js
// test/step-mesh-thread.test.js — Manifold in THIS process + OCCT in a worker_thread.
// This test doubles as the process-isolation spike: if it crashes, fall back to
// child_process.fork in step-mesh.js and record the finding in the plan/spec.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { tessellateStepAssets } from "../src/testing/step-mesh.js";

describe("node STEP crossover", () => {
  it("tessellates STEP in a thread while manifold runs here", async () => {
    const k = await bootManifoldKernel(); // manifold in the main isolate
    const bytes = readFileSync("test/fixtures/box-10mm.step");
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const meshes = await tessellateStepAssets([{ name: "ref", bytes: ab, digest: "dX" }]);
    const m = meshes.get("ref");
    expect(m.digest).toBe("dX");
    k._registerImport({ name: "ref", digest: "dX", positions: m.positions, indices: m.indices });
    expect(k.import("ref").volume()).toBeCloseTo(1000, 0);
  }, 180000);
  it("boot handles STEP imports transparently", async () => {
    const k2 = await bootManifoldKernel({ imports: { ref: new URL(`file://${process.cwd()}/test/fixtures/box-10mm.step`) } });
    expect(k2.import("ref").volume()).toBeCloseTo(1000, 0);
  }, 180000);
});
```

- [ ] **Step 3: Verify failure**, then implement:

```js
// src/testing/step-mesh.js
// STEP → triangle mesh for the Node crossover (Manifold part importing STEP).
// OCCT boots in a worker_thread — a separate isolate is a separate WASM world,
// so the "never both kernels in one process" invariant holds by construction.
import { Worker } from "node:worker_threads";

export function tessellateStepAssets(entries) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./step-mesh-thread.js", import.meta.url),
      { workerData: entries.map(({ name, bytes, digest }) => ({ name, bytes, digest })) });
    w.once("message", (out) => {
      resolve(new Map(out.map((m) => [m.name, { digest: m.digest, positions: m.positions, indices: m.indices }])));
      w.terminate();
    });
    w.once("error", reject);
    w.once("exit", (code) => { if (code !== 0) reject(new Error(`step tessellation thread exited ${code}`)); });
  });
}
```

```js
// src/testing/step-mesh-thread.js — runs INSIDE the worker_thread only.
import { parentPort, workerData } from "node:worker_threads";
import { bootOcctKernel } from "./occt.js";

const kernel = await bootOcctKernel();
const out = [];
const transfer = [];
for (const { name, bytes, digest } of workerData) {
  await kernel._registerImport({ name, digest, step: bytes });
  const { positions, indices } = kernel.import(name).toIndexedMesh({ quality: "print" });
  out.push({ name, digest, positions, indices });
  transfer.push(positions.buffer, indices.buffer);
}
parentPort.postMessage(out, transfer);
process.exit(0);
```

Boot integration in `bootManifoldKernel` (before the `ensureImports` call):

```js
if (imports) {
  const decl = nodeAssetSources(imports);
  const { resolveImports } = await import("../framework/imports.js");
  const resolved = await resolveImports(decl);
  const stepEntries = [...resolved].filter(([, a]) => a.format === "step")
    .map(([name, a]) => ({ name, bytes: a.bytes, digest: a.digest }));
  const meshes = importMeshes ?? (stepEntries.length ? await tessellateStepAssets(stepEntries) : null);
  await ensureImports(kernel, decl, meshes);
}
```

(Replace the Task 10 version of the `imports` block with this one.)
- [ ] **Step 4: Verify pass** — `npx vitest run test/step-mesh-thread.test.js test/cli-assets.test.js`. **If the coexistence test crashes the process:** implement the same protocol over `child_process.fork` (serialize buffers via the structured-clone IPC that fork supports, or base64) and note the outcome in the spec's Open items.
- [ ] **Step 5: Commit** — `git commit -m "feat: node STEP tessellation via worker_threads + step fixture"`

---

### Task 12: Deviation facts + `ref*` verify metrics

**Files:**
- Modify: `src/framework/oracle/measure.js` (compute `s.deviation` for sub-parts declaring `reference`)
- Modify: `src/framework/verify-metrics.js` (three new `SUBPART_METRICS`)
- Test: `test/deviation.test.js` (Manifold-booting)

**Interfaces:**
- Produces: sub-part declaration field `reference: "<import name>"`; fact `s.deviation = { ref, xorVolume, volumeDeltaPct, bboxDelta: [dx,dy,dz] } | null`; metrics `refXorVolume`, `refVolumeDeltaPct`, `refBboxDelta` usable in `verify.expect.<subpart>`.
- Consumes: `kernel.import` (6/7), existing `evaluateAssertion` DSL (vector form `<=[a,b,c]` for `refBboxDelta`).

- [ ] **Step 1: Write failing tests**

```js
// test/deviation.test.js
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { measure } from "../src/framework/oracle/measure.js";
import { verify } from "../src/framework/oracle/verify.js";
import { meshToStl } from "../src/framework/geometry/mesh-stl.js";
import { cubeSoup } from "./helpers/cube-soup.js";

const part = (bodyBuild) => ({
  meta: { title: "dev" },
  imports: { scan: () => { const c = cubeSoup(10); return meshToStl(c.positions, c.indices); } },
  defaults: {}, views: { main: {} },
  parts: {
    ref: { views: ["main"], exportable: false, build: (k) => k.import("scan") },
    body: { views: ["main"], reference: "scan", build: bodyBuild },
  },
  verify: { expect: { body: { refXorVolume: "<=50mm3", refVolumeDeltaPct: "<=2", refBboxDelta: "<=[0.5,0.5,0.5]" } } },
});

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel({ imports: { scan: () => { const c = cubeSoup(10); return meshToStl(c.positions, c.indices); } } }); });

describe("deviation gate", () => {
  it("an exact rebuild passes", () => {
    const p = part((k) => k.box({ min: [0, 0, 0], max: [10, 10, 10] })); // cubeSoup is origin-cornered — match its coordinates
    const r = measure(kernel, p, "main");
    const body = r.subparts.find((s) => s.name === "body");
    expect(body.deviation.xorVolume).toBeLessThan(1);
    expect(verify(kernel, p, { view: "main", seed: { params: {}, result: r } }).ok).toBe(true);
  });
  it("a drifted rebuild fails the gate", () => {
    const p = part((k) => k.box({ min: [0, 0, 0], max: [10, 10, 12] }));
    const v = verify(kernel, p, { view: "main" });
    expect(v.ok).toBe(false);
    expect(v.failures.some((f) => f.metric === "refXorVolume")).toBe(true);
  });
  it("no reference declared → no deviation facts, metrics skip", () => {
    const p = part((k) => k.box({ min: [0, 0, 0], max: [10, 10, 10] }));
    delete p.parts.body.reference;
    const r = measure(kernel, p, "main");
    expect(r.subparts.find((s) => s.name === "body").deviation).toBeNull();
    const v = verify(kernel, p, { view: "main" });
    expect(v.ok).toBe(true); // ref* checks report status "skip", not fail
  });
});
```

Match `cubeSoup`'s actual coordinates (Task 6's helper) — adjust `k.box` min/max if the helper centers the cube.

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.** In `measure.js`, inside the `built.map(...)` callback (solid facts must be read before `assemblyOverlaps`/cleanup):

```js
const refName = part.parts[name]?.reference;
let deviation = null;
if (refName && typeof kernel.import === "function") {
  const ref = kernel.import(refName);
  const refVol = ref.volume();
  const rb = ref.boundingBox();
  const vol = solid.volume();
  const inter = solid.intersect(ref).volume();
  deviation = {
    ref: refName,
    xorVolume: vol + refVol - 2 * inter, // symmetric difference, one boolean
    volumeDeltaPct: refVol > 1e-9 ? (100 * Math.abs(vol - refVol)) / refVol : null,
    bboxDelta: [0, 1, 2].map((i) => Math.max(Math.abs(b.min[i] - rb.min[i]), Math.abs(b.max[i] - rb.max[i]))),
  };
}
```

add `deviation` to the returned sub-part object (reuse the locally computed `vol` for the existing `volume:` field so `solid.volume()` is read once). In `verify-metrics.js`:

```js
refXorVolume: { kind: "gate", extract: (s) => s.deviation?.xorVolume ?? null,
  hint: "the rebuild's symmetric difference vs its reference import is too large — compare the ghost overlay, then adjust the governing dimensions toward the measured reference" },
refVolumeDeltaPct: { kind: "gate", extract: (s) => s.deviation?.volumeDeltaPct ?? null,
  hint: "rebuild volume differs from the reference import by more than the allowed percentage — a feature is missing, doubled, or mis-scaled vs the reference" },
refBboxDelta: { kind: "gate", extract: (s) => s.deviation?.bboxDelta ?? null,
  hint: "the rebuild's bounding-box corners drift from the reference import — check overall dimensions and that the rebuild is aligned to the reference's coordinates" },
```

(`extract` returning null/undefined already yields status "skip" via the existing `check()` — that's the no-reference path.)
- [ ] **Step 4: Verify pass** — `npx vitest run test/deviation.test.js`.
- [ ] **Step 5: Commit** — `git commit -m "feat: deviation facts + ref* verify metrics"`

---

### Task 13: Lint rules for imports

**Files:**
- Create: `src/framework/lint/rules-imports.js`
- Modify: `src/framework/lint/index.js` (add `IMPORT_RULES` to `RULES`)
- Test: `test/lint-imports.test.js` (pure — no kernel boots)

**Interfaces:**
- Produces rules (follow `finding.js`'s `err`/`warn` helpers and existing rule file shape — read `rules-verify.js` first):
  - `import-unknown-name` (error): a probe-recorded kernel-scope `import` call whose first arg (probe records it as a JSON string, e.g. `"scan"` → `'"scan"'`) is not a key of `part.imports ?? {}`.
  - `import-mesh-on-occt` (error): a declared import whose format (extension-detectable sources only — `URL`/string; bytes/thunks are skipped) is `stl`/`3mf` while `detectBackend(part) === "occt"` — the message names the routing cause (`meta.backend` or a CAD op). This is a static early-catch; the runtime authority is the lazy `k.import` error entry, so a case lint can't see (bytes/thunk sources, per-sub-part routing splits) still fails correctly at build time.
  - `reference-unknown` (error): `parts[x].reference` names no declared import.
  - `ref-metric-without-reference` (warning): `verify.expect[sub]` uses a `ref*` metric but `parts[sub]` declares no `reference`.
- Consumes: the probe `calls` already in lint's ctx (see how `rules-build.js` reads them), `detectFormat` (Task 2 — extension path only, pure), `detectBackend` (backend-select.js — probe-based, kernel-free, lint-purity-safe; **verify with `npx vitest run test/lint-purity.test.js`**, and if it trips, inline a local extension-only format map instead of importing `imports.js`).
- [ ] **Step 1: Write failing tests** — four rules × (violating part → finding with the right id+severity; clean part → no finding). Copy the harness style of an existing lint test file (`grep -l "lintPart" test/*.test.js`).
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** the four rules in `rules-imports.js` and wire `IMPORT_RULES` into `RULES` in `lint/index.js`. Anchor shape (adapt the ctx field names to what `lintContext` actually provides — read `rules-build.js` for how probe calls are consumed):

```js
// src/framework/lint/rules-imports.js
import { err, warn } from "./finding.js";
import { detectBackend } from "../backend-select.js";

const MESH_EXT = /\.(stl|3mf)$/i;
const declaredImports = (part) => Object.keys(part.imports ?? {});
const meshDeclared = (part) => Object.entries(part.imports ?? {}).filter(([, src]) => {
  const path = src instanceof URL ? src.pathname : typeof src === "string" ? src.split("?")[0] : null;
  return path && MESH_EXT.test(path); // bytes/thunks: format unknowable statically — skip
});

export const IMPORT_RULES = [
  { id: "import-unknown-name", run: ({ part, probe }) => {
      const known = new Set(declaredImports(part));
      return (probe?.calls ?? [])
        .filter((c) => c.scope === "kernel" && c.op === "import")
        .map((c) => { try { return JSON.parse(c.args[0]); } catch { return null; } })
        .filter((n) => typeof n === "string" && !known.has(n))
        .map((n) => err("import-unknown-name",
          `build calls k.import("${n}") but the part's imports field declares: ${[...known].join(", ") || "(nothing)"}`,
          "Declare the file under imports: { name: source } or fix the name."));
    } },
  { id: "import-mesh-on-occt", run: ({ part }) => {
      const mesh = meshDeclared(part);
      if (mesh.length === 0 || detectBackend(part) !== "occt") return [];
      const cause = part.meta?.backend === "occt" ? "meta.backend forces OCCT" : "a fillet/chamfer/shell routes this part to OCCT";
      return mesh.map(([name]) => err("import-mesh-on-occt",
        `import "${name}" is a mesh (STL/3MF) but ${cause} — mesh imports need the Manifold backend`,
        "Move the mesh import into a Manifold-routed part, or drop the CAD-only op."));
    } },
  { id: "reference-unknown", run: ({ part }) => {
      const known = new Set(declaredImports(part));
      return Object.entries(part.parts ?? {})
        .filter(([, sp]) => sp?.reference && !known.has(sp.reference))
        .map(([n, sp]) => err("reference-unknown",
          `sub-part "${n}" declares reference: "${sp.reference}" but no such import exists`,
          "reference must name a key of the part's imports field."));
    } },
  { id: "ref-metric-without-reference", run: ({ part }) => {
      const expect = typeof part.verify?.expect === "object" ? part.verify.expect : {};
      return Object.entries(expect)
        .filter(([sub, m]) => sub !== "_view" && m && typeof m === "object" &&
          Object.keys(m).some((k) => k.startsWith("ref")) && !part.parts?.[sub]?.reference)
        .map(([sub]) => warn("ref-metric-without-reference",
          `verify.expect.${sub} uses ref* metrics but sub-part "${sub}" declares no reference`,
          "Add reference: \"<import name>\" to the sub-part, or the checks will always skip."));
    } },
];
```

(If lint's ctx doesn't expose the probe result under `probe`, or `err`/`warn` take different arguments, follow the real signatures — the rule *semantics* above are the contract. A function-form `verify.expect` can't be inspected statically: guard with the `typeof` check shown and skip.)
- [ ] **Step 4: Verify pass** — `npx vitest run test/lint-imports.test.js test/lint-purity.test.js`.
- [ ] **Step 5: Commit** — `git commit -m "feat: lint rules for geometry imports"`

---### Task 14: Example part + glue

**Files:**
- Create: `src/parts/import-demo.js`, `src/parts/assets/import-demo-scan.stl` (small ascii STL, hand-written or from `cubeSoup` via a one-off script — keep it < 5 KB), `import-demo.html`, `src/app-import-demo.js`, `src/import-demo-worker.js` (copy the demo part's three glue files verbatim, changing only the part import)
- Test: extend `test/cli-assets.test.js` or add `test/import-demo.test.js`: `partforge lint` clean + `partforge measure` exits 0 on the real part file.

**Interfaces:**
- Consumes: everything shipped so far; this is the living documentation example referenced from AUTHORING-PARTS.md.

- [ ] **Step 1: Write the part** — a bracket-style part with: `imports: { scan: new URL("./assets/import-demo-scan.stl", import.meta.url) }`; a `ref` ghost sub-part (`exportable: false`, `display: { opacity: 0.3 }`, `build: (k) => k.import("scan")`); a parametric `body` sub-part with `reference: "scan"` rebuilt from params whose defaults match the scan; a `mount` sub-part cutting the import as a component (`k.cut(k.import("scan").scale(p.fit), …)` or similar); `verify.expect.body` using all three `ref*` metrics with defaults that pass.
- [ ] **Step 2: Wire the app** (three glue files; `import-demo.html` stays dev-only — do NOT add to `rollupOptions.input`).
- [ ] **Step 3: Verify** — `npx partforge lint src/parts/import-demo.js` clean; `npx partforge measure src/parts/import-demo.js` exits 0 with deviation checks passing; `npm run dev` + open `/import-demo.html`, confirm ghost + body render.
- [ ] **Step 4: Test + commit** — `git commit -m "feat: import-demo reference part"`

---

### Task 15: Documentation

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` — new "Importing geometry (STEP/STL/3MF)" section after the fonts section: the `imports` field grammar, `k.import`, the `reference` field + `ref*` metrics with the import-demo example, the backend matrix (STEP→OCCT native / STEP→Manifold tessellated / mesh→OCCT error), units (mm; STL assumed mm), the content-stable-for-a-session rule, ghost-reference pattern.
- Modify: `docs/KERNEL-CONTRACT.md` — `import` op row (additive; contract version stays 2 — confirm `kernel-contract.test.js`'s header assertion still passes), the `_registerImport`/`_importDigest`/`_acceptsStep` side-channel note, `NEEDS_IMPORT_MESH` next to wherever `NEEDS_OCCT` is documented.
- Modify: `docs/ERROR-PATTERNS.md` — five entries, matching the exact thrown text (grep the source for each message when writing): `import-mesh-not-solid`, `import-unrecognized-format`, `import-unknown-name`, `import-mesh-on-occt`, `import-step-tessellation-failed`.
- Modify: `test/error-patterns` coverage if a test pins pattern ids (grep `error-patterns` in test/).

- [ ] **Step 1: Write all three doc updates.** Follow each doc's existing structure exactly (ERROR-PATTERNS: one `##` per pattern, symptom → cause → fix).
- [ ] **Step 2: Verify** — `npm test` (docs-coupled tests: kernel-contract header, error-patterns lookups).
- [ ] **Step 3: Commit** — `git commit -m "docs: geometry import authoring guide + contract + error patterns"`

---

### Task 16: Version bump + full verification

**Files:**
- Modify: `package.json` (bump **minor** from whatever main holds after rebase — e.g. 0.61.0 → 0.62.0; check `npm view partforge version` and main's package.json, and pick the next unpublished minor)

- [ ] **Step 1: Bump the version.**
- [ ] **Step 2: Full suite** — `npm test` → all green.
- [ ] **Step 3: Smoke** — `npm run check` (Playwright Chromium; install with `npm i -D playwright && npx playwright install chromium` if missing) and `node scripts/check-app.mjs demo.html`.
- [ ] **Step 4: Lint/measure the demo part once more** — `npx partforge measure src/parts/import-demo.js` → exit 0.
- [ ] **Step 5: Commit** — `git commit -m "chore: bump to <version> for geometry import"` — then hand off per the finishing-a-development-branch skill (PR onto main; release fires on merge).
