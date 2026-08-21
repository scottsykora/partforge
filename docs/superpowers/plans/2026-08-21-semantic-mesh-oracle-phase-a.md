# Semantic Mesh Oracle (`describe`) — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `describe` oracle to partforge that consumes a triangle mesh and emits a semantic feature report — surfaces, holes, fillets, chamfers, pockets, bosses, extrusions, revolves, shells, hole patterns, symmetry — plus a scored, labeled reconstruction suggestion an agent can use to rebuild the part parametrically.

**Architecture:** Propose-then-confirm. Segmentation (Gauss-map seeding → region growing with refit → RANSAC mop-up) generates *candidates*; a kernel-backed greedy acceptance loop scores each candidate by symmetric-difference volume against the source mesh and decides membership and build order. The entire recognition stack is kernel-free and unit-tests without a WASM boot; only `accept.js` touches geometry, inside exactly one solid-cache bracket.

**Tech Stack:** Plain ESM JavaScript (no TypeScript, no build step for source), Node 24, vitest, Manifold WASM kernel via `bootManifoldKernel`. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-21-semantic-mesh-oracle-design.md` — read it alongside this plan. Section references below (§2.3, §4.1, …) point into it.

## Global Constraints

- **Node 24.** `.nvmrc` pins it; the default shell Node is too old. Run `nvm use` before `npm install`, tests, or the CLI. If `source nvm.sh` is unavailable, PATH-prefix the pinned Node from `~/.nvm/versions`.
- **Units are millimetres** throughout. No exceptions, no unit parameters.
- **Everything under `src/framework/oracle/` must be DOM-free, `three`-free, and `node:`-free.** `test/worker-layering.test.js` walks the worker's import graph and fails the build otherwise. Never import from `src/testing/` inside `src/framework/`.
- **`build` and every oracle function must be a pure function of its inputs** — no `Math.random`, no clock, no module-level mutable state. The one permitted exception is the digest-keyed memo in Task 14, which is a cache and is keyed by content.
- **Import geometry helpers from `partforge/geometry`, never `partforge`.** The main entry pulls in the DOM viewer.
- **`describe` is Manifold-only.** Mesh imports on OCCT are never attempted (`import-mesh-on-occt`). Do not add an OCCT path.
- **Comment density and style must match surrounding code.** This codebase explains *why* in prose above the code, often at length. Terse uncommented code will not pass review.
- **Report array caps** (Task 13, exact values): `MAX_SURFACES` 200, `MAX_EDGES` 400, `MAX_FEATURES` 120, `MAX_PATTERNS` 40, `MAX_RESIDUAL_REGIONS` 20, `MAX_SUGGESTION_STEPS` 60.
- **Closed error-code set** (Task 14, exact strings): `not-manifold` | `too-large` | `empty` | `budget-exceeded` | `unreadable`. Adding a code without adding an `ERROR-PATTERNS.md` entry is incomplete work.
- **On any build, test, or measure failure, grep `docs/ERROR-PATTERNS.md` for the symptom first.** It maps literal error text → cause → fix.
- **Commit after every task.** Do not batch commits across tasks.

---

## File Structure

**New — the recognition stack (all pure leaves, no kernel, no imports outside the oracle):**

| File | Responsibility |
| --- | --- |
| `src/framework/oracle/describe/topology.js` | Weld vertices; face adjacency; per-face normal and area; signed dihedral per edge. Normalizes both mesh conventions. |
| `src/framework/oracle/describe/fit.js` | Least-squares fits for plane, cylinder, cone, sphere, torus. Every fit returns its own error. |
| `src/framework/oracle/describe/segment.js` | Gauss-map seeding, region growing under a primitive predicate, refit to stability. |
| `src/framework/oracle/describe/ransac.js` | Efficient RANSAC mop-up over unassigned faces. |
| `src/framework/oracle/describe/surface-graph.js` | Merge patches to surfaces; boundary loops; attributed adjacency graph with convex/concave edge labels. |
| `src/framework/oracle/describe/features/holes.js` | Through-hole and blind-hole rules. |
| `src/framework/oracle/describe/features/dressups.js` | Fillet and chamfer rules. |
| `src/framework/oracle/describe/features/prismatic.js` | Pocket, boss, and extrusion rules. |
| `src/framework/oracle/describe/features/sweeps.js` | Revolve and uniform-wall shell rules. |
| `src/framework/oracle/describe/patterns.js` | Linear/circular/grid repetition; mirror and rotational symmetry. |
| `src/framework/oracle/describe/snap.js` | Number snapping, grid inference, fastener-table lookup. |
| `src/framework/oracle/describe/limits.js` | Plain-data caps module. **No imports at all** — both partforge and (Phase B) partforge-cloud read it. |
| `src/framework/oracle/describe/report.js` | Full and compact report shapes; cap enforcement; low-coverage banner. |
| `src/framework/oracle/describe/hints.js` | The labeled `suggestion` layer, ordered by acceptance. |

**New — kernel-touching:**

| File | Responsibility |
| --- | --- |
| `src/framework/oracle/describe/accept.js` | Greedy scored acceptance against the source mesh. One cache bracket, hard budget. |
| `src/framework/oracle/describe.js` | Orchestrator: `describe(kernel, mesh, opts)`. Owns the digest-keyed memo. |

**Modified:**

| File | Change |
| --- | --- |
| `src/framework/jobs.js` | New `describe` job type beside `inspect`. |
| `bin/cli.js` | New `describe` command; add to `USAGE`. |
| `src/testing.js` | Export `describe` and `compactDescribe`. |
| `docs/AUTHORING-PARTS.md` | New "Describing an imported mesh" section. |
| `docs/ERROR-PATTERNS.md` | One `##` entry per closed error code. |
| `package.json` | Version bump (Task 17). |

**New tests:** one per module under `test/`, plus `test/helpers/mesh-fixtures.js` and `test/describe-roundtrip.test.js`.

---

### Task 1: Mesh fixtures + topology

**Files:**
- Create: `test/helpers/mesh-fixtures.js`
- Create: `src/framework/oracle/describe/topology.js`
- Test: `test/describe-topology.test.js`

**Interfaces:**
- Consumes: `meshTriangles` from `src/framework/oracle/bvh.js` (handles both the Manifold non-indexed soup and the OCCT indexed form).
- Produces:
  - `boxMesh(sx, sy, sz)`, `cylinderMesh(r, h, segs)`, `annulusPlate(rOut, rIn, h, segs)` → `{ positions: number[] }`
  - `buildTopology(mesh, opts?) → { verts, tris, faceNormal, faceArea, edges, faceEdges }` where `edges[i] = { v0, v1, triA, triB, dihedral, convexity }`, `convexity` is one of `"convex" | "concave" | "flat" | "boundary"`, and `dihedral` is signed radians.

- [ ] **Step 1: Write the fixtures**

`test/helpers/mesh-fixtures.js`:

```js
// Hand-built triangle soups for the describe pipeline's kernel-free unit tests.
// Every fixture returns the Manifold convention (`positions` only, 9 floats per
// triangle, no `indices`) because that is what the describe path actually sees —
// mesh imports are Manifold-only. Winding is CCW seen from outside, so face
// normals point outward and dihedral signs come out convex-positive.
const tri = (out, a, b, c) => { out.push(...a, ...b, ...c); };

// Axis-aligned box at the origin, [0,0,0]..[sx,sy,sz]. 12 triangles, and every
// one of its 12 edges is a +90° convex edge — the simplest possible topology
// assertion.
export function boxMesh(sx, sy, sz) {
  const v = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]];
  const quads = [[3,2,1,0],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
  const positions = [];
  for (const [a,b,c,d] of quads) { tri(positions, v[a], v[b], v[c]); tri(positions, v[a], v[c], v[d]); }
  return { positions };
}

// Z-axis cylinder from z=0 to z=h, radius r, `segs` facets. Two planar caps and
// one cylindrical wall: the minimum fixture that makes segmentation prove it can
// tell a curved surface from a flat one.
export function cylinderMesh(r, h, segs = 32) {
  const positions = [];
  const p = (i, z) => [r * Math.cos(2 * Math.PI * i / segs), r * Math.sin(2 * Math.PI * i / segs), z];
  for (let i = 0; i < segs; i++) {
    const a = p(i, 0), b = p(i + 1, 0), c = p(i + 1, h), d = p(i, h);
    tri(positions, a, b, c); tri(positions, a, c, d);        // wall
    tri(positions, [0,0,0], b, a);                            // bottom cap (normal -Z)
    tri(positions, [0,0,h], d, c);                            // top cap (normal +Z)
  }
  return { positions };
}

// A washer: outer radius rOut, concentric bore rIn, thickness h. This is THE
// through-hole fixture. The outer wall's edges to the caps are convex; the bore's
// are concave, which is the single distinction every hole rule is built on.
export function annulusPlate(rOut, rIn, h, segs = 32) {
  const positions = [];
  const p = (rad, i, z) => [rad * Math.cos(2 * Math.PI * i / segs), rad * Math.sin(2 * Math.PI * i / segs), z];
  for (let i = 0; i < segs; i++) {
    const o0 = p(rOut, i, 0), o1 = p(rOut, i + 1, 0), o2 = p(rOut, i + 1, h), o3 = p(rOut, i, h);
    const n0 = p(rIn, i, 0), n1 = p(rIn, i + 1, 0), n2 = p(rIn, i + 1, h), n3 = p(rIn, i, h);
    tri(positions, o0, o1, o2); tri(positions, o0, o2, o3);   // outer wall, normal outward
    tri(positions, n1, n0, n3); tri(positions, n1, n3, n2);   // bore wall, normal inward-facing
    tri(positions, o1, o0, n0); tri(positions, o1, n0, n1);   // bottom annulus, normal -Z
    tri(positions, o3, o2, n2); tri(positions, o3, n2, n3);   // top annulus, normal +Z
  }
  return { positions };
}
```

- [ ] **Step 2: Write the failing test**

`test/describe-topology.test.js`:

```js
import { expect, test } from "vitest";
import { buildTopology } from "../src/framework/oracle/describe/topology.js";
import { boxMesh, cylinderMesh, annulusPlate } from "./helpers/mesh-fixtures.js";

test("a box welds to 8 vertices and 12 triangles", () => {
  const t = buildTopology(boxMesh(10, 20, 5));
  expect(t.verts.length / 3).toBe(8);
  expect(t.tris.length / 3).toBe(12);
});

test("every box edge shared by two coplanar triangles is flat", () => {
  const t = buildTopology(boxMesh(10, 20, 5));
  const flat = t.edges.filter((e) => e.convexity === "flat");
  expect(flat.length).toBe(6);              // one diagonal per quad face
});

test("every box corner edge is convex at +90 degrees", () => {
  const t = buildTopology(boxMesh(10, 20, 5));
  const convex = t.edges.filter((e) => e.convexity === "convex");
  expect(convex.length).toBe(12);
  for (const e of convex) expect(e.dihedral).toBeCloseTo(Math.PI / 2, 6);
});

// `.some(...)` would pass against a fixture with half its edges inverted — and did,
// until a divergence-theorem check caught the top cap winding backwards. Assert EVERY
// edge in each group, identified by radial distance from the bore axis.
test("every bore-to-cap edge is concave and every outer-wall-to-cap edge is convex", () => {
  const t = buildTopology(annulusPlate(10, 4, 3, 24));
  const radial = (e) => {
    const m = [0, 1].map((k) => {
      const v = (k ? e.v1 : e.v0) * 3;
      return [t.verts[v], t.verts[v + 1]];
    });
    return (Math.hypot(...m[0]) + Math.hypot(...m[1])) / 2;
  };
  const seams = t.edges.filter((e) => e.convexity === "convex" || e.convexity === "concave");
  const bore = seams.filter((e) => radial(e) < 7);
  const outer = seams.filter((e) => radial(e) >= 7);
  expect(bore.length).toBeGreaterThan(0);
  expect(outer.length).toBeGreaterThan(0);
  expect(bore.every((e) => e.convexity === "concave")).toBe(true);
  expect(outer.every((e) => e.convexity === "convex")).toBe(true);
});

// A closed mesh's area-weighted face normals must sum to zero. Three lines that make a
// whole class of fixture winding bugs impossible to ship.
test.each([["box", boxMesh(10, 20, 5)], ["cylinder", cylinderMesh(4, 10, 32)],
           ["annulus", annulusPlate(10, 4, 3, 24)]])("%s fixture is closed and outward-wound", (_n, mesh) => {
  const t = buildTopology(mesh);
  const sum = [0, 0, 0];
  for (let i = 0; i < t.faceArea.length; i++) for (let a = 0; a < 3; a++) sum[a] += t.faceArea[i] * t.faceNormal[3*i + a];
  for (const a of sum) expect(Math.abs(a)).toBeLessThan(1e-6);
});

test("a watertight mesh has no boundary edges", () => {
  const t = buildTopology(annulusPlate(10, 4, 3, 24));
  expect(t.edges.filter((e) => e.convexity === "boundary").length).toBe(0);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/describe-topology.test.js`
Expected: FAIL — cannot resolve `describe/topology.js`.

- [ ] **Step 4: Implement `topology.js`**

```js
// Mesh → welded topology: the shared substrate every describe stage reads. Two
// jobs nothing downstream should have to repeat. (1) NORMALIZE: Manifold hands us
// a non-indexed soup and OCCT an indexed mesh, and no detector should branch on
// which. (2) SIGN THE DIHEDRALS: the signed angle across each shared edge is what
// separates a boss from a pocket and a fillet from a chamfer, and it is the one
// quantity the whole feature vocabulary rests on. Getting its sign convention
// wrong inverts every feature rule at once, so it is asserted directly in tests
// rather than only through the rules that consume it.
//
// Pure leaf: no kernel, no BVH, no DOM. See docs/superpowers/specs/
// 2026-08-21-semantic-mesh-oracle-design.md §2.1.
import { meshTriangles } from "../bvh.js";

// Coplanarity band for calling an edge "flat" rather than convex/concave. A
// tessellated cylinder's wall edges are genuinely convex at a small angle and must
// NOT be swallowed by this, so the band is much tighter than any facet step a
// reasonable chord tolerance produces: 1e-4 rad is ~0.006°.
const FLAT_EPS = 1e-4;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

// Weld tolerance defaults to a fraction of the bbox diagonal rather than an
// absolute number: a 2mm part and a 2m part both need welding, and an absolute
// epsilon is wrong for one of them. Callers with a known chord tolerance override.
function weldTolerance(triples) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of triples) for (const v of t) for (let a = 0; a < 3; a++) {
    if (v[a] < lo[a]) lo[a] = v[a];
    if (v[a] > hi[a]) hi[a] = v[a];
  }
  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 1e-7;
}

export function buildTopology(mesh, opts = {}) {
  const triples = meshTriangles(mesh);
  const tol = opts.weld ?? weldTolerance(triples);
  // Quantized grid hash. Snapping to a grid of `tol` merges coordinates that agree
  // to that scale; probing the 26 neighbouring cells too would be more correct at
  // cell boundaries, but a CAD tessellation emits bit-identical shared vertices, so
  // the exact-cell hit is the normal case and the neighbour probe is not worth its
  // cost here. Real scans get the same treatment via a caller-supplied `weld`.
  const key = (v) => `${Math.round(v[0] / tol)},${Math.round(v[1] / tol)},${Math.round(v[2] / tol)}`;
  const index = new Map();
  const verts = [];
  const vid = (v) => {
    const k = key(v);
    let i = index.get(k);
    if (i === undefined) { i = verts.length / 3; verts.push(v[0], v[1], v[2]); index.set(k, i); }
    return i;
  };

  const tris = new Uint32Array(triples.length * 3);
  const faceNormal = new Float64Array(triples.length * 3);
  const faceArea = new Float64Array(triples.length);
  for (let t = 0; t < triples.length; t++) {
    const [a, b, c] = triples[t];
    tris[3*t] = vid(a); tris[3*t+1] = vid(b); tris[3*t+2] = vid(c);
    const n = cross(sub(b, a), sub(c, a));
    const len = norm(n);
    faceArea[t] = len / 2;
    // A degenerate triangle has no normal. Store zeros rather than NaN: downstream
    // code filters on zero area, and NaN would silently poison every dot product.
    for (let k = 0; k < 3; k++) faceNormal[3*t+k] = len > 0 ? n[k] / len : 0;
  }

  // Edge table keyed by the UNORDERED vertex pair, but each half-edge remembers the
  // ORDER it was traversed in. That order is the winding, and the winding is what
  // gives the dihedral its sign.
  const half = new Map();
  const edges = [];
  const faceEdges = Array.from({ length: triples.length }, () => []);
  for (let t = 0; t < triples.length; t++) {
    for (let k = 0; k < 3; k++) {
      const v0 = tris[3*t + k], v1 = tris[3*t + (k + 1) % 3];
      const ek = v0 < v1 ? `${v0}:${v1}` : `${v1}:${v0}`;
      const prev = half.get(ek);
      if (prev === undefined) {
        half.set(ek, { v0, v1, triA: t, triB: -1, index: edges.length });
        edges.push(half.get(ek));
      } else {
        prev.triB = t;
      }
      faceEdges[t].push(half.get(ek).index);
    }
  }

  for (const e of edges) {
    if (e.triB < 0) { e.dihedral = 0; e.convexity = "boundary"; continue; }
    const nA = [faceNormal[3*e.triA], faceNormal[3*e.triA+1], faceNormal[3*e.triA+2]];
    const nB = [faceNormal[3*e.triB], faceNormal[3*e.triB+1], faceNormal[3*e.triB+2]];
    const p0 = [verts[3*e.v0], verts[3*e.v0+1], verts[3*e.v0+2]];
    const p1 = [verts[3*e.v1], verts[3*e.v1+1], verts[3*e.v1+2]];
    const dir = sub(p1, p0);
    const len = norm(dir);
    if (len === 0) { e.dihedral = 0; e.convexity = "flat"; continue; }
    const u = [dir[0]/len, dir[1]/len, dir[2]/len];
    // Signed angle between the two outward normals about the shared edge. With CCW
    // winding and outward normals, a positive angle means the surface turns away
    // from the material — convex. Negative means it folds into it — concave.
    const s = dot(cross(nA, nB), u);
    const c = dot(nA, nB);
    e.dihedral = Math.atan2(s, c);
    e.convexity = Math.abs(e.dihedral) < FLAT_EPS ? "flat" : e.dihedral > 0 ? "convex" : "concave";
  }

  return { verts: Float64Array.from(verts), tris, faceNormal, faceArea, edges, faceEdges };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/describe-topology.test.js`
Expected: PASS, 7 tests (the closure check is parameterised over three fixtures).

If the convex/concave assertions come out inverted, the fixture winding is backwards, not the formula — check `boxMesh`'s quad order before touching `atan2`.

- [ ] **Step 6: Commit**

```bash
git add test/helpers/mesh-fixtures.js src/framework/oracle/describe/topology.js test/describe-topology.test.js
git commit -m "feat(describe): welded topology with signed dihedral edge labels"
```

---

### Task 2: Primitive fitting

**Files:**
- Create: `src/framework/oracle/describe/fit.js`
- Test: `test/describe-fit.test.js`

**Interfaces:**
- Consumes: nothing (pure numerics).
- Produces: `fitPlane(pts) → { type:"plane", normal:[x,y,z], offset, rms, maxDev }`; `fitSphere(pts) → { type:"sphere", center, radius, rms, maxDev }`; `fitCylinder(pts, normals) → { type:"cylinder", axis:{origin,direction}, radius, extent:[lo,hi], rms, maxDev }`; `fitCone(pts, normals) → { type:"cone", apex, direction, halfAngle, rms, maxDev }`; `fitTorus(pts, normals) → { type:"torus", center, axis, majorRadius, minorRadius, rms, maxDev }`. Every fit returns `null` when it has too few points. Also exports `jacobiEigen(m3) → { values, vectors }` for reuse.

- [ ] **Step 1: Write the failing test**

`test/describe-fit.test.js`:

```js
import { expect, test } from "vitest";
import { fitPlane, fitSphere, fitCylinder, fitCone, fitTorus } from "../src/framework/oracle/describe/fit.js";

const grid = (f, n = 12) => {
  const out = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out.push(f(i / (n - 1), j / (n - 1)));
  return out;
};

test("fitPlane recovers a tilted plane exactly", () => {
  // z = 2x + 3y + 5  ->  normal proportional to (-2,-3,1)
  const pts = grid((u, v) => [u * 10, v * 10, 2 * (u * 10) + 3 * (v * 10) + 5]);
  const f = fitPlane(pts);
  const k = 1 / Math.hypot(2, 3, 1);
  expect(Math.abs(f.normal[0])).toBeCloseTo(2 * k, 6);
  expect(Math.abs(f.normal[1])).toBeCloseTo(3 * k, 6);
  expect(f.rms).toBeLessThan(1e-9);
});

test("fitPlane reports real error on a deliberately non-planar set", () => {
  const pts = grid((u, v) => [u * 10, v * 10, u * v * 4]);
  expect(fitPlane(pts).rms).toBeGreaterThan(0.1);
});

test("fitSphere recovers centre and radius", () => {
  const pts = [];
  for (let i = 0; i < 200; i++) {
    const th = (i * 2.399963), z = -1 + 2 * (i + 0.5) / 200, r = Math.sqrt(1 - z * z);
    pts.push([3 + 7 * r * Math.cos(th), -2 + 7 * r * Math.sin(th), 5 + 7 * z]);
  }
  const f = fitSphere(pts);
  expect(f.center[0]).toBeCloseTo(3, 4);
  expect(f.center[1]).toBeCloseTo(-2, 4);
  expect(f.center[2]).toBeCloseTo(5, 4);
  expect(f.radius).toBeCloseTo(7, 4);
});

test("fitCylinder recovers axis direction, radius, and axial extent", () => {
  const pts = [], normals = [];
  for (let i = 0; i < 64; i++) for (const z of [0, 2, 4, 6]) {
    const a = 2 * Math.PI * i / 64;
    const n = [Math.cos(a), Math.sin(a), 0];
    normals.push(n);
    pts.push([1 + 2.5 * n[0], 4 + 2.5 * n[1], z]);
  }
  const f = fitCylinder(pts, normals);
  expect(Math.abs(f.axis.direction[2])).toBeCloseTo(1, 6);
  expect(f.radius).toBeCloseTo(2.5, 5);
  expect(f.extent[1] - f.extent[0]).toBeCloseTo(6, 5);
});

test("fitCone recovers half-angle", () => {
  const pts = [], normals = [];
  const halfAngle = Math.PI / 6;                   // 30 degrees
  for (let i = 0; i < 64; i++) for (const z of [1, 2, 3, 4]) {
    const a = 2 * Math.PI * i / 64;
    const r = z * Math.tan(halfAngle);
    pts.push([r * Math.cos(a), r * Math.sin(a), z]);
    // outward normal of a +Z-opening cone
    const n = [Math.cos(halfAngle) * Math.cos(a), Math.cos(halfAngle) * Math.sin(a), -Math.sin(halfAngle)];
    normals.push(n);
  }
  const f = fitCone(pts, normals);
  expect(f.halfAngle).toBeCloseTo(halfAngle, 3);
});

test("fitTorus recovers major and minor radii", () => {
  const pts = [], normals = [];
  const R = 10, r = 2;
  for (let i = 0; i < 32; i++) for (let j = 0; j < 16; j++) {
    const u = 2 * Math.PI * i / 32, v = 2 * Math.PI * j / 16;
    const radial = [Math.cos(u), Math.sin(u), 0];
    normals.push([radial[0] * Math.cos(v), radial[1] * Math.cos(v), Math.sin(v)]);
    pts.push([(R + r * Math.cos(v)) * radial[0], (R + r * Math.cos(v)) * radial[1], r * Math.sin(v)]);
  }
  const f = fitTorus(pts, normals);
  expect(f.majorRadius).toBeCloseTo(R, 3);
  expect(f.minorRadius).toBeCloseTo(r, 3);
});

test("a fit with too few points returns null rather than a garbage fit", () => {
  expect(fitPlane([[0,0,0],[1,0,0]])).toBeNull();
  expect(fitSphere([[0,0,0],[1,0,0],[0,1,0]])).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/describe-fit.test.js`
Expected: FAIL — cannot resolve `describe/fit.js`.

- [ ] **Step 3: Implement `fit.js`**

The numerical core. Three shared primitives do most of the work — a 3×3 symmetric
eigendecomposition, an algebraic sphere fit, and an algebraic 2D circle fit — and
the five public fits compose them.

```js
// Least-squares fits for the five analytic surfaces the describe vocabulary uses.
//
// EVERY fit returns its own error (`rms`, `maxDev`) and no fit is ever returned
// without one. That is not decoration: the report's entire claim to honesty is
// that a surface carries the residual of the primitive it was called, so a caller
// can tell a real cylinder from a lightly-curved freeform patch that a fitter was
// willing to call one. A fit function that returned only parameters would make the
// report unfalsifiable.
//
// The algebraic (rather than geometric/iterative) formulations are deliberate.
// They are exact for exact data — which is the v1 input class, CAD-exported
// tessellation — closed-form, dependency-free, and fast enough to run inside a
// region-growing refit loop. They bias slightly under heavy noise; that is the
// known cost to revisit if real scans become a target (spec §9).
//
// Pure leaf. See spec §2.2.

const MIN_PTS = { plane: 3, sphere: 4, circle: 3 };

const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const scale = (a, s) => [a[0]*s, a[1]*s, a[2]*s];
const unit = (a) => { const n = Math.hypot(a[0], a[1], a[2]); return n > 0 ? scale(a, 1/n) : [0,0,0]; };
const mean = (pts) => {
  const c = [0,0,0];
  for (const p of pts) { c[0]+=p[0]; c[1]+=p[1]; c[2]+=p[2]; }
  return scale(c, 1/pts.length);
};
// Deviations → {rms, maxDev}. One place, so no fit can invent its own error metric.
const errors = (devs) => {
  let s = 0, m = 0;
  for (const d of devs) { s += d*d; if (Math.abs(d) > m) m = Math.abs(d); }
  return { rms: Math.sqrt(s / devs.length), maxDev: m };
};

// Cyclic Jacobi eigendecomposition of a symmetric 3x3, returned smallest-first.
// Chosen over the analytic cubic because the cubic loses precision badly on nearly
// degenerate spectra — which is exactly the case here, since a well-fit plane's
// covariance HAS a near-zero eigenvalue and that eigenvector is the answer.
export function jacobiEigen(m) {
  const a = [[m[0][0], m[0][1], m[0][2]], [m[1][0], m[1][1], m[1][2]], [m[2][0], m[2][1], m[2][2]]];
  let v = [[1,0,0],[0,1,0],[0,0,1]];
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = 0;
    for (const [p, q] of [[0,1],[0,2],[1,2]]) off += a[p][q] * a[p][q];
    if (off < 1e-30) break;
    for (const [p, q] of [[0,1],[0,2],[1,2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta*theta + 1));
      const c = 1 / Math.sqrt(t*t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c*akp - s*akq; a[k][q] = s*akp + c*akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c*apk - s*aqk; a[q][k] = s*apk + c*aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c*vkp - s*vkq; v[k][q] = s*vkp + c*vkq;
      }
    }
  }
  const order = [0,1,2].sort((i, j) => a[i][i] - a[j][j]);
  return {
    values: order.map((i) => a[i][i]),
    vectors: order.map((i) => [v[0][i], v[1][i], v[2][i]]),
  };
}

// Dense Gaussian elimination with partial pivoting. n is 3 or 4 here, so the naive
// implementation is the right one; returns null on a singular system rather than
// producing Infinities that would look like a successful fit.
function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function fitPlane(pts) {
  if (pts.length < MIN_PTS.plane) return null;
  const c = mean(pts);
  const cov = [[0,0,0],[0,0,0],[0,0,0]];
  for (const p of pts) {
    const d = sub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += d[i] * d[j];
  }
  // The smallest-eigenvalue eigenvector of the covariance is the direction of least
  // spread — the plane normal. Its eigenvalue is the summed squared deviation.
  const normal = unit(jacobiEigen(cov).vectors[0]);
  if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) return null;
  const offset = dot(normal, c);
  return { type: "plane", normal, offset, ...errors(pts.map((p) => dot(normal, p) - offset)) };
}

export function fitSphere(pts) {
  if (pts.length < MIN_PTS.sphere) return null;
  // Algebraic form: |p|^2 = 2c·p + k, linear in (c, k). Four unknowns, one row per
  // point, solved through the 4x4 normal equations.
  const A = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]], b = [0,0,0,0];
  for (const p of pts) {
    const row = [2*p[0], 2*p[1], 2*p[2], 1], rhs = dot(p, p);
    for (let i = 0; i < 4; i++) { for (let j = 0; j < 4; j++) A[i][j] += row[i]*row[j]; b[i] += row[i]*rhs; }
  }
  const x = solve(A, b);
  if (!x) return null;
  const center = [x[0], x[1], x[2]];
  const r2 = x[3] + dot(center, center);
  if (!(r2 > 0)) return null;
  const radius = Math.sqrt(r2);
  return { type: "sphere", center, radius,
    ...errors(pts.map((p) => Math.hypot(p[0]-center[0], p[1]-center[1], p[2]-center[2]) - radius)) };
}

// 2D algebraic circle fit — the planar twin of fitSphere, used by the cylinder and
// torus fits after they project into a plane perpendicular to their axis.
function fitCircle2D(uv) {
  if (uv.length < MIN_PTS.circle) return null;
  const A = [[0,0,0],[0,0,0],[0,0,0]], b = [0,0,0];
  for (const [u, v] of uv) {
    const row = [2*u, 2*v, 1], rhs = u*u + v*v;
    for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) A[i][j] += row[i]*row[j]; b[i] += row[i]*rhs; }
  }
  const x = solve(A, b);
  if (!x) return null;
  const r2 = x[2] + x[0]*x[0] + x[1]*x[1];
  if (!(r2 > 0)) return null;
  return { cu: x[0], cv: x[1], radius: Math.sqrt(r2) };
}

// An orthonormal basis with `w` as its third axis. Picking the seed axis as the one
// `w` is LEAST aligned with keeps the cross product well-conditioned.
function basis(w) {
  const seed = Math.abs(w[0]) < 0.9 ? [1,0,0] : [0,1,0];
  const u = unit(cross(w, seed));
  return [u, cross(w, u), w];
}

// Axis of a surface of revolution, from its NORMAL field rather than its points — which
// is what makes it robust on a partial arc, where the points alone barely constrain it.
//
// Which eigenvector is the axis depends on the surface, and getting this wrong is a real
// trap (controller ruling R13). A cylinder's normals lie in a plane perpendicular to the
// axis: covariance eigenvalues go {0, 1/2, 1/2} and the axis is the SMALLEST. A full
// torus's normals sweep the whole sphere: eigenvalues go {1/4, 1/4, 1/2} and the axis is
// the LARGEST. What is invariant across both is that two eigenvalues are near-degenerate
// and the axis is the odd one out — so pick by which gap is wider, not by a fixed end.
function axisFromNormals(normals) {
  const cov = [[0,0,0],[0,0,0],[0,0,0]];
  for (const n of normals) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += n[i]*n[j];
  const { values, vectors } = jacobiEigen(cov);
  const gapLow = values[1] - values[0], gapHigh = values[2] - values[1];
  return unit(gapLow < gapHigh ? vectors[2] : vectors[0]);
}

export function fitCylinder(pts, normals) {
  if (pts.length < 6 || !normals || normals.length !== pts.length) return null;
  const direction = axisFromNormals(normals);
  const [u, v] = basis(direction);
  const c = mean(pts);
  const circle = fitCircle2D(pts.map((p) => { const d = sub(p, c); return [dot(d, u), dot(d, v)]; }));
  if (!circle) return null;
  const origin = [
    c[0] + circle.cu*u[0] + circle.cv*v[0],
    c[1] + circle.cu*u[1] + circle.cv*v[1],
    c[2] + circle.cu*u[2] + circle.cv*v[2],
  ];
  const axials = pts.map((p) => dot(sub(p, origin), direction));
  const devs = pts.map((p) => {
    const d = sub(p, origin);
    const ax = dot(d, direction);
    return Math.hypot(d[0]-ax*direction[0], d[1]-ax*direction[1], d[2]-ax*direction[2]) - circle.radius;
  });
  return { type: "cylinder", axis: { origin, direction }, radius: circle.radius,
    extent: [Math.min(...axials), Math.max(...axials)], ...errors(devs) };
}

export function fitCone(pts, normals) {
  if (pts.length < 6 || !normals || normals.length !== pts.length) return null;
  // On a cone of half-angle a, every outward normal satisfies n·axis = -sin(a) — a
  // constant. So the normals lie on a PLANE in normal space, and fitting that plane
  // gives the axis (its normal) and the half-angle (its offset) in one step.
  const pf = fitPlane(normals);
  if (!pf) return null;
  const direction = pf.normal;
  const sinA = -pf.offset;
  const halfAngle = Math.asin(Math.max(-1, Math.min(1, Math.abs(sinA))));
  if (!(halfAngle > 1e-4) || halfAngle > Math.PI/2 - 1e-4) return null;  // a plane or a cylinder, not a cone
  // Apex: the point minimising distance to every surface normal's plane. Each point
  // contributes n·x = n·p, and the least-squares intersection of those planes is the
  // apex, since every cone normal's plane passes through it.
  const A = [[0,0,0],[0,0,0],[0,0,0]], b = [0,0,0];
  for (let i = 0; i < pts.length; i++) {
    const n = normals[i], rhs = dot(n, pts[i]);
    for (let r = 0; r < 3; r++) { for (let cc = 0; cc < 3; cc++) A[r][cc] += n[r]*n[cc]; b[r] += n[r]*rhs; }
  }
  const apex = solve(A, b);
  if (!apex) return null;
  const axis = dot(sub(pts[0], apex), direction) < 0 ? scale(direction, -1) : direction;
  const tanA = Math.tan(halfAngle);
  const devs = pts.map((p) => {
    const d = sub(p, apex);
    const ax = dot(d, axis);
    const rad = Math.hypot(d[0]-ax*axis[0], d[1]-ax*axis[1], d[2]-ax*axis[2]);
    return (rad - ax * tanA) * Math.cos(halfAngle);   // perpendicular distance to the surface
  });
  return { type: "cone", apex, direction: axis, halfAngle, ...errors(devs) };
}

export function fitTorus(pts, normals) {
  if (pts.length < 8 || !normals || normals.length !== pts.length) return null;
  // NOT the smallest eigenvector — see axisFromNormals for why a torus inverts the choice.
  const axis = axisFromNormals(normals);
  const c = mean(pts);
  // In the (radial, axial) half-plane a torus is a CIRCLE of the minor radius centred
  // at the major radius. Fitting that 2D circle recovers both radii at once.
  const rz = pts.map((p) => {
    const d = sub(p, c);
    const ax = dot(d, axis);
    return [Math.hypot(d[0]-ax*axis[0], d[1]-ax*axis[1], d[2]-ax*axis[2]), ax];
  });
  const circle = fitCircle2D(rz);
  if (!circle || !(circle.cu > circle.radius)) return null;   // degenerate / self-intersecting
  const center = [c[0] + circle.cv*axis[0], c[1] + circle.cv*axis[1], c[2] + circle.cv*axis[2]];
  const devs = rz.map(([r, z]) => Math.hypot(r - circle.cu, z - circle.cv) - circle.radius);
  return { type: "torus", center, axis, majorRadius: circle.cu, minorRadius: circle.radius, ...errors(devs) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/describe-fit.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/framework/oracle/describe/fit.js test/describe-fit.test.js
git commit -m "feat(describe): least-squares fits for plane/sphere/cylinder/cone/torus"
```

---

### Task 3: Segmentation — Gauss-map seeding + region growing

**Files:**
- Create: `src/framework/oracle/describe/segment.js`
- Modify: `src/framework/oracle/describe/fit.js` (add and export `deviationOf`)
- Test: `test/describe-segment.test.js`
- Test: `test/describe-fit.test.js` (add cases for `deviationOf`)

**Interfaces:**
- Consumes: `buildTopology` (Task 1); `fitPlane`, `fitCylinder`, `fitCone`, `fitSphere`, `fitTorus` (Task 2).
- Adds to `fit.js`: `deviationOf(fit, point) → number` — SIGNED distance from `point` to the surface described by any Task 2 fit result. One definition of point-to-primitive distance, shared by this task's growth predicate and Task 4's RANSAC consensus test, so the two can never drift apart. Task 4 must import it rather than writing its own.
- Produces: `segment(topo, opts?) → { patches, unassigned }` where `patches[i] = { id, faces: number[], fit, area }` (`fit` is any Task 2 fit result) and `unassigned` is a `number[]` of face indices no patch claimed.

- [ ] **Step 1: Write the failing test**

`test/describe-segment.test.js`:

```js
import { expect, test } from "vitest";
import { buildTopology } from "../src/framework/oracle/describe/topology.js";
import { segment } from "../src/framework/oracle/describe/segment.js";
import { boxMesh, cylinderMesh, annulusPlate } from "./helpers/mesh-fixtures.js";

const run = (mesh) => segment(buildTopology(mesh));

test("a box segments into exactly six planes", () => {
  const { patches, unassigned } = run(boxMesh(10, 20, 5));
  expect(patches.length).toBe(6);
  expect(patches.every((p) => p.fit.type === "plane")).toBe(true);
  expect(unassigned.length).toBe(0);
});

test("box patches carry both triangles of their quad", () => {
  const { patches } = run(boxMesh(10, 20, 5));
  for (const p of patches) expect(p.faces.length).toBe(2);
});

test("a cylinder segments into two planes and one cylinder", () => {
  const { patches } = run(cylinderMesh(4, 10, 48));
  const types = patches.map((p) => p.fit.type).sort();
  expect(types).toEqual(["cylinder", "plane", "plane"]);
});

test("the recovered cylinder radius matches the fixture", () => {
  const { patches } = run(cylinderMesh(4, 10, 48));
  const cyl = patches.find((p) => p.fit.type === "cylinder");
  expect(cyl.fit.radius).toBeCloseTo(4, 2);
});

test("a washer segments into two annulus planes and two cylinders", () => {
  const { patches } = run(annulusPlate(10, 4, 3, 48));
  const radii = patches.filter((p) => p.fit.type === "cylinder").map((p) => p.fit.radius).sort((a, b) => a - b);
  expect(radii.length).toBe(2);
  expect(radii[0]).toBeCloseTo(4, 1);
  expect(radii[1]).toBeCloseTo(10, 1);
});

test("patch areas sum to the mesh area", () => {
  const topo = buildTopology(cylinderMesh(4, 10, 48));
  const { patches } = segment(topo);
  const total = [...topo.faceArea].reduce((a, b) => a + b, 0);
  expect(patches.reduce((a, p) => a + p.area, 0)).toBeCloseTo(total, 6);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/describe-segment.test.js`
Expected: FAIL — cannot resolve `describe/segment.js`.

- [ ] **Step 3: Implement `segment.js`**

