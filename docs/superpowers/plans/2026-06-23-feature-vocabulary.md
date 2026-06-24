# Feature Vocabulary Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add semantically meaningful geometry operations to the partforge kernel (sphere, revolve, clone, boundingBox, OCCT-routed shell) plus pure-JS 2D profile and pattern helpers, so LLMs can author parts by intent rather than hand-rolling primitive unions.

**Architecture:** New ops are added to both backends (`manifold-backend.js`, `occt-backend.js`) behind the existing `GeometryKernel`/`Solid` contract, keeping parts backend-agnostic so STEP export still works. `shell` is OCCT-only and routes through the existing capability probe like `fillet`/`chamfer`. Profile and pattern helpers are pure JavaScript in `polygon.js` (zero backend dependency) and compose existing ops.

**Tech Stack:** Manifold (`manifold-3d`), replicad (`replicad` + `replicad-opencascadejs`), Vitest, Node 24.

## Global Constraints

- **Node 24 for tests.** Run `nvm use` first (the `.nvmrc` pins it; the default shell Node is too old).
- **Manifold and OCCT must NOT boot in the same process.** Keep Manifold tests and OCCT tests in separate files (Vitest isolates files). OCCT tests boot via `bootOcctKernel()` from `src/testing/occt.js`; Manifold tests boot via `Module()`/`wasm.setup()`/`createManifoldKernel`.
- **Units are millimetres.** Z-up convention throughout.
- **replicad transforms consume their input** — never reuse a solid after `translate`/`rotate`/`mirror`/`cut`/`shell`/`fillet`/`chamfer`. Use `clone()` to make independent copies.
- **Keep ops backend-agnostic** unless deliberately OCCT-routed (only `shell` here).
- Commit messages follow repo convention; end with the `Co-Authored-By:`/`Claude-Session:` trailers.

---

## Task 1: 2D profile helpers

Pure-JS polygon generators in `polygon.js`. No kernel needed — tested directly on the returned point arrays.

**Files:**
- Modify: `src/framework/geometry/polygon.js` (append helpers)
- Test: `test/profiles.test.js` (create)

**Interfaces:**
- Produces:
  - `roundedRectPolygon(w, h, r, segs = 8) => number[][]`
  - `regularPolygon(n, r, { flat = false } = {}) => number[][]`
  - `ellipsePolygon(rx, ry, segs = 48) => number[][]`
  - `slotPolygon(length, r, segs = 16) => number[][]` (overall length = `length + 2r`)
  - `starPolygon(points, outerR, innerR) => number[][]`
  - `ringSectorPolygon(innerR, outerR, arcDeg, segs = 32) => number[][]` (arcDeg < 360)
  - All return CCW `[[x,y], …]` arrays.

- [ ] **Step 1: Write the failing tests**

Create `test/profiles.test.js`:

```js
import { expect, test } from "vitest";
import {
  roundedRectPolygon, regularPolygon, ellipsePolygon,
  slotPolygon, starPolygon, ringSectorPolygon,
} from "../src/framework/geometry/polygon.js";

const signedArea = (p) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};
const bbox = (p) => {
  const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const [x, y] of p) { lo[0] = Math.min(lo[0], x); lo[1] = Math.min(lo[1], y); hi[0] = Math.max(hi[0], x); hi[1] = Math.max(hi[1], y); }
  return { w: hi[0] - lo[0], h: hi[1] - lo[1] };
};

test("every profile is CCW (positive signed area)", () => {
  expect(signedArea(roundedRectPolygon(40, 20, 4))).toBeGreaterThan(0);
  expect(signedArea(regularPolygon(6, 10))).toBeGreaterThan(0);
  expect(signedArea(ellipsePolygon(10, 5))).toBeGreaterThan(0);
  expect(signedArea(slotPolygon(20, 4))).toBeGreaterThan(0);
  expect(signedArea(starPolygon(5, 10, 4))).toBeGreaterThan(0);
  expect(signedArea(ringSectorPolygon(5, 10, 90))).toBeGreaterThan(0);
});

test("roundedRectPolygon spans w x h and clamps the corner radius", () => {
  const b = bbox(roundedRectPolygon(40, 20, 4));
  expect(b.w).toBeCloseTo(40, 6);
  expect(b.h).toBeCloseTo(20, 6);
  // r clamped to min(w,h)/2 = 10 → a 20x20 with r=10 is a circle-ish, still 20 wide
  expect(bbox(roundedRectPolygon(20, 20, 999)).w).toBeCloseTo(20, 6);
});

test("regularPolygon returns n vertices on the circumradius", () => {
  const p = regularPolygon(6, 10);
  expect(p.length).toBe(6);
  for (const [x, y] of p) expect(Math.hypot(x, y)).toBeCloseTo(10, 6);
});

test("ellipsePolygon spans 2*rx by 2*ry", () => {
  const b = bbox(ellipsePolygon(10, 5));
  expect(b.w).toBeCloseTo(20, 6);
  expect(b.h).toBeCloseTo(10, 6);
});

test("slotPolygon overall length is length + 2r", () => {
  expect(bbox(slotPolygon(20, 4)).w).toBeCloseTo(28, 6);
  expect(bbox(slotPolygon(20, 4)).h).toBeCloseTo(8, 6);
});

test("starPolygon alternates outer and inner radius over 2*points vertices", () => {
  const p = starPolygon(5, 10, 4);
  expect(p.length).toBe(10);
  expect(Math.hypot(...p[0])).toBeCloseTo(10, 6);
  expect(Math.hypot(...p[1])).toBeCloseTo(4, 6);
});

test("ringSectorPolygon rejects a full 360 ring", () => {
  expect(() => ringSectorPolygon(5, 10, 360)).toThrow(/< 360/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nvm use && npx vitest run test/profiles.test.js`
