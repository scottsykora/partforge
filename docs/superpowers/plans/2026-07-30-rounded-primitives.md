# Rounded 3-D Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `roundedBox`, `roundedCylinder`, and `torus` kernel ops (selective edge rounding, both backends, no OCCT routing) per `docs/superpowers/specs/2026-07-30-rounded-primitives-design.md`.

**Architecture:** `roundedCylinder`/`torus` are shared kernel-front default compositions — one `revolve` of an arc-exact lathe contour (curve-exact on OCCT, mesh-LOD on Manifold). `roundedBox` is native per backend: Manifold hand-meshes a ring stack of analytically-inset rounded-rect cross-sections (reusing `loftMesh`), OCCT extrudes an arc-exact rounded rect + rim fillets (`side > 0`) or cuts quarter-cylinder wedges (`side = 0`). Argument normalization, validation, and the clamp-with-warning rule live in `op-options.js` so both backends see identical values.

**Tech Stack:** plain ESM, vitest, manifold-3d WASM, replicad (OCCT WASM).

## Global Constraints

- **Node 24 required**: run `nvm use` before any install/test/CLI, or geometry tests fail confusingly (AGENTS.md).
- **This repo's worktree has no `node_modules`**: run `npm install` once before the first test run.
- OCCT and Manifold must never boot in one process — OCCT tests live in their own files, booted via `bootOcctKernel()`.
- `build`-facing code must be pure and DOM-free; units mm; angles degrees; Z-up; primitives build from z=0.
- The contract tests assert each backend exposes **exactly** `KERNEL_OPS` (+optional) — an op may only be added to `KERNEL_OPS` in the same commit that gives BOTH backends the op AND names it in `docs/KERNEL-CONTRACT.md` (the doc-naming test).
- Clamp warning text (exact, from the spec): `roundedBox: round.<key> <val> clamped to round.side <side> (side must be 0 or ≥ rim radii; use side: 0 for a rim-only round-over)`.
- Options-only ops (no positional form), like `boredCylinder`.
- Normative cross-section formula (spec §Semantics): at height `z`, the roundedBox section is the rounded rect inset by `δ(z)` with corner radius `max(side − δ(z), 0)`, where `δ` traces a quarter circle in each rim zone (`δ = R(1 − sin φ)`, `z = R(1 − cos φ)` from the face) and 0 in the straight zone.

---

### Task 1: Pure geometry builders (`rounded-solids.js`)

**Files:**
- Create: `src/framework/geometry/rounded-solids.js`
- Test: `test/rounded-solids.test.js`

**Interfaces:**
- Produces: `latheRoundedRect(r, h, rTop, rBottom) → ArcContour`, `torusContour(rMajor, rMinor) → ArcContour`, `roundedRectRing(hw, hd, rc, A) → [[x,y],…]`, `roundedBoxRings([w,d,h], {side,top,bottom}, segs) → [{polygon, z},…]` (loft ring specs), `EPS_R`.
- Consumes: nothing (pure; ArcContour = `{ start:[x,y], segments:[{to}|{to,via}] }` per `profile.js`).

- [ ] **Step 1: Write the failing tests**

```js
// test/rounded-solids.test.js
import { expect, test } from "vitest";
import {
  latheRoundedRect, torusContour, roundedRectRing, roundedBoxRings, EPS_R,
} from "../src/framework/geometry/rounded-solids.js";

const SQ = Math.SQRT1_2;

test("latheRoundedRect rounds the two outer corners with exact tangents", () => {
  const c = latheRoundedRect(8, 20, 3, 1.5);
  expect(c.start).toEqual([0, 0]);
  expect(c.segments).toEqual([
    { to: [6.5, 0] },
    { to: [8, 1.5], via: [8 - 1.5 * (1 - SQ), 1.5 * (1 - SQ)] },
    { to: [8, 17] },
    { to: [5, 20], via: [8 - 3 * (1 - SQ), 20 - 3 * (1 - SQ)] },
    { to: [0, 20] },
  ]);
});

test("latheRoundedRect capsule: full-radius corners keep their FULL radius (no roundedProfile-style clamp)", () => {
  const c = latheRoundedRect(5, 10, 5, 5);
  // bottom edge is fully consumed: no zero-length lineTo, arc starts at [0,0].
  // Vias written with the implementation's own expression form (r − R(1−cos45))
  // so the comparison is bit-exact.
  expect(c.segments).toEqual([
    { to: [5, 5], via: [5 - 5 * (1 - SQ), 5 * (1 - SQ)] },
    { to: [0, 10], via: [5 - 5 * (1 - SQ), 10 - 5 * (1 - SQ)] },
  ]);
});

test("latheRoundedRect with round 0 is the plain rectangle", () => {
  expect(latheRoundedRect(6, 9, 0, 0).segments).toEqual([
    { to: [6, 0] }, { to: [6, 9] }, { to: [0, 9] },
  ]);
});

test("torusContour is four quarter arcs closing exactly on its start", () => {
  const c = torusContour(10, 3);
  expect(c.start).toEqual([13, 0]);
  expect(c.segments).toHaveLength(4);
  for (const s of c.segments) expect(s.via).toBeDefined();
  expect(c.segments[3].to).toEqual(c.start);
  // each via sits on the tube circle
  for (const s of c.segments)
    expect(Math.hypot(s.via[0] - 10, s.via[1])).toBeCloseTo(3, 12);
});

test("roundedRectRing: 4·(A+1) CCW points, corner centers at ±(hw−rc), ±(hd−rc)", () => {
  const A = 4;
  const ring = roundedRectRing(10, 7, 2, A);
  expect(ring).toHaveLength(4 * (A + 1));
  expect(ring[0]).toEqual([10, 5]);          // corner (+,+) arc starts at angle 0
  expect(ring[A][0]).toBeCloseTo(8, 12);     // ends at angle 90: (hw−rc, hd)
  expect(ring[A][1]).toBeCloseTo(7, 12);
  // CCW: shoelace area positive
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
    area += x0 * y1 - x1 * y0;
  }
  expect(area).toBeGreaterThan(0);
});

test("roundedRectRing clamps a sharp (rc ≤ 0) corner to EPS_R, never coincident points", () => {
  const ring = roundedRectRing(10, 7, -2, 3);
  const uniq = new Set(ring.map((p) => p.join(",")));
  expect(uniq.size).toBe(ring.length);
  // stays within the rect
  for (const [x, y] of ring) { expect(Math.abs(x)).toBeLessThanOrEqual(10 + EPS_R); expect(Math.abs(y)).toBeLessThanOrEqual(7 + EPS_R); }
});

test("roundedBoxRings: ascending z, constant N, correct zone endpoints", () => {
  const rings = roundedBoxRings([24, 16, 12], { side: 4, top: 2, bottom: 1 }, 32);
  const N = rings[0].polygon.length;
  for (const r of rings) expect(r.polygon.length).toBe(N);
  for (let i = 1; i < rings.length; i++) expect(rings[i].z).toBeGreaterThan(rings[i - 1].z);
  expect(rings[0].z).toBe(0);
  expect(rings[rings.length - 1].z).toBe(12);
  // base ring: δ = bottom = 1 → half-extent 11, corner radius side−δ = 3 → max |x| = 11
  const xs = rings[0].polygon.map((p) => p[0]);
  expect(Math.max(...xs)).toBeCloseTo(11, 9);
  // top ring: δ = top = 2 → half-extent 10
  const xt = rings[rings.length - 1].polygon.map((p) => p[0]);
  expect(Math.max(...xt)).toBeCloseTo(10, 9);
});

test("roundedBoxRings dedupes the shared station when top + bottom = h", () => {
  const rings = roundedBoxRings([20, 20, 10], { side: 5, top: 5, bottom: 5 }, 32);
  for (let i = 1; i < rings.length; i++) expect(rings[i].z).toBeGreaterThan(rings[i - 1].z);
});

test("roundedBoxRings with round 0 everywhere is just two rect rings", () => {
  const rings = roundedBoxRings([20, 12, 8], { side: 0, top: 0, bottom: 0 }, 32);
  expect(rings).toHaveLength(2);
  expect(rings[0].z).toBe(0);
  expect(rings[1].z).toBe(8);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/rounded-solids.test.js`
