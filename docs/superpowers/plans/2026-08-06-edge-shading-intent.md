# Kernel-Authoritative Shading Intent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the geometry kernel the single authority on shading normals and feature-edge lines so curved surfaces never show phantom edges (OCCT spheres) and intentional facets never get smoothed away (Manifold lofts).

**Architecture:** OCCT stops discarding replicad's analytic normals and ships true B-rep edges (tangent-filtered); Manifold gains a per-original-surface shading policy registered at primitive creation and applied by the crease pass. New logic lands in four small pure modules (`shading-policy.js`, `creased-normals.js`, `brep-edges.js`, plus `rotateNormals` in `pose.js`); the backends shrink to wiring. The viewer treats kernel edge data as authoritative even when empty.

**Tech Stack:** Plain ESM JavaScript, vitest, manifold-3d WASM, replicad (OCCT WASM). Spec: `docs/superpowers/specs/2026-08-06-edge-shading-intent-design.md`.

## Global Constraints

- **Node 24 required** — run `nvm use` before any `npm`/`npx` command; the default shell Node is too old and fails confusingly.
- All files under `src/framework/geometry/` must stay DOM-free, `three`-free, and `node:`-free (`test/worker-layering.test.js` enforces this).
- Never import `src/testing/` from `src/framework/`.
- OCCT and Manifold must NOT boot in the same test file (vitest isolates per file). OCCT boots via `bootOcctKernel()` from `src/testing/occt.js`; Manifold via `bootManifoldKernel()` from `src/testing.js`.
- Units are millimetres throughout.
- On any confusing build/test failure, grep `docs/ERROR-PATTERNS.md` for the symptom first.
- Commit after every task (steps include the commands).

## File Structure

| File | Responsibility |
|---|---|
| `src/framework/geometry/shading-policy.js` (new) | Policy constants (SMOOTH/FACETED), every shading threshold, loft intent inference |
| `src/framework/geometry/creased-normals.js` (new) | Manifold crease pass moved out of the backend; policy-aware normals + edge segments + feature attribution |
| `src/framework/geometry/brep-edges.js` (new) | OCCT tangent-edge filter: replicad `mesh()` + `meshEdges()` → sharp feature segments |
| `src/framework/geometry/pose.js` (modify) | Gains `rotateNormals` (rotation-only rigid-pose application) |
| `src/framework/geometry/manifold-backend.js` (modify) | Delete inlined crease pass; wire creased-normals; register loft policy; propagate policy through `label()` |
| `src/framework/geometry/occt-backend.js` (modify) | `toMesh` returns analytic normals + filtered B-rep edges, posed; finer preview tessellation |
| `src/framework/geometry/op-options.js` (modify) | `loft` accepts `smooth` |
| `src/framework/geometry/kernel.js` (modify) | loft typedef documents `smooth` |
| `src/framework/viewer.js` (modify) | Kernel edges authoritative even when empty; fallback comments |
| `test/shading-policy.test.js`, `test/creased-normals.test.js`, `test/brep-edges.test.js` (new) | Pure-module tests, no WASM boot |
| `test/loft-shading.test.js` (new, Manifold boot), `test/occt-shading.test.js` (new, OCCT boot) | Backend integration tests |
| `test/pose.test.js` (modify) | `rotateNormals` cases |
| `docs/KERNEL-CONTRACT.md`, `docs/AUTHORING-PARTS.md`, `docs/ERROR-PATTERNS.md`, `package.json` (modify) | Contract semantics, authoring docs, error patterns, version bump |

---

### Task 1: `shading-policy.js` — policies, thresholds, loft inference

**Files:**
- Create: `src/framework/geometry/shading-policy.js`
- Test: `test/shading-policy.test.js`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `SMOOTH`, `FACETED` (frozen `{creaseAngle:number, sameSurfaceLines:boolean}`), `COPLANAR_ANGLE`, `TANGENT_ANGLE`, `MIN_EDGE`, `SMOOTH_SIDES_MIN`, `cosDeg(deg)=>number`, `loftShadingPolicy(rings, {smooth, ruled})=>policy`. Tasks 2, 3, 5 import these exact names.

- [ ] **Step 1: Write the failing test**

Create `test/shading-policy.test.js`:

```js
import { expect, test } from "vitest";
import { SMOOTH, FACETED, SMOOTH_SIDES_MIN, cosDeg, loftShadingPolicy } from "../src/framework/geometry/shading-policy.js";

test("policies carry the spec'd angles and line gating", () => {
  expect(SMOOTH).toEqual({ creaseAngle: 35, sameSurfaceLines: true });
  expect(FACETED).toEqual({ creaseAngle: 10, sameSurfaceLines: false });
  expect(Object.isFrozen(SMOOTH)).toBe(true);
  expect(Object.isFrozen(FACETED)).toBe(true);
});

test("cosDeg converts degrees to a cosine", () => {
  expect(cosDeg(0)).toBeCloseTo(1, 10);
  expect(cosDeg(60)).toBeCloseTo(0.5, 10);
});

test("explicit smooth hint wins in both directions", () => {
  const rings = [{ sides: 12, radius: 20, z: 0 }, { sides: 12, radius: 20, z: 10 }];
  expect(loftShadingPolicy(rings, { smooth: true })).toBe(SMOOTH);
  expect(loftShadingPolicy(rings, { smooth: false })).toBe(FACETED);
  const many = [{ sides: 64, radius: 20, z: 0 }, { sides: 64, radius: 20, z: 10 }];
  expect(loftShadingPolicy(many, { smooth: false })).toBe(FACETED);
});

test("ruled:false (OCCT smooth blend) implies smooth shading intent", () => {
  const rings = [{ sides: 6, radius: 20, z: 0 }, { sides: 6, radius: 20, z: 10 }];
  expect(loftShadingPolicy(rings, { ruled: false })).toBe(SMOOTH);
});

test("inference: low side counts are facets, high counts approximate smooth", () => {
  const few = [{ sides: 12, radius: 20, z: 0 }, { sides: 12, radius: 20, z: 10 }];
  expect(loftShadingPolicy(few, {})).toBe(FACETED);
  const many = [{ sides: SMOOTH_SIDES_MIN, radius: 20, z: 0 }, { sides: SMOOTH_SIDES_MIN, radius: 20, z: 10 }];
  expect(loftShadingPolicy(many, {})).toBe(SMOOTH);
  expect(loftShadingPolicy(undefined, undefined)).toBe(FACETED); // malformed input: safe default, no throw
});

test("inference reads explicit polygon rings by point count", () => {
  const poly = (n) => Array.from({ length: n }, (_, i) => [Math.cos((i / n) * 2 * Math.PI), Math.sin((i / n) * 2 * Math.PI)]);
  expect(loftShadingPolicy([{ polygon: poly(8), z: 0 }, { polygon: poly(8), z: 5 }], {})).toBe(FACETED);
  expect(loftShadingPolicy([{ polygon: poly(48), z: 0 }, { polygon: poly(48), z: 5 }], {})).toBe(SMOOTH);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/shading-policy.test.js`
Expected: FAIL — cannot resolve `../src/framework/geometry/shading-policy.js`.

- [ ] **Step 3: Write the implementation**

Create `src/framework/geometry/shading-policy.js`:

```js
// Shading-intent policies — the single home for every edge/shading threshold.
// A policy says how one original surface (a Manifold originalID) wants its
// SAME-surface edges treated by creased-normals.js:
//   creaseAngle       deg — same-surface edges bending more than this shade hard
//   sameSurfaceLines  whether same-surface edges past creaseAngle also draw lines
// Cross-surface (boolean cut seam) behavior is not policy: seams always shade
// hard, and draw a line when bent more than COPLANAR_ANGLE.

export const SMOOTH = Object.freeze({ creaseAngle: 35, sameSurfaceLines: true });
export const FACETED = Object.freeze({ creaseAngle: 10, sameSurfaceLines: false });

export const COPLANAR_ANGLE = 5;  // deg — cut seams bending less than this are coplanar: no line
export const TANGENT_ANGLE = 5;   // deg — B-rep edges whose faces agree within this are tangent: no line
export const MIN_EDGE = 0.01;     // mm — drop shorter segments (degenerate slivers, pole edges)

// Loft rings with at least this many sides read as an approximation of a smooth
// surface (e.g. a 64-gon "circle"), not as 64 intentional facets.
export const SMOOTH_SIDES_MIN = 32;

export const cosDeg = (deg) => Math.cos((deg * Math.PI) / 180);

// Loft shading inference. An explicit `smooth` hint wins; `ruled:false` asks
// OCCT for a smoothly blended surface, so the Manifold preview of the same part
// must shade smooth too; otherwise low-side-count rings are intentional facets.
export function loftShadingPolicy(rings, { smooth, ruled } = {}) {
  if (smooth === true) return SMOOTH;
  if (smooth === false) return FACETED;
  if (ruled === false) return SMOOTH;
  let maxSides = 0;
  if (Array.isArray(rings)) for (const r of rings) {
    const n = Array.isArray(r?.polygon) ? r.polygon.length : (Number.isFinite(r?.sides) ? r.sides : 0);
    if (n > maxSides) maxSides = n;
  }
  return maxSides >= SMOOTH_SIDES_MIN ? SMOOTH : FACETED;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/shading-policy.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/shading-policy.js test/shading-policy.test.js
git commit -m "Add shading-policy module: SMOOTH/FACETED policies and loft intent inference"
```

---

### Task 2: `creased-normals.js` — extract the crease pass, make it policy-aware

**Files:**
- Create: `src/framework/geometry/creased-normals.js`
- Modify: `src/framework/geometry/manifold-backend.js` (delete the inlined function + its constants, import the module)
- Test: `test/creased-normals.test.js`

**Interfaces:**
- Consumes: `SMOOTH`, `COPLANAR_ANGLE`, `MIN_EDGE`, `cosDeg` from Task 1.
- Produces: `creasedNormals(g, { policies, featureLabels } = {})` where `g` is a Manifold MeshGL-shaped object (`numProp`, `vertProperties`, `triVerts`, optional `mergeFromVert`/`mergeToVert`, `runIndex`, `runOriginalID`), `policies` is a `Map<oid, policy>` (missing entries default to `SMOOTH`), `featureLabels` a `Map<oid, string>` or null. Returns `{ positions, normals, triangles, edges, featureIds?, features? }` exactly as the current inlined version does. Task 3 calls it with both maps.

- [ ] **Step 1: Write the failing test**

Create `test/creased-normals.test.js`. The `hinge` fixture is two triangles sharing the x-axis edge with a controllable dihedral bend and per-triangle originalIDs — the smallest mesh that exercises every branch:

```js
import { expect, test } from "vitest";
import { creasedNormals } from "../src/framework/geometry/creased-normals.js";
import { FACETED } from "../src/framework/geometry/shading-policy.js";

// Two triangles sharing the edge v0-v1 (the x axis). Tri A lies in the XY
// plane (face normal +Z); tri B is the same quad half rotated `bend` degrees
// up about the x axis. scale shrinks the whole fixture (for MIN_EDGE tests).
function hinge(bendDeg, { oids = [7, 7], scale = 1 } = {}) {
  const t = (bendDeg * Math.PI) / 180;
  const s = scale;
  return {
    numProp: 3,
    vertProperties: Float32Array.from([
      0, 0, 0,                      // v0
      1 * s, 0, 0,                  // v1
      0, 1 * s, 0,                  // v2  (tri A apex)
      0.5 * s, -Math.cos(t) * s, Math.sin(t) * s, // v3 (tri B apex)
    ]),
    triVerts: Uint32Array.from([0, 1, 2, 1, 0, 3]),
    mergeFromVert: new Uint32Array(0),
    mergeToVert: new Uint32Array(0),
    runIndex: Uint32Array.from([0, 3, 6]),
    runOriginalID: Uint32Array.from(oids),
  };
}

const cornerNormal = (r, tri, corner) => [
  r.normals[(tri * 3 + corner) * 3],
  r.normals[(tri * 3 + corner) * 3 + 1],
  r.normals[(tri * 3 + corner) * 3 + 2],
];

test("same surface, 30° bend, default SMOOTH: shared-edge normals are averaged, no edge line", () => {
  const r = creasedNormals(hinge(30));
  const [nx, ny, nz] = cornerNormal(r, 0, 0); // tri A's copy of v0 (shared vertex)
  expect(nz).toBeLessThan(0.9999);            // not the pure +Z face normal — it blends with tri B
  expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
  expect(r.edges.length).toBe(0);             // 30° < 35° — no line
});

test("same surface, 45° bend, default SMOOTH: hard normals and one edge segment", () => {
  const r = creasedNormals(hinge(45));
  expect(cornerNormal(r, 0, 0)[2]).toBeCloseTo(1, 5); // tri A shades with its own +Z face normal
  expect(r.edges.length).toBe(6);                     // one segment = 2 points × xyz
});

test("FACETED policy: a 30° same-surface bend shades hard and draws NO line", () => {
  const r = creasedNormals(hinge(30), { policies: new Map([[7, FACETED]]) });
  expect(cornerNormal(r, 0, 0)[2]).toBeCloseTo(1, 5); // hard: 30° > 10°
  expect(r.edges.length).toBe(0);                     // sameSurfaceLines: false
});

test("FACETED policy: bends under creaseAngle still smooth (ring-to-ring case)", () => {
  const r = creasedNormals(hinge(4), { policies: new Map([[7, FACETED]]) });
  expect(cornerNormal(r, 0, 0)[2]).toBeLessThan(0.9999); // 4° < 10° — averaged
});

test("different surfaces: always hard, line only past the 5° coplanar threshold", () => {
  const seam = creasedNormals(hinge(30, { oids: [7, 8] }));
  expect(cornerNormal(seam, 0, 0)[2]).toBeCloseTo(1, 5); // cut seams shade hard at any angle
  expect(seam.edges.length).toBe(6);
  const coplanar = creasedNormals(hinge(2, { oids: [7, 8] }));
  expect(cornerNormal(coplanar, 0, 0)[2]).toBeCloseTo(1, 5);
  expect(coplanar.edges.length).toBe(0);                 // 2° < 5° — coplanar seam, no line
});

test("sub-MIN_EDGE segments are dropped as degenerate slivers", () => {
  const r = creasedNormals(hinge(90, { scale: 0.005 })); // shared edge is 0.005mm long
  expect(r.edges.length).toBe(0);
});

test("feature labels map through runOriginalID unchanged", () => {
  const r = creasedNormals(hinge(45, { oids: [7, 8] }), { featureLabels: new Map([[7, "wall"]]) });
  expect(r.features).toEqual(["wall"]);
  expect(Array.from(r.featureIds)).toEqual([1, 0]); // tri A → feature 1, tri B unlabeled
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/creased-normals.test.js`
Expected: FAIL — cannot resolve `../src/framework/geometry/creased-normals.js`.

- [ ] **Step 3: Create the module**

Create `src/framework/geometry/creased-normals.js`. This is the function currently at `src/framework/geometry/manifold-backend.js:276-376`, moved verbatim except for the changes called out with `NEW` comments below (signature, per-OID policy lookup, policy-gated line emission):