Expected: FAIL — `roundedRectPolygon is not a function` (etc.).

- [ ] **Step 3: Implement the helpers**

Append to `src/framework/geometry/polygon.js`:

```js
// Rectangle w×h centred at the origin with radius-r corners (r clamped to min(w,h)/2).
export function roundedRectPolygon(w, h, r, segs = 8) {
  r = Math.min(r, Math.min(w, h) / 2);
  const hw = w / 2, hh = h / 2;
  if (r <= 0) return [[hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh]];
  const corners = [
    [hw - r, hh - r, 0],                 // top-right
    [-(hw - r), hh - r, Math.PI / 2],    // top-left
    [-(hw - r), -(hh - r), Math.PI],     // bottom-left
    [hw - r, -(hh - r), (3 * Math.PI) / 2], // bottom-right
  ];
  const pts = [];
  for (const [cx, cy, a0] of corners)
    for (let i = 0; i <= segs; i++) {
      const a = a0 + (Math.PI / 2) * (i / segs);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  return pts;
}

// Regular n-gon, circumradius r. Vertex up by default; flat:true puts a flat edge up.
export function regularPolygon(n, r, { flat = false } = {}) {
  const base = Math.PI / 2 + (flat ? Math.PI / n : 0);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = base + (2 * Math.PI * i) / n;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}

// Ellipse with semi-axes rx, ry.
export function ellipsePolygon(rx, ry, segs = 48) {
  const pts = [];
  for (let i = 0; i < segs; i++) {
    const a = (2 * Math.PI * i) / segs;
    pts.push([rx * Math.cos(a), ry * Math.sin(a)]);
  }
  return pts;
}

// Stadium/obround slot: two r-radius semicircles whose centres are `length` apart
// (overall length = length + 2r), centred at the origin, long axis along X.
export function slotPolygon(length, r, segs = 16) {
  const hl = length / 2;
  const pts = [];
  for (let i = 0; i <= segs; i++) { const a = -Math.PI / 2 + Math.PI * (i / segs); pts.push([hl + r * Math.cos(a), r * Math.sin(a)]); }
  for (let i = 0; i <= segs; i++) { const a = Math.PI / 2 + Math.PI * (i / segs); pts.push([-hl + r * Math.cos(a), r * Math.sin(a)]); }
  return pts;
}

// Star with `points` tips, alternating outer/inner radius. First tip points up.
export function starPolygon(points, outerR, innerR) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const a = Math.PI / 2 + (Math.PI * i) / points;
    const rr = i % 2 === 0 ? outerR : innerR;
    pts.push([rr * Math.cos(a), rr * Math.sin(a)]);
  }
  return pts;
}

// Annular sector as a single closed contour (outer arc, then inner arc back).
// arcDeg must be < 360 — a full annulus is a contour-with-hole; cut an inner
// cylinder from an outer one for a full ring.
export function ringSectorPolygon(innerR, outerR, arcDeg, segs = 32) {
  if (arcDeg >= 360) throw new Error("ringSectorPolygon: arcDeg must be < 360 (use a cut for a full ring)");
  const a = (arcDeg * Math.PI) / 180;
  const steps = Math.max(2, Math.ceil((segs * arcDeg) / 360));
  const pts = [];
  for (let i = 0; i <= steps; i++) { const t = (a * i) / steps; pts.push([outerR * Math.cos(t), outerR * Math.sin(t)]); }
  for (let i = steps; i >= 0; i--) { const t = (a * i) / steps; pts.push([innerR * Math.cos(t), innerR * Math.sin(t)]); }
  return pts;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nvm use && npx vitest run test/profiles.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/polygon.js test/profiles.test.js
git commit -m "feat: add 2D profile helpers (roundedRect, regularPolygon, ellipse, slot, star, ringSector)"
```

---

## Task 2: `clone()` on Solid

Add `clone()` to both backends and the probe. Needed by the pattern helpers (Task 6).

**Files:**
- Modify: `src/framework/geometry/kernel.js` (typedef)
- Modify: `src/framework/geometry/manifold-backend.js` (the `wrap` object, ~line 51)
- Modify: `src/framework/geometry/occt-backend.js` (the `wrap` object, ~line 79)
- Modify: `src/framework/geometry/probe.js` (the `proxy` object, ~line 9)
- Test: `test/manifold-backend.test.js` (extend), `test/occt-backend.test.js` (extend)

**Interfaces:**
- Produces: `s.clone() => Solid` on both backends. Manifold solids are immutable so `clone()` returns a new wrapper over the same handle; replicad's `clone()` makes a real independent copy so the original survives a consuming transform.

- [ ] **Step 1: Write the failing Manifold test**

Append to `test/manifold-backend.test.js`:

```js
test("clone() yields an independent usable solid", () => {
  const a = k.box([0, 0, 0], [10, 10, 10]);
  const b = a.clone().translate([20, 0, 0]);
  expect(a.volume()).toBeCloseTo(1000, 0);
  expect(b.volume()).toBeCloseTo(1000, 0);
});
```

- [ ] **Step 2: Write the failing OCCT test**

Append to `test/occt-backend.test.js`:

```js
test("clone() lets the original survive a consuming transform", () => {
  const a = k.box([0, 0, 0], [10, 10, 10]);
  const moved = a.clone().translate([20, 0, 0]); // consumes the clone, not `a`
  expect(a.volume()).toBeCloseTo(1000, 0);        // original still usable
  expect(moved.volume()).toBeCloseTo(1000, 0);
});
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `nvm use && npx vitest run test/manifold-backend.test.js test/occt-backend.test.js -t clone`
Expected: FAIL — `a.clone is not a function`.

- [ ] **Step 4: Implement clone in the Manifold backend**

In `src/framework/geometry/manifold-backend.js`, inside the `wrap` object literal (after `intersect:`), add:

```js
    clone: () => wrap(m),
```

- [ ] **Step 5: Implement clone in the OCCT backend**

In `src/framework/geometry/occt-backend.js`, inside the `wrap` object literal (after `cutAll:`), add:

```js
    clone: () => wrap(shape.clone()),
```

- [ ] **Step 6: Record clone in the probe**

In `src/framework/geometry/probe.js`, inside the `proxy` object (after `intersect()`), add:

```js
    clone() { note("clone"); return proxy; },
```

- [ ] **Step 7: Document clone in the kernel contract**

In `src/framework/geometry/kernel.js`, add to the `Solid` typedef (after the `intersect` line):

```js
 * @property {() => Solid} clone   independent copy (replicad consumes solids on transform)
```

- [ ] **Step 8: Run both test files to verify they pass**

Run: `nvm use && npx vitest run test/manifold-backend.test.js test/occt-backend.test.js -t clone`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/framework/geometry/kernel.js src/framework/geometry/manifold-backend.js src/framework/geometry/occt-backend.js src/framework/geometry/probe.js test/manifold-backend.test.js test/occt-backend.test.js
git commit -m "feat: add Solid.clone() to both backends"
```

---

## Task 3: `boundingBox()` query on Solid

**Files:**
- Modify: `src/framework/geometry/kernel.js` (typedef)
- Modify: `src/framework/geometry/manifold-backend.js` (the `wrap` object)
- Modify: `src/framework/geometry/occt-backend.js` (the `wrap` object)
- Modify: `src/framework/geometry/probe.js` (the `proxy` object)
- Test: `test/manifold-backend.test.js` (extend), `test/occt-backend.test.js` (extend)

**Interfaces:**
- Produces: `s.boundingBox() => { min:[x,y,z], max:[x,y,z], center:[x,y,z], size:[x,y,z] }` on both backends. Query only — does not consume the solid.

- [ ] **Step 1: Write the failing Manifold test**

Append to `test/manifold-backend.test.js`:

```js
test("boundingBox reports min/max/center/size of a box", () => {
  const bb = k.box([0, 0, 0], [10, 20, 30]).boundingBox();
  expect(bb.min).toEqual([0, 0, 0]);
  expect(bb.max[0]).toBeCloseTo(10, 6);
  expect(bb.max[1]).toBeCloseTo(20, 6);
  expect(bb.max[2]).toBeCloseTo(30, 6);
  expect(bb.center).toEqual([5, 10, 15]);
  expect(bb.size).toEqual([10, 20, 30]);
});
```

- [ ] **Step 2: Write the failing OCCT test**

Append to `test/occt-backend.test.js`:

```js
test("boundingBox reports size/center of a box (query does not consume)", () => {
  const b = k.box([0, 0, 0], [10, 20, 30]);
  const bb = b.boundingBox();
  expect(bb.size[0]).toBeCloseTo(10, 3);
  expect(bb.size[1]).toBeCloseTo(20, 3);
  expect(bb.size[2]).toBeCloseTo(30, 3);
  expect(bb.center[0]).toBeCloseTo(5, 3);
  expect(b.volume()).toBeCloseTo(6000, 0); // still usable after the query
});
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `nvm use && npx vitest run test/manifold-backend.test.js test/occt-backend.test.js -t boundingBox`
Expected: FAIL — `b.boundingBox is not a function`.

- [ ] **Step 4: Implement boundingBox in the Manifold backend**

In `manifold-backend.js`, inside the `wrap` object (after `clone:`), add:

```js
    boundingBox: () => {
      const b = m.boundingBox();           // { min: Vec3, max: Vec3 }
      const min = [...b.min], max = [...b.max];
      return {
        min, max,
        center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
        size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      };
    },
```

- [ ] **Step 5: Implement boundingBox in the OCCT backend**

In `occt-backend.js`, inside the `wrap` object (after `clone:`), add:

```js
    boundingBox: () => {
      const bb = shape.boundingBox;        // replicad BoundingBox: .bounds [[min],[max]], .center
      const [min, max] = bb.bounds;
      return {
        min: [...min], max: [...max], center: [...bb.center],
        size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      };
    },