```js
// Mesh faces -> primitive patches. The classic reverse-engineering segmentation,
// implemented rather than invented (spec "Prior art"): seed in normal space, grow
// on the dual graph under a primitive predicate, refit as the region grows, repeat
// to stability.
//
// Why BOTH seeding and growing, when either alone half-works: Gauss-map bucketing
// alone cannot separate two parallel planes at different offsets, and it shreds a
// tessellated cylinder into one bucket per facet. Region growing alone has no idea
// where to start and picks up whatever its arbitrary seed happened to touch. Seeds
// give growth a well-conditioned starting hypothesis; growth gives seeds their
// spatial coherence. This is the same structure Efficient RANSAC and VSA arrive at
// from different directions.
//
// The patches this produces are CANDIDATES, not truth (spec §2.8) — accept.js
// decides what is real. So a slightly over-eager grow here is recoverable, and the
// tolerances lean permissive on purpose.
//
// Pure leaf. See spec §2.3.
import { fitPlane, fitCylinder, fitCone, fitSphere, fitTorus, deviationOf } from "./fit.js";

// Fit acceptance band, as a fraction of the mesh's bbox diagonal. A CAD
// tessellation's chord error is bounded and small; this sits an order of magnitude
// above it so faceting never breaks a surface apart, and well below any real
// feature size so two genuinely different surfaces never merge.
const FIT_TOL_FRAC = 3e-4;
const MIN_PATCH_FACES = 1;
const REFIT_ROUNDS = 3;

// Try each primitive in ascending order of degrees of freedom and keep the FIRST
// that fits within tolerance, never the best-scoring one. A plane is a degenerate
// cylinder of infinite radius and a cylinder is a degenerate cone of zero angle,
// so "best RMS" would routinely dress a flat face as a huge-radius cylinder and
// produce a technically-accurate, semantically-useless report.
function bestFit(pts, normals, tol) {
  for (const f of [fitPlane(pts), fitCylinder(pts, normals), fitCone(pts, normals),
                   fitSphere(pts), fitTorus(pts, normals)]) {
    if (f && f.maxDev <= tol) return f;
  }
  return null;
}

const faceCentroid = (topo, t) => {
  const c = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const v = topo.tris[3*t + k] * 3;
    c[0] += topo.verts[v] / 3; c[1] += topo.verts[v+1] / 3; c[2] += topo.verts[v+2] / 3;
  }
  return c;
};
const faceNormalOf = (topo, t) => [topo.faceNormal[3*t], topo.faceNormal[3*t+1], topo.faceNormal[3*t+2]];

// All three vertices of a face, so a fit sees the real surface rather than a cloud
// of centroids — a cylinder fitted from centroids alone comes out systematically
// under-radius by the sagitta of one facet.
function facePoints(topo, faces) {
  const pts = [], normals = [];
  for (const t of faces) {
    const n = faceNormalOf(topo, t);
    for (let k = 0; k < 3; k++) {
      const v = topo.tris[3*t + k] * 3;
      pts.push([topo.verts[v], topo.verts[v+1], topo.verts[v+2]]);
      normals.push(n);
    }
  }
  return { pts, normals };
}

// Worst distance from a face's three vertices to a fitted primitive. The growth
// predicate (ruling R19): cheap, allocation-light, and it reuses the ONE definition of
// point-to-primitive distance that fit.js owns, so growth and RANSAC can never disagree
// about what "within tolerance" means.
function faceDeviation(topo, t, fit) {
  let worst = 0;
  for (let k = 0; k < 3; k++) {
    const v = topo.tris[3*t + k] * 3;
    const d = Math.abs(deviationOf(fit, [topo.verts[v], topo.verts[v+1], topo.verts[v+2]]));
    if (d > worst) worst = d;
  }
  return worst;
}

// Neighbour faces across non-boundary edges.
function neighbours(topo, t) {
  const out = [];
  for (const ei of topo.faceEdges[t]) {
    const e = topo.edges[ei];
    if (e.triB < 0) continue;
    out.push(e.triA === t ? e.triB : e.triA);
  }
  return out;
}

// Seed order: bucket faces by quantized normal on the Gauss sphere, then visit the
// buckets largest-area-first. Big flat regions get claimed while the fit is
// best-conditioned, and the fiddly transition strips (fillets, chamfers) are left
// for last instead of being grown into by accident.
function seedOrder(topo) {
  const buckets = new Map();
  for (let t = 0; t < topo.faceArea.length; t++) {
    if (topo.faceArea[t] <= 0) continue;
    const n = faceNormalOf(topo, t);
    const key = `${Math.round(n[0]*24)},${Math.round(n[1]*24)},${Math.round(n[2]*24)}`;
    if (!buckets.has(key)) buckets.set(key, { area: 0, faces: [] });
    const b = buckets.get(key);
    b.area += topo.faceArea[t];
    b.faces.push(t);
  }
  return [...buckets.values()].sort((a, b) => b.area - a.area).flatMap((b) => b.faces);
}

export function segment(topo, opts = {}) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < topo.verts.length; i += 3) for (let a = 0; a < 3; a++) {
    if (topo.verts[i+a] < lo[a]) lo[a] = topo.verts[i+a];
    if (topo.verts[i+a] > hi[a]) hi[a] = topo.verts[i+a];
  }
  const tol = opts.tol ?? Math.hypot(hi[0]-lo[0], hi[1]-lo[1], hi[2]-lo[2]) * FIT_TOL_FRAC;

  const owner = new Int32Array(topo.faceArea.length).fill(-1);
  const patches = [];

  for (const seed of seedOrder(topo)) {
    if (owner[seed] >= 0) continue;
    let faces = [seed];
    owner[seed] = patches.length;
    let fit = bestFit(...Object.values(facePoints(topo, faces)), tol);
    if (!fit) { owner[seed] = -1; continue; }

    // Grow, refit, grow again. Refitting matters: a patch seeded on one facet of a
    // cylinder starts out fitted as a PLANE, and only once it has grown across a few
    // facets does the cylinder fit become the better description. Without the refit
    // rounds the whole wall would come out as a fan of tiny planes.
    for (let round = 0; round < REFIT_ROUNDS; round++) {
      // Candidates are tested against the CURRENT fit's parameters, not by re-fitting
      // the whole trial set (controller ruling R19). Re-fitting per candidate would call
      // bestFit — and therefore fitTorus, the most expensive fit at ~3-17ms — on every
      // REJECTED neighbour, which is most of them: a trial set spanning two surfaces fits
      // nothing, so it falls through every cheaper fit first. That is thousands of full
      // fits per part. A deviation check against the standing fit is the standard
      // region-growing formulation, is orders of magnitude cheaper, and is
      // correctness-neutral because the refit below re-converges the patch each round.
      const queue = [...faces];
      let grew = false;
      while (queue.length) {
        for (const nb of neighbours(topo, queue.pop())) {
          if (owner[nb] >= 0 || topo.faceArea[nb] <= 0) continue;
          if (faceDeviation(topo, nb, fit) > tol) continue;   // see helper below
          faces.push(nb); owner[nb] = patches.length; queue.push(nb); grew = true;
        }
      }
      if (!grew) break;
      const { pts, normals } = facePoints(topo, faces);
      fit = bestFit(pts, normals, tol) ?? fit;
    }

    if (faces.length < MIN_PATCH_FACES) { for (const t of faces) owner[t] = -1; continue; }
    patches.push({
      id: `q${patches.length}`, faces, fit,
      area: faces.reduce((a, t) => a + topo.faceArea[t], 0),
    });
  }

  const unassigned = [];
  for (let t = 0; t < owner.length; t++) if (owner[t] < 0 && topo.faceArea[t] > 0) unassigned.push(t);
  return { patches, unassigned };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/describe-segment.test.js`
Expected: PASS, 6 tests.

If the cylinder shreds into many plane patches, `FIT_TOL_FRAC` is too tight for the
fixture's facet count — raise the fixture's `segs`, do not loosen the constant
past 1e-3 (two distinct surfaces start merging above that).

- [ ] **Step 5: Commit**

```bash
git add src/framework/oracle/describe/segment.js test/describe-segment.test.js
git commit -m "feat(describe): Gauss-map seeded region-growing segmentation"
```

---

### Task 4: RANSAC mop-up

**Files:**
- Create: `src/framework/oracle/describe/ransac.js`
- Modify: `src/framework/oracle/describe/segment.js` (call the mop-up at the end)
- Test: `test/describe-ransac.test.js`

**Interfaces:**
- Consumes: Task 2's fits plus `deviationOf` (added to `fit.js` in Task 3 — import it; do NOT write a second point-to-primitive distance); `topo` from Task 1.
- Produces: `ransacPatches(topo, faces, tol, opts?) → { patches, unassigned }` — same patch shape as Task 3, `id` prefixed `r`. `segment()` gains an `opts.ransac = false` escape hatch and otherwise runs the mop-up over its own `unassigned`.

- [ ] **Step 1: Write the failing test**

`test/describe-ransac.test.js`:

```js
import { expect, test } from "vitest";
import { buildTopology } from "../src/framework/oracle/describe/topology.js";
import { ransacPatches } from "../src/framework/oracle/describe/ransac.js";
import { segment } from "../src/framework/oracle/describe/segment.js";
import { boxMesh, cylinderMesh } from "./helpers/mesh-fixtures.js";

test("ransac recovers a plane from a disconnected face set", () => {
  const topo = buildTopology(boxMesh(10, 20, 5));
  // Every face, offered with no adjacency hint at all — region growing's job is
  // done by connectivity, ransac's job is done by consensus.
  const all = [...topo.faceArea.keys()];
  const { patches } = ransacPatches(topo, all, 1e-3);
  expect(patches.length).toBeGreaterThanOrEqual(6);
  expect(patches.every((p) => p.fit.type === "plane")).toBe(true);
});

test("ransac is deterministic across runs", () => {
  const topo = buildTopology(cylinderMesh(4, 10, 32));
  const a = ransacPatches(topo, [...topo.faceArea.keys()], 1e-2);
  const b = ransacPatches(topo, [...topo.faceArea.keys()], 1e-2);
  expect(a.patches.map((p) => p.faces.length)).toEqual(b.patches.map((p) => p.faces.length));
});

test("ransac leaves faces it cannot explain in unassigned", () => {
  const topo = buildTopology(boxMesh(10, 20, 5));
  const { patches, unassigned } = ransacPatches(topo, [0, 1], 1e-9);
  const claimed = patches.reduce((a, p) => a + p.faces.length, 0);
  expect(claimed + unassigned.length).toBe(2);
});

test("segment runs the mop-up and reports no unassigned faces on a box", () => {
  expect(segment(buildTopology(boxMesh(10, 20, 5))).unassigned.length).toBe(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/describe-ransac.test.js`
Expected: FAIL — cannot resolve `describe/ransac.js`.

- [ ] **Step 3: Implement `ransac.js`**

```js
// Efficient RANSAC (Schnabel/Wahl/Klein 2007) over the faces region growing could
// not claim. Growth is connectivity-driven and therefore blind to a surface split
// into disjoint islands by a feature crossing it — a plane interrupted by a boss,
// a wall broken by a slot. RANSAC is consensus-driven and does not care whether its
// inliers touch, so the two are complementary rather than redundant.
//
// DETERMINISM IS A HARD REQUIREMENT, not a nicety. Oracle output feeds a
// content-hash memo (spec §4.1) and the framework's purity rule forbids Math.random
// outright, so candidate sampling walks a fixed stride over the face list instead
// of drawing randomly. Same input, same patches, every run, in every process.
//
// Pure leaf. See spec §2.3.
import { fitPlane, fitCylinder, fitCone, fitSphere, fitTorus, deviationOf } from "./fit.js";

const MIN_INLIERS = 3;
const MAX_ROUNDS = 64;      // consensus attempts per extraction round
const STRIDE = 7;           // coprime-ish walk so successive samples are spread out

const faceNormalOf = (topo, t) => [topo.faceNormal[3*t], topo.faceNormal[3*t+1], topo.faceNormal[3*t+2]];
function facePoints(topo, faces) {
  const pts = [], normals = [];
  for (const t of faces) {
    const n = faceNormalOf(topo, t);
    for (let k = 0; k < 3; k++) {
      const v = topo.tris[3*t + k] * 3;
      pts.push([topo.verts[v], topo.verts[v+1], topo.verts[v+2]]);
      normals.push(n);
    }
  }
  return { pts, normals };
}

// Worst distance from a face's three vertices to a fitted primitive. Exported because
// segment.js's growth predicate needs exactly the same question answered exactly the same
// way; the point-to-primitive distance itself lives in fit.js (ruling R19), so there is
// one definition and neither consumer can drift from it.
export function faceDeviation(topo, t, fit) {
  let worst = 0;
  for (let k = 0; k < 3; k++) {
    const v = topo.tris[3*t + k] * 3;
    const d = Math.abs(deviationOf(fit, [topo.verts[v], topo.verts[v+1], topo.verts[v+2]]));
    if (d > worst) worst = d;
  }
  return worst;
}

function candidateFrom(topo, sample, tol) {
  const { pts, normals } = facePoints(topo, sample);
  for (const f of [fitPlane(pts), fitCylinder(pts, normals), fitCone(pts, normals),
                   fitSphere(pts), fitTorus(pts, normals)]) {
    if (f && f.maxDev <= tol) return f;
  }
  return null;
}

export function ransacPatches(topo, faces, tol, opts = {}) {
  const minInliers = opts.minInliers ?? MIN_INLIERS;
  let pool = [...faces];
  const patches = [];

  while (pool.length >= minInliers) {
    let best = null;
    for (let round = 0; round < Math.min(MAX_ROUNDS, pool.length); round++) {
      // Deterministic minimal sample: three faces spread across the pool.
      const sample = [0, 1, 2].map((k) => pool[(round * STRIDE + k * Math.max(1, pool.length >> 2)) % pool.length]);
      if (new Set(sample).size < 3) continue;
      const fit = candidateFrom(topo, sample, tol);
      if (!fit) continue;
      const inliers = pool.filter((t) => faceDeviation(topo, t, fit) <= tol);
      if (inliers.length >= minInliers && (!best || inliers.length > best.inliers.length)) best = { fit, inliers };
    }
    if (!best) break;
    // Refit on the full consensus set: the minimal sample only located the surface,
    // and every subsequent consumer reads these parameters as measurements.
    const { pts, normals } = facePoints(topo, best.inliers);
    const refit = candidateFrom(topo, best.inliers, tol)
      ?? (best.fit.type === "plane" ? fitPlane(pts) : candidateFrom(topo, best.inliers, tol * 2))
      ?? best.fit;
    patches.push({
      id: `r${patches.length}`, faces: best.inliers, fit: refit,
      area: best.inliers.reduce((a, t) => a + topo.faceArea[t], 0),
    });
    const claimed = new Set(best.inliers);
    pool = pool.filter((t) => !claimed.has(t));
  }

  return { patches, unassigned: pool };
}
```

- [ ] **Step 4: Wire the mop-up into `segment.js`**

Add the import at the top of `segment.js`:

```js
import { ransacPatches } from "./ransac.js";
```

Replace the final `return { patches, unassigned };` with:

```js
  // Region growing is connectivity-bound; RANSAC is not. Anything growth could not
  // claim gets one consensus pass before it is declared residual, so a surface split
  // into islands by a crossing feature is recovered rather than reported as a hole in
  // the description. `opts.ransac === false` skips it — used by ransac.js's own tests
  // and by the budget path in accept.js.
  if (opts.ransac !== false && unassigned.length) {
    const mop = ransacPatches(topo, unassigned, tol);
    patches.push(...mop.patches);
    return { patches, unassigned: mop.unassigned };
  }
  return { patches, unassigned };
```

- [ ] **Step 5: Run both test files to verify they pass**

Run: `npx vitest run test/describe-ransac.test.js test/describe-segment.test.js`
Expected: PASS, 10 tests total. Task 3's assertions must still hold — the mop-up
must not change a clean segmentation.

- [ ] **Step 6: Commit**

```bash
git add src/framework/oracle/describe/ransac.js src/framework/oracle/describe/segment.js test/describe-ransac.test.js
git commit -m "feat(describe): deterministic RANSAC mop-up for unclaimed faces"
```

---

### Task 5: Surface graph (the attributed adjacency graph)

**Files:**
- Create: `src/framework/oracle/describe/surface-graph.js`
- Test: `test/describe-surface-graph.test.js`

**Interfaces:**
- Consumes: `buildTopology` (Task 1), `segment` (Tasks 3–4).
- Produces: `surfaceGraph(topo, patches) → { surfaces, arcs }` where
  `surfaces[i] = { id: "s0", type, fit, faces, area, loops, curvature }` where `curvature` is
  `"convex" | "concave" | null` (null for planes — see controller ruling R10) and `loops` is an
  array of closed vertex-index rings on the surface boundary, and
  `arcs[i] = { between: [idA, idB], convexity, kind: "line"|"circle"|"mixed", radius, length, axis }`.
  Also exports `arcsOf(graph, surfaceId) → arc[]`.

- [ ] **Step 1: Write the failing test**

`test/describe-surface-graph.test.js`:

```js
import { expect, test } from "vitest";
import { buildTopology } from "../src/framework/oracle/describe/topology.js";
import { segment } from "../src/framework/oracle/describe/segment.js";
import { surfaceGraph, arcsOf } from "../src/framework/oracle/describe/surface-graph.js";
import { boxMesh, annulusPlate } from "./helpers/mesh-fixtures.js";

const graphOf = (mesh) => { const t = buildTopology(mesh); return surfaceGraph(t, segment(t).patches); };

test("a box yields six surfaces with stable s-prefixed ids", () => {
  const g = graphOf(boxMesh(10, 20, 5));
  expect(g.surfaces.length).toBe(6);
  expect(g.surfaces.map((s) => s.id)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
});

test("a box yields twelve convex arcs, all straight", () => {
  const g = graphOf(boxMesh(10, 20, 5));
  expect(g.arcs.length).toBe(12);
  expect(g.arcs.every((a) => a.convexity === "convex")).toBe(true);
  expect(g.arcs.every((a) => a.kind === "line")).toBe(true);
});

// The discriminator (ruling R10): the bore is a CONCAVE cylinder, the outer wall a convex
// one. This is the attribute every hole rule keys on.
test("the washer bore is a concave cylinder and its outer wall a convex one", () => {
  const g = graphOf(annulusPlate(10, 4, 3, 48));
  const bore = g.surfaces.find((s) => s.type === "cylinder" && s.fit.radius < 6);
  const wall = g.surfaces.find((s) => s.type === "cylinder" && s.fit.radius > 6);
  expect(bore.curvature).toBe("concave");
  expect(wall.curvature).toBe("convex");
});

test("planes carry no curvature at all", () => {
  const g = graphOf(annulusPlate(10, 4, 3, 48));
  for (const s of g.surfaces.filter((x) => x.type === "plane")) expect(s.curvature).toBeNull();
});

// And the trap: BOTH rims are convex 90-degree corners. A test that expected the bore's
// rims to be concave would be asserting something geometrically false.
test("both the bore rim and the outer rim are convex circular arcs", () => {
  const g = graphOf(annulusPlate(10, 4, 3, 48));
  for (const r of [4, 10]) {
    const cyl = g.surfaces.find((s) => s.type === "cylinder" && Math.abs(s.fit.radius - r) < 2);
    const rims = arcsOf(g, cyl.id).filter((a) => a.kind === "circle");
    expect(rims.length).toBe(2);
    expect(rims.every((a) => a.convexity === "convex")).toBe(true);
  }
});

test("every surface reports at least one closed boundary loop", () => {
  const g = graphOf(annulusPlate(10, 4, 3, 48));
  for (const s of g.surfaces) expect(s.loops.length).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/describe-surface-graph.test.js`
Expected: FAIL — cannot resolve `describe/surface-graph.js`.

- [ ] **Step 3: Implement `surface-graph.js`**

```js
// Patches -> the attributed adjacency graph (Joshi & Chang 1988), the structure every
// feature rule in features/ is written against. Nodes are surfaces; arcs are the
// shared boundaries between them, each labelled convex or concave and carrying its own
// geometry.
//
// TWO attributes come out of here, and confusing them is the trap this file exists to
// close (controller ruling R10, found when Task 1's fixture review contradicted itself).
//
// ARC convexity says whether an edge is an outer or an inner corner, and nothing more. It
// is decided by the interior dihedral measured through the material: under 180° convex,
// over 180° concave. A through-hole's rim leaves a 90° wedge of material and is CONVEX —
// exactly like the outer edge of the same plate. A pocket floor or a boss base leaves 270°
// and is CONCAVE. So arc convexity cannot, on its own, tell a hole from a boss: it is the
// same label on both.
//
// SURFACE curvature is what does tell them apart. A bore is a concave cylinder — its
// outward normals point toward its own axis — while a shaft or a boss is a convex one,
// normals pointing away. That sign is a property of the surface, not of any edge, and it
// survives tessellation density, partial arcs, and whatever the neighbouring faces do.
//
// Both are derived here, once, and every feature rule downstream reads them rather than
// recomputing either.
//
// An arc's convexity is the SIGN-MAJORITY of its constituent edges weighted by length,
// not the first edge's label. A tessellated circular seam has a handful of edges whose
// individual dihedral wobbles around zero at the facet joins; taking one of them as
// the verdict makes a hole intermittently read as a boss.
//
// Pure leaf. See spec §2.4.

// A patch pair is joined by an arc only if their shared boundary is long enough to be
// a real edge rather than a stray facet contact at a vertex fan.
const MIN_ARC_EDGES = 1;
// Circularity band: an arc is a circle when its edge midpoints are equidistant from
// their own centroid to within this fraction of the mean radius.
const CIRCLE_TOL_FRAC = 0.02;

const vertOf = (topo, v) => [topo.verts[3*v], topo.verts[3*v+1], topo.verts[3*v+2]];
const dist = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);

// Classify an arc's shape from its edge midpoints. Straight arcs have collinear
// midpoints; circular arcs have midpoints on a common circle. Anything else is
// "mixed" and no rule is allowed to assume geometry about it.
function arcKind(pts) {
  if (pts.length < 3) return { kind: "line", radius: null, axis: null };
  const c = pts.reduce((a, p) => [a[0]+p[0]/pts.length, a[1]+p[1]/pts.length, a[2]+p[2]/pts.length], [0,0,0]);
  const radii = pts.map((p) => dist(p, c));
  const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
  if (mean < 1e-12) return { kind: "line", radius: null, axis: null };
  const spread = Math.max(...radii.map((r) => Math.abs(r - mean))) / mean;
  if (spread > CIRCLE_TOL_FRAC) {
    // Collinear? Then it is one straight edge chain, which is the common case for a
    // box corner and must not be reported as a huge-radius circle.
    const d0 = [pts[1][0]-pts[0][0], pts[1][1]-pts[0][1], pts[1][2]-pts[0][2]];
    const len = Math.hypot(...d0);
    const straight = len > 0 && pts.every((p) => {
      const d = [p[0]-pts[0][0], p[1]-pts[0][1], p[2]-pts[0][2]];
      const t = (d[0]*d0[0] + d[1]*d0[1] + d[2]*d0[2]) / (len*len);
      return Math.hypot(d[0]-t*d0[0], d[1]-t*d0[1], d[2]-t*d0[2]) < len * CIRCLE_TOL_FRAC;
    });
    return { kind: straight ? "line" : "mixed", radius: null, axis: null, center: c };
  }
  // Circle: the axis is the normal of the plane the midpoints lie in, taken from the
  // largest-area triangle among them for conditioning.
  const a = [pts[1][0]-pts[0][0], pts[1][1]-pts[0][1], pts[1][2]-pts[0][2]];
  const b = [pts[2][0]-pts[0][0], pts[2][1]-pts[0][1], pts[2][2]-pts[0][2]];
  const n = [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const nl = Math.hypot(...n) || 1;
  return { kind: "circle", radius: mean, axis: [n[0]/nl, n[1]/nl, n[2]/nl], center: c };
}

// Does this curved patch bend away from its own centre of curvature, or around it? Take
// each face's outward normal against the radial vector from the axis (or centre) out to
// that face: normals pointing outward mean a convex surface — a shaft, a boss, a plate's
// outer wall. Normals pointing back toward the axis mean a concave one — a bore. Averaged
// over the patch's faces so one bad facet normal cannot flip the verdict.
//
// Planes get null: a plane has no curvature and no side, and forcing it into this
// vocabulary would invent a distinction the geometry does not carry.
function curvatureOf(topo, patch) {
  const fit = patch.fit;
  const centre = fit.type === "cylinder" ? fit.axis.origin
               : fit.type === "cone" ? fit.apex
               : fit.type === "sphere" ? fit.center
               : fit.type === "torus" ? fit.center : null;
  if (!centre) return null;
  const axis = fit.type === "cylinder" ? fit.axis.direction
             : fit.type === "cone" ? fit.direction
             : fit.type === "torus" ? fit.axis : null;
  let vote = 0;
  for (const t of patch.faces) {
    const c = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const v = topo.tris[3*t + k] * 3;
      for (let a = 0; a < 3; a++) c[a] += topo.verts[v + a] / 3;
    }
    let radial = [c[0]-centre[0], c[1]-centre[1], c[2]-centre[2]];
    if (axis) {
      // Only the component perpendicular to the axis is radial; the axial part says
      // nothing about which way the surface curves.
      const ax = radial[0]*axis[0] + radial[1]*axis[1] + radial[2]*axis[2];
      radial = [radial[0]-ax*axis[0], radial[1]-ax*axis[1], radial[2]-ax*axis[2]];
    }
    const rl = Math.hypot(radial[0], radial[1], radial[2]);
    if (rl < 1e-12) continue;
    const n = [topo.faceNormal[3*t], topo.faceNormal[3*t+1], topo.faceNormal[3*t+2]];
    vote += topo.faceArea[t] * (n[0]*radial[0] + n[1]*radial[1] + n[2]*radial[2]) / rl;
  }
  if (Math.abs(vote) < 1e-12) return null;
  return vote > 0 ? "convex" : "concave";
}

export function surfaceGraph(topo, patches) {
  const surfaces = patches.map((p, i) => ({
    id: `s${i}`, type: p.fit.type, fit: p.fit, faces: p.faces, area: p.area, loops: [],
    curvature: curvatureOf(topo, p),
  }));
  const owner = new Int32Array(topo.faceArea.length).fill(-1);
  patches.forEach((p, i) => { for (const t of p.faces) owner[t] = i; });

  // Group boundary edges by the unordered pair of surfaces they separate. Edges
  // interior to one surface are what the boundary loops are built from instead.
  const between = new Map();
  const boundaryEdges = new Map();   // surface index -> edge indices on its rim
  for (const e of topo.edges) {
    if (e.triB < 0) continue;
    const a = owner[e.triA], b = owner[e.triB];
    if (a < 0 || b < 0 || a === b) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (!between.has(key)) between.set(key, { a: Math.min(a,b), b: Math.max(a,b), edges: [] });
    between.get(key).edges.push(e);
    for (const s of [a, b]) {
      if (!boundaryEdges.has(s)) boundaryEdges.set(s, []);
      boundaryEdges.get(s).push(e);
    }
  }

  const arcs = [];
  for (const { a, b, edges } of between.values()) {
    if (edges.length < MIN_ARC_EDGES) continue;
    // Length-weighted majority vote (see the header comment on why not first-edge).
    let convexLen = 0, concaveLen = 0, total = 0;
    const mids = [];
    for (const e of edges) {
      const p0 = vertOf(topo, e.v0), p1 = vertOf(topo, e.v1);
      const len = dist(p0, p1);
      total += len;
      if (e.convexity === "convex") convexLen += len;
      else if (e.convexity === "concave") concaveLen += len;
      mids.push([(p0[0]+p1[0])/2, (p0[1]+p1[1])/2, (p0[2]+p1[2])/2]);
    }
    const convexity = convexLen === concaveLen ? "flat" : convexLen > concaveLen ? "convex" : "concave";
    const { kind, radius, axis, center } = arcKind(mids);
    arcs.push({
      between: [surfaces[a].id, surfaces[b].id],
      convexity, kind, radius: radius ?? null, axis: axis ?? null, center: center ?? null,
      length: total, edges: edges.length,
    });
  }

  // Boundary loops: chain each surface's rim edges end to end. A surface with an
  // island hole in it (an annulus cap) yields two loops, which is exactly the signal
  // the pocket and hole rules read.
  for (const [si, edges] of boundaryEdges) {
    const adj = new Map();
    for (const e of edges) {
      if (!adj.has(e.v0)) adj.set(e.v0, []);
      if (!adj.has(e.v1)) adj.set(e.v1, []);
      adj.get(e.v0).push(e.v1); adj.get(e.v1).push(e.v0);
    }
    const seen = new Set();
    for (const start of adj.keys()) {
      if (seen.has(start)) continue;
      const loop = [];
      let cur = start, prev = -1;
      while (cur !== undefined && !seen.has(cur)) {
        seen.add(cur); loop.push(cur);
        const next = (adj.get(cur) ?? []).find((v) => v !== prev && !seen.has(v));
        prev = cur; cur = next;
      }
      if (loop.length >= 3) surfaces[si].loops.push(loop);
    }
  }

  return { surfaces, arcs };
}

export function arcsOf(graph, surfaceId) {
  return graph.arcs.filter((a) => a.between[0] === surfaceId || a.between[1] === surfaceId);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/describe-surface-graph.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/framework/oracle/describe/surface-graph.js test/describe-surface-graph.test.js
git commit -m "feat(describe): attributed adjacency graph with convexity-labelled arcs"
```