Expected: FAIL — `Cannot find module '../src/framework/geometry/rounded-solids.js'`

- [ ] **Step 3: Write the implementation**

```js
// src/framework/geometry/rounded-solids.js
// Pure geometry builders for the rounded 3-D primitives (roundedBox /
// roundedCylinder / torus). No WASM, no DOM — shared by the kernel front
// (lathe contours for the revolve-based ops) and the Manifold backend
// (roundedBox ring stack). Normative semantics: the design spec
// (docs/superpowers/specs/2026-07-30-rounded-primitives-design.md) — at
// height z the box cross-section is the rounded rect inset δ(z) with corner
// radius max(side − δ, ~0), δ tracing a quarter circle in each rim zone.

const COS45 = Math.SQRT1_2;

// Minimum corner radius standing in for a "sharp" ring corner: keeps every
// ring at the same vertex count (4·(A+1)) without coincident points, so the
// loft stitching never sees a degenerate quad. Far below mesh/print resolution.
export const EPS_R = 1e-6;

// One CCW rounded-rectangle ring: half-extents hw/hd, corner radius rc, A arc
// segments per corner → 4·(A+1) points. Corner centers sit at (±(hw−rc),
// ±(hd−rc)); the straight edges are implied between consecutive corner arcs.
// rc is clamped into [EPS_R, min(hw, hd) − EPS_R] so sharp corners and
// full-radius (stadium) corners never emit coincident points.
export function roundedRectRing(hw, hd, rc, A) {
  const r = Math.min(Math.max(rc, EPS_R), Math.max(EPS_R, Math.min(hw, hd) - EPS_R));
  const cx = hw - r, cy = hd - r;
  const C = [[cx, cy], [-cx, cy], [-cx, -cy], [cx, -cy]];
  const pts = [];
  for (let q = 0; q < 4; q++) {
    const a0 = (q * Math.PI) / 2; // corner (+,+) spans 0..90°, then CCW
    for (let i = 0; i <= A; i++) {
      const a = a0 + (i / A) * (Math.PI / 2);
      pts.push([C[q][0] + r * Math.cos(a), C[q][1] + r * Math.sin(a)]);
    }
  }
  return pts;
}

// Ring stack for the Manifold roundedBox: ascending-z loft ring specs
// [{ polygon, z }]. A (arc samples per corner AND z-stations per rim zone) is
// derived from the kernel's segs so the z-sampling matches the in-plane LOD.
// Consecutive duplicate stations (top + bottom = h) are deduped so the loft
// never sees a zero-height band.
export function roundedBoxRings([w, d, h], { side, top, bottom }, segs) {
  const A = Math.max(2, Math.ceil(segs / 8));
  const st = [];
  const push = (z, delta) => {
    const last = st[st.length - 1];
    if (last && Math.abs(last.z - z) < 1e-9 && Math.abs(last.delta - delta) < 1e-9) return;
    st.push({ z, delta });
  };
  if (bottom > 0) {
    for (let i = 0; i <= A; i++) {
      const phi = (i / A) * (Math.PI / 2);
      push(bottom * (1 - Math.cos(phi)), bottom * (1 - Math.sin(phi)));
    }
  } else push(0, 0);
  if (top > 0) {
    for (let i = A; i >= 0; i--) {
      const phi = (i / A) * (Math.PI / 2);
      push(h - top * (1 - Math.cos(phi)), top * (1 - Math.sin(phi)));
    }
  } else push(h, 0);
  return st.map(({ z, delta }) =>
    ({ polygon: roundedRectRing(w / 2 - delta, d / 2 - delta, side - delta, A), z }));
}

// ArcContour for the roundedCylinder lathe profile: the rectangle
// [0,0]→[r,0]→[r,h]→[0,h] with the two outer corners rounded (rBottom, rTop).
// Built with explicit tangent/via points — NOT roundedProfile, whose
// conservative per-corner clamp (tangent ≤ min-adjacent-edge/2) would
// silently shrink a capsule's full-radius corner. Zero-length lines are
// skipped so boundary radii (rBottom = r, rTop + rBottom = h) stay valid.
export function latheRoundedRect(r, h, rTop, rBottom) {
  const start = [0, 0];
  const segments = [];
  let cur = start;
  const lineTo = (p) => { if (Math.hypot(p[0] - cur[0], p[1] - cur[1]) > 1e-12) { segments.push({ to: p }); cur = p; } };
  const arcTo = (to, via) => { segments.push({ to, via }); cur = to; };
  lineTo([r - rBottom, 0]);
  if (rBottom > 0)
    arcTo([r, rBottom], [r - rBottom * (1 - COS45), rBottom * (1 - COS45)]);
  lineTo([r, h - rTop]);
  if (rTop > 0)
    arcTo([r - rTop, h], [r - rTop * (1 - COS45), h - rTop * (1 - COS45)]);
  lineTo([0, h]);
  return { start, segments }; // consumers close() back down the revolve axis
}

// ArcContour for the torus lathe profile: a full circle of radius rMinor
// centered at [rMajor, 0], as four quarter arcs. The loop ends exactly on its
// start: replicad's close() skips the closing line when the pen is already
// home (verified in _closeSketch), and the Manifold tessellator's duplicated
// seam point is cleaned by Clipper2 (CrossSection.ofPolygons).
export function torusContour(rMajor, rMinor) {
  const R = rMajor, r = rMinor, c = r * COS45;
  return { start: [R + r, 0], segments: [
    { to: [R, r], via: [R + c, c] },
    { to: [R - r, 0], via: [R - c, c] },
    { to: [R, -r], via: [R - c, -c] },
    { to: [R + r, 0], via: [R + c, -c] },
  ] };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/rounded-solids.test.js`
Expected: PASS (all 9)