```

- [ ] **Step 6: Record boundingBox in the probe**

In `probe.js`, inside the `proxy` object (after `clone()`), add:

```js
    boundingBox() { note("boundingBox"); return { min: [0, 0, 0], max: [1, 1, 1], center: [0.5, 0.5, 0.5], size: [1, 1, 1] }; },
```

- [ ] **Step 7: Document boundingBox in the kernel contract**

In `kernel.js`, add to the `Solid` typedef:

```js
 * @property {() => {min:number[],max:number[],center:number[],size:number[]}} boundingBox   axis-aligned bounds (query)
```

- [ ] **Step 8: Run both test files to verify they pass**

Run: `nvm use && npx vitest run test/manifold-backend.test.js test/occt-backend.test.js -t boundingBox`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/framework/geometry/kernel.js src/framework/geometry/manifold-backend.js src/framework/geometry/occt-backend.js src/framework/geometry/probe.js test/manifold-backend.test.js test/occt-backend.test.js
git commit -m "feat: add Solid.boundingBox() query to both backends"
```

---

## Task 4: `sphere` primitive

**Files:**
- Modify: `src/framework/geometry/kernel.js` (typedef)
- Modify: `src/framework/geometry/manifold-backend.js` (kernel return object, ~line 74)
- Modify: `src/framework/geometry/occt-backend.js` (destructure + kernel return, ~line 8 and ~line 130)
- Modify: `src/framework/geometry/probe.js` (the `kernel` object, ~line 23)
- Test: `test/manifold-backend.test.js` (extend), `test/occt-backend.test.js` (extend)

**Interfaces:**
- Produces: `k.sphere(r) => Solid` — sphere centred at the origin, on both backends.

- [ ] **Step 1: Write the failing Manifold test**

Append to `test/manifold-backend.test.js`:

```js
test("sphere volume is ~4/3 pi r^3", () => {
  const r = 10;
  const v = k.sphere(r).volume();
  expect(v).toBeCloseTo((4 / 3) * Math.PI * r ** 3, -1); // within ~10mm³ (faceting)
});
```

- [ ] **Step 2: Write the failing OCCT test**

Append to `test/occt-backend.test.js`:

```js
test("sphere volume is ~4/3 pi r^3", () => {
  const r = 10;
  expect(k.sphere(r).volume()).toBeCloseTo((4 / 3) * Math.PI * r ** 3, -1);
});
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `nvm use && npx vitest run test/manifold-backend.test.js test/occt-backend.test.js -t sphere`
Expected: FAIL — `k.sphere is not a function`.

- [ ] **Step 4: Implement sphere in the Manifold backend**

In `manifold-backend.js`, in the returned kernel object (after the `cylinder:` line), add:

```js
    sphere: (r) => wrap(T(Manifold.sphere(r, segs))),
```

- [ ] **Step 5: Implement sphere in the OCCT backend**

In `occt-backend.js`, add `makeSphere` to the destructure on line ~8:

```js
  const { makeCylinder, makeBox, makeCircle, makeHelix, assembleWire, genericSweep,
          makeCompound, loft, draw, exportSTEP, measureVolume, makeSphere } = replicad;
```

Then in the returned kernel object (the `return { cylinder, box: ..., }` block), add `sphere`:

```js
    sphere: (r) => wrap(makeSphere(r)),
```

- [ ] **Step 6: Record sphere in the probe**

In `probe.js`, inside the `kernel` object (after `cylinder()`), add:

```js
    sphere() { note("sphere"); return proxy; },
```

- [ ] **Step 7: Document sphere in the kernel contract**

In `kernel.js`, add to the `GeometryKernel` typedef (after the `cylinder` line):

```js
 * @property {(r:number) => Solid} sphere   sphere centred at the origin
```

- [ ] **Step 8: Run both test files to verify they pass**

Run: `nvm use && npx vitest run test/manifold-backend.test.js test/occt-backend.test.js -t sphere`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/framework/geometry/kernel.js src/framework/geometry/manifold-backend.js src/framework/geometry/occt-backend.js src/framework/geometry/probe.js test/manifold-backend.test.js test/occt-backend.test.js
git commit -m "feat: add sphere primitive to both backends"
```

---

## Task 5: `revolve` (lathe profile around Z)

**Files:**
- Modify: `src/framework/geometry/kernel.js` (typedef)
- Modify: `src/framework/geometry/manifold-backend.js` (kernel return object)
- Modify: `src/framework/geometry/occt-backend.js` (a `revolve` function + kernel return)
- Modify: `src/framework/geometry/probe.js` (the `kernel` object)
- Test: `test/manifold-backend.test.js` (extend), `test/occt-backend.test.js` (extend)

**Interfaces:**
- Produces: `k.revolve(points2D, { degrees = 360 } = {}) => Solid`. `points2D` is `[[r, z], …]` (r = radius ≥ 0, z = height), revolved around the Z axis. Negative `r` throws. Partial revolves (`degrees < 360`) get flat end-caps.
- Note: Manifold's `revolve` revolves around its Y axis and then remaps that to Z, so the `[r, z]` profile maps directly with no extra reorientation.

- [ ] **Step 1: Write the failing Manifold test**

Append to `test/manifold-backend.test.js`:

```js
test("revolve of a rectangular profile equals a cylinder volume", () => {
  // profile r in [0,10], z in [0,20] → solid cylinder r=10 h=20
  const rect = [[0, 0], [10, 0], [10, 20], [0, 20]];
  const v = k.revolve(rect).volume();
  expect(v).toBeCloseTo(Math.PI * 10 ** 2 * 20, -2); // within ~100mm³ (faceting)
});

test("a half revolve is about half the volume", () => {
  const rect = [[0, 0], [10, 0], [10, 20], [0, 20]];
  const full = k.revolve(rect).volume();
  const half = k.revolve(rect, { degrees: 180 }).volume();
  expect(half).toBeLessThan(full * 0.6);
  expect(half).toBeGreaterThan(full * 0.4);
});

test("revolve rejects a negative radius", () => {
  expect(() => k.revolve([[-1, 0], [10, 0], [10, 20]])).toThrow(/radius must be/);
});
```

- [ ] **Step 2: Write the failing OCCT test**

Append to `test/occt-backend.test.js`:

```js
test("revolve of a rectangular profile equals a cylinder volume", () => {
  const rect = [[0, 0], [10, 0], [10, 20], [0, 20]];
  expect(k.revolve(rect).volume()).toBeCloseTo(Math.PI * 10 ** 2 * 20, -2);
});

test("revolve rejects a negative radius", () => {
  expect(() => k.revolve([[-1, 0], [10, 0], [10, 20]])).toThrow(/radius must be/);
});
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `nvm use && npx vitest run test/manifold-backend.test.js test/occt-backend.test.js -t revolve`
Expected: FAIL — `k.revolve is not a function`.

- [ ] **Step 4: Implement revolve in the Manifold backend**

In `manifold-backend.js`, in the returned kernel object (after `sphere:`), add:

```js
    revolve: (pts, { degrees = 360 } = {}) => {
      for (const [r] of pts) if (r < 0) throw new Error("revolve: profile radius must be ≥ 0");
      return wrap(T(Manifold.revolve([pts], segs, degrees)));
    },
```

- [ ] **Step 5: Implement revolve in the OCCT backend**

In `occt-backend.js`, after the `prism` function (~line 119), add a `revolve` function:

```js
  // revolve a lathe profile [[r,z],…] around the Z axis (degrees defaults to 360)
  const revolve = (pts, { degrees = 360 } = {}) => {
    for (const [r] of pts) if (r < 0) throw new Error("revolve: profile radius must be ≥ 0");
    let pen = draw(pts[0]);
    for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
    const sketch = pen.close().sketchOnPlane("XZ");
    return wrap(sketch.revolve([0, 0, 1], { angle: degrees }));
  };
```

Then add `revolve` to the returned kernel object (the `return { cylinder, box: ..., prism, helixSweptTube, ... }` line):

```js
    cylinder, box: (min, max) => wrap(makeBox(min, max)), prism, revolve, helixSweptTube, sphere: (r) => wrap(makeSphere(r)),
```

(Adjust to keep `sphere` from Task 4 — merge the two; the final return lists `cylinder, box, prism, revolve, helixSweptTube, sphere, union, toSTEP`.)

- [ ] **Step 6: Record revolve in the probe**

In `probe.js`, inside the `kernel` object (after `prism()`), add:

```js
    revolve() { note("revolve"); return proxy; },
```

- [ ] **Step 7: Document revolve in the kernel contract**

In `kernel.js`, add to the `GeometryKernel` typedef (after `prism`):

```js
 * @property {(points2D:number[][], opts?:{degrees?:number}) => Solid} revolve   revolve a lathe profile [[r,z],…] around Z
```

- [ ] **Step 8: Run both test files to verify they pass**

Run: `nvm use && npx vitest run test/manifold-backend.test.js test/occt-backend.test.js -t revolve`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/framework/geometry/kernel.js src/framework/geometry/manifold-backend.js src/framework/geometry/occt-backend.js src/framework/geometry/probe.js test/manifold-backend.test.js test/occt-backend.test.js
git commit -m "feat: add revolve (lathe profile around Z) to both backends"
```

---

## Task 6: Pattern helpers (linearPattern, circularPattern)

Pure-JS helpers in `polygon.js` that compose `clone()` (Task 2), `translate`, `rotate`, and `boundingBox()` (Task 3). They return `Solid[]` for the caller to feed to `k.union(...)` or `s.cutAll(...)`.

**Files:**
- Modify: `src/framework/geometry/polygon.js` (append helpers)
- Test: `test/patterns.test.js` (create — Manifold-backed)

**Interfaces:**
- Consumes: `Solid.clone()`, `Solid.translate([x,y,z])`, `Solid.rotate(deg, center, axis)`, `Solid.boundingBox()`.
- Produces:
  - `linearPattern(solid, count, step) => Solid[]` — copies at `i*step` for `i` in `0..count-1`; `step` is `[dx,dy,dz]`.
  - `circularPattern(solid, count, { center = [0,0,0], axis = "Z", angle = 360, rotateCopies = true } = {}) => Solid[]` — `count` copies spaced `angle/count` apart around `axis` through `center`. `rotateCopies:false` keeps each copy's original orientation (places it at the orbital position only).

- [ ] **Step 1: Write the failing tests**