---

### Task 6: Feature rules — holes, fillets, chamfers

**Files:**
- Create: `src/framework/oracle/describe/features/holes.js`
- Create: `src/framework/oracle/describe/features/dressups.js`
- Test: `test/describe-features-holes.test.js`

**Interfaces:**
- Consumes: `surfaceGraph`, `arcsOf` (Task 5).
- Produces:
  - `detectHoles(graph) → feature[]` with `{ id, type: "throughHole"|"blindHole", diameter, depth, axis:{origin,direction}, entryFace, exitFace|null, floorFace|null, surfaces, evidence }` — keys on `surface.curvature === "concave"` per ruling R10, NOT on arc convexity
  - `detectDressups(graph) → feature[]` with `{ id, type: "fillet"|"chamfer", radius|width, angle?, between:[idA,idB], surfaces, evidence }`
  - Feature `id`s are assigned by the caller (Task 12); these return `id: null` and a stable `key` string so the orchestrator can number them deterministically.

- [ ] **Step 1: Write the failing test**

`test/describe-features-holes.test.js`:

```js
import { expect, test } from "vitest";
import { buildTopology } from "../src/framework/oracle/describe/topology.js";
import { segment } from "../src/framework/oracle/describe/segment.js";
import { surfaceGraph } from "../src/framework/oracle/describe/surface-graph.js";
import { detectHoles } from "../src/framework/oracle/describe/features/holes.js";
import { detectDressups } from "../src/framework/oracle/describe/features/dressups.js";
import { annulusPlate, cylinderMesh } from "./helpers/mesh-fixtures.js";

const graphOf = (mesh) => { const t = buildTopology(mesh); return surfaceGraph(t, segment(t).patches); };

test("the washer bore is detected as one through hole", () => {
  const holes = detectHoles(graphOf(annulusPlate(10, 4, 3, 48)));
  expect(holes.length).toBe(1);
  expect(holes[0].type).toBe("throughHole");
});

test("the through hole reports the fixture diameter and depth", () => {
  const [hole] = detectHoles(graphOf(annulusPlate(10, 4, 3, 48)));
  expect(hole.diameter).toBeCloseTo(8, 1);
  expect(hole.depth).toBeCloseTo(3, 2);
});

test("the outer wall of a washer is NOT a hole", () => {
  // The outer wall's rims are convex circular arcs to both caps — IDENTICAL in convexity
  // to the bore's rims (ruling R10). Only its curvature differs, so this test is the one
  // that fails if a rule ever regresses to keying on arc convexity.
  const holes = detectHoles(graphOf(annulusPlate(10, 4, 3, 48)));
  expect(holes.length).toBe(1);
  expect(holes[0].diameter).toBeLessThan(12);
});

// The blind-hole branch has no hand-buildable fixture here, so assert the invariant from
// the other side: a THROUGH hole must report two mouths and no floor. A rule that started
// mistaking a mouth for a floor would fail this.
test("a through hole reports an exit face and no floor face", () => {
  const [hole] = detectHoles(graphOf(annulusPlate(10, 4, 3, 48)));
  expect(hole.exitFace).not.toBeNull();
  expect(hole.floorFace).toBeNull();
});

test("a bare cylinder has no holes at all", () => {
  expect(detectHoles(graphOf(cylinderMesh(4, 10, 48)))).toEqual([]);
});

test("a sharp-edged fixture reports no fillets or chamfers", () => {
  expect(detectDressups(graphOf(annulusPlate(10, 4, 3, 48)))).toEqual([]);
});

test("holes carry a stable key derived from geometry, not from iteration order", () => {
  const a = detectHoles(graphOf(annulusPlate(10, 4, 3, 48)))[0];
  const b = detectHoles(graphOf(annulusPlate(10, 4, 3, 48)))[0];
  expect(a.key).toBe(b.key);
  expect(a.id).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/describe-features-holes.test.js`
Expected: FAIL — cannot resolve `features/holes.js`.

- [ ] **Step 3: Implement `features/holes.js`**

```js
// Hole rules over the attributed adjacency graph.
//
// The primary test is the cylinder's own CURVATURE, not the convexity of its arcs
// (controller ruling R10). A bore is a concave cylinder — outward normals pointing back
// toward its axis. A shaft or a boss is a convex one. Arc convexity cannot make this call:
// a through-hole's rim and a plate's outer edge are both plain 90-degree convex corners,
// because in both cases the material leaves a 90-degree wedge at the seam.
//
// Arc convexity still does the SECOND half of the job, once curvature has established we
// are looking at a bore: a convex circular arc to a plane is a MOUTH (the bore breaking
// out through a face), and a concave arc to a plane or cone is a FLOOR (the bore
// bottoming out). Two mouths on anti-parallel planes is a through hole; one mouth plus a
// floor is a blind hole. Everything else — radius, extent, axis — fit.js already measured.
//
// `id` is deliberately null: feature numbering is the orchestrator's job (Task 12),
// because ids must be assigned once across ALL feature families in a stable order.
// A `key` derived from rounded geometry gives that ordering something deterministic
// to sort on, so the same mesh always numbers its features the same way.
//
// Pure leaf. See spec §2.5.
import { arcsOf } from "../surface-graph.js";

// Two planes count as "parallel" (a through hole's two mouths) within this band.
const PARALLEL_DOT = 0.98;
// `arcsOf` is imported for the mouth/floor split; curvature comes off the surface itself.
const round3 = (v) => Math.round(v * 1000) / 1000;

const byId = (graph) => new Map(graph.surfaces.map((s) => [s.id, s]));
const other = (arc, id) => (arc.between[0] === id ? arc.between[1] : arc.between[0]);

export function detectHoles(graph) {
  const surfaces = byId(graph);
  const out = [];

  for (const s of graph.surfaces) {
    if (s.type !== "cylinder") continue;
    if (s.curvature !== "concave") continue;                  // a boss, a shaft, an outer wall

    const arcs = arcsOf(graph, s.id);
    // A mouth is where the bore breaks out through a face: a convex seam to a plane.
    const mouths = arcs
      .filter((a) => a.convexity === "convex")
      .map((a) => ({ arc: a, face: surfaces.get(other(a, s.id)) }))
      .filter((m) => m.face && m.face.type === "plane");
    if (mouths.length === 0) continue;

    const dir = s.fit.axis.direction;
    const depth = Math.abs(s.fit.extent[1] - s.fit.extent[0]);
    const diameter = s.fit.radius * 2;
    const origin = s.fit.axis.origin;

    // Through: two planar mouths whose normals are anti-parallel to each other and
    // aligned with the bore axis. Blind: one mouth, with the far end closed by a
    // surface the bore also touches (planar floor or conical drill point).
    let type = null, entryFace = null, exitFace = null, floorFace = null;
    if (mouths.length >= 2) {
      const [m0, m1] = mouths;
      const d = m0.face.fit.normal[0]*m1.face.fit.normal[0]
              + m0.face.fit.normal[1]*m1.face.fit.normal[1]
              + m0.face.fit.normal[2]*m1.face.fit.normal[2];
      if (d <= -PARALLEL_DOT) { type = "throughHole"; entryFace = m0.face.id; exitFace = m1.face.id; }
    }
    if (!type) {
      // A floor is the opposite seam: CONCAVE, because the bore bottoming out leaves 270
      // degrees of material there. Planar for a flat-bottomed bore, conical for a drill point.
      const floor = arcs
        .filter((a) => a.convexity === "concave")
        .map((a) => surfaces.get(other(a, s.id)))
        .find((n) => n && n.id !== mouths[0].face.id && (n.type === "plane" || n.type === "cone"));
      if (floor) { type = "blindHole"; entryFace = mouths[0].face.id; floorFace = floor.id; }
    }
    if (!type) continue;

    out.push({
      id: null,
      key: `hole:${round3(diameter)}:${round3(origin[0])},${round3(origin[1])},${round3(origin[2])}`,
      type, diameter, depth,
      axis: { origin, direction: dir },
      entryFace, exitFace, floorFace,
      surfaces: [s.id],
      // What the rule actually saw. The report carries this so a wrong call can be
      // argued with rather than merely disbelieved.
      evidence: { curvature: s.curvature, planarMouths: mouths.length, arcs: arcs.length, fitRms: s.fit.rms },
    });
  }

  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
```

- [ ] **Step 4: Implement `features/dressups.js`**

```js
// Fillet and chamfer rules.
//
// Both are TRANSITION surfaces: narrow strips whose job is to soften the meeting of
// two larger neighbours. That is what distinguishes them from a small functional
// face, and it is why the rules test the strip's relationship to its neighbours
// rather than its size alone. A 2mm-wide plane between two walls is a chamfer; a
// 2mm-wide plane bounded by four other 2mm planes is just a small face.
//
// Fillet:  cylinder or torus, exactly two arcs, both to larger surfaces, tangent to
//          both (the arc convexity gives inside vs outside rounding).
// Chamfer: plane, exactly two arcs, both to larger surfaces, meeting each at a
//          consistent angle that is neither ~0 nor ~90 degrees.
//
// Pure leaf. See spec §2.5.
import { arcsOf } from "../surface-graph.js";

// A dress-up must be materially smaller than what it joins, or it is a face in its
// own right. Ratio, not an absolute size, so it scales with the part.
const MAX_AREA_RATIO = 0.34;
// Chamfer angle band: outside this it is a tangent continuation or a square corner.
const MIN_CHAMFER_RAD = 0.15, MAX_CHAMFER_RAD = Math.PI / 2 - 0.15;
const round3 = (v) => Math.round(v * 1000) / 1000;

const byId = (graph) => new Map(graph.surfaces.map((s) => [s.id, s]));
const other = (arc, id) => (arc.between[0] === id ? arc.between[1] : arc.between[0]);
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];

export function detectDressups(graph) {
  const surfaces = byId(graph);
  const out = [];

  for (const s of graph.surfaces) {
    const arcs = arcsOf(graph, s.id);
    if (arcs.length !== 2) continue;
    const nbrs = arcs.map((a) => surfaces.get(other(a, s.id)));
    if (nbrs.some((n) => !n)) continue;
    if (!nbrs.every((n) => s.area <= n.area * MAX_AREA_RATIO)) continue;

    if (s.type === "cylinder" || s.type === "torus") {
      const radius = s.type === "cylinder" ? s.fit.radius : s.fit.minorRadius;
      out.push({
        id: null,
        key: `fillet:${round3(radius)}:${nbrs.map((n) => n.id).sort().join("-")}`,
        type: "fillet", radius,
        between: nbrs.map((n) => n.id),
        convexity: arcs[0].convexity,
        surfaces: [s.id],
        evidence: { arcs: arcs.length, areaRatio: round3(s.area / Math.max(...nbrs.map((n) => n.area))), fitRms: s.fit.rms },
      });
      continue;
    }

    if (s.type === "plane" && nbrs.every((n) => n.type === "plane")) {
      const angles = nbrs.map((n) => Math.acos(Math.max(-1, Math.min(1, Math.abs(dot(s.fit.normal, n.fit.normal))))));
      if (!angles.every((a) => a > MIN_CHAMFER_RAD && a < MAX_CHAMFER_RAD)) continue;
      // Strip width from the area and the longer of the two arcs — a chamfer is a
      // ribbon, so area/length is its width.
      const width = s.area / Math.max(arcs[0].length, arcs[1].length, 1e-9);
      out.push({
        id: null,
        key: `chamfer:${round3(width)}:${nbrs.map((n) => n.id).sort().join("-")}`,
        type: "chamfer", width, angle: (angles[0] + angles[1]) / 2,
        between: nbrs.map((n) => n.id),
        convexity: arcs[0].convexity,
        surfaces: [s.id],
        evidence: { arcs: arcs.length, angles: angles.map(round3), fitRms: s.fit.rms },
      });
    }
  }

  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/describe-features-holes.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/framework/oracle/describe/features/ test/describe-features-holes.test.js
git commit -m "feat(describe): hole, fillet, and chamfer rules over the adjacency graph"
```

---

### Task 7: Feature rules — pockets, bosses, extrusions, revolves, shells

**Files:**
- Create: `src/framework/oracle/describe/features/prismatic.js`
- Create: `src/framework/oracle/describe/features/sweeps.js`
- Test: `test/describe-features-prismatic.test.js`

**Interfaces:**
- Consumes: `surfaceGraph`, `arcsOf` (Task 5).
- Produces:
  - `detectPrismatic(graph) → feature[]` — `{ id:null, key, type:"pocket"|"boss"|"extrusion", depth?, direction, floorFace?, wallFaces, profile, surfaces, evidence }`; pocket-vs-boss is decided by signed cap displacement against the surrounding plane, NOT by arc convexity (ruling R10)
  - `detectSweeps(graph) → feature[]` — `{ id:null, key, type:"revolve"|"shell", axis?, profile?, thickness?, surfaces, evidence }`
  - `profile` is `{ kind: "circle"|"polygon"|"mixed", radius?, points? }` — enough for the hints layer to propose a sketch, never claimed as exact.

- [ ] **Step 1: Write the failing test**

`test/describe-features-prismatic.test.js`:

```js
import { expect, test } from "vitest";
import { buildTopology } from "../src/framework/oracle/describe/topology.js";
import { segment } from "../src/framework/oracle/describe/segment.js";
import { surfaceGraph } from "../src/framework/oracle/describe/surface-graph.js";
import { detectPrismatic } from "../src/framework/oracle/describe/features/prismatic.js";
import { detectSweeps } from "../src/framework/oracle/describe/features/sweeps.js";
import { boxMesh, cylinderMesh, annulusPlate } from "./helpers/mesh-fixtures.js";

const ctx = (mesh) => { const t = buildTopology(mesh); return { t, g: surfaceGraph(t, segment(t).patches) }; };

test("a plain box is one extrusion, not a pocket or a boss", () => {
  const { g } = ctx(boxMesh(10, 20, 5));
  const f = detectPrismatic(g);
  expect(f.map((x) => x.type)).toEqual(["extrusion"]);
});

// Guards ruling R10 from the prismatic side: a washer's cap arcs are a MIX of convex
// (both rims) and concave (nothing) — a rule that counted them to decide pocket-vs-boss
// would classify by noise. The base extrusion must win regardless.
test("a washer's base extrusion is not misread as a pocket or a boss", () => {
  const { g } = ctx(annulusPlate(10, 4, 3, 48));
  expect(detectPrismatic(g).map((x) => x.type)).toEqual(["extrusion"]);
});

test("the box extrusion recovers a rectangular profile and its depth", () => {
  const { g } = ctx(boxMesh(10, 20, 5));
  const [ex] = detectPrismatic(g);
  expect(ex.profile.kind).toBe("polygon");
  expect(ex.depth).toBeCloseTo(5, 2);
});

test("a cylinder is an extrusion with a circular profile", () => {
  const { g } = ctx(cylinderMesh(4, 10, 48));
  const [ex] = detectPrismatic(g);
  expect(ex.profile.kind).toBe("circle");
  expect(ex.profile.radius).toBeCloseTo(4, 2);
  expect(ex.depth).toBeCloseTo(10, 2);
});

test("a washer is recognised as axisymmetric (a revolve candidate)", () => {
  const { t, g } = ctx(annulusPlate(10, 4, 3, 48));
  const rev = detectSweeps(g).find((f) => f.type === "revolve");
  expect(rev).toBeDefined();
  expect(Math.abs(rev.axis.direction[2])).toBeCloseTo(1, 3);
});

test("a solid box is not reported as a shell", () => {
  const { t, g } = ctx(boxMesh(10, 20, 5));
  expect(detectSweeps(g).some((f) => f.type === "shell")).toBe(false);
});

test("prismatic features carry stable keys and null ids", () => {
  const { g } = ctx(boxMesh(10, 20, 5));
  const a = detectPrismatic(g)[0], b = detectPrismatic(g)[0];
  expect(a.key).toBe(b.key);
  expect(a.id).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/describe-features-prismatic.test.js`
Expected: FAIL — cannot resolve `features/prismatic.js`.

- [ ] **Step 3: Implement `features/prismatic.js`**