```js
// Policy-aware crease pass for Manifold meshes — moved out of the backend so it
// is unit-testable on plain arrays without booting WASM. Builds a non-indexed
// mesh with normals that are smooth within a single original surface but HARD
// across boolean-cut seams. Manifold's runOriginalID tells us which input solid
// each triangle came from; we average a corner's face normals only over
// incident triangles of the SAME original surface that also meet within that
// surface's policy creaseAngle — so cut seams stay crisp at any angle (even
// near-tangent), and a surface's own sharp edges stay crisp too. Each original
// surface may carry a shading policy (shading-policy.js); surfaces without one
// use SMOOTH, which reproduces the pre-policy behavior exactly.
import { SMOOTH, COPLANAR_ANGLE, MIN_EDGE, cosDeg } from "./shading-policy.js";

const COPLANAR_COS = cosDeg(COPLANAR_ANGLE);
const MIN_EDGE2 = MIN_EDGE * MIN_EDGE;

export function creasedNormals(g, { policies = null, featureLabels = null } = {}) {
  const np = g.numProp, vp = g.vertProperties, tris = g.triVerts;
  const nTri = (tris.length / 3) | 0, nVert = (vp.length / np) | 0;

  // NEW: per-OID policy lookup with a cached cosine per OID
  const polFor = (oid) => (policies && policies.get(oid)) || SMOOTH;
  const cosCache = new Map();
  const cosFor = (oid) => {
    let c = cosCache.get(oid);
    if (c === undefined) { c = cosDeg(polFor(oid).creaseAngle); cosCache.set(oid, c); }
    return c;
  };

  // unify any coincident vertices Manifold kept separate, for adjacency
  const remap = new Uint32Array(nVert);
  for (let i = 0; i < nVert; i++) remap[i] = i;
  const mf = g.mergeFromVert, mt = g.mergeToVert;
  if (mf && mt) for (let i = 0; i < mf.length; i++) remap[mf[i]] = mt[i];

  // per-triangle original-surface id, from the run table
  const triOID = new Uint32Array(nTri);
  const ri = g.runIndex, roid = g.runOriginalID;
  for (let r = 0; r < roid.length; r++)
    for (let t = ri[r] / 3; t < ri[r + 1] / 3; t++) triOID[t] = roid[r];

  // per-triangle face normals
  const fn = new Float32Array(nTri * 3);
  for (let t = 0; t < nTri; t++) {
    const a = tris[t * 3] * np, b = tris[t * 3 + 1] * np, c = tris[t * 3 + 2] * np;
    const ux = vp[b] - vp[a], uy = vp[b + 1] - vp[a + 1], uz = vp[b + 2] - vp[a + 2];
    const vx = vp[c] - vp[a], vy = vp[c + 1] - vp[a + 1], vz = vp[c + 2] - vp[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    fn[t * 3] = nx / L; fn[t * 3 + 1] = ny / L; fn[t * 3 + 2] = nz / L;
  }

  // canonical vertex → incident triangles
  const incident = new Map();
  for (let t = 0; t < nTri; t++)
    for (let k = 0; k < 3; k++) {
      const cv = remap[tris[t * 3 + k]];
      const arr = incident.get(cv);
      if (arr) arr.push(t); else incident.set(cv, [t]);
    }

  const positions = new Float32Array(nTri * 9);
  const normals = new Float32Array(nTri * 9);
  for (let t = 0; t < nTri; t++) {
    const fx = fn[t * 3], fy = fn[t * 3 + 1], fz = fn[t * 3 + 2], oid = triOID[t];
    const sharpCos = cosFor(oid); // NEW: per-surface crease threshold
    for (let k = 0; k < 3; k++) {
      const v = tris[t * 3 + k];
      let nx = 0, ny = 0, nz = 0;
      for (const t2 of incident.get(remap[v])) {
        if (triOID[t2] !== oid) continue; // different cut surface → hard
        if (fn[t2 * 3] * fx + fn[t2 * 3 + 1] * fy + fn[t2 * 3 + 2] * fz < sharpCos) continue; // sharp same-surface edge → hard
        nx += fn[t2 * 3]; ny += fn[t2 * 3 + 1]; nz += fn[t2 * 3 + 2];
      }
      const L = Math.hypot(nx, ny, nz) || 1;
      const o = (t * 3 + k) * 3, vv = v * np;
      positions[o] = vp[vv]; positions[o + 1] = vp[vv + 1]; positions[o + 2] = vp[vv + 2];
      normals[o] = nx / L; normals[o + 1] = ny / L; normals[o + 2] = nz / L;
    }
  }

  // Feature edge segments for CAD-style edge lines: draw a line where the
  // surface actually BENDS. Same-surface edges draw per the surface's policy
  // (sharper than creaseAngle, and only if the policy wants same-surface lines
  // at all — intentional facets shade flat with no wireframe). Cut seams
  // (different original surface) draw when they bend more than COPLANAR_ANGLE;
  // coplanar seams get no line, and curved-surface facets are skipped.
  const edges = [];
  const seenEdge = new Map(); // edge key → first incident triangle
  for (let t = 0; t < nTri; t++)
    for (let e = 0; e < 3; e++) {
      const i = remap[tris[t * 3 + e]], j = remap[tris[t * 3 + ((e + 1) % 3)]];
      if (i === j) continue;
      const key = i < j ? i * nVert + j : j * nVert + i;
      const prev = seenEdge.get(key);
      if (prev === undefined) { seenEdge.set(key, t); continue; }
      seenEdge.delete(key);
      const dot = fn[prev * 3] * fn[t * 3] + fn[prev * 3 + 1] * fn[t * 3 + 1] + fn[prev * 3 + 2] * fn[t * 3 + 2];
      // NEW: policy-gated same-surface lines; seam rule unchanged
      const hard = triOID[prev] === triOID[t]
        ? polFor(triOID[t]).sameSurfaceLines && dot < cosFor(triOID[t])
        : dot < COPLANAR_COS;
      if (hard) {
        const ai = i * np, bj = j * np;
        const dx = vp[ai] - vp[bj], dy = vp[ai + 1] - vp[bj + 1], dz = vp[ai + 2] - vp[bj + 2];
        if (dx * dx + dy * dy + dz * dz >= MIN_EDGE2) // skip degenerate sliver segments (noise)
          edges.push(vp[ai], vp[ai + 1], vp[ai + 2], vp[bj], vp[bj + 1], vp[bj + 2]);
      }
    }

  // Per-triangle feature attribution: map each triangle's original-surface id
  // through the label registry. Same label string → same feature entry, so a
  // pattern of solids labeled alike reads as one feature.
  let featureIds = null, features = null;
  if (featureLabels?.size) {
    const indexOf = new Map(); // label string -> 1-based feature index
    features = [];
    featureIds = new Uint16Array(nTri);
    for (let t = 0; t < nTri; t++) {
      const label = featureLabels.get(triOID[t]);
      if (label === undefined) continue;
      let fi = indexOf.get(label);
      if (fi === undefined) { features.push(label); fi = features.length; indexOf.set(label, fi); }
      featureIds[t] = fi;
    }
    if (features.length === 0) { featureIds = features = null; } // labels exist in the kernel, none in THIS mesh
  }

  const out = { positions, normals, triangles: nTri, edges: Float32Array.from(edges) }; // mesh non-indexed
  if (featureIds) { out.featureIds = featureIds; out.features = features; }
  return out;
}
```

Note the seam-line rule: the old code's `dot < sharpCos || (diffOID && dot < COPLANAR_COS)` collapses to `dot < COPLANAR_COS` for different-OID pairs (cos 5° > cos 35°, so the second clause subsumes the first) — the rewrite above is behavior-identical for seams.

- [ ] **Step 4: Run the new tests**

Run: `npx vitest run test/creased-normals.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Rewire manifold-backend.js**

In `src/framework/geometry/manifold-backend.js`:

1. Delete the whole inlined `creasedNormals` function (lines 270–376, the block starting `// Build a non-indexed mesh with normals…` through its closing `}`).
2. Delete the now-unused constants at the top: the `SHARP_ANGLE`, `COPLANAR_COS`, and `MIN_EDGE2` lines (lines 19–21).
3. Add to the imports:

```js
import { creasedNormals } from "./creased-normals.js";
```

4. In `meshOut` (currently line 115-120), change the call:

```js
  function meshOut(m, asStl) {
    const g = m.getMesh();
    const r = asStl ? stlFromMesh(g) : creasedNormals(g, { featureLabels });
    g.delete?.();
    return r;
  }
```

(The `policies` map is wired in Task 3; passing only `featureLabels` keeps today's behavior — every OID defaults to `SMOOTH`.)

- [ ] **Step 6: Run the Manifold backend suite to prove the extraction is behavior-neutral**

Run: `npx vitest run test/manifold-backend.test.js test/loft-mesh.test.js test/feature-labels.test.js test/worker-layering.test.js`
Expected: PASS, no changes needed.

- [ ] **Step 7: Commit**

```bash
git add src/framework/geometry/creased-normals.js src/framework/geometry/manifold-backend.js test/creased-normals.test.js
git commit -m "Extract policy-aware creased-normals module from the Manifold backend"
```

---

### Task 3: Manifold loft policy registration + label propagation + `smooth` option

**Files:**
- Modify: `src/framework/geometry/manifold-backend.js` (loft op, `label()`, policy map)
- Modify: `src/framework/geometry/op-options.js:118-121` (`loftArgs`)
- Modify: `src/framework/geometry/kernel.js:109` (loft typedef)
- Test: `test/loft-shading.test.js`

**Interfaces:**
- Consumes: `creasedNormals(g, { policies, featureLabels })` from Task 2; `loftShadingPolicy(rings, opts)` from Task 1.
- Produces: part-facing `k.loft({ rings, ruled?, closed?, smooth? })`. Internally: `oidPolicies: Map<oid, policy>` living beside `featureLabels`, entries added on loft creation and removed on cache disposal; `label()` copies the source solid's policy to the re-stamped OID.

- [ ] **Step 1: Write the failing test**

Create `test/loft-shading.test.js`. Uses a 2-ring, 12-sided straight loft: facet-to-facet bend is exactly 30° — between FACETED's 10° (shades hard) and SMOOTH's 35° (shades smooth), so the two policies produce measurably different normals. The discriminator is per-triangle flatness: a wall triangle is "flat" when all three of its corner normals equal its own face normal. In this loft every wall vertex sits on a facet corner, so under smooth shading every corner is averaged (dot ≈ cos 15° ≈ 0.966 with the face normal) and NO wall triangle is flat; under faceted shading ALL of them are:

```js
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const RINGS = [{ sides: 12, radius: 20, z: 0 }, { sides: 12, radius: 20, z: 10 }];

// Classify wall triangles (face normal horizontal; caps are ±Z and skipped) as
// flat (all 3 corner normals ≈ the face normal) or smoothed. Non-indexed mesh:
// tri t occupies positions/normals [t*9, t*9+9).
function wallTris(m) {
  let flat = 0, total = 0;
  const P = m.positions, N = m.normals;
  for (let t = 0; t * 9 < P.length; t++) {
    const o = t * 9;
    const ux = P[o + 3] - P[o], uy = P[o + 4] - P[o + 1], uz = P[o + 5] - P[o + 2];
    const vx = P[o + 6] - P[o], vy = P[o + 7] - P[o + 1], vz = P[o + 8] - P[o + 2];
    let fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const L = Math.hypot(fx, fy, fz) || 1;
    fx /= L; fy /= L; fz /= L;
    if (Math.abs(fz) > 1e-3) continue; // cap or cap-fan triangle — not a wall
    total++;
    let allFlat = true;
    for (let c = 0; c < 3; c++) {
      const n = o + c * 3;
      if (N[n] * fx + N[n + 1] * fy + N[n + 2] * fz < 0.9999) allFlat = false;
    }
    if (allFlat) flat++;
  }
  return { flat, total };
}

test("12-sided loft defaults to faceted: every wall triangle flat, zero edge lines", () => {
  const m = k.loft({ rings: RINGS }).toMesh();
  const w = wallTris(m);
  expect(w.total).toBeGreaterThan(0);
  expect(w.flat).toBe(w.total);
  expect(m.edges.length).toBe(0); // no same-surface lines — not even the 90° cap rims
});

test("smooth:true overrides inference: corners averaged, cap-rim lines return", () => {
  const m = k.loft({ rings: RINGS, smooth: true }).toMesh();
  const w = wallTris(m);
  expect(w.total).toBeGreaterThan(0);
  expect(w.flat).toBe(0); // every wall vertex is a facet corner — all averaged at 30° < 35°
  expect(m.edges.length).toBeGreaterThan(0); // 90° cap rims draw under SMOOTH
});

test("high-side-count lofts infer smooth (cap-rim lines present without any hint)", () => {
  const many = [{ sides: 64, radius: 20, z: 0 }, { sides: 64, radius: 20, z: 10 }];
  expect(k.loft({ rings: many }).toMesh().edges.length).toBeGreaterThan(0);
});

test("label() preserves the loft's shading policy (the vase labels its walls)", () => {
  const m = k.loft({ rings: RINGS }).label("Faceted wall").toMesh();
  const w = wallTris(m);
  expect(w.total).toBeGreaterThan(0);
  expect(w.flat).toBe(w.total);
  expect(m.edges.length).toBe(0);
  expect(m.features).toEqual(["Faceted wall"]);
});

test("booleans keep per-surface policy: faceted loft cut by a box stays flat, seam draws", () => {
  const tool = k.box({ min: [0, -30, 5], max: [30, 30, 15] });
  const m = k.loft({ rings: RINGS }).cut(tool).toMesh();
  // Surviving loft walls stay flat; the tool's cut faces are planes (flat too);
  // seams between the two OIDs shade hard — so every wall-class triangle is flat.
  const w = wallTris(m);
  expect(w.total).toBeGreaterThan(0);
  expect(w.flat).toBe(w.total);
  expect(m.edges.length).toBeGreaterThan(0); // the cut seam draws lines
});

test("smooth is rejected on other ops (option list is per-op)", () => {
  expect(() => k.sphere({ r: 5, smooth: true })).toThrow(/unknown option/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/loft-shading.test.js`
Expected: FAIL — `loft: unknown option "smooth"` (op-options rejects it), and after that fix, the faceted assertions fail (with no policy every corner is averaged at 30° < 35°, so `flat` is 0 where the test expects `flat === total`).

- [ ] **Step 3: Accept `smooth` in op-options and the kernel typedef**

In `src/framework/geometry/op-options.js`, change `loftArgs` (line 118):

```js
export function loftArgs(o) {
  checkKeys("loft", o, ["rings", "ruled", "closed", "smooth"]);
  return [req("loft", o, "rings"), ...tail(o, ["ruled", "closed", "smooth"])];
}
```

In `src/framework/geometry/kernel.js`, update the loft typedef line (109) to include the option:

```js
 * @property {(o:{rings:{polygon?:number[][],sides?:number,radius?:number,z:number,rotate?:number,scale?:number|number[]}[],ruled?:boolean,closed?:boolean,smooth?:boolean}) => Solid} loft   stack polygon cross-sections; smooth overrides facet-vs-smooth shading inference; legacy (rings,opts) accepted until v2
```

- [ ] **Step 4: Register loft policy and propagate through label()**

In `src/framework/geometry/manifold-backend.js`:

1. Import the inference (extend the Task 2 import line):

```js
import { creasedNormals } from "./creased-normals.js";
import { loftShadingPolicy } from "./shading-policy.js";
```

2. Add the policy registry beside `featureLabels` (line 48):

```js
  const featureLabels = new Map(); // originalID -> label string (grows per label(); tiny)
  const oidPolicies = new Map();   // originalID -> shading policy (grows per faceted/hinted loft; tiny)
```

3. Pass it to the crease pass in `meshOut`:

```js
    const r = asStl ? stlFromMesh(g) : creasedNormals(g, { policies: oidPolicies, featureLabels });
```

4. Replace the `loft` op (currently `loft: (rings, opts = {}) => cached(h("loft", rings, opts), () => T(loftMesh(wasm, rings, opts))),`) with a direct `cache.lookup` so disposal can unregister the policy — the same pattern `label()` uses. `asOriginal()` stamps a stable originalID to key the policy by:

```js
    // Ring loft: hand-meshed via the shared ring-mesh helpers (helix-tube recipe).
    // Cached atomically; the hash folds every ring's points/z/rotate/scale and the
    // opts (including `smooth`, so toggling the hint is a fresh cache node).
    // asOriginal() stamps a stable originalID; the shading policy (inferred from
    // the rings, or forced by `smooth`) registers under it for the crease pass
    // and lives exactly as long as the cache pins the solid.
    loft: (rings, opts = {}) => {
      const key = h("loft", rings, opts);
      return cache.lookup(key, () => {
        const raw = T(loftMesh(wasm, rings, opts));
        const m = T(raw.asOriginal());
        const id = m.originalID();
        oidPolicies.set(id, loftShadingPolicy(rings, opts));
        return { value: wrap(m, key), pin: m, dispose: () => { oidPolicies.delete(id); m.delete?.(); } };
      });
    },
```

5. In `label()` (line 153-161), propagate the policy across the OID re-stamp and clean it up on disposal:

```js
    label: (name) => {
      const lh = h("label", hash, name);
      return cache.lookup(lh, () => {
        const prevId = typeof m.originalID === "function" ? m.originalID() : -1;
        const o = T(m.asOriginal());
        const id = o.originalID();
        featureLabels.set(id, name);
        // labeling re-stamps the originalID — carry the surface's shading policy along
        if (prevId !== -1 && oidPolicies.has(prevId)) oidPolicies.set(id, oidPolicies.get(prevId));
        return { value: wrap(o, lh), pin: o, dispose: () => { featureLabels.delete(id); oidPolicies.delete(id); o.delete?.(); } };
      });
    },
```

- [ ] **Step 5: Run the new tests**

Run: `npx vitest run test/loft-shading.test.js`
Expected: PASS (6 tests).

- [ ] **Step 6: Run the wider Manifold + lint + contract suites for regressions**

Run: `npx vitest run test/manifold-backend.test.js test/loft-mesh.test.js test/feature-labels.test.js test/kernel-contract.test.js test/calling-convention.test.js test/op-options.test.js test/lint-parts.test.js`
Expected: PASS. If `kernel-contract.test.js` flags the typedef change, follow its failure message — it holds the doc's op tables to `kernel.js`; the doc row is updated in Task 8, so a doc-sync assertion failing here means do that doc row edit now instead.

- [ ] **Step 7: Commit**

```bash
git add src/framework/geometry/manifold-backend.js src/framework/geometry/op-options.js src/framework/geometry/kernel.js test/loft-shading.test.js
git commit -m "Register per-surface shading policy for lofts; add loft smooth hint"
```

---

### Task 4: `rotateNormals` in pose.js

**Files:**
- Modify: `src/framework/geometry/pose.js`
- Test: `test/pose.test.js` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `rotateNormals(normals: Float32Array, m: number[16]): void` — in-place, rotation block only. Task 6 imports it from `./pose.js`.

- [ ] **Step 1: Write the failing test**

Append to `test/pose.test.js`:

```js
import { composePose, rotateNormals } from "../src/framework/geometry/pose.js";

test("rotateNormals applies the rotation block and ignores translation", () => {
  const m = composePose([
    { t: "rotate", deg: 90, center: [5, 5, 5], axis: [0, 0, 1] }, // off-origin center: translation parts must not leak
    { t: "translate", v: [100, -3, 7] },
  ]);
  const n = Float32Array.from([1, 0, 0, 0, 0, 1]);
  rotateNormals(n, m);
  expect(n[0]).toBeCloseTo(0, 6); // +X → +Y under 90° about Z
  expect(n[1]).toBeCloseTo(1, 6);
  expect(n[2]).toBeCloseTo(0, 6);
  expect([n[3], n[4], n[5]]).toEqual([0, 0, 1]); // +Z unchanged by a Z rotation, untouched by translation
});
```

(Adapt the import line to the file's existing imports — it already imports `composePose`; add `rotateNormals` to that list rather than duplicating the import.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pose.test.js`
Expected: FAIL — `rotateNormals` is not exported.

- [ ] **Step 3: Implement**

Append to `src/framework/geometry/pose.js`:

```js
// Apply ONLY the rotation block of a rigid mat4 to interleaved xyz normals, in
// place. composePose matrices are rigid (orthonormal 3x3 block), so normals
// transform by the same block — no inverse-transpose — and stay unit length.
// Translation columns are deliberately ignored: normals are directions.
export function rotateNormals(normals, m) {
  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i], y = normals[i + 1], z = normals[i + 2];
    normals[i] = m[0] * x + m[4] * y + m[8] * z;
    normals[i + 1] = m[1] * x + m[5] * y + m[9] * z;
    normals[i + 2] = m[2] * x + m[6] * y + m[10] * z;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pose.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/pose.js test/pose.test.js
git commit -m "Add rotateNormals: rotation-only rigid-pose application for normals"
```

---

### Task 5: `brep-edges.js` — tangent-edge filter for OCCT

**Files:**
- Create: `src/framework/geometry/brep-edges.js`
- Test: `test/brep-edges.test.js`

**Interfaces:**
- Consumes: `TANGENT_ANGLE`, `MIN_EDGE`, `cosDeg` from Task 1.
- Produces: `filterBrepEdges(mesh, meshEdges): Float32Array` — `mesh` is replicad `ShapeMesh` (`{vertices, normals, triangles, faceGroups}`), `meshEdges` is replicad's `{lines, edgeGroups}`. Returns flat segment pairs (6 floats per segment) ready for the viewer's `LineSegmentsGeometry.setPositions`. Task 6 calls it inside `baseMesh`.

**Background an implementer needs (verified against replicad 's source):**
- `mesh().vertices` are concatenated per B-rep face — boundary points are DUPLICATED, one copy per adjacent face, each carrying that face's analytic normal. Edge polyline nodes come from the same face triangulation (`BRep_Tool.PolygonOnTriangulation`), so an edge point's coordinates are bit-identical to face-vertex coordinates → an exact-position string key connects an edge point to every adjacent face's normal.
- `meshEdges().lines` is ALREADY flat segment pairs: for polyline points p0…pn it stores (p0,p1),(p1,p2),… Each `edgeGroups[i] = {start, count, edgeId}` spans one B-rep edge; `start`/`count` are in points (3 floats each), `count = 2 × segments`.
- Interior points of a group (indices 1…count−2) sit on exactly the edge's two adjacent faces. The group's first/last points are edge ENDPOINTS — corners touching third faces whose normals would falsely read "sharp" — so sample interior points when the group has more than one segment.

- [ ] **Step 1: Write the failing test**

Create `test/brep-edges.test.js`:

```js
import { expect, test } from "vitest";
import { filterBrepEdges } from "../src/framework/geometry/brep-edges.js";

// Minimal replicad-shaped fixtures: `mesh` supplies position→normal evidence
// (vertices duplicated per face, as replicad emits them); `meshEdges` supplies
// the candidate segments. Triangles/faceGroups are irrelevant to the filter.
const mesh = (verts, norms) => ({ vertices: verts.flat(), normals: norms.flat(), triangles: [], faceGroups: [] });
const seg = (a, b) => [...a, ...b];

const A = [0, 0, 0], B = [10, 0, 0]; // the shared edge under test

test("edge between faces at 90° is kept as one segment", () => {
  const m = mesh([A, B, A, B], [[0, 0, 1], [0, 0, 1], [0, -1, 0], [0, -1, 0]]); // +Z face copy, −Y face copy
  const e = { lines: seg(A, B), edgeGroups: [{ start: 0, count: 2, edgeId: 1 }] };
  expect(Array.from(filterBrepEdges(m, e))).toEqual([...A, ...B]);
});

test("edge between coplanar/tangent faces is dropped", () => {
  const m = mesh([A, B, A, B], [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]]);
  const e = { lines: seg(A, B), edgeGroups: [{ start: 0, count: 2, edgeId: 1 }] };
  expect(filterBrepEdges(m, e).length).toBe(0);
});

test("multi-segment edge: sharp corner endpoints do not overrule tangent interior points", () => {
  const P1 = [3, 0, 0], P2 = [6, 0, 0];
  // interior junctions P1,P2 see only agreeing +Z normals (tangent); endpoints A,B
  // also touch a perpendicular face — which must be ignored for count>2 groups
  const m = mesh(
    [A, P1, P2, B, A, P1, P2, B, A, B],
    [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1], [1, 0, 0], [1, 0, 0]],
  );
  const e = { lines: [...seg(A, P1), ...seg(P1, P2), ...seg(P2, B)], edgeGroups: [{ start: 0, count: 6, edgeId: 1 }] };
  expect(filterBrepEdges(m, e).length).toBe(0);
});

test("edge with no normal evidence is kept (fail visible, not invisible)", () => {
  const m = mesh([], []);
  const e = { lines: seg(A, B), edgeGroups: [{ start: 0, count: 2, edgeId: 1 }] };
  expect(filterBrepEdges(m, e).length).toBe(6);
});

test("sub-MIN_EDGE segments are dropped even on kept edges (degenerate pole edges)", () => {
  const C = [0.005, 0, 0]; // 0.005mm from A — below the 0.01mm floor
  const m = mesh([A, C, A, C], [[0, 0, 1], [0, 0, 1], [0, -1, 0], [0, -1, 0]]);
  const e = { lines: seg(A, C), edgeGroups: [{ start: 0, count: 2, edgeId: 1 }] };
  expect(filterBrepEdges(m, e).length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/brep-edges.test.js`
Expected: FAIL — cannot resolve `../src/framework/geometry/brep-edges.js`.

- [ ] **Step 3: Implement**

Create `src/framework/geometry/brep-edges.js`:

```js
// Filter replicad meshEdges() down to genuinely sharp feature edges using the
// analytic per-vertex normals from mesh(). A B-rep edge whose adjacent faces
// meet tangentially (fillet blend boundaries, closed-surface seam lines) is
// not a visual feature — drop it, so a sphere or fillet never draws phantom
// lines. Plain arrays in, plain arrays out; no OCCT required (unit-testable).
//
// Format facts this relies on (replicad):
// - mesh() vertices are concatenated per face: boundary points are duplicated,
//   one copy per adjacent face, each carrying that face's analytic normal, and
//   edge polyline nodes reuse the exact face-triangulation coordinates — so an
//   exact-position key connects an edge point to every adjacent face normal.
// - meshEdges().lines is already flat segment PAIRS ((p0,p1),(p1,p2),…);
//   edgeGroups {start,count} span one B-rep edge, in points (count = 2·segs).
import { TANGENT_ANGLE, MIN_EDGE, cosDeg } from "./shading-policy.js";

const TANGENT_COS = cosDeg(TANGENT_ANGLE);
const MIN_EDGE2 = MIN_EDGE * MIN_EDGE;

export function filterBrepEdges(mesh, meshEdges) {
  const { vertices, normals } = mesh;
  const { lines, edgeGroups } = meshEdges;

  // exact-position key → the normals of every face copy of that vertex
  const byPos = new Map();
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    const key = `${vertices[i]},${vertices[i + 1]},${vertices[i + 2]}`;
    let arr = byPos.get(key);
    if (!arr) byPos.set(key, arr = []);
    arr.push([normals[i], normals[i + 1], normals[i + 2]]);
  }

  const out = [];
  for (const g of edgeGroups) {
    if (g.count < 2) continue;
    // Sharp iff any sampled point sees two adjacent-face normals disagreeing
    // past TANGENT_COS. Group endpoints are edge ENDPOINTS — corners touching
    // third faces that would falsely read sharp — so sample interior points
    // when the group has them (count > 2). A point with fewer than two known
    // normals is inconclusive; an edge with no conclusive point is KEPT: a
    // spurious line is visible and debuggable, a missing feature edge is not.
    const p0 = g.count > 2 ? 1 : 0, p1 = g.count > 2 ? g.count - 2 : g.count - 1;
    let sharp = false, conclusive = false;
    for (let p = p0; p <= p1 && !sharp; p++) {
      const o = (g.start + p) * 3;
      const ns = byPos.get(`${lines[o]},${lines[o + 1]},${lines[o + 2]}`);
      if (!ns || ns.length < 2) continue;
      conclusive = true;
      for (let a = 0; a < ns.length && !sharp; a++)
        for (let b = a + 1; b < ns.length; b++) {
          const dot = ns[a][0] * ns[b][0] + ns[a][1] * ns[b][1] + ns[a][2] * ns[b][2];
          if (dot < TANGENT_COS) { sharp = true; break; }
        }
    }
    if (conclusive && !sharp) continue; // tangent edge — not a visual feature

    for (let p = 0; p + 1 < g.count; p += 2) { // lines is segment pairs — step 2 points
      const a = (g.start + p) * 3, b = (g.start + p + 1) * 3;
      const dx = lines[a] - lines[b], dy = lines[a + 1] - lines[b + 1], dz = lines[a + 2] - lines[b + 2];
      if (dx * dx + dy * dy + dz * dz < MIN_EDGE2) continue; // degenerate sliver / pole edge
      out.push(lines[a], lines[a + 1], lines[a + 2], lines[b], lines[b + 1], lines[b + 2]);
    }
  }
  return Float32Array.from(out);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/brep-edges.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/brep-edges.js test/brep-edges.test.js
git commit -m "Add brep-edges: tangent-filtered B-rep feature edges for OCCT meshes"
```

---

### Task 6: OCCT backend — analytic normals, B-rep edges, finer preview mesh

**Files:**
- Modify: `src/framework/geometry/occt-backend.js` (`MESH` line 34, `baseMesh` line 86-102, `posedPositions` block ~line 104-108, `toMesh` line 178-188)
- Test: `test/occt-shading.test.js` (new; OCCT boots alone in this file)

**Interfaces:**
- Consumes: `filterBrepEdges(mesh, meshEdges)` from Task 5; `rotateNormals(normals, m)` from Task 4.
- Produces: OCCT `toMesh({quality})` now returns `{ positions, normals, edges, indices, triangles, featureIds?, features? }` — `normals` non-empty analytic per-vertex normals, `edges` flat segment pairs (possibly empty `Float32Array`, which MEANS "no feature edges", not "unknown"). Task 7 relies on that distinction.

- [ ] **Step 1: Write the failing test**

Create `test/occt-shading.test.js`:

```js
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

test("sphere: analytic radial normals everywhere and ZERO edge segments", () => {
  const m = k.sphere({ r: 10 }).toMesh();
  expect(m.normals.length).toBe(m.positions.length);
  for (let i = 0; i < m.positions.length; i += 3) {
    const L = Math.hypot(m.positions[i], m.positions[i + 1], m.positions[i + 2]) || 1;
    const dot = (m.positions[i] * m.normals[i] + m.positions[i + 1] * m.normals[i + 1] + m.positions[i + 2] * m.normals[i + 2]) / L;
    expect(dot).toBeGreaterThan(0.999); // normal ∥ radius — smooth by construction
  }
  expect(m.edges.length).toBe(0); // seam meridian + pole edges all filtered
});

test("box: exactly 12 sharp edges, one straight segment each", () => {
  const m = k.box({ min: [0, 0, 0], max: [10, 10, 10] }).toMesh();
  expect(m.edges.length).toBe(12 * 6);
});

test("internal spherical void adds no edge lines (phantom-sphere-edge regression)", () => {
  const solid = k.box({ min: [0, 0, 0], max: [20, 20, 20] })
    .cut(k.sphere({ r: 5 }).translate([10, 10, 10]));
  expect(solid.toMesh().edges.length).toBe(12 * 6); // the void's sphere face contributes nothing
});

test("fillet blend boundaries draw no lines; chamfer boundaries do", () => {
  const f = k.box({ min: [0, 0, 0], max: [20, 20, 20] }).fillet({ r: 3, edges: { dir: "Z" } }).toMesh();
  const c = k.box({ min: [0, 0, 0], max: [20, 20, 20] }).chamfer({ d: 3, edges: { dir: "Z" } }).toMesh();
  expect(f.edges.length).toBeGreaterThan(0);          // the unfilleted horizontal edges remain
  expect(c.edges.length).toBeGreaterThan(f.edges.length); // chamfer keeps 2 sharp boundaries per edge
});

test("posed toMesh rotates normals with the solid", () => {
  const m = k.box({ min: [0, 0, 0], max: [10, 10, 10] }).rotate(45, [0, 0, 0], [0, 0, 1]).toMesh();
  let diagonal = false;
  for (let i = 0; i < m.normals.length; i += 3) {
    expect(Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2])).toBeCloseTo(1, 3);
    if (Math.abs(Math.abs(m.normals[i]) - Math.SQRT1_2) < 1e-3 &&
        Math.abs(Math.abs(m.normals[i + 1]) - Math.SQRT1_2) < 1e-3) diagonal = true;
  }
  expect(diagonal).toBe(true); // side normals sit at 45° — unrotated normals would stay axis-aligned
});

test("posed toMesh transforms edge segments like positions", () => {
  const m = k.box({ min: [0, 0, 0], max: [10, 10, 10] }).translate([100, 0, 0]).toMesh();
  expect(m.edges.length).toBe(12 * 6);
  for (let i = 0; i < m.edges.length; i += 3) expect(m.edges[i]).toBeGreaterThanOrEqual(100);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/occt-shading.test.js`
Expected: FAIL — `m.normals.length` is 0 and `m.edges` is undefined.

- [ ] **Step 3: Implement in occt-backend.js**

1. Extend the pose import (line 32) and add the filter import:

```js
import { composePose, transformPositions, rotateNormals } from "./pose.js";
import { filterBrepEdges } from "./brep-edges.js";
```

2. Finer preview tessellation (line 34) — shading no longer hides silhouette density:

```js
const MESH = { preview: { tolerance: 0.1, angularTolerance: 0.25 }, print: { tolerance: 0.01, angularTolerance: 0.1 } };
```

3. In `baseMesh` (line 86), keep the analytic normals and compute filtered B-rep edges (both cached pose-free, per quality, like positions):

```js
    const baseMesh = (quality) => cached(h("mesh", baseHash, quality), () => {
      const m = shape.mesh(MESH[quality]);
      const out = {
        positions: Float32Array.from(m.vertices),
        normals: Float32Array.from(m.normals),   // analytic per-face-vertex normals — smooth by construction
        edges: filterBrepEdges(m, shape.meshEdges(MESH[quality])), // true B-rep edges, tangent-filtered
        indices: Uint32Array.from(m.triangles),
        triangles: m.triangles.length / 3,
      };
      if (labels.length) {
        const soups = labels.map((l) => {
          const lm = l.snapshot.clone().mesh(MESH.preview); // clone: mesh() must not disturb the kept snapshot
          return { label: l.label, vertices: lm.vertices, triangles: lm.triangles };
        });
        Object.assign(out, classifyFaceGroups(m, soups));
      }
      return out;
    });
```

4. Beside `posedPositions` (~line 104), add the posed copies (fresh arrays — jobs.js transfers and detaches the buffers, so the cache must never hand out its own):

```js
    const posedNormals = (base) => {
      const normals = Float32Array.from(base.normals);
      if (pose.length) rotateNormals(normals, composePose(pose)); // rotation only — normals are directions
      return normals;
    };
    const posedEdges = (base) => {
      const edges = Float32Array.from(base.edges);
      if (pose.length) transformPositions(edges, composePose(pose)); // segment endpoints pose like positions
      return edges;
    };
```

5. In `toMesh` (line 178), replace the empty-normals placeholder:

```js
      toMesh: ({ quality = "preview" } = {}) => {
        const base = baseMesh(quality);
        const out = {
          positions: posedPositions(base),
          normals: posedNormals(base), // analytic — the viewer must NOT re-crease these
          edges: posedEdges(base),     // empty array = "no feature edges", not "unknown"
          indices: Uint32Array.from(base.indices),
          triangles: base.triangles,
        };
        if (base.featureIds) { out.featureIds = Uint16Array.from(base.featureIds); out.features = base.features; }
        return out;
      },
```

- [ ] **Step 4: Run the new tests**

Run: `npx vitest run test/occt-shading.test.js`
Expected: PASS (6 tests). If the sphere edge-count assertion fails with a few surviving segments, the culprit is the seam/pole handling in `filterBrepEdges` — debug there (the module is pure; reproduce with the failing edge group's data in `test/brep-edges.test.js`), not by loosening the assertion.

- [ ] **Step 5: Run the OCCT regression files**

Run: `npx vitest run test/occt-backend.test.js test/occt-fillet.test.js test/occt-cache.test.js test/render-occt.test.js test/export-occt.test.js test/measure-occt.test.js test/feature-labels-occt.test.js`
Expected: PASS. Candidates that could have baked in the old behavior: anything asserting `normals.length === 0`, or byte-exact render PNG expectations. Fix such assertions to the new truth (normals present; renders now shaded smooth) — do not revert the backend.

- [ ] **Step 6: Commit**

```bash
git add src/framework/geometry/occt-backend.js test/occt-shading.test.js
git commit -m "OCCT toMesh ships analytic normals and tangent-filtered B-rep edges"
```

---

### Task 7: Viewer — kernel edge data is authoritative even when empty

**Files:**
- Modify: `src/framework/viewer.js` (`buildGeometry`, lines 258-281, and the `CREASE_ANGLE`/`EDGE_ANGLE` comments at 169 and 249-253)

**Interfaces:**
- Consumes: mesh payloads whose `edges` may be a present-but-empty `Float32Array` (Task 6 semantics).
- Produces: no API change; `buildGeometry` behavior only.

- [ ] **Step 1: Make the edge branch distinguish "empty" from "absent"**

In `buildGeometry`, replace the edge-lines block (lines 276-280):

```js
    // feature edge lines: kernel-supplied segments are authoritative — an EMPTY
    // array means "this solid has no feature edges" (e.g. a lone sphere), so
    // draw none rather than falling back. Only a payload with NO edge data at
    // all (edges === undefined; no current backend does this) derives by angle.
    const lg = new LineSegmentsGeometry();
    if (edges) { if (edges.length) lg.setPositions(edges); }
    else lg.fromEdgesGeometry(new THREE.EdgesGeometry(out, EDGE_ANGLE));
    out.userData.edges = lg;
```

- [ ] **Step 2: Update the stale comments**

Line 168-169 currently says OCCT falls back to the angle threshold — replace with:

```js
  // CAD-style feature edge lines (anti-aliased "fat" lines), one per sub-part.
  const EDGE_ANGLE = 35; // deg — last-ditch threshold for payloads with no kernel edge data
```

Lines 249-253 (`CREASE_ANGLE` comment) — replace the paragraph with:

```js
  // Fallback creasing for payloads with no kernel normals. Both backends now
  // ship authoritative normals (Manifold: policy-aware crease pass; OCCT:
  // analytic B-rep normals), so this path is last-ditch only — it must not be
  // "improved" in lieu of fixing a backend that stopped sending normals.
  const CREASE_ANGLE = Math.PI / 6; // 30°
```

Also update the comment INSIDE `buildGeometry` at line 265 from `// kernel-computed normals (Manifold) — …` to:

```js
      // kernel-computed normals (both backends) — smooth within a surface, hard at cut seams
```

- [ ] **Step 3: Run the framework/viewer-adjacent tests**

Run: `npx vitest run test/viewer-capture.test.js test/selection-raycast.test.js test/inspect-job.test.js test/geometry-service.test.js`
Expected: PASS.

- [ ] **Step 4: Run the headless smoke check (real Chromium; needs Playwright installed)**

```bash
npm run check
```

Expected: all four apps (demo, planter, filleted-box, text-smoke) boot and render without console errors. If Playwright's Chromium is missing: `npm i -D playwright && npx playwright install chromium`.

- [ ] **Step 5: Commit**

```bash
git add src/framework/viewer.js
git commit -m "Viewer: treat kernel edge segments as authoritative, even when empty"
```

---

### Task 8: Docs, contract, error patterns, version bump

**Files:**
- Modify: `docs/KERNEL-CONTRACT.md`, `docs/AUTHORING-PARTS.md`, `docs/ERROR-PATTERNS.md`, `package.json`

**Interfaces:**
- Consumes: everything shipped in Tasks 1-7.
- Produces: documentation only. CONTRACT_VERSION stays 1 — `smooth` is an additive optional option and the new `toMesh` fields are additive; no breaking change.

- [ ] **Step 1: KERNEL-CONTRACT.md — toMesh shading semantics + loft smooth**

Find the section documenting `toMesh` semantics and add (adjusting heading level to match neighbors):

```markdown
### Shading intent (toMesh normals and edges)

`toMesh` output is the authoritative statement of how a solid SHADES and which
edges are FEATURE edges — consumers (viewer, CLI renderer) must draw what they
are given and must not re-derive either from dihedral angles when the fields
are present:

- `normals` — per-vertex shading normals. Smooth within one surface, hard
  across boolean-cut seams. OCCT ships analytic B-rep normals; Manifold ships
  the policy-aware crease pass (`src/framework/geometry/creased-normals.js`).
- `edges` — flat feature-edge segment pairs (6 floats per segment). An EMPTY
  array means "this solid has no feature edges"; it is not "unknown". OCCT
  ships true B-rep edges with tangent edges (fillet blends, seam lines)
  filtered out; Manifold ships policy-gated sharp/seam segments.

`loft` accepts `smooth?: boolean` to override facet-vs-smooth inference: by
default, rings with fewer than 32 sides shade as intentional flat facets with
no same-surface edge lines, while rings with 32+ sides (and `ruled: false`
lofts) shade smooth. `smooth: true` forces smooth shading; `smooth: false`
forces facets. Thresholds live in `src/framework/geometry/shading-policy.js`.

Known limitation: the OCCT backend ignores `smooth` — a loft forced to OCCT
via `meta.backend` draws its facet corner edges as B-rep feature lines. The
hint is honored on the Manifold path, which is where lofts preview by default.
```

- [ ] **Step 2: AUTHORING-PARTS.md — loft option + authoring note**

On the `loft` documentation row, add `smooth?: boolean` to the options with the one-line description: *"override facet/smooth shading inference (default: <32-side rings shade as flat facets, no facet edge lines; ≥32 sides shade smooth)"*. Then add a short paragraph to the section on how parts preview (near the backend-selection or viewer notes):

```markdown
**Shading intent.** The kernel decides what shades smooth and where edge lines
draw — spheres, cylinders and fillets are smooth by construction; boolean cut
seams always shade hard and draw a line; a loft's facets shade flat when its
rings have fewer than 32 sides (`smooth: true|false` on `k.loft` overrides the
inference either way). If your part previews smooth but would print faceted —
or the reverse — set the hint rather than changing facet counts.
```

- [ ] **Step 3: ERROR-PATTERNS.md — two new patterns**

Append under the core namespace, following the entry shape exactly (three list lines, then optional notes):

```markdown
## phantom-edges-on-curved-surface

- **Symptom:** edge lines or hard-shaded patches appear scattered on a smooth
  curved surface (a sphere, fillet, or blend) in the viewer or in `render` PNGs.
- **Cause:** the mesh reached the viewer without kernel `normals`/`edges`, so a
  consumer fell back to dihedral-angle guessing on coarse preview tessellation.
- **Fix:** the backend's `toMesh` must return analytic normals and filtered
  feature edges ([KERNEL-CONTRACT.md](KERNEL-CONTRACT.md) "Shading intent") —
  fix the backend or payload plumbing; do not tune viewer angle thresholds.

## faceted-loft-previews-smooth

- **Symptom:** an intentionally faceted loft (low-side-count rings) previews
  smooth-shaded, but exports/prints show flat facets.
- **Cause:** the loft's shading policy resolved to smooth — a `smooth: true`
  hint, `ruled: false`, or rings with 32+ sides.
- **Fix:** pass `smooth: false` to `k.loft` (or drop the smooth-implying
  option) per [AUTHORING-PARTS.md](AUTHORING-PARTS.md) shading-intent note.
```

- [ ] **Step 4: Version bump**

In `package.json` line 3: `"version": "0.44.0"` → `"version": "0.45.0"`.

- [ ] **Step 5: Run the doc-holding tests**

Run: `npx vitest run test/kernel-contract.test.js test/error-patterns.test.js test/lint-registry.test.js`
Expected: PASS — the contract test parses the doc's op tables and version header; the error-patterns test parses every `##` entry's shape.

- [ ] **Step 6: Commit**

```bash
git add docs/KERNEL-CONTRACT.md docs/AUTHORING-PARTS.md docs/ERROR-PATTERNS.md package.json
git commit -m "Document shading-intent contract, loft smooth hint, and error patterns; bump to 0.45.0"
```

---

### Task 9: Full verification — suite, smoke, and visual acceptance

**Files:**
- No new files (fixes only if regressions surface). Renders land in `render/` (gitignored).

**Interfaces:**
- Consumes: the complete feature.
- Produces: the acceptance evidence from the spec's criteria.

- [ ] **Step 1: Full test suite**

```bash
npm test
```

Expected: PASS. For any failure, grep `docs/ERROR-PATTERNS.md` for the symptom first; likely suspects are tests that baked in pre-policy shading (Manifold edge counts, OCCT empty normals). Fix assertions to the new contract; never weaken the new tests from Tasks 1-8.

- [ ] **Step 2: Headless smoke check**

```bash
npm run check
```

Expected: all four CI apps boot clean.

- [ ] **Step 3: Visual acceptance renders**

```bash
npx partforge render src/parts/faceted-vase.js
npx partforge render src/parts/filleted-box.js
```

Then Read the PNGs in `render/` and verify with your own eyes:
- faceted-vase: facets read as distinct flat planes (visible shading contrast between neighbors), NO spiral wireframe of facet-crease lines, rim/seam lines still present where the cavity cut meets the wall.
- filleted-box: no phantom lines or shading patches on filleted regions; chamfer boundaries and sharp edges still draw lines.

If either fails the eyeball check, the bug is upstream in Tasks 2-6 — reproduce it as a unit test in the relevant pure-module test file before fixing.

- [ ] **Step 4: Commit any regression fixes**

```bash
git add -A
git commit -m "Fix regressions surfaced by full-suite and visual verification"
```

(Skip if nothing changed.)

- [ ] **Step 5: Done — hand off per branch flow**

Implementation complete on branch `claude/edge-rendering-smooth-shading-f6092a`. Follow `superpowers:finishing-a-development-branch` (PR to `main`; the version bump is already on the branch per the release flow — tag `v0.45.0` only after merge).