Create `test/patterns.test.js`:

```js
import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { linearPattern, circularPattern } from "../src/framework/geometry/polygon.js";
import { bboxSize } from "../src/testing/mesh.js";

let k;
beforeAll(async () => { const w = await Module(); w.setup(); k = createManifoldKernel(w, { quality: "preview" }); });

test("linearPattern makes `count` copies the union of which spans the run", () => {
  const unit = k.box([-1, -1, -1], [1, 1, 1]);          // 2mm cube at origin
  const copies = linearPattern(unit, 4, [10, 0, 0]);
  expect(copies.length).toBe(4);
  const [w] = bboxSize(k.union(copies).toMesh().positions);
  expect(w).toBeCloseTo(32, 1);                          // 0..30 plus the 2mm cube width
});

test("circularPattern makes `count` copies arranged around the axis", () => {
  const tool = k.box([18, -1, -1], [22, 1, 1]);          // a tab out at radius ~20 on +X
  const copies = circularPattern(tool, 4, { axis: "Z" });
  expect(copies.length).toBe(4);
  const u = k.union(copies).toMesh().positions;
  const [w, h] = bboxSize(u);
  expect(w).toBeCloseTo(44, 0);                          // tabs reach ±22 on X and Y
  expect(h).toBeCloseTo(44, 0);
});

test("rotateCopies:false keeps each copy axis-aligned", () => {
  const tool = k.box([18, -1, -2], [22, 1, 2]);          // longer in Z
  const rotated = circularPattern(tool, 4, { axis: "Z", rotateCopies: true });
  const fixed = circularPattern(tool, 4, { axis: "Z", rotateCopies: false });
  // every fixed copy keeps the original Z-extent of 4; bbox Z stays 4
  expect(bboxSize(k.union(fixed).toMesh().positions)[2]).toBeCloseTo(4, 1);
  expect(rotated.length).toBe(4);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nvm use && npx vitest run test/patterns.test.js`
Expected: FAIL — `linearPattern is not a function`.

- [ ] **Step 3: Implement the pattern helpers**

Append to `src/framework/geometry/polygon.js`:

```js
const PATTERN_AXIS = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

// `count` copies of `solid` translated by i*step ([dx,dy,dz]) for i in 0..count-1.
// Returns a Solid[] — feed to k.union(...) (features) or s.cutAll(...) (holes).
export function linearPattern(solid, count, step) {
  const out = [];
  for (let i = 0; i < count; i++)
    out.push(solid.clone().translate([step[0] * i, step[1] * i, step[2] * i]));
  return out;
}

// `count` copies spaced angle/count degrees apart around `axis` through `center`.
// rotateCopies:true re-orients each copy to face along the circle; false places it
// at the orbital position with its original orientation (for radially symmetric tools).
export function circularPattern(solid, count, { center = [0, 0, 0], axis = "Z", angle = 360, rotateCopies = true } = {}) {
  const ax = Array.isArray(axis) ? axis : PATTERN_AXIS[axis];
  const out = [];
  for (let i = 0; i < count; i++) {
    const deg = (angle / count) * i;
    const placed = solid.clone().rotate(deg, center, ax);
    if (rotateCopies) { out.push(placed); continue; }
    // cancel the orientation change by counter-rotating about the copy's own centre
    const c = placed.boundingBox().center;
    out.push(placed.rotate(-deg, c, ax));
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `nvm use && npx vitest run test/patterns.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/polygon.js test/patterns.test.js
git commit -m "feat: add linearPattern and circularPattern helpers"
```

---

## Task 7: Face selector + OCCT-routed `shell`

`shell` hollows inward (wall = `thickness`, outer dimensions preserved), removing the face(s) chosen by `openFaces` (required). OCCT-only: Manifold throws `KernelCapabilityError`, and the part auto-routes to OCCT via the probe.

**Files:**
- Create: `src/framework/geometry/face-selector.js`
- Modify: `src/framework/geometry/manifold-backend.js` (the `wrap` object — add `shell` that throws)
- Modify: `src/framework/geometry/occt-backend.js` (import `toFaceFinder`; add `shell` to the `wrap` object)
- Modify: `src/framework/geometry/probe.js` (add `shell` to `OCCT_ONLY` and to `proxy`)
- Modify: `src/framework/geometry/kernel.js` (typedef)
- Test: `test/face-selector.test.js` (create), `test/occt-shell.test.js` (create), `test/capability.test.js` (extend), `test/probe.test.js` (extend)

**Interfaces:**
- Consumes: replicad `FaceFinder` (`inPlane`, `parallelTo`, `containsPoint`).
- Produces:
  - `toFaceFinder(selector) => ((FaceFinder) => FaceFinder) | undefined` (in `face-selector.js`). Maps `{ inPlane, at } / { dir } / { near }` (AND of given criteria) or a raw finder function; `null`/`undefined` → `undefined`.
  - `s.shell(thickness, openFaces) => Solid`. `openFaces` is the selector (required). Manifold throws `KernelCapabilityError`.

- [ ] **Step 1: Write the failing face-selector test**

Create `test/face-selector.test.js`:

```js
import { expect, test } from "vitest";
import { toFaceFinder } from "../src/framework/geometry/face-selector.js";