```js
// Pocket, boss, and extrusion rules.
//
// All three are the same observation read at different scopes: a set of side walls sharing
// one sweep direction, capped at one or both ends, is an extrusion of the capped profile.
//
// What separates a POCKET from a BOSS is NOT arc convexity (controller ruling R10). Both
// leave 270 degrees of material where their walls meet the surrounding face — a pocket
// floor and a boss base are each concave seams — so the label is identical on both and
// carries no information. The real distinction is DISPLACEMENT: measure the feature's cap
// plane against the surrounding base plane along their shared normal. A cap sunk into the
// material is a pocket; a cap standing proud of it is a boss. If the walls ARE the part's
// outer envelope, it is the base extrusion and neither.
//
// The extrusion direction comes from the wall normals, which all lie perpendicular to
// it: the same normal-covariance trick fit.js uses for a cylinder axis. Reading it
// from the cap normal instead would fail on a part whose base is not the largest face.
//
// The `profile` is explicitly a PROPOSAL, not a measurement — it is the cap's boundary
// loop reduced to a circle or a polygon. It exists so hints.js can suggest a sketch;
// nothing in the facts layer depends on it being exact.
//
// Pure leaf. See spec §2.5.
import { arcsOf } from "../surface-graph.js";
import { jacobiEigen } from "../fit.js";

const PERPENDICULAR_DOT = 0.08;   // wall normal vs sweep direction
const round3 = (v) => Math.round(v * 1000) / 1000;
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const byId = (graph) => new Map(graph.surfaces.map((s) => [s.id, s]));
const other = (arc, id) => (arc.between[0] === id ? arc.between[1] : arc.between[0]);

// The direction every wall normal is perpendicular to: the least-spread eigenvector of
// the wall normals' covariance.
function sweepDirection(walls) {
  const cov = [[0,0,0],[0,0,0],[0,0,0]];
  for (const w of walls) {
    const n = w.type === "plane" ? w.fit.normal : w.fit.axis?.direction ?? w.fit.normal;
    if (!n) continue;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += n[i]*n[j];
  }
  const v = jacobiEigen(cov).vectors[0];
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0]/len, v[1]/len, v[2]/len];
}

// A cap's boundary reduced to something a sketch could be built from. One loop that is
// a circle -> circle; a loop whose arcs are all straight -> polygon; anything else ->
// mixed, and hints.js will decline to propose a sketch for it.
function profileOf(graph, cap) {
  const arcs = arcsOf(graph, cap.id);
  const circles = arcs.filter((a) => a.kind === "circle");
  if (circles.length === 1 && arcs.length === 1) return { kind: "circle", radius: circles[0].radius };
  if (arcs.length && arcs.every((a) => a.kind === "line")) {
    return { kind: "polygon", points: (cap.loops[0] ?? []).length };
  }
  return { kind: "mixed" };
}

export function detectPrismatic(graph) {
  const surfaces = byId(graph);
  const out = [];
  const claimed = new Set();

  // Caps first, largest-area first: the biggest planar face is the most likely base of
  // the part's dominant extrusion, and claiming it first keeps the base extrusion from
  // being described as a pocket in some smaller face's frame.
  const caps = graph.surfaces.filter((s) => s.type === "plane").sort((a, b) => b.area - a.area);

  for (const cap of caps) {
    if (claimed.has(cap.id)) continue;
    const arcs = arcsOf(graph, cap.id);
    const walls = arcs.map((a) => surfaces.get(other(a, cap.id))).filter(Boolean);
    if (walls.length === 0) continue;

    const direction = sweepDirection(walls);
    // Every wall must actually be a wall of THIS sweep: its normal perpendicular to
    // the direction. A neighbour that fails this is a different feature's surface.
    const sideWalls = walls.filter((w) => {
      const n = w.type === "plane" ? w.fit.normal : w.fit.axis?.direction;
      return n && Math.abs(dot(n, direction)) < (w.type === "plane" ? PERPENDICULAR_DOT : 1 - PERPENDICULAR_DOT);
    });
    if (sideWalls.length === 0) continue;

    // Depth: the axial spread of the walls along the sweep direction.
    // A cylindrical wall carries its own axial extent from the fit. A planar wall does
    // not, so when none of the walls are cylinders the fallback below reads the depth off
    // the opposing cap instead.
    let lo = Infinity, hi = -Infinity;
    for (const w of sideWalls) {
      if (w.type === "cylinder") { lo = Math.min(lo, w.fit.extent[0]); hi = Math.max(hi, w.fit.extent[1]); }
    }
    if (!Number.isFinite(lo)) {
      // Planar walls: use the opposing cap's offset along the direction.
      const opposite = caps.find((c) => c.id !== cap.id &&
        Math.abs(dot(c.fit.normal, cap.fit.normal)) > 0.98);
      if (!opposite) continue;
      lo = 0; hi = Math.abs(cap.fit.offset - (-opposite.fit.offset));
      if (hi < 1e-9) hi = Math.abs(cap.fit.offset + opposite.fit.offset);
    }
    const depth = Math.abs(hi - lo);

    // Recessed or raised? Compare this cap's plane against the largest parallel plane that
    // is not itself — the surrounding face. Signed along the cap's own outward normal, a
    // negative displacement means the cap sits BELOW the surrounding material (a pocket);
    // positive means it stands above it (a boss).
    const isBase = out.length === 0;
    let type = "extrusion";
    if (!isBase) {
      const surround = caps.find((c) => c.id !== cap.id && dot(c.fit.normal, cap.fit.normal) > 0.98);
      // With co-oriented normals both offsets are measured along the same direction, so
      // their difference is the signed displacement directly.
      const displacement = surround ? cap.fit.offset - surround.fit.offset : 0;
      type = displacement < 0 ? "pocket" : "boss";
    }

    out.push({
      id: null,
      key: `${type}:${round3(depth)}:${cap.id}`,
      type, depth, direction,
      floorFace: cap.id,
      wallFaces: sideWalls.map((w) => w.id),
      profile: profileOf(graph, cap),
      surfaces: [cap.id, ...sideWalls.map((w) => w.id)],
      evidence: {
        walls: sideWalls.length,
        concaveArcs: arcs.filter((a) => a.convexity === "concave").length,
        convexArcs: arcs.filter((a) => a.convexity === "convex").length,
      },
    });
    claimed.add(cap.id);
    for (const w of sideWalls) claimed.add(w.id);
    if (isBase) break;   // one base extrusion per part; the rest are pockets/bosses
  }

  return out;
}
```

- [ ] **Step 4: Implement `features/sweeps.js`**

```js
// Revolve and uniform-wall shell rules — the two additions past the prismatic core
// (spec decisions table), both mapping directly onto partforge ops that already exist.
//
// REVOLVE: every surface's own axis is collinear with one shared axis. Turned parts,
// vases, and washers all satisfy this, and when they do, a revolve of the axial
// half-profile is a far better parameterisation than a stack of extrusions.
//
// SHELL: a surface has a matching counter-surface at constant offset. This is the
// hardest detector in the vocabulary and the spec names it as the first thing to cut
// if v1 runs long — so it is written conservatively and reports NOTHING when it is not
// confident, which is always the safe direction: a missed shell is residual, an
// invented shell is a lie the agent will build against.
//
// Pure leaf. See spec §2.5.
import { jacobiEigen } from "../fit.js";

const COLLINEAR_DOT = 0.995;
const OFFSET_SPREAD_FRAC = 0.06;   // wall thickness must be this consistent to count
const round3 = (v) => Math.round(v * 1000) / 1000;
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];

const axisOf = (s) =>
  s.type === "cylinder" ? s.fit.axis.direction :
  s.type === "cone" ? s.fit.direction :
  s.type === "torus" ? s.fit.axis : null;

export function detectSweeps(graph) {
  const out = [];

  // --- revolve ---------------------------------------------------------------
  const axial = graph.surfaces.map((s) => ({ s, a: axisOf(s) })).filter((x) => x.a);
  if (axial.length >= 1) {
    // Vote: the axis most surfaces agree with, weighted by area. Antipodal directions
    // are the same axis, so compare on |dot|.
    let best = null;
    for (const cand of axial) {
      const agree = axial.filter((x) => Math.abs(dot(x.a, cand.a)) > COLLINEAR_DOT);
      const area = agree.reduce((t, x) => t + x.s.area, 0);
      if (!best || area > best.area) best = { axis: cand.a, agree, area };
    }
    const axialArea = best ? best.area : 0;
    const total = graph.surfaces.reduce((t, s) => t + s.area, 0);
    // Planes perpendicular to the axis (caps) are consistent with a revolve too, so
    // count their area as agreeing rather than as evidence against.
    const capArea = graph.surfaces
      .filter((s) => s.type === "plane" && best && Math.abs(dot(s.fit.normal, best.axis)) > COLLINEAR_DOT)
      .reduce((t, s) => t + s.area, 0);
    if (best && (axialArea + capArea) / total > 0.9) {
      const origin = best.agree[0].s.type === "cylinder" ? best.agree[0].s.fit.axis.origin
                   : best.agree[0].s.type === "cone" ? best.agree[0].s.fit.apex
                   : best.agree[0].s.fit.center;
      out.push({
        id: null,
        key: `revolve:${best.axis.map(round3).join(",")}`,
        type: "revolve",
        axis: { origin, direction: best.axis },
        profile: { kind: "mixed" },
        surfaces: best.agree.map((x) => x.s.id),
        evidence: { axialAreaFraction: round3((axialArea + capArea) / total), agreeing: best.agree.length },
      });
    }
  }

  // --- shell -----------------------------------------------------------------
  // Pair each plane with an anti-parallel plane and measure the gap. A shell shows up
  // as MANY such pairs sharing one gap; a solid box shows up as three pairs with three
  // different gaps, which is why the spread test — not the pair count — is the gate.
  const planes = graph.surfaces.filter((s) => s.type === "plane");
  const gaps = [];
  for (let i = 0; i < planes.length; i++) for (let j = i + 1; j < planes.length; j++) {
    const d = dot(planes[i].fit.normal, planes[j].fit.normal);
    if (d > -COLLINEAR_DOT) continue;
    gaps.push({ gap: Math.abs(planes[i].fit.offset + planes[j].fit.offset), pair: [planes[i].id, planes[j].id] });
  }
  if (gaps.length >= 3) {
    const mean = gaps.reduce((t, g) => t + g.gap, 0) / gaps.length;
    const spread = Math.max(...gaps.map((g) => Math.abs(g.gap - mean)));
    if (mean > 0 && spread / mean < OFFSET_SPREAD_FRAC) {
      out.push({
        id: null,
        key: `shell:${round3(mean)}`,
        type: "shell", thickness: mean,
        surfaces: gaps.flatMap((g) => g.pair),
        evidence: { pairs: gaps.length, spreadFraction: round3(spread / mean) },
      });
    }
  }

  return out;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/describe-features-prismatic.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/framework/oracle/describe/features/prismatic.js src/framework/oracle/describe/features/sweeps.js test/describe-features-prismatic.test.js
git commit -m "feat(describe): pocket/boss/extrusion, revolve, and shell rules"
```

---

### Task 8: Patterns and symmetry

**Files:**
- Create: `src/framework/oracle/describe/patterns.js`
- Test: `test/describe-patterns.test.js`

**Interfaces:**
- Consumes: feature arrays from Tasks 6–7 (each with `key`, `type`, and either `axis` or `direction`).
- Produces: `detectPatterns(features, bounds) → { patterns, symmetry }` where
  `patterns[i] = { id:"p0", type:"linear"|"circular"|"grid", members:[featureKey], counts, pitch, plane?, axis?, confidence }`
  and `symmetry[i] = { type:"mirror"|"rotational", plane?, axis?, order?, coverage }`.

- [ ] **Step 1: Write the failing test**

`test/describe-patterns.test.js`:

```js
import { expect, test } from "vitest";
import { detectPatterns } from "../src/framework/oracle/describe/patterns.js";

const hole = (x, y, d = 5) => ({
  key: `hole:${d}:${x},${y},0`, type: "throughHole", diameter: d,
  axis: { origin: [x, y, 0], direction: [0, 0, 1] },
});
const bounds = { min: [0, 0, 0], max: [60, 40, 12] };

test("four holes on a rectangle collapse to one 2x2 grid pattern", () => {
  const { patterns } = detectPatterns([hole(5,5), hole(55,5), hole(5,35), hole(55,35)], bounds);
  const grid = patterns.find((p) => p.type === "grid");
  expect(grid).toBeDefined();
  expect(grid.counts).toEqual([2, 2]);
  expect(grid.members.length).toBe(4);
});

test("the grid reports the fixture pitch", () => {
  const { patterns } = detectPatterns([hole(5,5), hole(55,5), hole(5,35), hole(55,35)], bounds);
  const grid = patterns.find((p) => p.type === "grid");
  expect(grid.pitch[0]).toBeCloseTo(50, 3);
  expect(grid.pitch[1]).toBeCloseTo(30, 3);
});

test("three evenly spaced collinear holes are a linear pattern", () => {
  const { patterns } = detectPatterns([hole(10,20), hole(20,20), hole(30,20)], bounds);
  expect(patterns[0].type).toBe("linear");
  expect(patterns[0].counts).toEqual([3]);
  expect(patterns[0].pitch[0]).toBeCloseTo(10, 6);
});

test("holes of different diameters do not form one pattern", () => {
  const { patterns } = detectPatterns([hole(10,20,5), hole(20,20,8), hole(30,20,5)], bounds);
  expect(patterns.every((p) => p.members.length < 3)).toBe(true);
});

test("two unrelated holes produce no pattern", () => {
  const { patterns } = detectPatterns([hole(3,3), hole(41,29)], bounds);
  expect(patterns).toEqual([]);
});

test("a symmetric hole layout reports a mirror plane", () => {
  const { symmetry } = detectPatterns([hole(5,5), hole(55,5), hole(5,35), hole(55,35)], bounds);
  const mirror = symmetry.find((s) => s.type === "mirror");
  expect(mirror).toBeDefined();
  expect(mirror.coverage).toBeCloseTo(1, 6);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/describe-patterns.test.js`
Expected: FAIL — cannot resolve `describe/patterns.js`.

- [ ] **Step 3: Implement `patterns.js`**

```js
// Repetition and symmetry over the feature list.
//
// This is the stage that turns a feature DUMP into design INTENT, and it is worth more
// to the consuming agent than marginal recognition accuracy is. Four holes reported
// individually invite four hard-coded positions; the same four reported as a 2x2 grid
// on a 50x30 pitch invite two parameters. A detected mirror plane tells the agent the
// part wants a symmetric parameterisation. Neither is recoverable from the feature list
// once it has been written out flat, which is why it happens here and not in the model.
//
// Grouping is by feature SIGNATURE (type plus rounded principal dimension) before any
// geometry is considered: two holes of different diameters are never one pattern no
// matter how neatly they line up, and testing that first keeps the position search
// small.
//
// Pure leaf. See spec §2.6.

const TOL_FRAC = 1e-3;          // spacing agreement, as a fraction of the bbox diagonal
const MIN_MEMBERS = 3;          // below this a "pattern" is just two features
const round3 = (v) => Math.round(v * 1000) / 1000;

const posOf = (f) => f.axis?.origin ?? f.center ?? null;
const signature = (f) =>
  `${f.type}:${round3(f.diameter ?? f.radius ?? f.width ?? f.depth ?? 0)}`;

const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

export function detectPatterns(features, bounds) {
  const diag = len(sub(bounds.max, bounds.min));
  const tol = diag * TOL_FRAC;
  const patterns = [];
  const groups = new Map();
  for (const f of features) {
    if (!posOf(f)) continue;
    const k = signature(f);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }

  for (const members of groups.values()) {
    if (members.length < MIN_MEMBERS) continue;
    const pts = members.map(posOf);

    // Grid: the positions factor into two independent spacings. Detected before linear
    // so a 2x2 layout is not reported as two unrelated 2-member lines.
    const grid = asGrid(members, pts, tol);
    if (grid) { patterns.push({ id: `p${patterns.length}`, ...grid }); continue; }

    const linear = asLinear(members, pts, tol);
    if (linear) { patterns.push({ id: `p${patterns.length}`, ...linear }); continue; }

    const circular = asCircular(members, pts, tol);
    if (circular) patterns.push({ id: `p${patterns.length}`, ...circular });
  }

  return { patterns, symmetry: detectSymmetry(features, bounds, tol) };
}

// Two distinct coordinate values on each of two axes, every combination present.
function asGrid(members, pts, tol) {
  const axes = [0, 1, 2].map((a) => uniqueSorted(pts.map((p) => p[a]), tol));
  const spanning = [0, 1, 2].filter((a) => axes[a].length >= 2);
  if (spanning.length !== 2) return null;
  const [i, j] = spanning;
  if (axes[i].length * axes[j].length !== pts.length) return null;
  const pitch = [spacing(axes[i], tol), spacing(axes[j], tol)];
  if (pitch.some((p) => p === null)) return null;
  return {
    type: "grid", members: members.map((m) => m.key),
    counts: [axes[i].length, axes[j].length], pitch,
    plane: null, axis: null,
    confidence: 1,
  };
}

// Collinear and evenly spaced.
function asLinear(members, pts, tol) {
  if (pts.length < MIN_MEMBERS) return null;
  const dir = sub(pts[1], pts[0]);
  const dl = len(dir);
  if (dl < tol) return null;
  const u = [dir[0]/dl, dir[1]/dl, dir[2]/dl];
  const ts = [];
  for (const p of pts) {
    const d = sub(p, pts[0]);
    const t = d[0]*u[0] + d[1]*u[1] + d[2]*u[2];
    if (len(sub(d, [t*u[0], t*u[1], t*u[2]])) > tol) return null;   // off the line
    ts.push(t);
  }
  ts.sort((a, b) => a - b);
  const step = spacing(ts, tol);
  if (step === null) return null;
  return {
    type: "linear", members: members.map((m) => m.key),
    counts: [pts.length], pitch: [step], axis: u, plane: null, confidence: 1,
  };
}

// Equidistant from a common centre, evenly spaced in angle.
function asCircular(members, pts, tol) {
  if (pts.length < MIN_MEMBERS) return null;
  const c = pts.reduce((a, p) => [a[0]+p[0]/pts.length, a[1]+p[1]/pts.length, a[2]+p[2]/pts.length], [0,0,0]);
  const radii = pts.map((p) => len(sub(p, c)));
  const rm = radii.reduce((a, b) => a + b, 0) / radii.length;
  if (rm < tol || Math.max(...radii.map((r) => Math.abs(r - rm))) > tol) return null;
  return {
    type: "circular", members: members.map((m) => m.key),
    counts: [pts.length], pitch: [round3(360 / pts.length)],
    axis: members[0].axis?.direction ?? null, plane: null, confidence: 1,
  };
}

// Distinct values, merged within tol.
function uniqueSorted(values, tol) {
  const s = [...values].sort((a, b) => a - b), out = [];
  for (const v of s) if (!out.length || Math.abs(v - out[out.length - 1]) > tol) out.push(v);
  return out;
}

// The common step of a sorted sequence, or null when the steps disagree.
function spacing(sorted, tol) {
  if (sorted.length < 2) return null;
  const steps = sorted.slice(1).map((v, i) => v - sorted[i]);
  const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
  return steps.every((s) => Math.abs(s - mean) <= tol) ? mean : null;
}

// Mirror symmetry about each bbox mid-plane: does every positioned feature have a
// counterpart at its reflection? `coverage` is the matched fraction, so a nearly
// symmetric part reports 0.9 rather than silently reporting nothing.
function detectSymmetry(features, bounds, tol) {
  const positioned = features.filter((f) => posOf(f));
  if (positioned.length < 2) return [];
  const out = [];
  for (let a = 0; a < 3; a++) {
    const mid = (bounds.min[a] + bounds.max[a]) / 2;
    let matched = 0;
    for (const f of positioned) {
      const p = posOf(f), want = [...p];
      want[a] = 2 * mid - p[a];
      const hit = positioned.some((g) =>
        signature(g) === signature(f) && len(sub(posOf(g), want)) <= tol);
      if (hit) matched++;
    }
    const coverage = matched / positioned.length;
    if (coverage > 0.6) {
      const normal = [0, 0, 0]; normal[a] = 1;
      out.push({ type: "mirror", plane: { normal, offset: mid }, coverage: round3(coverage) });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/describe-patterns.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/framework/oracle/describe/patterns.js test/describe-patterns.test.js
git commit -m "feat(describe): grid/linear/circular patterns and mirror symmetry"
```

---

### Task 9: Snapping — numbers, grid, fasteners

**Files:**
- Create: `src/framework/oracle/describe/snap.js`
- Test: `test/describe-snap.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `snapValue(raw, opts?) → { raw, to, note } | null` (null when no snap is
  warranted — the caller keeps the raw value); `inferGrid(values) → { grid, coverage } | null`;
  `snapHoleDiameter(raw) → { raw, to, note } | null`; `SNAP_TOL_FRAC` for reuse.

- [ ] **Step 1: Write the failing test**

`test/describe-snap.test.js`:

```js
import { expect, test } from "vitest";
import { snapValue, inferGrid, snapHoleDiameter } from "../src/framework/oracle/describe/snap.js";

test("a near-integer snaps to the integer and keeps its raw value", () => {
  const s = snapValue(11.9976);
  expect(s.to).toBe(12);
  expect(s.raw).toBe(11.9976);
});

test("a value that is genuinely 11.5 snaps to 11.5, not to 12", () => {
  expect(snapValue(11.4998).to).toBe(11.5);
});

test("a value far from any round number does not snap", () => {
  expect(snapValue(11.732)).toBeNull();
});

test("snapping is scale-aware: 0.4999 snaps to 0.5", () => {
  expect(snapValue(0.4999).to).toBe(0.5);
});

test("a hole diameter matching an M5 clearance is annotated", () => {
  const s = snapHoleDiameter(5.2996);
  expect(s.to).toBe(5.3);
  expect(s.note).toMatch(/M5/);
});

test("a hole diameter matching no standard fastener still snaps numerically", () => {
  const s = snapHoleDiameter(7.0004);
  expect(s.to).toBe(7);
  expect(s.note).toBeNull();
});

test("inferGrid finds a 5mm working grid", () => {
  const g = inferGrid([5, 10, 20, 35, 60]);
  expect(g.grid).toBe(5);
  expect(g.coverage).toBeCloseTo(1, 6);
});