Note: the capsule test pins exact via/tangent values — if it fails on float formatting, compare with `toBeCloseTo(…, 12)` per coordinate instead of `toEqual`; the geometry (center `(r−rBottom, rBottom)`, via at ∓45°) is normative.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/rounded-solids.js test/rounded-solids.test.js
git commit -m "feat: pure contour + ring builders for rounded primitives"
```

---

### Task 2: Options normalizers with clamp-and-warn (`op-options.js`)

**Files:**
- Modify: `src/framework/geometry/op-options.js` (add three exported normalizers + `KERNEL_OP_SPECS` entries at the end of the specs object, after `helixSweptTube`)
- Test: `test/rounded-op-options.test.js`

**Interfaces:**
- Consumes: existing `checkKeys`, `req`, `isPlainOptions` in `op-options.js`.
- Produces: `roundedBoxArgs(o) → [{size:[w,d,h], center:boolean, round:{side,top,bottom}}]`, `roundedCylinderArgs(o) → [{r, h, center:boolean, round:{top,bottom}}]`, `torusArgs(o) → [{rMajor, rMinor}]`; `KERNEL_OP_SPECS.roundedBox/.roundedCylinder/.torus = { toArgs }`. Backends receive exactly these normalized single-object shapes. (Adding specs before the ops exist is safe — `finishKernel`'s wrap loop skips absent ops.)

- [ ] **Step 1: Write the failing tests**

```js
// test/rounded-op-options.test.js
import { expect, test, vi } from "vitest";
import { roundedBoxArgs, roundedCylinderArgs, torusArgs, KERNEL_OP_SPECS } from "../src/framework/geometry/op-options.js";

test("KERNEL_OP_SPECS has entries for the three rounded ops", () => {
  for (const op of ["roundedBox", "roundedCylinder", "torus"])
    expect(KERNEL_OP_SPECS[op]?.toArgs).toBeTypeOf("function");
});

test("roundedBox: number round broadcasts to all groups; object form defaults to 0", () => {
  expect(roundedBoxArgs({ size: [20, 12, 8], round: 2 }))
    .toEqual([{ size: [20, 12, 8], center: false, round: { side: 2, top: 2, bottom: 2 } }]);
  expect(roundedBoxArgs({ size: [20, 12, 8], center: true, round: { top: 3 } }))
    .toEqual([{ size: [20, 12, 8], center: true, round: { side: 0, top: 3, bottom: 0 } }]);
});

test("roundedBox: middle regime clamps rims down to side with ONE deduped console.warn", () => {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const [o] = roundedBoxArgs({ size: [20, 20, 10], round: { side: 1, top: 3 } });
  expect(o.round).toEqual({ side: 1, top: 1, bottom: 0 });
  expect(spy).toHaveBeenCalledWith(
    "roundedBox: round.top 3 clamped to round.side 1 (side must be 0 or ≥ rim radii; use side: 0 for a rim-only round-over)");
  const n = spy.mock.calls.length;
  roundedBoxArgs({ size: [20, 20, 10], round: { side: 1, top: 3 } }); // same combo → deduped
  expect(spy.mock.calls.length).toBe(n);
  spy.mockRestore();
});