// A minimal fake FaceFinder recording which filters were applied.
const fakeFinder = () => {
  const calls = [];
  const f = {
    calls,
    inPlane(plane, at) { calls.push(["inPlane", plane, at]); return f; },
    parallelTo(plane) { calls.push(["parallelTo", plane]); return f; },
    containsPoint(p) { calls.push(["containsPoint", p]); return f; },
  };
  return f;
};

test("null selector → undefined (all faces)", () => {
  expect(toFaceFinder(undefined)).toBeUndefined();
  expect(toFaceFinder(null)).toBeUndefined();
});

test("a raw function passes through", () => {
  const fn = (f) => f;
  expect(toFaceFinder(fn)).toBe(fn);
});

test("inPlane+at maps to FaceFinder.inPlane", () => {
  const f = fakeFinder();
  toFaceFinder({ inPlane: "XY", at: 16 })(f);
  expect(f.calls).toContainEqual(["inPlane", "XY", 16]);
});

test("dir maps to parallelTo the perpendicular plane (Z → XY)", () => {
  const f = fakeFinder();
  toFaceFinder({ dir: "Z" })(f);
  expect(f.calls).toContainEqual(["parallelTo", "XY"]);
});

test("near maps to containsPoint", () => {
  const f = fakeFinder();
  toFaceFinder({ near: [0, 0, 16] })(f);
  expect(f.calls).toContainEqual(["containsPoint", [0, 0, 16]]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `nvm use && npx vitest run test/face-selector.test.js`
Expected: FAIL — cannot find module `face-selector.js`.

- [ ] **Step 3: Implement the face selector**

Create `src/framework/geometry/face-selector.js`:

```js
// Map partforge's declarative face selector onto a replicad FaceFinder filter.
//   undefined / null   → undefined (all faces)
//   (f) => f...         → passed through (raw replicad finder escape hatch)
//   { dir, inPlane, at, near } → a filter applying the given criteria (AND)
// dir picks faces whose normal runs along that axis (i.e. parallel to the
// perpendicular plane): X→YZ, Y→XZ, Z→XY.
const PERP_PLANE = { X: "YZ", Y: "XZ", Z: "XY" };

export function toFaceFinder(selector) {
  if (selector == null) return undefined;
  if (typeof selector === "function") return selector;
  return (f) => {
    let r = f;
    if (selector.dir != null) r = r.parallelTo(PERP_PLANE[selector.dir]);
    if (selector.inPlane != null) r = r.inPlane(selector.inPlane, selector.at);
    if (selector.near != null) r = r.containsPoint(selector.near);
    return r;
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `nvm use && npx vitest run test/face-selector.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing Manifold capability + probe tests**

Append to `test/capability.test.js`:

```js
test("Manifold shell throws KernelCapabilityError with code NEEDS_OCCT", () => {
  try { k.box([0, 0, 0], [10, 10, 10]).shell(1, { dir: "Z" }); }
  catch (e) { expect(e).toBeInstanceOf(KernelCapabilityError); expect(e.code).toBe("NEEDS_OCCT"); }
});
```

Append to `test/probe.test.js`:

```js
test("a part using shell routes to occt", () => {
  const shelled = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) => k.box([0, 0, 0], [10, 10, 10]).shell(1, { dir: "Z" }) } } };
  expect(detectBackend(shelled)).toBe("occt");
});
```

- [ ] **Step 6: Write the failing OCCT shell test**

Create `test/occt-shell.test.js`:

```js
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

test("shell hollows a box inward, keeping outer dimensions", () => {
  const solidV = k.box([0, 0, 0], [20, 20, 20]).volume(); // 8000
  const cup = k.box([0, 0, 0], [20, 20, 20]).shell(2, { inPlane: "XY", at: 20 }); // open top
  const v = cup.volume();
  expect(v).toBeLessThan(solidV);        // material removed
  expect(v).toBeGreaterThan(1000);       // a wall remains (not vanished)
  // outer footprint unchanged
  expect(cup.boundingBox().size[0]).toBeCloseTo(20, 1);
  expect(cup.boundingBox().size[1]).toBeCloseTo(20, 1);
  expect(cup.toMesh().triangles).toBeGreaterThan(0);
});

test("shell requires openFaces", () => {
  expect(() => k.box([0, 0, 0], [10, 10, 10]).shell(1)).toThrow(/openFaces/);
});
```

- [ ] **Step 7: Run the OCCT/capability/probe tests to verify they fail**

Run: `nvm use && npx vitest run test/occt-shell.test.js test/capability.test.js test/probe.test.js -t shell`
Expected: FAIL — `shell is not a function` / not routing to occt.

- [ ] **Step 8: Implement shell in the Manifold backend (throw)**

In `manifold-backend.js`, inside the `wrap` object (next to `fillet`/`chamfer`), add:

```js
    shell: () => { throw new KernelCapabilityError("shell requires the OCCT backend"); },
```

- [ ] **Step 9: Implement shell in the OCCT backend**

In `occt-backend.js`, add the import at the top (next to the edge-selector import):

```js
import { toFaceFinder } from "./face-selector.js";
```

Then inside the `wrap` object (after `chamfer:`), add:

```js
    shell: (thickness, openFaces) => {
      if (openFaces == null) throw new Error("shell: openFaces is required (a fully closed hollow is not supported)");
      // replicad shells inward with a negative thickness, keeping outer dimensions.
      return wrap(safeOp(shape, (sh) => sh.shell(-thickness, toFaceFinder(openFaces)), `shell(${thickness})`));
    },
```

> If the volume-drop test fails because volume *grew*, the sign is inverted for this
> replicad version — change `-thickness` to `thickness`. The test pins the correct sign.

- [ ] **Step 10: Route shell to OCCT in the probe**

In `probe.js`, extend `OCCT_ONLY` and add a `shell` proxy entry:

```js
export const OCCT_ONLY = new Set(["fillet", "chamfer", "shell"]);
```

In the `proxy` object (after `chamfer()`):

```js
    shell() { note("shell"); return proxy; },
```

- [ ] **Step 11: Document shell in the kernel contract**

In `kernel.js`, add to the `Solid` typedef (near `fillet`/`chamfer` if present, else after `boundingBox`):

```js
 * @property {(thickness:number, openFaces:object) => Solid} shell   hollow inward (OCCT only); openFaces selector required
```

- [ ] **Step 12: Run all the affected tests to verify they pass**

Run: `nvm use && npx vitest run test/occt-shell.test.js test/face-selector.test.js test/capability.test.js test/probe.test.js`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add src/framework/geometry/face-selector.js src/framework/geometry/manifold-backend.js src/framework/geometry/occt-backend.js src/framework/geometry/probe.js src/framework/geometry/kernel.js test/face-selector.test.js test/occt-shell.test.js test/capability.test.js test/probe.test.js
git commit -m "feat: add OCCT-routed shell() and a face selector"
```

---

## Task 8: Documentation

Document the new vocabulary in the authoring guide.

**Files:**
- Modify: `docs/AUTHORING-PARTS.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Extend the "make solids" table**

In `docs/AUTHORING-PARTS.md`, in the "Kernel — make solids" table, add rows:

```markdown
| `k.sphere(r)` | sphere centred at the origin |
| `k.revolve(points2D, { degrees })` | revolve a lathe profile `[[r,z],…]` (r ≥ 0) around the Z axis (full or partial) |
```

- [ ] **Step 2: Extend the `Solid` table**

In the "`Solid` — combine / transform / export" table, add rows:

```markdown
| `s.clone()` | independent copy (replicad consumes solids on transform) |
| `s.boundingBox()` | `{ min, max, center, size }` axis-aligned bounds (query) |
```

- [ ] **Step 3: Add a "Profiles & patterns" subsection**

After the parameters/geometry sections, add:

```markdown
## Profiles & patterns

Pure helpers from `partforge/geometry` (no backend dependency):

**2-D profiles** (CCW point arrays for `k.prism` / `k.revolve`):
`roundedRectPolygon(w,h,r)`, `regularPolygon(n,r,{flat})`, `ellipsePolygon(rx,ry)`,
`slotPolygon(length,r)` (overall length = `length + 2r`), `starPolygon(points,outerR,innerR)`,
`ringSectorPolygon(innerR,outerR,arcDeg)` (**arcDeg < 360** — a full ring is a contour-with-hole;
cut an inner cylinder from an outer one instead).

**Patterns** (return `Solid[]` — feed to `k.union(...)` for features or `s.cutAll(...)` for holes):
`linearPattern(solid, count, [dx,dy,dz])`, `circularPattern(solid, count, { center, axis, angle, rotateCopies })`.

```js
const hole = k.cylinder(2, 2, 20).translate([20, 0, 0]);
body = body.cutAll(circularPattern(hole, 8, { axis: "Z" }));   // 8 bolt holes on a 40mm circle
```
```

- [ ] **Step 4: Add `shell` to the OCCT-routed op table**

In the "Fillet & chamfer (automatic OCCT backend)" section's op table, add a row:

```markdown
| `s.shell(thickness, openFaces)` | hollow inward, wall = `thickness`; `openFaces` selector (`{inPlane,at}`/`{dir}`/`{near}`) chooses which face(s) to open. Closed (no-open-face) hollows are not supported. |
```

- [ ] **Step 5: Commit**

```bash
git add docs/AUTHORING-PARTS.md
git commit -m "docs: document sphere, revolve, clone, boundingBox, shell, profiles & patterns"
```

---

## Self-review notes

- **Spec coverage:** sphere (T4), revolve (T5), clone (T2), boundingBox (T3), shell (T7), profile helpers (T1), pattern helpers (T6), face-selector (T7), probe routing (T2–T5, T7), docs (T8) — all covered.
- **Spec deviation:** the spec's "omit `shell` for a closed void" is **dropped** — replicad's `shell` requires a face to remove and exposes no clean 3D solid-offset, so `openFaces` is required and the closed-void case is deferred. Spec amended to match.
- **Type consistency:** `boundingBox()` returns `{min,max,center,size}` everywhere (T3 def, T6 + T7 consumers). `toFaceFinder` mirrors `toEdgeFinder`'s shape. Pattern helpers return `Solid[]` consumed by `k.union`/`s.cutAll`.
- **Ordering:** T6 (patterns) depends on T2 (clone) + T3 (boundingBox); both precede it. T7 (shell) is independent. T8 (docs) last.