test("inferGrid returns null when values share no grid", () => {
  expect(inferGrid([3.1, 7.7, 11.3])).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/describe-snap.test.js`
Expected: FAIL — cannot resolve `describe/snap.js`.

- [ ] **Step 3: Implement `snap.js`**

```js
// Measurement -> intent. A tessellated CAD export puts a 12mm wall at 11.9976 and a
// clearance hole at 5.2996, and handing those numbers to an agent produces a part
// parameterised on scanning artefacts. Snapping converts them back into the numbers a
// human actually typed.
//
// The invariant that makes this safe: snapping NEVER destroys the measurement. Every
// snap returns {raw, to, note} and report.js writes both, so a reader can always see
// what was measured and what it was interpreted as, and disagree with the second
// without losing the first (spec §3.1 principle 3).
//
// Candidates are ordered coarsest-first and the FIRST match within tolerance wins, not
// the nearest. 11.4998 must become 11.5 rather than 11.5 losing to 12 on some
// tie-break, and a coarse-first walk with a tight band gives that for free.
//
// Pure leaf. See spec §2.7.

// Snap band, relative to the value. Tight enough that a real 11.73 never becomes 11.75,
// loose enough to absorb any chord tolerance a sane exporter produces.
export const SNAP_TOL_FRAC = 5e-4;
const ABS_FLOOR = 1e-4;          // below this a relative band is meaninglessly small

// ISO metric clearance holes, medium (close) fit, in millimetres. Keyed by the drilled
// diameter a CAD model actually carries, which is what a mesh can show us — the thread
// size is the annotation, not the measurement.
const CLEARANCE = [
  { d: 2.4, note: "M2 clearance (close fit)" },
  { d: 2.9, note: "M2.5 clearance (close fit)" },
  { d: 3.4, note: "M3 clearance (close fit)" },
  { d: 4.5, note: "M4 clearance (close fit)" },
  { d: 5.3, note: "M5 clearance (close fit)" },
  { d: 6.4, note: "M6 clearance (close fit)" },
  { d: 8.4, note: "M8 clearance (close fit)" },
  { d: 10.5, note: "M10 clearance (close fit)" },
];

const near = (a, b) => Math.abs(a - b) <= Math.max(Math.abs(b) * SNAP_TOL_FRAC, ABS_FLOOR);

export function snapValue(raw, opts = {}) {
  if (!Number.isFinite(raw)) return null;
  const steps = opts.steps ?? [10, 5, 1, 0.5, 0.25, 0.1, 0.05];
  for (const step of steps) {
    const to = Math.round(raw / step) * step;
    // Re-round to kill float dust from the divide: 0.4999/0.5 -> 0.5, not 0.5000000001.
    const clean = Math.round(to * 1e6) / 1e6;
    if (clean !== 0 && near(raw, clean)) return { raw, to: clean, note: null };
  }
  return null;
}

export function snapHoleDiameter(raw) {
  for (const c of CLEARANCE) if (near(raw, c.d)) return { raw, to: c.d, note: c.note };
  return snapValue(raw);
}

// The coarsest step every value is a multiple of. Reported so the hints layer can
// propose parameters on that grid, and so a report reader can see at a glance whether
// the part was designed in whole millimetres or in something finer.
export function inferGrid(values) {
  const finite = values.filter((v) => Number.isFinite(v) && Math.abs(v) > ABS_FLOOR);
  if (finite.length < 2) return null;
  for (const grid of [10, 5, 2.5, 2, 1, 0.5, 0.25, 0.1]) {
    const hits = finite.filter((v) => near(v, Math.round(v / grid) * grid));
    if (hits.length === finite.length) return { grid, coverage: 1 };
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/describe-snap.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/framework/oracle/describe/snap.js test/describe-snap.test.js
git commit -m "feat(describe): value snapping, grid inference, and fastener annotation"
```

---

### Task 10: Scored acceptance (the only kernel-touching stage)

**Files:**
- Create: `src/framework/oracle/describe/accept.js`
- Test: `test/describe-accept.test.js`

**Interfaces:**
- Consumes: features from Tasks 6–7; a live Manifold `kernel`; the source mesh.
- Produces: `acceptCandidates(kernel, source, candidates, opts?) → { accepted, residual, score, budgetSpent }` where
  `accepted[i] = { candidate, gain, cumulativeXor, order }`, `score = { explainedVolumeFraction, xorFraction, xorVolume }`,
  and `residual = { xorVolume, xorFraction }`. Also exports `DEFAULT_BUDGET` (48).

**Important:** this is the one file in the pipeline that may import the kernel, and it
must obey the cache-bracket rule in spec §2.8. Read that section before writing it.

- [ ] **Step 1: Write the failing test**

`test/describe-accept.test.js`:

```js
import { expect, test, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { acceptCandidates, DEFAULT_BUDGET } from "../src/framework/oracle/describe/accept.js";

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(); });

// Candidates are thunks so acceptance controls WHEN geometry is built — nothing is
// materialised for a candidate the loop never reaches.
const boxCand = (k, sx, sy, sz, at = [0,0,0]) =>
  ({ key: `box:${sx}x${sy}x${sz}`, op: "union", build: () => k.box(sx, sy, sz).translate(at) });
const holeCand = (k, r, h, at) =>
  ({ key: `hole:${r}`, op: "cut", build: () => k.cylinder(r, h).translate(at) });

test("a single exact candidate is accepted and leaves near-zero residual", () => {
  const source = kernel.box(10, 20, 5);
  const r = acceptCandidates(kernel, source, [boxCand(kernel, 10, 20, 5)]);
  expect(r.accepted.length).toBe(1);
  expect(r.score.xorFraction).toBeLessThan(1e-6);
});

test("acceptance is greedy: the better base body is taken first", () => {
  const source = kernel.box(10, 20, 5);
  const r = acceptCandidates(kernel, source, [boxCand(kernel, 4, 4, 4), boxCand(kernel, 10, 20, 5)]);
  expect(r.accepted[0].candidate.key).toBe("box:10x20x5");
});

test("a candidate that does not reduce xor volume is rejected", () => {
  const source = kernel.box(10, 20, 5);
  const r = acceptCandidates(kernel, source, [boxCand(kernel, 10, 20, 5), boxCand(kernel, 40, 40, 40)]);
  expect(r.accepted.length).toBe(1);
});

test("every accepted candidate strictly reduces cumulative xor volume", () => {
  const source = kernel.cut(kernel.box(20, 20, 10), kernel.cylinder(3, 30).translate([10, 10, -10]));
  const r = acceptCandidates(kernel, source, [
    boxCand(kernel, 20, 20, 10),
    holeCand(kernel, 3, 30, [10, 10, -10]),
  ]);
  let prev = Infinity;
  for (const a of r.accepted) { expect(a.cumulativeXor).toBeLessThan(prev); prev = a.cumulativeXor; }
});

test("the hole candidate carries a positive gain", () => {
  const source = kernel.cut(kernel.box(20, 20, 10), kernel.cylinder(3, 30).translate([10, 10, -10]));
  const r = acceptCandidates(kernel, source, [
    boxCand(kernel, 20, 20, 10),
    holeCand(kernel, 3, 30, [10, 10, -10]),
  ]);
  expect(r.accepted.find((a) => a.candidate.key === "hole:3").gain).toBeGreaterThan(0);
});

test("the budget caps boolean work and is reported", () => {
  const source = kernel.box(10, 20, 5);
  const many = Array.from({ length: 40 }, (_, i) => boxCand(kernel, 10 + i * 0.01, 20, 5));
  const r = acceptCandidates(kernel, source, many, { budget: 6 });
  expect(r.budgetSpent).toBeLessThanOrEqual(6);
});

test("DEFAULT_BUDGET is a finite positive number", () => {
  expect(Number.isFinite(DEFAULT_BUDGET)).toBe(true);
  expect(DEFAULT_BUDGET).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/describe-accept.test.js`
Expected: FAIL — cannot resolve `describe/accept.js`.

- [ ] **Step 3: Implement `accept.js`**

```js
// The confirm half of propose-then-confirm (spec §2.8). Segmentation and the feature
// rules produce CANDIDATES; this decides which are real, in what order, and how sure
// we are — by building each one and measuring it against the source mesh.
//
// Three properties are load-bearing.
//
// ONE CACHE BRACKET. geometry/solid-cache.js scopes retention to the current build's
// graph: each begin()/end() pair rebuilds the retained set and DISPOSES anything not
// re-used that round. A search loop that opened a bracket per candidate would evict its
// own shared subtrees on every iteration — quadratic rebuilds and WASM churn on a part
// that should be nearly free. So the whole loop runs inside exactly one bracket, and
// every candidate's geometry stays warm and shared for its duration.
//
// HARD BUDGET. Booleans are the cost centre and the candidate list is attacker-shaped
// (it grows with mesh complexity, not with anything we control). The budget counts
// boolean operations, and running out DEGRADES INTO RESIDUAL rather than throwing: an
// over-budget describe returns a partial, honestly-scored report, which is exactly what
// a caller can act on.
//
// CONFIDENCE IS THE GAIN. A feature's confidence is the marginal xor reduction that
// admitted it, not a separate estimate invented afterwards. That is what makes the
// number falsifiable — it is a measurement of how much of the part that feature
// explains.
//
// The ONLY kernel-touching file in describe/.

export const DEFAULT_BUDGET = 48;
// A candidate must explain at least this fraction of the source volume to be worth a
// line in the report. Below it, the "feature" is tessellation noise.
const MIN_GAIN_FRACTION = 1e-4;

// Symmetric-difference volume — the same measure measure.js uses for the `reference`
// deviation fact, so a describe score and a verify ref-gate are directly comparable.
// Two booleans and two volume reads; no meshing, no rasterisation.
function xorVolume(kernel, a, b) {
  const inter = kernel.intersect(a.clone(), b.clone()).volume();
  return a.volume() + b.volume() - 2 * inter;
}

export function acceptCandidates(kernel, source, candidates, opts = {}) {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const sourceVolume = source.volume();
  const accepted = [];
  let spent = 0;

  // The single bracket. `describe:accept` is deliberately its own partition name, not a
  // display sub-part's: the cross-partition hash index still lets it ADOPT geometry the
  // viewer already built, while its own eviction at end() cannot throw away what the
  // viewer is showing. Same reasoning as oracle/build.js's `oracle:view:` naming.
  kernel.beginSubPart?.("describe:accept");
  try {
    let current = null;                  // the reconstruction so far
    let currentXor = sourceVolume;       // an empty reconstruction differs by the whole part
    const pending = [...candidates];

    while (pending.length && spent < budget) {
      let best = null;
      for (const cand of pending) {
        if (spent >= budget) break;
        let trial;
        try {
          const piece = cand.build();
          trial = current === null
            ? (cand.op === "cut" ? null : piece)      // nothing to cut from yet
            : cand.op === "cut" ? kernel.cut(current.clone(), piece)
            : kernel.union(current.clone(), piece);
        } catch {
          // A candidate whose geometry will not build is not an error — it is simply
          // not a description of this mesh. Drop it and keep going.
          trial = null;
        }
        spent++;
        if (!trial) continue;
        const xor = xorVolume(kernel, trial, source);
        const gain = currentXor - xor;
        if (gain > sourceVolume * MIN_GAIN_FRACTION && (!best || gain > best.gain)) {
          best = { cand, trial, xor, gain };
        }
      }
      if (!best) break;                  // nothing left improves the reconstruction

      current = best.trial;
      currentXor = best.xor;
      accepted.push({
        candidate: best.cand,
        gain: best.gain / sourceVolume,          // normalised: comparable across parts
        cumulativeXor: currentXor,
        order: accepted.length,
      });
      pending.splice(pending.indexOf(best.cand), 1);
    }

    const xorFraction = sourceVolume > 0 ? currentXor / sourceVolume : 1;
    return {
      accepted,
      residual: { xorVolume: currentXor, xorFraction },
      score: {
        explainedVolumeFraction: Math.max(0, 1 - xorFraction),
        xorFraction,
        xorVolume: currentXor,
      },
      budgetSpent: spent,
      budgetExceeded: spent >= budget && pending.length > 0,
    };
  } finally {
    kernel.endSubPart?.();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/describe-accept.test.js`
Expected: PASS, 7 tests.

This file boots a Manifold kernel, so it must stay in its own test file — OCCT and
Manifold must never boot in the same process, and vitest isolates per file.

- [ ] **Step 5: Commit**

```bash
git add src/framework/oracle/describe/accept.js test/describe-accept.test.js
git commit -m "feat(describe): greedy scored acceptance in one cache bracket"
```

---

### Task 11: Caps, report, and hints

**Files:**
- Create: `src/framework/oracle/describe/limits.js`
- Create: `src/framework/oracle/describe/report.js`
- Create: `src/framework/oracle/describe/hints.js`
- Test: `test/describe-report.test.js`

**Interfaces:**
- Consumes: graph (Task 5), features (Tasks 6–7), patterns (Task 8), snap (Task 9), acceptance (Task 10).
- Produces:
  - `limits.js`: `DESCRIBE_LIMITS = { MAX_SURFACES: 200, MAX_EDGES: 400, MAX_FEATURES: 120, MAX_PATTERNS: 40, MAX_RESIDUAL_REGIONS: 20, MAX_SUGGESTION_STEPS: 60 }` — **no imports in this file at all.**
  - `report.js`: `buildReport(input) → fullReport`; `compactDescribe(full) → compactReport`; `LOW_COVERAGE` (0.85).
  - `hints.js`: `buildHints(accepted, patterns, bounds) → suggestion`.

- [ ] **Step 1: Write the failing test**

`test/describe-report.test.js`:

```js
import { expect, test } from "vitest";
import { DESCRIBE_LIMITS } from "../src/framework/oracle/describe/limits.js";
import { buildReport, compactDescribe, LOW_COVERAGE } from "../src/framework/oracle/describe/report.js";
import { buildHints } from "../src/framework/oracle/describe/hints.js";

const base = {
  source: { name: "scan", digest: "abc123", triangles: 24310, watertight: true },
  bounds: { min: [0,0,0], max: [60,40,12] },
  surfaces: [{ id: "s0", type: "plane", fit: { normal: [0,0,1], offset: 12, rms: 4e-4 }, area: 2100, faces: [1,2] }],
  arcs: [{ between: ["s0","s7"], convexity: "concave", kind: "circle", radius: 2.65, length: 16.6 }],
  features: [{ id: "f0", type: "throughHole", diameter: 5.3, depth: 12, confidence: 0.99,
               snapped: { diameter: { raw: 5.2996, to: 5.3, note: "M5 clearance (close fit)" } } }],
  patterns: [], symmetry: [],
  residual: { areaFraction: 0.012, regions: [] },
  score: { explainedArea: 0.988, xorFraction: 0.0019 },
  suggestion: { disclaimer: "x", params: [], steps: [] },
};

test("the full report states its coordinate frame explicitly", () => {
  expect(buildReport(base).frame.up).toBe("+Z");
});

test("raw and snapped values are both retained", () => {
  const f = buildReport(base).features[0];
  expect(f.snapped.diameter.raw).toBe(5.2996);
  expect(f.snapped.diameter.to).toBe(5.3);
});

test("arrays are capped and the report says so", () => {
  const many = { ...base, surfaces: Array.from({ length: 500 }, (_, i) => ({ ...base.surfaces[0], id: `s${i}` })) };
  const r = buildReport(many);
  expect(r.surfaces.length).toBe(DESCRIBE_LIMITS.MAX_SURFACES);
  expect(r.truncated.surfaces).toBe(true);
});

test("an uncapped report reports truncated:false for every array", () => {
  const r = buildReport(base);
  expect(Object.values(r.truncated).every((v) => v === false)).toBe(true);
});

test("the compact report elides surfaces and edges to counts", () => {
  const c = compactDescribe(buildReport(base));
  expect(c.surfaces).toBeUndefined();
  expect(c.counts.surfaces).toBe(1);
  expect(c.counts.edges).toBe(1);
});

test("the compact report keeps features, patterns, score and residual", () => {
  const c = compactDescribe(buildReport(base));
  expect(c.features.length).toBe(1);
  expect(c.score.explainedArea).toBe(0.988);
  expect(c.residual.areaFraction).toBe(0.012);
});

test("low coverage raises a loud banner at the top of the compact report", () => {
  const poor = { ...base, score: { explainedArea: 0.61, xorFraction: 0.4 } };
  const c = compactDescribe(buildReport(poor));
  expect(c.warning).toMatch(/LOW COVERAGE/);
  expect(c.warning).toMatch(/incomplete/i);
});

test("good coverage carries no banner", () => {
  expect(compactDescribe(buildReport(base)).warning).toBeUndefined();
});

test("LOW_COVERAGE is the documented threshold", () => {
  expect(LOW_COVERAGE).toBe(0.85);
});

// --- hints layer -----------------------------------------------------------
const accepted = [
  { candidate: { key: "extrusion:5:s0", featureKey: "extrusion:5:s0", op: "union", hintOp: "box",
                 explains: ["f0"], hintArgs: { shape: "polygon" } }, gain: 0.94, order: 0 },
  { candidate: { key: "hole:5.3:a", featureKey: "hole:5.3:a", op: "cut", explains: ["f1"],
                 dimension: 5.3, paramName: "holeDia", hintArgs: {} }, gain: 0.02, order: 1 },
  { candidate: { key: "hole:5.3:b", featureKey: "hole:5.3:b", op: "cut", explains: ["f2"],
                 dimension: 5.3, paramName: "holeDia", hintArgs: {} }, gain: 0.02, order: 2 },
];
const patterns = [{ id: "p0", type: "grid", members: ["hole:5.3:a", "hole:5.3:b"], counts: [2, 1], pitch: [50] }];

test("hint steps come out in acceptance order", () => {
  const h = buildHints(accepted, [], base.bounds);
  expect(h.steps.map((s) => s.op)).toEqual(["box", "cut", "cut"]);
});

test("a pattern's members collapse into a single hint step", () => {
  const h = buildHints(accepted, patterns, base.bounds);
  expect(h.steps.length).toBe(2);
  expect(h.steps[1].pattern).toBe("p0");
});

test("the hints layer labels itself as an interpretation, not a measurement", () => {
  expect(buildHints(accepted, patterns, base.bounds).disclaimer).toMatch(/not measurement/i);
});

test("hint params are derived from bounds and carry their provenance", () => {
  const h = buildHints(accepted, patterns, base.bounds);
  const width = h.params.find((p) => p.name === "width");
  expect(width.value).toBe(60);
  expect(width.from).toBe("bounds.size[0]");
});

test("hint step scores are the acceptance gains", () => {
  const h = buildHints(accepted, [], base.bounds);
  expect(h.steps[0].score).toBe(0.94);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/describe-report.test.js`
Expected: FAIL — cannot resolve `describe/limits.js`.

- [ ] **Step 3: Implement `limits.js`**

```js
// Report array caps. A plain-data module with NO IMPORTS AT ALL, deliberately.
//
// partforge-cloud's sandbox boundary treats everything crossing it as
// attacker-controlled and whitelists fields, types, AND sizes (protocol.js's
// sanitizeResult). Phase B needs these exact numbers on the far side of that boundary,
// and it must be able to read them without dragging the oracle's import graph into a
// browser bundle. Same idiom as cloud's own src/chat/profileLimits.js, and for the same
// reason.
//
// These are CEILINGS, not targets. A report that hits one is not broken; it says so
// through its `truncated` block and carries on.
export const DESCRIBE_LIMITS = {
  MAX_SURFACES: 200,
  MAX_EDGES: 400,
  MAX_FEATURES: 120,
  MAX_PATTERNS: 40,
  MAX_RESIDUAL_REGIONS: 20,
  MAX_SUGGESTION_STEPS: 60,
};
```

- [ ] **Step 4: Implement `report.js`**

```js
// The two report shapes, defined together on purpose.
//
// FULL is the archive: everything measured, written to disk by `partforge describe
// --json`. COMPACT is what a model reads: features, patterns, symmetry, score,
// residual, and the suggestion, with surfaces and edges elided to counts.
//
// Both live here rather than compact being invented by each consumer. A 24k-triangle
// part yields hundreds of surfaces, and every consumer that trims them independently
// trims them differently — cloud's model-facing view and the CLI's summary would drift
// apart within a release. mountManager.js's compactReport is the precedent for the
// principle (a full oracle report is not a model-facing artefact) and the warning: it
// lives downstream, and its field renames have to be kept in sync by hand.
//
// Pure leaf. See spec §3.
import { DESCRIBE_LIMITS } from "./limits.js";

// Below this explained-area fraction the feature list is not trustworthy as a
// description of the part, and saying so quietly is worse than saying nothing: an agent
// will build against a confident-looking list that covers 61% of the geometry.
export const LOW_COVERAGE = 0.85;

const cap = (arr, max, flags, name) => {
  const a = arr ?? [];
  flags[name] = a.length > max;
  return a.slice(0, max);
};

export function buildReport(input) {
  const truncated = {};
  return {
    source: {
      name: input.source?.name ?? null,
      digest: input.source?.digest ?? null,
      triangles: input.source?.triangles ?? 0,
      watertight: input.source?.watertight ?? null,
      units: "mm",
    },
    // Stated explicitly, every time. Z-up/Y-up confusion is a documented LLM failure
    // mode (research doc §5) and one line defuses it. "as-imported" is the honest
    // claim: describe never realigns, so the frame is whatever the file carried.
    frame: { up: "+Z", note: "as-imported; no realignment applied" },
    bounds: {
      min: input.bounds.min,
      max: input.bounds.max,
      size: [0, 1, 2].map((i) => input.bounds.max[i] - input.bounds.min[i]),
    },
    surfaces: cap(input.surfaces, DESCRIBE_LIMITS.MAX_SURFACES, truncated, "surfaces"),
    edges: cap(input.arcs, DESCRIBE_LIMITS.MAX_EDGES, truncated, "edges"),
    features: cap(input.features, DESCRIBE_LIMITS.MAX_FEATURES, truncated, "features"),
    patterns: cap(input.patterns, DESCRIBE_LIMITS.MAX_PATTERNS, truncated, "patterns"),
    symmetry: input.symmetry ?? [],
    residual: {
      areaFraction: input.residual?.areaFraction ?? 0,
      regions: cap(input.residual?.regions, DESCRIBE_LIMITS.MAX_RESIDUAL_REGIONS, truncated, "residualRegions"),
    },
    score: input.score,
    suggestion: input.suggestion
      ? { ...input.suggestion,
          steps: cap(input.suggestion.steps, DESCRIBE_LIMITS.MAX_SUGGESTION_STEPS, truncated, "suggestionSteps") }
      : null,
    truncated,
  };
}

export function compactDescribe(full) {
  const out = {
    source: full.source,
    frame: full.frame,
    bounds: full.bounds,
    counts: { surfaces: full.surfaces.length, edges: full.edges.length },
    features: full.features,
    patterns: full.patterns,
    symmetry: full.symmetry,
    residual: full.residual,
    score: full.score,
    suggestion: full.suggestion,
    truncated: full.truncated,
  };
  // A banner, not a field. It is the first key a reader hits and it says outright that
  // the list below is not to be trusted as complete.
  if ((full.score?.explainedArea ?? 0) < LOW_COVERAGE) {
    out.warning =
      `LOW COVERAGE: only ${(100 * (full.score?.explainedArea ?? 0)).toFixed(1)}% of this mesh's ` +
      `surface area is explained by the features below. Treat the feature list as incomplete — ` +
      `do not assume a feature is absent because it is not listed. See residual.regions for where ` +
      `the unexplained geometry is.`;
  }
  return out;
}
```

- [ ] **Step 5: Implement `hints.js`**

```js
// The `suggestion` layer: a proposed reconstruction in partforge terms.
//
// It is physically separate from the facts and labelled as unverified because it is a
// different KIND of claim. The facts layer says "there is a 5.3mm cylinder here with
// concave arcs to two parallel planes" — a measurement. The suggestion says "so build a
// box and cut a hole" — an interpretation, and one the agent is free to reject.
//
// Its step order is not chosen by a heuristic. It is acceptance order, which is the
// order the candidates actually reduced the error in — the payoff of propose-then-
// confirm (spec §2.8). A build order arrived at this way is one we can defend.
//
// Pure leaf. See spec §3.2.
import { snapValue } from "./snap.js";

const DISCLAIMER =
  "Proposed reconstruction, not measurement. The facts above are authoritative; " +
  "this is one way to rebuild them and may be wrong about intent.";

export function buildHints(accepted, patterns, bounds) {
  const params = [];
  const seen = new Set();
  const addParam = (name, value, from) => {
    if (seen.has(name) || !Number.isFinite(value)) return;
    seen.add(name);
    params.push({ name, value: snapValue(value)?.to ?? value, from });
  };

  const size = [0, 1, 2].map((i) => bounds.max[i] - bounds.min[i]);
  addParam("width", size[0], "bounds.size[0]");
  addParam("depth", size[1], "bounds.size[1]");
  addParam("height", size[2], "bounds.size[2]");

  const byKey = new Map();
  for (const p of patterns) for (const m of p.members) byKey.set(m, p.id);

  const steps = accepted.map((a) => {
    const c = a.candidate;
    const patternId = byKey.get(c.featureKey) ?? null;
    // A candidate covered by a pattern names the pattern instead of repeating itself,
    // which is the whole reason patterns.js runs: four steps become one.
    if (c.dimension) addParam(c.paramName ?? c.key.split(":")[0], c.dimension, patternId ?? c.key);
    return {
      op: c.op === "cut" ? "cut" : c.hintOp ?? "union",
      explains: c.explains ?? [],
      pattern: patternId,
      score: Math.round(a.gain * 1000) / 1000,
      args: c.hintArgs ?? {},
    };
  });

  // Steps a pattern already covers collapse into the first of their group: emitting all
  // four members plus the pattern would tell the agent to cut the same holes twice.
  const emitted = new Set();
  const collapsed = steps.filter((s) => {
    if (!s.pattern) return true;
    if (emitted.has(s.pattern)) return false;
    emitted.add(s.pattern);
    return true;
  });

  return { disclaimer: DISCLAIMER, params, steps: collapsed };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/describe-report.test.js`
Expected: PASS, 14 tests.

- [ ] **Step 7: Commit**

```bash
git add src/framework/oracle/describe/limits.js src/framework/oracle/describe/report.js src/framework/oracle/describe/hints.js test/describe-report.test.js
git commit -m "feat(describe): capped full/compact report shapes and the hints layer"
```

---

### Task 12: The orchestrator and its digest memo

**Files:**
- Create: `src/framework/oracle/describe.js`
- Modify: `src/testing.js` (export `describe`, `compactDescribe`, `DESCRIBE_LIMITS`)
- Modify: `docs/ERROR-PATTERNS.md` (one `##` entry per closed error code)
- Test: `test/describe.test.js`

**Interfaces:**
- Consumes: every module from Tasks 1–11.
- Produces: `describe(kernel, solid, opts) → fullReport` where `solid` is a live kernel `Solid`
  (there is no public mesh→solid entry point — see controller ruling R1) and
  `opts = { name?, digest?, budget?, memo? }`;
  `describeMemo() → Map` (a fresh memo store, so callers can scope one per worker);
  `DESCRIBE_ERRORS` — the frozen closed set.

- [ ] **Step 1: Write the failing test**

`test/describe.test.js`:

```js
import { expect, test, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { describe as describeMesh, describeMemo, DESCRIBE_ERRORS } from "../src/framework/oracle/describe.js";

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(); });

const plateSolid = () => kernel.cut(kernel.box(60, 40, 12), kernel.cylinder(2.65, 40).translate([30, 20, -14]));

test("a plate with a bore reports a through hole", () => {
  const r = describeMesh(kernel, plateSolid(), { name: "plate", digest: "d1" });
  expect(r.features.some((f) => f.type === "throughHole")).toBe(true);
});

test("the report explains nearly all of the surface area", () => {
  const r = describeMesh(kernel, plateSolid(), { name: "plate", digest: "d2" });
  expect(r.score.explainedArea).toBeGreaterThan(0.9);
});

test("features are numbered f0..fN in a stable order", () => {
  const a = describeMesh(kernel, plateSolid(), { digest: "d3" });
  const b = describeMesh(kernel, plateSolid(), { digest: "d4" });
  expect(a.features.map((f) => f.id)).toEqual(b.features.map((f) => f.id));
  expect(a.features[0].id).toBe("f0");
});

test("the memo returns the identical object for the same digest", () => {
  const memo = describeMemo();
  const a = describeMesh(kernel, plateSolid(), { digest: "same", memo });
  const b = describeMesh(kernel, plateSolid(), { digest: "same", memo });
  expect(b).toBe(a);
});

test("a different digest misses the memo", () => {
  const memo = describeMemo();
  const a = describeMesh(kernel, plateSolid(), { digest: "one", memo });
  const b = describeMesh(kernel, plateSolid(), { digest: "two", memo });
  expect(b).not.toBe(a);
});

test("an empty solid returns the `empty` error rather than throwing", () => {
  const empty = kernel.cut(kernel.box(1, 1, 1), kernel.box(4, 4, 4).translate([-2, -2, -2]));
  const r = describeMesh(kernel, empty, { digest: "e" });
  expect(r.error).toBe("empty");
  expect(DESCRIBE_ERRORS).toContain("empty");
});

test("a closed-set error carries the structured diagnostic triple", () => {
  const empty = kernel.cut(kernel.box(1, 1, 1), kernel.box(4, 4, 4).translate([-2, -2, -2]));
  const d = describeMesh(kernel, empty, { name: "scan", digest: "e2" }).diagnostic;
  expect(d.cause).toBeTruthy();
  expect(d.location).toMatch(/scan/);
  expect(d.correctiveAction).toMatch(/ERROR-PATTERNS/);
});

test("the closed error set is exactly the documented five", () => {
  expect([...DESCRIBE_ERRORS].sort()).toEqual(
    ["budget-exceeded", "empty", "not-manifold", "too-large", "unreadable"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/describe.test.js`
Expected: FAIL — cannot resolve `oracle/describe.js`.

- [ ] **Step 3: Implement `describe.js`**

```js
// The describe orchestrator: mesh in, semantic report out. Sits beside measure.js and
// plays the same role for an imported mesh that measure plays for a built part.
//
// THE MEMO IS THE POINT OF THE WHOLE CACHING STORY (spec §4.1). measure and verify
// depend on part source AND params, so they must re-run on every apply. describe depends
// on NOTHING BUT THE MESH BYTES. So it keys on the import's content digest and an edit
// can never invalidate it: computed once per mesh per worker, reused for the entire
// session, across every turn. The memo Map is caller-owned rather than module-level so
// a worker can scope it to its own lifetime and a test can get a clean one — the same
// reasoning bvh.js's cachedBVH documents for its cache.
//
// Errors come from a CLOSED SET and are returned, never thrown, for anything short of a
// programming mistake. A mesh describe cannot read is a finding about the mesh, and the
// caller (a CLI, an agent) can act on `{error: "not-manifold"}` far better than on an
// exception. Every code has an ERROR-PATTERNS.md entry.
import { buildTopology } from "./describe/topology.js";
import { segment } from "./describe/segment.js";
import { surfaceGraph } from "./describe/surface-graph.js";
import { detectHoles } from "./describe/features/holes.js";
import { detectDressups } from "./describe/features/dressups.js";
import { detectPrismatic } from "./describe/features/prismatic.js";
import { detectSweeps } from "./describe/features/sweeps.js";
import { detectPatterns } from "./describe/patterns.js";
import { snapValue, snapHoleDiameter } from "./describe/snap.js";
import { acceptCandidates, DEFAULT_BUDGET } from "./describe/accept.js";
import { buildReport } from "./describe/report.js";
import { buildHints } from "./describe/hints.js";
import { bounds, meshArea } from "./mesh.js";

export const DESCRIBE_ERRORS = Object.freeze(
  ["not-manifold", "too-large", "empty", "budget-exceeded", "unreadable"]);

// Above this the segmentation cost stops being worth the wait in an interactive loop.
// Not a correctness limit — a responsiveness one, reported as `too-large` so the caller
// can decimate and retry rather than wonder why nothing happened.
const MAX_TRIANGLES = 400_000;

export const describeMemo = () => new Map();

// A closed-set error, shaped as the repo's structured diagnostic triple (spec §5, and
// the same (cause, location, correctiveAction) contract measure/verify emit). The
// research behind it is blunt about why: structured triples cut average agent retries
// 2.62 -> 1.86 against the same failures reported as prose. `error` stays a bare code so
// a caller can switch on it exhaustively.
const fail = (error, opts, source, cause, location, correctiveAction) => ({
  error,
  detail: cause,
  diagnostic: { cause, location, correctiveAction },
  source: { name: opts.name ?? null, digest: opts.digest ?? null, ...source },
});

export function describe(kernel, solid, opts = {}) {
  // A live Solid in, not a mesh. The kernel exposes no public mesh->solid constructor —
  // geometry only enters through `_registerImport` + `import(name)` — and acceptance needs
  // a Solid to diff against. Both real callers (the worker job and the CLI) already hold
  // one from `k.import(name)`, so taking the Solid and deriving the mesh here is both the
  // honest signature and the shorter path.
  const mesh = solid.toMesh();
  const triangles = mesh?.indices ? mesh.indices.length / 3 : (mesh?.positions?.length ?? 0) / 9;
  if (!triangles) {
    return fail("empty", opts, { triangles: 0 },
      "the mesh has no triangles",
      `import "${opts.name ?? "?"}"`,
      "check that the `imports` source resolves to a real file; see ERROR-PATTERNS.md#describe-empty");
  }
  if (triangles > MAX_TRIANGLES) {
    return fail("too-large", opts, { triangles },
      `${triangles} triangles exceeds the ${MAX_TRIANGLES} describe limit`,
      `import "${opts.name ?? "?"}"`,
      "re-export or decimate at a coarser chord tolerance; the feature rules read surfaces, not facets");
  }

  const memo = opts.memo;
  const key = opts.digest ? `${opts.digest}:${opts.budget ?? DEFAULT_BUDGET}` : null;
  if (memo && key && memo.has(key)) return memo.get(key);

  const topo = buildTopology(mesh);
  const { patches, unassigned } = segment(topo);
  const graph = surfaceGraph(topo, patches);

  // Feature families run in a fixed order and their results are concatenated in that
  // order, then sorted by each rule's own geometry-derived `key`. So f-numbering depends
  // on the MESH, never on iteration order or on which family happened to run first.
  const raw = [
    ...detectHoles(graph),
    ...detectDressups(graph),
    ...detectPrismatic(graph),
    ...detectSweeps(graph),
  ].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const features = raw.map((f, i) => {
    const snapped = {};
    if (Number.isFinite(f.diameter)) { const s = snapHoleDiameter(f.diameter); if (s) snapped.diameter = s; }
    for (const k of ["depth", "radius", "width", "thickness"]) {
      if (Number.isFinite(f[k])) { const s = snapValue(f[k]); if (s) snapped[k] = s; }
    }
    return { ...f, id: `f${i}`, snapped };
  });

  const b = bounds(mesh.positions);
  const { patterns, symmetry } = detectPatterns(features, b);

  // Candidates for acceptance, in the order the rules produced them. `featureKey` is what
  // hints.js joins against to collapse a pattern's members into one step.
  const candidates = features
    .filter((f) => typeof f.toCandidate === "function" || f.type)
    .map((f) => toCandidate(kernel, f, b))
    .filter(Boolean);

  const graded = acceptCandidates(kernel, solid, candidates, { budget: opts.budget });

  const totalArea = meshArea(mesh.positions, mesh.indices);
  const explainedArea = totalArea > 0
    ? graph.surfaces.reduce((a, s) => a + s.area, 0) / totalArea
    : 0;
  const residualArea = unassigned.reduce((a, t) => a + topo.faceArea[t], 0);

  const report = buildReport({
    source: { name: opts.name ?? null, digest: opts.digest ?? null, triangles, watertight: true },
    bounds: b,
    surfaces: graph.surfaces.map((s) => ({
      id: s.id, type: s.type, area: s.area, triangles: s.faces.length,
      rms: s.fit.rms, maxDev: s.fit.maxDev, fit: s.fit,
    })),
    arcs: graph.arcs,
    features: features.map((f) => ({
      ...f, confidence: graded.accepted.find((a) => a.candidate.featureKey === f.key)?.gain ?? null,
    })),
    patterns, symmetry,
    residual: {
      areaFraction: totalArea > 0 ? residualArea / totalArea : 0,
      regions: residualRegions(topo, unassigned),
    },
    score: {
      explainedArea,
      xorFraction: graded.score.xorFraction,
      xorVolume: graded.score.xorVolume,
    },
    suggestion: buildHints(graded.accepted, patterns, b),
  });
  if (graded.budgetExceeded) report.warning = "budget-exceeded";

  if (memo && key) memo.set(key, report);
  return report;
}

// Unassigned faces grouped into connected islands, each reported with its own extent.
// A count alone tells the agent nothing actionable; "290 triangles, here" does.
function residualRegions(topo, unassigned) {
  const pool = new Set(unassigned), out = [];
  for (const seed of unassigned) {
    if (!pool.has(seed)) continue;
    const stack = [seed], faces = [];
    pool.delete(seed);
    while (stack.length) {
      const t = stack.pop();
      faces.push(t);
      for (const ei of topo.faceEdges[t]) {
        const e = topo.edges[ei];
        const nb = e.triA === t ? e.triB : e.triA;
        if (nb >= 0 && pool.has(nb)) { pool.delete(nb); stack.push(nb); }
      }
    }
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const c = [0, 0, 0];
    for (const t of faces) for (let k = 0; k < 3; k++) {
      const v = topo.tris[3*t + k] * 3;
      for (let a = 0; a < 3; a++) {
        const val = topo.verts[v + a];
        if (val < lo[a]) lo[a] = val;
        if (val > hi[a]) hi[a] = val;
        c[a] += val / (faces.length * 3);
      }
    }
    out.push({ triangles: faces.length, centroid: c, bounds: { min: lo, max: hi } });
  }
  return out.sort((a, b) => b.triangles - a.triangles);
}

// One acceptance candidate per feature. `build` is a thunk so nothing is materialised
// for a candidate the greedy loop never reaches.
function toCandidate(kernel, f, b) {
  const size = [0,1,2].map((i) => b.max[i] - b.min[i]);
  if (f.type === "throughHole" || f.type === "blindHole") {
    const depth = f.type === "throughHole" ? Math.max(...size) * 2 : f.depth;
    return {
      key: f.key, featureKey: f.key, op: "cut", explains: [f.id],
      dimension: f.diameter, paramName: "holeDia", hintOp: "cut",
      hintArgs: { shape: "cylinder", diameter: f.diameter, depth },
      build: () => kernel.cylinder(f.diameter / 2, depth)
        .translate([f.axis.origin[0], f.axis.origin[1], f.axis.origin[2] - depth / 2]),
    };
  }
  if (f.type === "extrusion" || f.type === "boss") {
    return {
      key: f.key, featureKey: f.key, op: "union", explains: [f.id],
      dimension: f.depth, paramName: "height", hintOp: f.type === "boss" ? "union" : "box",
      hintArgs: { shape: f.profile.kind, depth: f.depth },
      build: () => f.profile.kind === "circle"
        ? kernel.cylinder(f.profile.radius, f.depth).translate([b.min[0] + size[0]/2, b.min[1] + size[1]/2, b.min[2]])
        : kernel.box(size[0], size[1], f.depth).translate(b.min),
    };
  }
  // Fillets, chamfers, pockets, revolves and shells are described but not yet proposed
  // as acceptance candidates: each needs an edge or profile selector the facts layer
  // does not yet carry, and a candidate that cannot be built is worse than none. They
  // still appear in `features` with a null confidence, which is the honest report.
  return null;
}
```

- [ ] **Step 4: Export from the testing barrel**

Add to `src/testing.js`, next to the existing `measure` export:

```js
// The semantic mesh oracle. Worker-reachable like the rest of the oracle (the
// `describe` job runs it); re-exported so a downstream harness can run it directly.
export { describe, describeMemo, DESCRIBE_ERRORS } from "./framework/oracle/describe.js";
export { compactDescribe, LOW_COVERAGE } from "./framework/oracle/describe/report.js";
export { DESCRIBE_LIMITS } from "./framework/oracle/describe/limits.js";
```

- [ ] **Step 5: Add the five ERROR-PATTERNS entries**

Append to `docs/ERROR-PATTERNS.md`, one `##` per code, matching the file's existing
symptom → cause → fix shape:

```markdown
## describe-not-manifold

**Symptom:** `partforge describe` returns `{"error": "not-manifold"}`.

**Cause:** The mesh still has open edges after vertex-merge and winding repair, so it
does not bound a solid and acceptance cannot diff against it.

**Fix:** Repair the mesh before describing it — Meshmixer, `meshlabserver`, or the
slicer's own repair. `partforge describe` will not repair geometry it was asked to
report on; silently sealing a hole would make the report a description of a mesh the
user does not have.

## describe-too-large

**Symptom:** `{"error": "too-large"}` naming a triangle count.

**Cause:** Above 400,000 triangles the segmentation pass stops being usable in an
interactive loop.

**Fix:** Decimate first. A CAD-exported STL re-exported at a coarser chord tolerance
loses nothing the describer uses; the feature vocabulary reads surfaces, not facets.

## describe-empty

**Symptom:** `{"error": "empty"}`.

**Cause:** The mesh has zero triangles — usually an import that resolved to an empty
file, or a `k.import` name that registered as an error entry.

**Fix:** Check the `imports` source actually resolves. See
[import-unknown-name](#import-unknown-name).

## describe-budget-exceeded

**Symptom:** The report carries `warning: "budget-exceeded"` and `score.xorFraction`
is higher than expected.

**Cause:** The acceptance loop hit its boolean budget before the residual converged.
The report is partial but honestly scored — not wrong, just incomplete.

**Fix:** Raise `--budget`, or accept the partial description. A part needing far more
than the default is usually one where a residual region is being attacked by many
near-identical candidates; check `residual.regions` first.

## describe-unreadable

**Symptom:** `{"error": "unreadable"}`.

**Cause:** The file could not be parsed as STL, 3MF, or STEP.

**Fix:** Confirm the format. STL is assumed to be in millimetres (the format carries
no unit metadata) — see the import section of AUTHORING-PARTS.md.
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/describe.test.js test/error-patterns.test.js`
Expected: PASS. `error-patterns.test.js` validates the doc's structure, so a malformed
entry fails there rather than at runtime.

- [ ] **Step 7: Commit**

```bash
git add src/framework/oracle/describe.js src/testing.js docs/ERROR-PATTERNS.md test/describe.test.js
git commit -m "feat(describe): orchestrator, digest memo, and closed error set"
```

---

### Task 13: The `describe` worker job

**Files:**
- Modify: `src/framework/jobs.js` (new branch beside `inspect`)
- Test: `test/describe-job.test.js`

**Interfaces:**
- Consumes: `describe`, `describeMemo` (Task 12); `compactDescribe` (Task 11).
- Produces: a job `{ type: "describe", importName, budget?, compact? }` answered with
  `{ type: "describe-report", report }` on success and `{ type: "error", message }` on a
  programming failure. A closed-set error is a *successful* job whose report carries
  `error` — the caller must not have to distinguish "the job broke" from "the mesh is
  not describable".

- [ ] **Step 1: Write the failing test**

`test/describe-job.test.js`:

```js
import { expect, test, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handle } from "../src/framework/jobs.js";

const part = {
  name: "washer",
  imports: { scan: new URL("./fixtures/describe-washer.stl", import.meta.url) },
  parts: { body: { build: (k) => k.import("scan") } },
  views: { default: { parts: ["body"] } },
  params: {},
};

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(part); });

const run = (msg) => new Promise((resolve) => handle(kernel, part, msg, resolve));

test("a describe job answers with a describe-report", async () => {
  const out = await run({ type: "describe", importName: "scan" });
  expect(out.type).toBe("describe-report");
  expect(out.report.source.name).toBe("scan");
});

test("the report carries the import digest so the caller can key its own cache", async () => {
  const out = await run({ type: "describe", importName: "scan" });
  expect(typeof out.report.source.digest).toBe("string");
  expect(out.report.source.digest.length).toBeGreaterThan(0);
});

test("compact:true returns the compact shape with surfaces elided", async () => {
  const out = await run({ type: "describe", importName: "scan", compact: true });
  expect(out.report.surfaces).toBeUndefined();
  expect(out.report.counts.surfaces).toBeGreaterThan(0);
});

test("a second describe of the same import is served from the memo", async () => {
  const a = await run({ type: "describe", importName: "scan" });
  const b = await run({ type: "describe", importName: "scan" });
  expect(b.report).toBe(a.report);
});

test("an unknown import name is an error, not a crash", async () => {
  const out = await run({ type: "describe", importName: "nope" });
  expect(out.type).toBe("error");
  expect(out.message).toMatch(/nope/);
});
```

Generate the fixture STL once, from the washer fixture, and commit it:

```bash
node -e '
import("./src/testing/manifold.js").then(async ({ bootManifoldKernel }) => {
  const k = await bootManifoldKernel();
  const s = k.cut(k.cylinder(10, 3), k.cylinder(4, 9).translate([0,0,-3]));
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { meshToStl } = await import("./src/framework/geometry/mesh-stl.js");
  mkdirSync("test/fixtures", { recursive: true });
  const m = s.toMesh();
  writeFileSync("test/fixtures/describe-washer.stl", Buffer.from(meshToStl(m.positions, m.indices)));
});'
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/describe-job.test.js`
Expected: FAIL — the job type is unhandled, so nothing is posted.

- [ ] **Step 3: Add the job branch to `jobs.js`**

Add the imports at the top:

```js
import { describe as describeMesh, describeMemo } from "./oracle/describe.js";
import { compactDescribe } from "./oracle/describe/report.js";
```

Add a module-level memo store beside the other worker-lifetime state:

```js
// One describe memo for the life of this worker. It is deliberately NOT swept on
// setPart the way solid-cache is: describe is pure in the mesh bytes (spec §4.1), so an
// edit cannot invalidate it, and dropping it on rebind would throw away the single most
// expensive thing this worker computes for no reason at all. Keyed by content digest, so
// a genuinely changed file misses correctly.
const DESCRIBE_MEMO = describeMemo();
```

Add the branch immediately after the `inspect` branch, inside the same `try`:

```js
    } else if (msg.type === "describe") {
      // Semantic description of an IMPORTED mesh — not of the built part. The two are
      // different questions: `inspect` asks "what did this source build?", `describe`
      // asks "what is this file?". describe never touches the part's own geometry, which
      // is why it takes an import name rather than a view.
      //
      // Manifold only, and not by choice on this path: mesh imports on OCCT are never
      // attempted, so a describe job posted to an OCCT worker is a routing bug, not a
      // fallback opportunity. It surfaces as an ordinary error rather than a reroute.
      const solid = kernel.import(msg.importName);      // throws on an unknown name
      // `_importDigest` is the backend's existing underscore side-channel (KERNEL-CONTRACT
      // "Conformance classes") — the same digest already folded into every import cache key.
      const digest = kernel._importDigest?.(msg.importName) ?? null;
      const full = describeMesh(kernel, solid, {
        name: msg.importName,
        digest,
        budget: msg.budget,
        memo: DESCRIBE_MEMO,
      });
      // The compact shape is derived, never memoised separately: one memo entry per
      // mesh, two views of it, no way for the two to drift.
      post({ type: "describe-report", report: msg.compact ? compactDescribe(full) : full });
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/describe-job.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Verify the layering rule still holds**

Run: `npx vitest run test/worker-layering.test.js`
Expected: PASS. `jobs.js` now reaches the whole describe stack, so any accidental
`node:`/`three`/DOM import anywhere under `describe/` fails here and names the chain.

- [ ] **Step 6: Commit**

```bash
git add src/framework/jobs.js test/describe-job.test.js test/fixtures/describe-washer.stl
git commit -m "feat(describe): worker job type with a worker-lifetime digest memo"
```

---

### Task 14: The `describe` CLI verb and its documentation

**Files:**
- Modify: `bin/cli.js` (new command + `USAGE`)
- Modify: `docs/AUTHORING-PARTS.md` (new section)
- Test: `test/cli-describe.test.js`

**Interfaces:**
- Consumes: `describe` (Task 12), `compactDescribe` (Task 11), the existing `loadPart` /
  `bootKernel` / `parse` / `crash` helpers in `bin/cli.js`.
- Produces: `partforge describe <part-module#importName | mesh-path> [--json] [--surfaces] [--budget N] [--out <file>]`.

- [ ] **Step 1: Write the failing test**

`test/cli-describe.test.js`:

```js
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const run = (args) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

test("describe prints a markdown summary by default", () => {
  const out = run(["describe", "src/parts/import-demo.js#scan"]);
  expect(out).toMatch(/Features/);
  expect(out).toMatch(/explained/i);
});

test("the default summary does not dump the surface list", () => {
  const out = run(["describe", "src/parts/import-demo.js#scan"]);
  expect(out).not.toMatch(/^\s*s0\s+plane/m);
});

test("--surfaces includes the surface table", () => {
  const out = run(["describe", "src/parts/import-demo.js#scan", "--surfaces"]);
  expect(out).toMatch(/s0/);
});

test("--json emits the full report", () => {
  const r = JSON.parse(run(["describe", "src/parts/import-demo.js#scan", "--json"]));
  expect(Array.isArray(r.surfaces)).toBe(true);
  expect(r.frame.up).toBe("+Z");
});

test("low coverage does not make describe exit non-zero", () => {
  // Coverage is a finding, not a failure — an agent must be able to read a poor report
  // rather than only see a non-zero exit.
  expect(() => run(["describe", "src/parts/import-demo.js#scan"])).not.toThrow();
});

test("an unknown import name exits non-zero with a message naming it", () => {
  let err = null;
  try { run(["describe", "src/parts/import-demo.js#missing"]); } catch (e) { err = e; }
  expect(err).not.toBeNull();
  expect(String(err.stderr)).toMatch(/missing/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/cli-describe.test.js`
Expected: FAIL — `describe` is not in the command table, so the CLI dies on `USAGE`.

- [ ] **Step 3: Add the command to `bin/cli.js`**

Update the usage banner:

```js
const USAGE = "usage: partforge <lint|measure|render|describe|pick-serve|pick> …";
```

Add the imports:

```js
import { describe as describeMesh } from "../src/framework/oracle/describe.js";
import { compactDescribe } from "../src/framework/oracle/describe/report.js";
```

Add the command to the table, beside `measure`:

```js
  async describe(args) {
    const usage = "usage: partforge describe <part-module#importName> [--surfaces] [--json] [--budget N] [--out <file>]";
    const { values: flags, positionals: [target] } = parse(args, {
      surfaces: { type: "boolean" },
      json: { type: "boolean" },
      budget: { type: "string" },
      out: { type: "string" },
    }, usage);
    if (!target) die(usage);
    // `part.js#importName` — describe reads a FILE, and a file only reaches the kernel
    // through a part's `imports` declaration, so the part is how we find it. A bare mesh
    // path is deliberately not accepted in v1: it would need its own resolver, its own
    // format sniffing, and its own unit assumptions, all of which the import pipeline
    // already owns.
    const [partPath, importName] = target.split("#");
    if (!importName) die(`describe needs an import name: <part-module>#<importName>\n${usage}`);
    try {
      const part = await loadPart(partPath, usage);
      if (!part.imports?.[importName]) {
        die(`describe: "${importName}" is not a declared import of ${partPath} ` +
            `(have: ${Object.keys(part.imports ?? {}).join(", ") || "none"})`);
      }
      const kernel = await bootKernel(part);
      const solid = kernel.import(importName);
      const report = describeMesh(kernel, solid, {
        name: importName,
        digest: kernel._importDigest?.(importName) ?? null,
        budget: flags.budget ? Number(flags.budget) : undefined,
      });
      if (flags.out) {
        mkdirSync(dirname(resolve(flags.out)), { recursive: true });
        writeFileSync(flags.out, JSON.stringify(report, null, 2));
      }
      if (flags.json) console.log(JSON.stringify(report, null, 2));
      else printDescribe(report, { surfaces: !!flags.surfaces });
      if (flags.out) console.log(`\nwrote ${flags.out}`);
      // A closed-set error exits non-zero; LOW COVERAGE does not. Coverage is a finding
      // the caller must be able to read, and an exit code that conflated the two would
      // train an agent to discard exactly the reports it most needs to look at.
      process.exit(report.error ? 1 : 0);
    } catch (e) {
      crash("describe", e, !!flags.json);
    }
  },
```

Add the printer beside the existing `printMeasure` / `printVerify`:

```js
// Human/agent-readable summary. Features, patterns, symmetry, score, residual — the
// compact shape (spec §3.4), because a 24k-triangle part yields hundreds of surfaces and
// dumping them buries the reader in the noise the oracle exists to remove. `--surfaces`
// opts back in; `--json` always has everything.
function printDescribe(report, { surfaces }) {
  if (report.error) {
    console.error(`describe: ${report.error}${report.detail ? ` — ${report.detail}` : ""}`);
    return;
  }
  const c = compactDescribe(report);
  if (c.warning) console.log(`\n!! ${c.warning}\n`);
  console.log(`${c.source.name ?? "mesh"} — ${c.source.triangles} triangles, ` +
              `${c.bounds.size.map((v) => v.toFixed(2)).join(" x ")} mm, ${c.frame.up} up`);
  console.log(`\nFeatures (${c.features.length}):`);
  for (const f of c.features) {
    const dim = f.diameter ?? f.radius ?? f.width ?? f.thickness ?? f.depth;
    const snap = f.snapped?.diameter?.note ? `  [${f.snapped.diameter.note}]` : "";
    console.log(`  ${f.id.padEnd(5)} ${f.type.padEnd(14)} ` +
                `${dim != null ? dim.toFixed(3) : ""}`.padEnd(10) +
                `conf ${f.confidence == null ? "n/a" : f.confidence.toFixed(3)}${snap}`);
  }
  if (c.patterns.length) {
    console.log(`\nPatterns (${c.patterns.length}):`);
    for (const p of c.patterns) {
      console.log(`  ${p.id.padEnd(5)} ${p.type.padEnd(9)} x${p.counts.join("x")} ` +
                  `pitch ${p.pitch.map((v) => v.toFixed(2)).join(", ")}  [${p.members.length} members]`);
    }
  }
  if (c.symmetry.length) {
    console.log(`\nSymmetry:`);
    for (const s of c.symmetry) console.log(`  ${s.type} coverage ${s.coverage}`);
  }
  if (surfaces) {
    console.log(`\nSurfaces (${report.surfaces.length}):`);
    for (const s of report.surfaces) {
      console.log(`  ${s.id.padEnd(5)} ${s.type.padEnd(9)} area ${s.area.toFixed(2)}`.padEnd(40) +
                  `rms ${s.rms.toExponential(2)}`);
    }
  }
  console.log(`\nScore: ${(100 * c.score.explainedArea).toFixed(1)}% area explained, ` +
              `xor ${(100 * c.score.xorFraction).toFixed(2)}% of volume`);
  console.log(`Residual: ${(100 * c.residual.areaFraction).toFixed(2)}% of area in ` +
              `${c.residual.regions.length} region(s)`);
  const truncated = Object.entries(report.truncated ?? {}).filter(([, v]) => v).map(([k]) => k);
  if (truncated.length) console.log(`Truncated (caps hit): ${truncated.join(", ")}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/cli-describe.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Document it in AUTHORING-PARTS.md**

Add a "Describing an imported mesh" section immediately after the geometry-import
section (which ends near the `k.import` "CLI" note). Cover, with a worked example on
`import-demo.js`: the two report layers and which is authoritative; that `describe` is
pure in the mesh so it is computed once and reused; the `--surfaces` / `--json` split and
why the default elides surfaces; that low coverage exits zero and why; the closed error
set with a pointer to each ERROR-PATTERNS anchor; and the loop this completes —
`describe` the import, write the part, bind a `reference` sub-part, let `verify`'s `ref*`
gates hold the rebuild to the scan.

- [ ] **Step 6: Commit**

```bash
git add bin/cli.js docs/AUTHORING-PARTS.md test/cli-describe.test.js
git commit -m "feat(describe): partforge describe CLI verb and authoring docs"
```

---

### Task 15: Integration tests, the third-party corpus, and the release bump

**Files:**
- Create: `test/describe-roundtrip.test.js`
- Create: `test/fixtures/third-party/README.md` (+ 3 committed STL files)
- Modify: `package.json` (version bump)

**Interfaces:**
- Consumes: everything.
- Produces: no new API. This task is the honesty check on all of it.

- [ ] **Step 1: Write the round-trip test**

`test/describe-roundtrip.test.js`:

```js
import { expect, test, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { buildView } from "../src/framework/oracle/build.js";
import { describe as describeMesh } from "../src/framework/oracle/describe.js";
import demo from "../src/parts/demo.js";
import filletedBox from "../src/parts/filleted-box.js";
import bracket from "../src/parts/bracket.js";

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(); });

// The repo's own reference parts are free, perfectly-labelled ground truth for the exact
// input class describe targets: a CAD-exported tessellation whose real dimensions we can
// read straight out of the part source. Nothing else in the suite can check that the
// numbers the describer reports are the numbers that were built.
const solidOf = (part, view = Object.keys(part.views)[0]) =>
  buildView(kernel, part, view, {})[0].solid;

test("demo.js round-trips with high coverage", () => {
  const r = describeMesh(kernel, solidOf(demo), { digest: "rt-demo" });
  expect(r.score.explainedArea).toBeGreaterThan(0.95);
});

test("demo.js is described as a single extrusion", () => {
  const r = describeMesh(kernel, solidOf(demo), { digest: "rt-demo2" });
  expect(r.features.some((f) => f.type === "extrusion")).toBe(true);
});

test("demo.js's recovered bbox matches the built mesh exactly", () => {
  const solid = solidOf(demo);
  const mesh = solid.toMesh();
  const r = describeMesh(kernel, solid, { digest: "rt-demo3" });
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) for (let a = 0; a < 3; a++) {
    lo[a] = Math.min(lo[a], mesh.positions[i+a]); hi[a] = Math.max(hi[a], mesh.positions[i+a]);
  }
  for (let a = 0; a < 3; a++) expect(r.bounds.size[a]).toBeCloseTo(hi[a] - lo[a], 6);
});

test("filleted-box.js reports fillets", () => {
  const r = describeMesh(kernel, solidOf(filletedBox), { digest: "rt-fb" });
  expect(r.features.some((f) => f.type === "fillet")).toBe(true);
});

test("bracket.js round-trips without an error and with localised residual", () => {
  const r = describeMesh(kernel, solidOf(bracket), { digest: "rt-br" });
  expect(r.error).toBeUndefined();
  // Whatever it cannot explain must be LOCATED, not merely counted — an agent can act
  // on "290 triangles, here" and cannot act on "1.2%".
  for (const region of r.residual.regions) {
    expect(region.triangles).toBeGreaterThan(0);
    expect(region.centroid.every(Number.isFinite)).toBe(true);
  }
});

test("noise injection degrades the score but does not throw or lose every feature", () => {
  const solid = solidOf(demo);
  const mesh = solid.toMesh();
  const jittered = Float32Array.from(mesh.positions, (v, i) => v + ((i * 2654435761 % 1000) / 1000 - 0.5) * 0.002);
  kernel._registerImport({ name: "noisy-demo", digest: "noisy-demo", positions: jittered, indices: mesh.indices });
  const clean = describeMesh(kernel, solid, { digest: "n-clean" });
  const dirty = describeMesh(kernel, kernel.import("noisy-demo"), { digest: "n-dirty" });
  expect(dirty.error).toBeUndefined();
  expect(dirty.score.explainedArea).toBeLessThanOrEqual(clean.score.explainedArea + 1e-9);
  expect(dirty.features.length).toBeGreaterThan(0);
});

test("every accepted feature's confidence is a finite fraction", () => {
  const r = describeMesh(kernel, solidOf(demo), { digest: "rt-conf" });
  for (const f of r.features) {
    if (f.confidence == null) continue;
    expect(Number.isFinite(f.confidence)).toBe(true);
    expect(f.confidence).toBeGreaterThan(0);
  }
});
```

- [ ] **Step 2: Run it and fix what it finds**

Run: `npx vitest run test/describe-roundtrip.test.js`

Expect real failures here — this is the first time the whole pipeline runs on geometry
nobody designed a fixture around. Fix the pipeline, not the assertions. The one
assertion it is legitimate to relax is the `> 0.95` coverage floor on a part with
genuinely freeform surfaces, and only after confirming the residual is located where the
freeform geometry actually is.

- [ ] **Step 3: Add the third-party corpus**

The round-trip tests above check the describer against *ideal* input — our own
tessellation, at our own chord tolerance, with no re-meshing. Real downloaded STLs are
decimated, re-meshed, and occasionally slightly non-manifold. Without this the suite goes
green against a describer that falls over on the first real file.

Add three permissively-licensed STLs (CC0 or CC-BY) under `test/fixtures/third-party/`,
chosen to span the v1 vocabulary: one prismatic machined bracket with holes, one turned
axisymmetric part, one printed enclosure with a shelled wall. Record each file's source
URL and licence in `test/fixtures/third-party/README.md`.

Extend `test/describe-roundtrip.test.js` with one test per file asserting only what is
defensible without ground truth:

```js
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("./fixtures/third-party/", import.meta.url));

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".stl"))) {
  test(`third-party ${file} describes without an error`, () => {
    // Geometry enters the kernel the one way it can: register it as an import, then read it
    // back as a Solid — exactly what the framework's own import pipeline does.
    const { positions, indices } = parseStl(readFileSync(`${DIR}${file}`));
    kernel._registerImport({ name: file, digest: file, positions, indices });
    const r = describeMesh(kernel, kernel.import(file), { digest: `tp-${file}` });
    // Deliberately weak: we have no ground truth for these. What we CAN insist on is
    // that the describer never throws, never claims coverage it cannot back, and always
    // localises what it could not explain.
    expect(r.error).toBeUndefined();
    expect(r.score.explainedArea).toBeGreaterThan(0);
    expect(r.score.explainedArea).toBeLessThanOrEqual(1 + 1e-9);
    expect(r.residual.regions.every((g) => g.triangles > 0)).toBe(true);
  });
}
```

Import `parseStl` from `src/framework/geometry/stl-parse.js`. This test file boots
Manifold and no OCCT, so it stays a single-kernel file.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS, including `test/worker-layering.test.js` and `test/error-patterns.test.js`.

- [ ] **Step 5: Bump the version**

**This is the step that is quietly skipped and it is the one that decides whether any of
the work ships.** Releasing is automatic: when this branch merges, `publish.yml` tags the
merge commit and publishes — but only if `package.json` carries a version npm has not seen.
Forget it and the merge lands, the workflow correctly does nothing, and the feature never
reaches Phase B.

```bash
node -e 'const p=require("./package.json"); console.log("current:", p.version)'
```

Bump the **minor** version (a new CLI verb and a new published export are additive
surface, not a fix), edit `package.json`, and confirm the new number is unpublished:

```bash
npm view partforge versions --json | grep -c '"<new-version>"'
```

Expected: `0`.

- [ ] **Step 6: Commit**

```bash
git add test/describe-roundtrip.test.js test/fixtures/third-party/ package.json
git commit -m "test(describe): reference-part round-trip, noise, and third-party corpus

Bumps the version so the merge actually publishes."
```

---

## Definition of done

- [ ] `npm test` passes, including `worker-layering` and `error-patterns`.
- [ ] `npx partforge describe src/parts/import-demo.js#scan` prints a summary and exits 0.
- [ ] `npx partforge describe src/parts/import-demo.js#scan --json` emits a full report with `frame`, `truncated`, and `suggestion`.
- [ ] `docs/AUTHORING-PARTS.md` documents the verb; `docs/ERROR-PATTERNS.md` has all five entries.
- [ ] `package.json` carries an unpublished version.
- [ ] Phase B (partforge-cloud) is untouched — it is a separate repo and a separate PR.