test("roundedBox: side = 0 with big rims does NOT clamp or warn", () => {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const [o] = roundedBoxArgs({ size: [20, 20, 10], round: { side: 0, top: 4 } });
  expect(o.round).toEqual({ side: 0, top: 4, bottom: 0 });
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test("roundedBox: validation errors", () => {
  expect(() => roundedBoxArgs({ size: [20, 12, 8], round: { side: 11 } }))
    .toThrow("roundedBox: round.side (11) must be ≤ min(w, d)/2");
  expect(() => roundedBoxArgs({ size: [20, 12, 8], round: { top: 5, bottom: 4 } }))
    .toThrow("roundedBox: round.top + round.bottom must be ≤ h");
  expect(() => roundedBoxArgs({ size: [20, 12, 8], round: -1 }))
    .toThrow("roundedBox: round.side must be a finite number ≥ 0");
  expect(() => roundedBoxArgs({ size: [20, 12], round: 1 }))
    .toThrow("roundedBox: size must be [w, d, h] with three positive numbers");
  expect(() => roundedBoxArgs({ size: [20, 12, 8], round: { sied: 1 } }))
    .toThrow(/unknown option "sied"/);
  expect(() => roundedBoxArgs({ size: [20, 12, 8] })).toThrow("roundedBox: round is required");
});

test("roundedCylinder: r/d exclusivity, defaults, validation", () => {
  expect(roundedCylinderArgs({ d: 16, h: 20, round: 3 }))
    .toEqual([{ r: 8, h: 20, center: false, round: { top: 3, bottom: 3 } }]);
  expect(() => roundedCylinderArgs({ r: 8, d: 16, h: 20, round: 1 }))
    .toThrow("roundedCylinder: pass exactly one of r/d");
  expect(() => roundedCylinderArgs({ r: 8, h: 20, round: 9 }))
    .toThrow("roundedCylinder: round.top (9) must be ≤ r");
  expect(() => roundedCylinderArgs({ r: 8, h: 4, round: { top: 3, bottom: 2 } }))
    .toThrow("roundedCylinder: round.top + round.bottom must be ≤ h");
});

test("torus: 0 < rMinor < rMajor enforced", () => {
  expect(torusArgs({ rMajor: 10, rMinor: 3 })).toEqual([{ rMajor: 10, rMinor: 3 }]);
  for (const bad of [{ rMajor: 3, rMinor: 5 }, { rMajor: 3, rMinor: 3 }, { rMajor: 3, rMinor: 0 }])
    expect(() => torusArgs(bad)).toThrow("torus: requires 0 < rMinor < rMajor");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/rounded-op-options.test.js`
Expected: FAIL — `roundedBoxArgs` is not exported

- [ ] **Step 3: Implement in `op-options.js`**

Add after `sweepArgs` (before the `checkScaleTop` comment block):

```js
// ---- rounded primitives (options-only ops) -------------------------------

// Clamp warnings are deduped per distinct message so a slider sweep doesn't
// spam the console on every rebuild. Console-only side channel; the returned
// geometry stays a pure function of the arguments.
const warnedClamps = new Set();

// `round` accepts a number (broadcast to every group) or a plain object with
// the op's group keys (missing keys → 0).
const normalizeRound = (op, v, keys) => {
  if (typeof v === "number") return Object.fromEntries(keys.map((key) => [key, v]));
  if (isPlainOptions(v)) {
    checkKeys(`${op}: round`, v, keys);
    return Object.fromEntries(keys.map((key) => [key, v[key] ?? 0]));
  }
  throw new Error(`${op}: round must be a number or { ${keys.join("?, ")}? }`);
};

const checkRoundRadius = (op, name, v, max, maxDesc) => {
  if (!(typeof v === "number" && Number.isFinite(v) && v >= 0))
    throw new Error(`${op}: ${name} must be a finite number ≥ 0`);
  if (v > max + 1e-9) throw new Error(`${op}: ${name} (${v}) must be ≤ ${maxDesc}`);
};

export function roundedBoxArgs(o) {
  checkKeys("roundedBox", o, ["size", "center", "round"]);
  const size = req("roundedBox", o, "size");
  if (!Array.isArray(size) || size.length !== 3 || !size.every((v) => Number.isFinite(v) && v > 0))
    throw new Error("roundedBox: size must be [w, d, h] with three positive numbers");
  const [w, d, h] = size;
  const round = normalizeRound("roundedBox", req("roundedBox", o, "round"), ["side", "top", "bottom"]);
  checkRoundRadius("roundedBox", "round.side", round.side, Math.min(w, d) / 2, "min(w, d)/2");
  checkRoundRadius("roundedBox", "round.top", round.top, Math.min(w, d) / 2, "min(w, d)/2");
  checkRoundRadius("roundedBox", "round.bottom", round.bottom, Math.min(w, d) / 2, "min(w, d)/2");
  if (round.top + round.bottom > h + 1e-9)
    throw new Error("roundedBox: round.top + round.bottom must be ≤ h");
  // Middle regime (0 < side < rim): rims clamp DOWN to side — side defines the
  // footprint and must not grow; a shrunk round-over only adds material. The
  // side = 0 sphere-free rim round-over stays fully valid (see the spec).
  if (round.side > 0) {
    for (const key of ["top", "bottom"]) {
      if (round[key] > round.side) {
        const msg = `roundedBox: round.${key} ${round[key]} clamped to round.side ${round.side} (side must be 0 or ≥ rim radii; use side: 0 for a rim-only round-over)`;
        if (!warnedClamps.has(msg)) { warnedClamps.add(msg); console.warn(msg); }
        round[key] = round.side;
      }
    }
  }
  return [{ size: [w, d, h], center: o.center === true, round }];
}

export function roundedCylinderArgs(o) {
  checkKeys("roundedCylinder", o, ["r", "d", "h", "center", "round"]);
  const hasR = o.r !== undefined;
  if (hasR === (o.d !== undefined)) throw new Error("roundedCylinder: pass exactly one of r/d");
  const r = hasR ? o.r : o.d / 2;
  if (!(Number.isFinite(r) && r > 0)) throw new Error("roundedCylinder: r must be > 0");
  const h = req("roundedCylinder", o, "h");
  if (!(Number.isFinite(h) && h > 0)) throw new Error("roundedCylinder: h must be > 0");
  const round = normalizeRound("roundedCylinder", req("roundedCylinder", o, "round"), ["top", "bottom"]);
  checkRoundRadius("roundedCylinder", "round.top", round.top, r, "r");
  checkRoundRadius("roundedCylinder", "round.bottom", round.bottom, r, "r");
  if (round.top + round.bottom > h + 1e-9)
    throw new Error("roundedCylinder: round.top + round.bottom must be ≤ h");
  return [{ r, h, center: o.center === true, round }];
}

export function torusArgs(o) {
  checkKeys("torus", o, ["rMajor", "rMinor"]);
  const rMajor = req("torus", o, "rMajor"), rMinor = req("torus", o, "rMinor");
  if (!(Number.isFinite(rMajor) && Number.isFinite(rMinor) && rMinor > 0 && rMinor < rMajor))
    throw new Error("torus: requires 0 < rMinor < rMajor");
  return [{ rMajor, rMinor }];
}
```

And extend `KERNEL_OP_SPECS` (after the `helixSweptTube` entry):

```js
  roundedBox:      { toArgs: roundedBoxArgs },
  roundedCylinder: { toArgs: roundedCylinderArgs },
  torus:           { toArgs: torusArgs },
```

- [ ] **Step 4: Run the new tests AND the full suite** (the specs touch the shared normalizer path)

Run: `npx vitest run test/rounded-op-options.test.js && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/op-options.js test/rounded-op-options.test.js
git commit -m "feat: rounded-primitive option normalizers with clamp-and-warn"
```

---

### Task 3: `roundedCylinder` + `torus` ops (kernel front) + Manifold tests

**Files:**
- Modify: `src/framework/geometry/kernel-front.js` (default compositions, next to the `boredCylinder ??=` block)
- Modify: `src/framework/geometry/kernel.js` (`KERNEL_OPS` + typedef lines)
- Modify: `docs/KERNEL-CONTRACT.md` (name the two ops — the doc-naming test requires it in this commit)
- Create: `test/fixtures/rounded-oracles.js`
- Test: `test/rounded-primitives.test.js`

**Interfaces:**
- Consumes: `latheRoundedRect`, `torusContour` from Task 1; normalized options from Task 2 (`{r, h, center, round:{top,bottom}}`, `{rMajor, rMinor}`).
- Produces: `k.roundedCylinder(opts) → Solid`, `k.torus(opts) → Solid` on BOTH backends (via `??=` — no backend override); oracle helpers `roundedCylinderVolume(r, h, {top,bottom})`, `torusVolume(rMajor, rMinor)`, `roundedBoxVolume(size, {side,top,bottom})`, `minkowskiRoundedBoxVolume(size, r)` used by Tasks 4–5.

- [ ] **Step 1: Write the volume-oracle fixture** (test-only, no WASM)

```js
// test/fixtures/rounded-oracles.js
// Analytic volume oracles for the rounded primitives: numeric quadrature over
// the spec's exact closed-form cross-sections. The all-equal Minkowski form is
// an independent anchor the quadrature is checked against.

export function simpson(f, a, b, n = 8192) {
  const h = (b - a) / n;
  let s = f(a) + f(b);
  for (let i = 1; i < n; i++) s += f(a + i * h) * (i % 2 ? 4 : 2);
  return (s * h) / 3;
}

// Round-over inset at distance zFromFace ∈ [0, R] into a rim zone of radius R.
const inset = (R, zFromFace) =>
  R <= 0 ? 0 : R - Math.sqrt(Math.max(0, R * R - (R - zFromFace) ** 2));

// Normative roundedBox cross-section area at height z (spec §Semantics).
export function roundedBoxSection([w, d, h], { side, top, bottom }, z) {
  const delta = z < bottom ? inset(bottom, z) : z > h - top ? inset(top, h - z) : 0;
  const rc = Math.max(side - delta, 0);
  return (w - 2 * delta) * (d - 2 * delta) - (4 - Math.PI) * rc * rc;
}

export const roundedBoxVolume = (size, round) =>
  simpson((z) => roundedBoxSection(size, round, z), 0, size[2]);

export function roundedCylinderRadius(r, h, { top, bottom }, z) {
  const delta = z < bottom ? inset(bottom, z) : z > h - top ? inset(top, h - z) : 0;
  return r - delta;
}

export const roundedCylinderVolume = (r, h, round) =>
  simpson((z) => Math.PI * roundedCylinderRadius(r, h, round, z) ** 2, 0, h);

export const torusVolume = (rMajor, rMinor) => 2 * Math.PI ** 2 * rMajor * rMinor * rMinor;

// Exact Minkowski closed form for the ALL-EQUAL rounded box.
export function minkowskiRoundedBoxVolume([w, d, h], r) {
  const a = w - 2 * r, b = d - 2 * r, c = h - 2 * r;
  return a * b * c + 2 * r * (a * b + a * c + b * c)
    + Math.PI * r * r * (a + b + c) + (4 / 3) * Math.PI * r ** 3;
}
```

- [ ] **Step 2: Write the failing tests**

```js
// test/rounded-primitives.test.js
// Manifold-side integration for the rounded primitives. The OCCT twin lives in
// rounded-primitives-occt.test.js (the two backends never boot in one process).
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import {
  roundedCylinderVolume, torusVolume, roundedBoxVolume, minkowskiRoundedBoxVolume,
} from "./fixtures/rounded-oracles.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const rel = (actual, exact) => Math.abs(actual - exact) / exact;

test("oracle self-check: quadrature agrees with the Minkowski anchor", () => {
  expect(rel(roundedBoxVolume([20, 14, 10], { side: 3, top: 3, bottom: 3 }),
    minkowskiRoundedBoxVolume([20, 14, 10], 3))).toBeLessThan(1e-5);
});

test("roundedCylinder volume matches the lathe oracle", () => {
  const v = k.roundedCylinder({ r: 8, h: 20, round: { top: 3, bottom: 1.5 } }).volume();
  expect(rel(v, roundedCylinderVolume(8, 20, { top: 3, bottom: 1.5 }))).toBeLessThan(0.01);
});

test("capsule boundary (round = r, top + bottom = h) builds watertight — a sphere", () => {
  const s = k.roundedCylinder({ r: 5, h: 10, round: 5 });
  expect(s.isEmpty()).toBe(false);
  expect(s.genus()).toBe(0);
  expect(rel(s.volume(), (4 / 3) * Math.PI * 125)).toBeLessThan(0.01);
});

test("round: 0 degenerates to the plain cylinder", () => {
  const v = k.roundedCylinder({ r: 6, h: 9, round: 0 }).volume();
  expect(rel(v, k.cylinder({ r: 6, h: 9 }).volume())).toBeLessThan(0.005);
});

test("roundedCylinder center: true centers Z", () => {
  const bb = k.roundedCylinder({ r: 5, h: 12, round: 2, center: true }).boundingBox();
  expect(bb.min[2]).toBeCloseTo(-6, 5);
  expect(bb.max[2]).toBeCloseTo(6, 5);
});

test("torus: genus 1, volume 2π²·R·r²", () => {
  const s = k.torus({ rMajor: 10, rMinor: 3 });
  expect(s.genus()).toBe(1);
  expect(s.isEmpty()).toBe(false);
  expect(rel(s.volume(), torusVolume(10, 3))).toBeLessThan(0.01);
});

test("torus bounding box spans z ∈ [−rMinor, rMinor]", () => {
  const bb = k.torus({ rMajor: 10, rMinor: 3 }).boundingBox();
  expect(bb.min[2]).toBeCloseTo(-3, 3);
  expect(bb.max[2]).toBeCloseTo(3, 3);
  expect(bb.max[0]).toBeCloseTo(13, 2);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/rounded-primitives.test.js`
Expected: FAIL — `k.roundedCylinder is not a function`

- [ ] **Step 4: Implement the default compositions in `kernel-front.js`**

Add the import:

```js
import { latheRoundedRect, torusContour } from "./rounded-solids.js";
```

Add directly under the `k.boredCylinder ??=` block (BEFORE the wrap loop, so the options normalization from Task 2 wraps these too):

```js
  // Compound defaults: rounded lathe solids — ONE revolve of an arc-exact
  // profile, so OCCT gets real torus/sphere/cylinder faces in STEP and
  // Manifold facets at the mesh LOD. Zero booleans; neither backend overrides.
  k.roundedCylinder ??= ({ r, h, center, round }) => {
    const s = k.revolve({ profile: k.shape2d(latheRoundedRect(r, h, round.top, round.bottom)) });
    return center ? s.translate([0, 0, -h / 2]) : s;
  };
  k.torus ??= ({ rMajor, rMinor }) =>
    k.revolve({ profile: k.shape2d(torusContour(rMajor, rMinor)) });
```

In `kernel.js`, extend `KERNEL_OPS`:

```js
export const KERNEL_OPS = [
  "cylinder", "boredCylinder", "sphere", "box", "prism", "extrude", "revolve",
  "loft", "sweep", "helixSweptTube", "union", "shape2d", "text2d", "hull", "hullChain", "toSTEP",
  "roundedCylinder", "torus",
];
```

And add typedef lines in the kernel `@typedef` block (next to `cylinder`/`sphere`):

```js
 * @property {(o:{r?:number,d?:number,h:number,center?:boolean,round:number|{top?:number,bottom?:number}}) => Solid} roundedCylinder   rim round-overs via one lathe revolve; options-only; round ≤ r, top+bottom ≤ h
 * @property {(o:{rMajor:number,rMinor:number}) => Solid} torus   centered at origin, tube centerline in the z=0 plane; 0 < rMinor < rMajor; options-only
```

In `docs/KERNEL-CONTRACT.md`, the doc-naming test needs both op names present. Add two rows to the primitives table / op list where `cylinder` and `sphere` are described (full prose semantics land in Task 6; minimal rows now):

```markdown
- `roundedCylinder({ r|d, h, center?, round })` — cylinder with rim round-overs
  (`round`: number = both rims, or `{ top?, bottom? }`), built as one lathe
  `revolve` of an arc-exact profile — real torus faces in STEP. Validation:
  radii ≥ 0, each ≤ r, top + bottom ≤ h. Options-only.
- `torus({ rMajor, rMinor })` — torus centered at the origin, tube centerline
  in the z = 0 plane; requires 0 < rMinor < rMajor. Curve-exact on B-rep
  backends. Options-only.
```

- [ ] **Step 5: Run the new tests, then the full suite**

Run: `npx vitest run test/rounded-primitives.test.js && npm test`
Expected: PASS — including `kernel-contract.test.js` (Manifold exposes the two new ops; nothing undocumented) and `occt-backend.test.js` (OCCT gets them via the same kernel front).

- [ ] **Step 6: Commit**

```bash
git add src/framework/geometry/kernel-front.js src/framework/geometry/kernel.js docs/KERNEL-CONTRACT.md test/fixtures/rounded-oracles.js test/rounded-primitives.test.js
git commit -m "feat: roundedCylinder + torus kernel ops (shared revolve composition)"
```

---

### Task 4: OCCT parity + STEP exactness for `roundedCylinder` / `torus`

**Files:**
- Test: `test/rounded-primitives-occt.test.js` (new — OCCT boots in its own file)

**Interfaces:**
- Consumes: `bootOcctKernel` from `src/testing.js`; oracles from Task 3. No production code changes — this task proves the shared composition on the B-rep backend.

- [ ] **Step 1: Write the tests**

```js
// test/rounded-primitives-occt.test.js
// OCCT twin of rounded-primitives.test.js. B-rep volumes are exact, so the
// tolerance is the oracle's quadrature error, not a facet tolerance.
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { roundedCylinderVolume, torusVolume } from "./fixtures/rounded-oracles.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

const rel = (actual, exact) => Math.abs(actual - exact) / exact;

test("roundedCylinder volume is B-rep exact against the oracle", () => {
  const v = k.roundedCylinder({ r: 8, h: 20, round: { top: 3, bottom: 1.5 } }).volume();
  expect(rel(v, roundedCylinderVolume(8, 20, { top: 3, bottom: 1.5 }))).toBeLessThan(1e-4);
});

test("capsule boundary is exact (a sphere)", () => {
  const v = k.roundedCylinder({ r: 5, h: 10, round: 5 }).volume();
  expect(rel(v, (4 / 3) * Math.PI * 125)).toBeLessThan(1e-6);
});

test("torus volume is B-rep exact", () => {
  const v = k.torus({ rMajor: 10, rMinor: 3 }).volume();
  expect(rel(v, torusVolume(10, 3))).toBeLessThan(1e-6);
});

test("validation errors are backend-identical (shared normalizer)", () => {
  expect(() => k.torus({ rMajor: 3, rMinor: 5 })).toThrow("torus: requires 0 < rMinor < rMajor");
  expect(() => k.roundedCylinder({ r: 8, h: 4, round: { top: 3, bottom: 2 } }))
    .toThrow("roundedCylinder: round.top + round.bottom must be ≤ h");
});

test("STEP export carries real curved surfaces (no faceting)", async () => {
  const torusStep = new TextDecoder().decode(
    await k.toSTEP([{ name: "t", solid: k.torus({ rMajor: 10, rMinor: 3 }) }]));
  expect(torusStep).toMatch(/TOROIDAL_SURFACE/);
  const cylStep = new TextDecoder().decode(
    await k.toSTEP([{ name: "c", solid: k.roundedCylinder({ r: 8, h: 20, round: 2 }) }]));
  expect(cylStep).toMatch(/TOROIDAL_SURFACE/); // the rim round-over is a torus band
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/rounded-primitives-occt.test.js`
Expected: PASS. If the torus test fails inside replicad's `close()`, the all-arc loop closure is the suspect — grep `docs/ERROR-PATTERNS.md` first, then check `_closeSketch` behavior (it must skip the closing line when the pen is at the start; verified against replicad's source during planning).

- [ ] **Step 3: Run the full suite and commit**

```bash
npm test
git add test/rounded-primitives-occt.test.js
git commit -m "test: OCCT parity + STEP exactness for roundedCylinder/torus"
```

---

### Task 5: `roundedBox` on both backends + probe routing

**Files:**
- Modify: `src/framework/geometry/manifold-backend.js` (op + import)
- Modify: `src/framework/geometry/occt-backend.js` (op + imports)
- Modify: `src/framework/geometry/kernel.js` (`KERNEL_OPS` + typedef)
- Modify: `docs/KERNEL-CONTRACT.md` (name the op)
- Test: extend `test/rounded-primitives.test.js` and `test/rounded-primitives-occt.test.js`

**Interfaces:**
- Consumes: `roundedBoxRings(size, round, segs)` from Task 1; `loftMesh(wasm, rings)` from `loft.js` (already imported by the Manifold backend); `roundedProfile` from `polygon.js`; `contourDrawing`, `safeOp`, `cached`, `wrap`, `makeBox`, `makeCylinder` in the OCCT backend; normalized `{size, center, round:{side,top,bottom}}` from Task 2.
- Produces: `k.roundedBox(opts) → Solid` on both backends; `KERNEL_OPS` gains `"roundedBox"`.

- [ ] **Step 1: Write the failing Manifold tests** (append to `test/rounded-primitives.test.js`; add `detectBackend` to the imports)

```js
import { detectBackend } from "../src/framework/geometry/probe.js";

test("all-equal roundedBox matches the Minkowski closed form", () => {
  const v = k.roundedBox({ size: [20, 14, 10], round: 3 }).volume();
  expect(rel(v, minkowskiRoundedBoxVolume([20, 14, 10], 3))).toBeLessThan(0.01);
});

test("selective radii (side > rims) match the section oracle", () => {
  const round = { side: 4, top: 2, bottom: 1 };
  const v = k.roundedBox({ size: [24, 16, 12], round }).volume();
  expect(rel(v, roundedBoxVolume([24, 16, 12], round))).toBeLessThan(0.01);
});

test("side = 0 rim-only round-over matches the oracle", () => {
  const round = { side: 0, top: 3, bottom: 0 };
  const v = k.roundedBox({ size: [20, 20, 8], round }).volume();
  expect(rel(v, roundedBoxVolume([20, 20, 8], round))).toBeLessThan(0.01);
});

test("vertical-only rounding (rims 0) matches the oracle", () => {
  const round = { side: 3, top: 0, bottom: 0 };
  const v = k.roundedBox({ size: [20, 12, 8], round }).volume();
  expect(rel(v, roundedBoxVolume([20, 12, 8], round))).toBeLessThan(0.01);
});

test("roundedBox is watertight (genus 0) across regimes and boundaries", () => {
  const cases = [
    { size: [20, 14, 10], round: 3 },                              // all-equal
    { size: [24, 16, 12], round: { side: 4, top: 2, bottom: 1 } }, // selective
    { size: [20, 20, 8], round: { side: 0, top: 3, bottom: 2 } },  // rim-only
    { size: [20, 12, 10], round: { side: 6, top: 5, bottom: 5 } }, // stadium (2·side = min) + top+bottom = h
  ];
  for (const c of cases) {
    const s = k.roundedBox(c);
    expect(s.isEmpty(), JSON.stringify(c)).toBe(false);
    expect(s.genus(), JSON.stringify(c)).toBe(0);
    expect(s.volume(), JSON.stringify(c)).toBeGreaterThan(0);
  }
});

test("clamped middle regime builds the SAME solid as the explicit clamp", () => {
  const a = k.roundedBox({ size: [20, 20, 10], round: { side: 1, top: 3 } });
  const b = k.roundedBox({ size: [20, 20, 10], round: { side: 1, top: 1 } });
  expect(a.volume()).toBe(b.volume()); // identical normalized args → same cache node
});

test("roundedBox center: true centers all axes", () => {
  const bb = k.roundedBox({ size: [20, 14, 10], round: 2, center: true }).boundingBox();
  expect(bb.min[2]).toBeCloseTo(-5, 5);
  expect(bb.max[2]).toBeCloseTo(5, 5);
});

test("a roundedBox part routes to Manifold, not OCCT", () => {
  const part = { defaults: {}, parts: { main: { build: (kk) => kk.roundedBox({ size: [20, 12, 8], round: 2 }) } } };
  expect(detectBackend(part)).toBe("manifold");
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run test/rounded-primitives.test.js`
Expected: new tests FAIL with `k.roundedBox is not a function`; Task-3 tests still PASS.

- [ ] **Step 3: Implement the Manifold op**

In `manifold-backend.js`, add to the `loft.js`-adjacent imports:

```js
import { roundedBoxRings } from "./rounded-solids.js";
```

Add the op to the kernel object literal (after `boredCylinder`):

```js
    // Rounded box: ONE hand-meshed ring stack (no booleans) whose cross-
    // sections follow the normative formula (rounded-solids.js / the design
    // spec). Reuses loftMesh's stitch/cap/winding machinery. Atomic cache
    // node hashed from its own args, like boredCylinder.
    roundedBox: ({ size, center, round }) => cached(
      h("roundedBox", size, center, round.side, round.top, round.bottom, segs),
      () => {
        const solid = T(loftMesh(wasm, roundedBoxRings(size, round, segs)));
        return center ? T(solid.translate([0, 0, -size[2] / 2])) : solid;
      }),
```

- [ ] **Step 4: Run the Manifold tests**

Run: `npx vitest run test/rounded-primitives.test.js`
Expected: PASS. (`kernel-contract.test.js` would now FAIL on the undocumented op — that is expected until Step 7; don't run the full suite yet.)

If the stadium/boundary watertight case fails inside `Manifold.ofMesh`: the degenerate-ring mitigation is `EPS_R` clamping in `roundedRectRing` (Task 1) — verify the failing ring's points are unique before touching mesh code; if a genuinely zero-width ring (only reachable via `2·top = min(w,d)`, not in the test cases) proves unmeshable, tighten that one validation in `roundedBoxArgs` to strict `<` with message `roundedBox: round.top must be < min(w, d)/2` and record the decision in the spec's validation list.

- [ ] **Step 5: Write the failing OCCT tests** (append to `test/rounded-primitives-occt.test.js`; extend the oracle import with `roundedBoxVolume, minkowskiRoundedBoxVolume`)

```js
test("all-equal roundedBox is B-rep exact against the Minkowski form", () => {
  const v = k.roundedBox({ size: [20, 14, 10], round: 3 }).volume();
  expect(rel(v, minkowskiRoundedBoxVolume([20, 14, 10], 3))).toBeLessThan(1e-6);
});

test("selective radii (side > rims) are B-rep exact against the oracle", () => {
  const round = { side: 4, top: 2, bottom: 1 };
  const v = k.roundedBox({ size: [24, 16, 12], round }).volume();
  expect(rel(v, roundedBoxVolume([24, 16, 12], round))).toBeLessThan(1e-4);
});

test("side = 0 wedge-cut round-over is B-rep exact against the oracle", () => {
  const round = { side: 0, top: 3, bottom: 2 };
  const v = k.roundedBox({ size: [20, 20, 8], round }).volume();
  expect(rel(v, roundedBoxVolume([20, 20, 8], round))).toBeLessThan(1e-4);
});

test("roundedBox STEP export carries spherical corner patches (all-equal)", async () => {
  const step = new TextDecoder().decode(
    await k.toSTEP([{ name: "b", solid: k.roundedBox({ size: [20, 14, 10], round: 3 }) }]));
  expect(step).toMatch(/SPHERICAL_SURFACE/);
});
```

- [ ] **Step 6: Implement the OCCT op**

In `occt-backend.js`, extend the polygon import:

```js
import { roundedProfile } from "./polygon.js";
```

Add near the other primitive helpers (after the `cylinder` const):

```js
  // Rounded box. side > 0: an arc-exact rounded-rect extrusion (real CIRCLE
  // wall edges in STEP) with each rim rounded by ONE native fillet on its
  // smooth rim loop — exact torus/sphere corner patches, matching the mesh
  // backend's ring semantics by construction. side = 0: rim round-overs are
  // CUT with strip-minus-quarter-cylinder wedges running the full edge
  // length, so corners are the deterministic intersection of adjacent
  // round-overs (native fillet's vertex blend is kernel-specific and the
  // mesh backend could not reproduce it — see the design spec).
  const roundedBox = ({ size, center, round }) => {
    const [w, d, hgt] = size;
    const { side, top, bottom } = round;
    const key = h("roundedBox", size, center, side, top, bottom);
    return cached(key, () => {
      const z0 = center ? -hgt / 2 : 0;
      if (side > 0) {
        const rect = [[w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2], [-w / 2, -d / 2]];
        let s = contourDrawing(roundedProfile(rect, side)).sketchOnPlane("XY", z0).extrude(hgt);
        if (top > 0) s = safeOp(s, (sh) => sh.fillet(top, (e) => e.inPlane("XY", z0 + hgt)), `fillet(${top})`);
        if (bottom > 0) s = safeOp(s, (sh) => sh.fillet(bottom, (e) => e.inPlane("XY", z0)), `fillet(${bottom})`);
        return wrap(s, [], key);
      }
      let s = makeBox([-w / 2, -d / 2, z0], [w / 2, d / 2, z0 + hgt]);
      for (const [rim, zFace, into] of [[top, z0 + hgt, -1], [bottom, z0, 1]]) {
        if (!(rim > 0)) continue;
        const zAxis = zFace + into * rim;
        const zMin = Math.min(zFace, zAxis), zMax = Math.max(zFace, zAxis);
        for (const sy of [1, -1]) { // ±Y walls: strip + quarter-cylinder axis along X
          const strip = makeBox([-w / 2, sy > 0 ? d / 2 - rim : -d / 2, zMin],
            [w / 2, sy > 0 ? d / 2 : -d / 2 + rim, zMax]);
          const cyl = makeCylinder(rim, w, [-w / 2, sy * (d / 2 - rim), zAxis], [1, 0, 0]);
          s = s.cut(strip.cut(cyl));
        }
        for (const sx of [1, -1]) { // ±X walls: strip + axis along Y
          const strip = makeBox([sx > 0 ? w / 2 - rim : -w / 2, -d / 2, zMin],
            [sx > 0 ? w / 2 : -w / 2 + rim, d / 2, zMax]);
          const cyl = makeCylinder(rim, d, [sx * (w / 2 - rim), -d / 2, zAxis], [0, 1, 0]);
          s = s.cut(strip.cut(cyl));
        }
      }
      return wrap(s, [], key);
    });
  };
```

Register it in the backend's `finishKernel({...})` object (next to `box:`):

```js
    roundedBox,
```

- [ ] **Step 7: Add the op to the contract**

`kernel.js` — extend the line Task 3 added so it reads:

```js
  "roundedCylinder", "torus", "roundedBox",
```

Typedef line (next to the Task-3 additions):

```js
 * @property {(o:{size:number[],center?:boolean,round:number|{side?:number,top?:number,bottom?:number}}) => Solid} roundedBox   selective edge rounding (side = vertical edges, top/bottom = rims); 0 < side < rim clamps rims down to side with a console.warn; options-only
```

`docs/KERNEL-CONTRACT.md` — add next to the Task-3 rows:

```markdown
- `roundedBox({ size, center?, round })` — box with selectively rounded edges;
  `round`: number = every edge, or `{ side?, top?, bottom? }` (vertical edges /
  top rim / bottom rim). Corner semantics and the `0 < side < rim` clamp-with-
  warning rule are normative in the design spec and summarized under
  [Rounded primitives](#rounded-primitives). Options-only.
```

(The `#rounded-primitives` prose section itself lands in Task 6; the anchor in this row is forward-looking and harmless in Markdown.)

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS — including both contract-exactness tests and the doc-naming test.

- [ ] **Step 9: Commit**

```bash
git add src/framework/geometry/manifold-backend.js src/framework/geometry/occt-backend.js src/framework/geometry/kernel.js docs/KERNEL-CONTRACT.md test/rounded-primitives.test.js test/rounded-primitives-occt.test.js
git commit -m "feat: roundedBox — Manifold ring-stack mesh + OCCT fillet/wedge B-rep"
```

---

### Task 6: Docs, error pattern, backlog, version bump

**Files:**
- Modify: `docs/KERNEL-CONTRACT.md` (prose semantics section)
- Modify: `docs/AUTHORING-PARTS.md` (usage rows, snippet, torus idiom note)
- Modify: `docs/ERROR-PATTERNS.md` (clamp pattern)
- Modify: `docs/superpowers/BACKLOG.md` (mark shipped)
- Modify: `package.json` (version)

**Interfaces:** none — documentation of the shipped surface. Follow each doc's existing formatting exactly (read the surrounding sections first).

- [ ] **Step 1: KERNEL-CONTRACT.md — add the normative prose section**

Add a `### Rounded primitives` subsection (anchor `#rounded-primitives`) near the other op-semantics prose:

```markdown
### Rounded primitives

`roundedBox` / `roundedCylinder` / `torus` are options-only compound
primitives (atomic cache nodes). Normative semantics for `roundedBox`
(design spec 2026-07-30): the cross-section at height z is the rounded
rectangle inset by δ(z) with corner radius max(side − δ(z), 0), where δ
traces a quarter circle of the rim radius in each rim zone and is 0 in the
straight zone. Consequences an implementation must honour:

- **side ≥ max(top, bottom)**: top/bottom corners are exact torus patches
  (sphere octants when equal).
- **side = 0**: each rim round-over runs the full edge length and adjacent
  round-overs meet in their natural intersection curve — NOT a
  kernel-specific vertex blend; the top/bottom face keeps sharp corners.
- **0 < side < max(top, bottom)**: the rim radii CLAMP DOWN to side, with a
  console warning (deduped per distinct message). A clamped call and its
  explicitly-clamped equivalent are the same normalized arguments — one
  cache node. For a rim-only round-over use side: 0 exactly.

Validation (op-named plain Errors, backend-identical): radii ≥ 0 and finite;
box: 2·r ≤ min(w, d) for every group, top + bottom ≤ h; cylinder: rims ≤ r,
top + bottom ≤ h; torus: 0 < rMinor < rMajor. `roundedCylinder`/`torus` are
single lathe revolves of arc-exact profiles — B-rep backends carry real
torus/sphere faces to STEP; mesh backends facet at the segs LOD (the standard
exact-vs-faceted split, not a parity waiver). `roundedBox` is faceted at the
segs LOD on mesh backends and exact B-rep on OCCT; measure parity holds
within facet tolerance.
```

- [ ] **Step 2: AUTHORING-PARTS.md — usage rows + snippet + torus note**

Add three rows to the kernel-op table (with `prism`/`extrude`/`sphere`):

```markdown
| `k.roundedBox({ size, center?, round })` | box with rounded edges — `round` = number (all edges) or `{ side?, top?, bottom? }` (vertical edges / rims); stays on Manifold (no OCCT routing, unlike `fillet`); `side` must be 0 or ≥ the rim radii (between clamps with a warning) |
| `k.roundedCylinder({ r\|d, h, center?, round })` | cylinder with rounded rims — `round` = number (both) or `{ top?, bottom? }`; `round: r` with `top+bottom = h` gives a capsule; one lathe revolve, curve-exact in STEP |
| `k.torus({ rMajor, rMinor })` | torus centered at the origin (tube centerline in z=0); `0 < rMinor < rMajor` |
```

Replace the torus idiom note (currently: `**a torus is `k.revolve({ profile: circleProfile(minorR, [majorR, 0]) })`** (with `majorR > minorR`) — partforge has no `torus` primitive because it's just a revolved circle.`) with:

```markdown
**use `k.torus({ rMajor, rMinor })` for a torus** — it desugars to a revolve of
an arc-exact circle profile (`k.revolve({ profile: circleProfile(minorR,
[majorR, 0]) })` is the faceted hand-rolled equivalent; the primitive keeps
real TORUS faces in STEP).
```

Add one worked snippet near the other examples:

```js
// Rounded enclosure: soft vertical edges, a softer lid, a flat base.
const shell = k.roundedBox({ size: [60, 40, 22], round: { side: 4, top: 2, bottom: 0 } });
```

- [ ] **Step 3: ERROR-PATTERNS.md — one pattern**

Read the file's preamble and copy an existing `##` section's exact field format, then add:

```markdown
## roundedBox rim radius comes out smaller than requested

**Symptom:** `roundedBox: round.top <n> clamped to round.side <m> (side must be 0 or ≥ rim radii; use side: 0 for a rim-only round-over)` in the console, and the built rim round-over is smaller than the `round.top`/`round.bottom` you passed.

**Cause:** the middle regime `0 < side < rim` has no closed-form corner shared by both backends, so the rim radii clamp down to `side` (the footprint-defining radius never grows silently).

**Fix:** either raise `round.side` to ≥ the rim radii (torus/sphere corners), or set `side: 0` exactly for a full-size rim-only round-over on sharp vertical edges.
```

- [ ] **Step 4: BACKLOG.md — mark shipped**

In `docs/superpowers/BACKLOG.md`: move candidate 2 ("Rounded 3-D primitives") into the Shipped list as:

```markdown
- **Rounded 3-D primitives** (v0.37.0) — `roundedBox` (selective side/top/
  bottom radii; Manifold ring-stack mesh, OCCT fillet/wedge B-rep, no OCCT
  routing), `roundedCylinder` and `torus` (single arc-exact lathe revolves,
  STEP-exact). Middle regime (0 < side < rim) clamps rims down with a warning.
```

Flip the JSCAD coverage-map row `rounded 3-D primitives … | — | ❌` to `| roundedBox / roundedCylinder / torus | ✅ |`, and renumber the remaining candidates.

- [ ] **Step 5: Version bump**

In `package.json`: `"version": "0.36.1"` → `"version": "0.37.0"`.

- [ ] **Step 6: Full suite + doc-parity check**

Run: `npm test`
Expected: PASS (the KERNEL-CONTRACT doc tests re-verify op naming; error-patterns tests re-parse the new section).

- [ ] **Step 7: Commit**

```bash
git add docs/KERNEL-CONTRACT.md docs/AUTHORING-PARTS.md docs/ERROR-PATTERNS.md docs/superpowers/BACKLOG.md package.json
git commit -m "docs: rounded primitives contract semantics, authoring rows, error pattern; bump 0.37.0"
```

---

## Verification checklist (post-plan)

- `npm test` green end-to-end.
- `node scripts/check-app.mjs demo.html` (needs Playwright) — unchanged apps still boot.
- Spot-check in the dev viewer if desired: add `k.roundedBox({ size: [30, 20, 12], round: { side: 4, top: 2 } })` to a scratch part and confirm the preview shades smoothly with crisp feature edges.
