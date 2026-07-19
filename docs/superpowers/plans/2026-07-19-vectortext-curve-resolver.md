# vectorText Curve Fill-Resolver Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the broken endpoint-containment glyph classifier with a curve-preserving, font-format-aware fill resolver built on paper.js, so `k.text2d` renders overlapping and self-intersecting glyphs correctly on both backends with beziers intact.

**Architecture:** A new pure, DOM-free module resolves a glyph's raw (self-intersecting / overlapping) cubic contours into simple `{outer, holes}` curve regions using a private paper.js `PaperScope`: per-contour `resolveCrossings()` → `CompoundPath` with the font's fill rule → `unite(self)`. TrueType and CFF2 use nonzero winding; CFF1 uses even-odd. Region grouping stays in Paper geometry (`Path.area`, `Path.interiorPoint`, `Path.contains`) until the final conversion to `pathProfile`, so no endpoint-only approximation is reintroduced. The resolved curve regions feed the existing `k.shape2d`, which is already curve-preserving on both backends (Manifold tessellates at mesh LOD; OCCT emits `cubicBezierCurveTo` B-rep edges → STEP `B_SPLINE`). The layout half of `text2d.js` remains unchanged.

**Tech Stack:** paper.js (`paper` ^0.12.18, imported as `paper/dist/paper-core.js` — DOM-free core, runs headless), opentype.js (existing), Manifold + replicad/OCCT kernels (existing).

## Global Constraints

- **Node 24** — run `nvm use` before any `npm`/`vitest`/CLI command, or geometry/tests fail confusingly.
- **Units are millimetres**; `size` in `text2d` = cap height in mm.
- **`build` and part/geometry modules must be pure and DOM-free** — no `Math.random`, clock, or module-level mutable state that leaks between builds; they load in both the main thread (schema) and the worker (build). Use the DOM-free `paper-core` entry with a private `new paper.PaperScope()`; no canvas is required.
- **Import geometry helpers from `partforge/geometry`, never `partforge`** (the main entry pulls in the DOM viewer).
- **OCCT and Manifold must not boot in the same process** — keep OCCT-booting tests in their own files; boot via `bootOcctKernel()` / `bootManifoldKernel()`.
- **replicad (OCCT) transforms consume their operand** — never reuse a solid/drawing after transforming; `.clone()` first.
- **Font fill rules:** TrueType (`glyf`) and CFF2 use `"nonzero"`; CFF1 (`CFF ` / Type 2 CharStrings) uses `"evenodd"`. Detect from `font.tables.cff` / `font.tables.cff2`; do not apply one rule to every font.
- **paper.js state hygiene:** create a resolver-owned `PaperScope`, never use or clear the package-global Paper project. Clear only the private scope's project after each resolve so builds stay pure and deterministic without disturbing another consumer that imports paper.js.
- **Dependency:** `paper` is a runtime dependency; `bezier-js` was removed (superseded). Do not reintroduce bezier-js.
- **The Manifold fill oracle is the correctness reference:** `CrossSection.ofPolygons(tessellatedContours, "NonZero" | "EvenOdd")` renders the expected fill. Tests must reconstruct the resolver's actual consumer semantics (one `EvenOdd` CrossSection per `{outer,holes}` region, then union the regions), not merely feed all output contours back through the original rule.

## Why paper.js is justified

- The current endpoint-containment classifier is observably wrong for the bundled Roboto: `B` loses a counter, `P` loses its counter, `L` gains a false hole, and `R`, `4`, `&`, `6`, `9`, and `e` are also misclassified.
- Manifold already evaluates the raw outlines correctly with its fill-rule-aware `CrossSection`, but only after tessellation; using it as the resolver would discard the exact cubic edges promised by OCCT/STEP.
- Replicad preserves curves but does not expose self-crossing resolution, and direct booleans on these glyph contours fail for the hard cases.
- The existing three.js `ShapePath.toShapes()` classifies subpaths by winding/containment but does not split self-intersections or normalize overlaps (`B` remains two filled shapes with no holes).
- Reimplementing robust cubic/cubic intersection splitting and boolean tracing locally would be substantially more code and risk than the dependency. `paper/dist/paper-core.js` supplies those operations headlessly and preserves cubic segments. Its minified artifact is about 208 KB raw / 71 KB gzip before Vite bundling; Task 4 records the actual production worker chunk sizes.

---

### Task 1: `curve-fill.js` — the format-aware curve resolver

**Files:**
- Create: `src/framework/geometry/curve-fill.js`
- Test: `test/curve-fill.test.js`

**Interfaces:**
- Consumes: `pathProfile` cubic contours `{ start:[x,y], segments:[{to}|{to,c1,c2}] }` (glyph outlines, font-unit space, y-up), plus `{ fillRule: "nonzero" | "evenodd" }`.
- Produces: `resolveCurveFill(contours, {fillRule}) => Array<{ outer, holes }>` where `outer` and each `holes[i]` are simple `pathProfile` cubic contours with correct nesting. Multiple entries represent disjoint filled pieces (for example `i`, `%`, `!`). Returns `[]` for empty input.

- [ ] **Step 1: Write the failing test** (`test/curve-fill.test.js`)

```js
import { describe, it, expect, beforeAll } from "vitest";
import Module from "manifold-3d";
import opentype from "opentype.js";
import { DEFAULT_FONT_BYTES } from "../src/framework/geometry/fonts/default-font.js";
import { pathProfile } from "../src/framework/geometry/polygon.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { resolveCurveFill } from "../src/framework/geometry/curve-fill.js";

// Build a glyph's raw cubic contours (y-up), mirroring text2d's glyph reader.
function glyphContours(font, ch) {
  const cmds = font.charToGlyph(ch).getPath(0, 0, font.unitsPerEm).commands;
  const cs = []; let pen = null, cur = null; const P = ([x, y]) => [x, -y];
  for (const c of cmds) {
    if (c.type === "M") { if (pen) cs.push(pen.close()); cur = P([c.x, c.y]); pen = pathProfile(cur); }
    else if (c.type === "L") { cur = P([c.x, c.y]); pen.lineTo(cur); }
    else if (c.type === "C") { pen.cubicTo(P([c.x, c.y]), P([c.x1, c.y1]), P([c.x2, c.y2])); cur = P([c.x, c.y]); }
    else if (c.type === "Q") { const p0 = cur, q = P([c.x1, c.y1]), e = P([c.x, c.y]);
      pen.cubicTo(e, [p0[0] + 2/3*(q[0]-p0[0]), p0[1] + 2/3*(q[1]-p0[1])], [e[0] + 2/3*(q[0]-e[0]), e[1] + 2/3*(q[1]-e[1])]); cur = e; }
    else if (c.type === "Z") { if (pen) { cs.push(pen.close()); pen = null; } }
  }
  if (pen) cs.push(pen.close());
  return cs;
}

let font, wasm, CrossSection;
beforeAll(async () => {
  const { buffer, byteOffset, byteLength } = DEFAULT_FONT_BYTES;
  font = opentype.parse(buffer.slice(byteOffset, byteOffset + byteLength));
  wasm = await Module(); wasm.setup(); CrossSection = wasm.CrossSection;
});

// Reconstruct exactly what k.text2d does: each {outer,holes} region goes through
// k.shape2d's EvenOdd region semantics, then all regions are unioned.
function resolvedArea(regions) {
  const parts = regions.map((r) => CrossSection.ofPolygons(
    [r.outer, ...r.holes].map((c) => tessellateContour(c, 120)), "EvenOdd"));
  if (parts.length === 0) return 0;
  let acc = parts[0];
  for (const part of parts.slice(1)) {
    const next = acc.add(part); acc.delete?.(); part.delete?.(); acc = next;
  }
  const a = acc.area(); acc.delete?.(); return a;
}
function oracleArea(contours, fillRule = "nonzero") {
  const cs = CrossSection.ofPolygons(
    contours.map((c) => tessellateContour(c, 300)),
    fillRule === "nonzero" ? "NonZero" : "EvenOdd");
  const a = cs.area(); cs.delete?.(); return a;
}

describe("resolveCurveFill", () => {
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789&%@#!?.,-+=$".split("");
  it("matches the Manifold NonZero fill for the bundled TrueType charset", () => {
    for (const ch of CHARS) {
      const contours = glyphContours(font, ch);
      const got = resolvedArea(resolveCurveFill(contours, { fillRule: "nonzero" }));
      const want = oracleArea(contours, "nonzero");
      expect(Math.abs(got - want) / want, `glyph '${ch}'`).toBeLessThan(0.01);
    }
  });

  it("resolves B into one outer with two counters (holes), curves preserved", () => {
    const regions = resolveCurveFill(glyphContours(font, "B"), { fillRule: "nonzero" });
    expect(regions.length).toBe(1);
    expect(regions[0].holes.length).toBe(2);
    const hasCubic = [regions[0].outer, ...regions[0].holes].some((c) => c.segments.some((s) => s.c1));
    expect(hasCubic).toBe(true);
  });

  it("resolves i into two disjoint filled regions (dot + stem), no holes", () => {
    const regions = resolveCurveFill(glyphContours(font, "i"), { fillRule: "nonzero" });
    expect(regions.length).toBe(2);
    expect(regions.every((r) => r.holes.length === 0)).toBe(true);
  });

  it("distinguishes nonzero from even-odd for same-winding nested contours", () => {
    const rect = (x0, y0, x1, y1) => pathProfile([x0, y0])
      .lineTo([x1, y0]).lineTo([x1, y1]).lineTo([x0, y1]).close();
    const sameWinding = [rect(0, 0, 10, 10), rect(2, 2, 8, 8)];
    expect(resolveCurveFill(sameWinding, { fillRule: "nonzero" })[0].holes).toHaveLength(0);
    expect(resolveCurveFill(sameWinding, { fillRule: "evenodd" })[0].holes).toHaveLength(1);
  });

  it("groups by actual cubic geometry, not the endpoint polygon", () => {
    // Each oval has only two distinct endpoints, so its endpoint polygon has zero area.
    const oval = (r, reverse = false) => ({
      start: [0, -r],
      segments: reverse
        ? [
            { to: [0, r], c1: [-4*r/3, -r], c2: [-4*r/3, r] },
            { to: [0, -r], c1: [4*r/3, r], c2: [4*r/3, -r] },
          ]
        : [
            { to: [0, r], c1: [4*r/3, -r], c2: [4*r/3, r] },
            { to: [0, -r], c1: [-4*r/3, r], c2: [-4*r/3, -r] },
          ],
    });
    const regions = resolveCurveFill([oval(10), oval(4, true)], { fillRule: "nonzero" });
    expect(regions).toHaveLength(1);
    expect(regions[0].holes).toHaveLength(1);
  });

  it("rejects an unknown fill rule", () => {
    expect(() => resolveCurveFill(glyphContours(font, "O"), { fillRule: "wut" }))
      .toThrow(/fillRule/);
  });

  it("returns [] for empty input and is deterministic across repeated calls", () => {
    expect(resolveCurveFill([], { fillRule: "nonzero" })).toEqual([]);
    const a = resolvedArea(resolveCurveFill(glyphContours(font, "O"), { fillRule: "nonzero" }));
    const b = resolvedArea(resolveCurveFill(glyphContours(font, "O"), { fillRule: "nonzero" }));
    expect(a).toBeCloseTo(b, 3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use && npx vitest run test/curve-fill.test.js`
Expected: FAIL — `curve-fill.js` does not exist.

- [ ] **Step 3: Write the implementation** (`src/framework/geometry/curve-fill.js`)

```js
// Resolve raw glyph outlines (self-intersecting / overlapping cubic contours) into
// simple, correctly-nested {outer,holes} curve regions under the requested font fill
// rule. Beziers are split where needed but never flattened.
//
// The required recipe is:
//   1. resolveCrossings() each contour individually;
//   2. CompoundPath of all the simple sub-paths;
//   3. set the font's nonzero/evenodd rule;
//   4. unite(self) to normalize overlaps and crossings into simple paths.
import paper from "paper/dist/paper-core.js";

// Never use paper's package-global project: another consumer in the same worker may import
// paper too. This resolver owns and clears only this private, headless scope.
const scope = new paper.PaperScope();
scope.setup(new scope.Size(1, 1));

function toPaperPath(contour) {
  const path = new scope.Path({ insert: false });
  path.moveTo(new scope.Point(contour.start[0], contour.start[1]));
  for (const s of contour.segments) {
    if (s.c1) path.cubicCurveTo(
      new scope.Point(s.c1[0], s.c1[1]),
      new scope.Point(s.c2[0], s.c2[1]),
      new scope.Point(s.to[0], s.to[1]));
    else path.lineTo(new scope.Point(s.to[0], s.to[1]));
  }
  path.closePath();
  return path;
}

function toContour(path) {
  const segs = path.segments;
  const start = [segs[0].point.x, segs[0].point.y];
  const out = { start, segments: [] };
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i], b = segs[(i + 1) % segs.length];
    const straight = a.handleOut.isZero() && b.handleIn.isZero();
    const closing = i === segs.length - 1;
    if (closing && straight) continue;                 // implicit straight close
    const to = [b.point.x, b.point.y];
    if (straight) out.segments.push({ to });
    else out.segments.push({ to, c1: [a.point.x + a.handleOut.x, a.point.y + a.handleOut.y], c2: [b.point.x + b.handleIn.x, b.point.y + b.handleIn.y] });
  }
  return out;
}

// Group while paths are still Paper geometry. Path.area includes cubic handles and
// interiorPoint is guaranteed to lie inside the curve; never reduce curves to endpoint rings.
function groupPaperPaths(paths) {
  const largest = paths.reduce((a, b) => Math.abs(b.area) > Math.abs(a.area) ? b : a);
  const outerClockwise = largest.clockwise;
  const outers = paths.filter((p) => p.clockwise === outerClockwise)
    .map((path) => ({ path, holes: [] }));
  for (const hole of paths.filter((p) => p.clockwise !== outerClockwise)) {
    const home = outers.filter((o) => o.path.contains(hole.interiorPoint))
      .sort((a, b) => Math.abs(a.path.area) - Math.abs(b.path.area))[0];
    if (!home) throw new Error("curve-fill: resolved hole has no containing outer");
    home.holes.push(hole);
  }
  return outers.map(({ path, holes }) => ({
    outer: toContour(path),
    holes: holes.map(toContour),
  }));
}

export function resolveCurveFill(contours, { fillRule = "nonzero" } = {}) {
  if (fillRule !== "nonzero" && fillRule !== "evenodd")
    throw new Error('curve-fill: fillRule must be "nonzero" or "evenodd"');
  if (!contours || contours.length === 0) return [];
  try {
    const simple = [];
    for (const ct of contours) {
      const resolved = toPaperPath(ct).resolveCrossings();
      const kids = resolved.className === "CompoundPath" ? resolved.children : [resolved];
      for (const k of kids) if (k.segments && k.segments.length >= 2) simple.push(k.clone({ insert: false }));
    }
    if (simple.length === 0) return [];
    const compound = new scope.CompoundPath({ children: simple, fillRule });
    const united = compound.unite(compound, { insert: false });
    const paths = (united.className === "CompoundPath" ? united.children : [united])
      .filter((p) => p.segments && p.segments.length >= 2 && Math.abs(p.area) > 1e-9);
    return paths.length ? groupPaperPaths(paths) : [];
  } finally {
    scope.project.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use && npx vitest run test/curve-fill.test.js`
Expected: PASS — the TrueType charset is within 1%, nonzero/even-odd differ as expected, curve-only containment works, B has 2 holes, and i has 2 regions.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/curve-fill.js test/curve-fill.test.js
git commit -m "feat: add format-aware curve fill resolver"
```

---

### Task 2: Rewire `text2d.js` to the resolver

**Files:**
- Modify: `src/framework/geometry/text2d.js` (delete `flatten`/`groupContours`; select the font fill rule; feed contours through `resolveCurveFill`)
- Test: `test/text2d.test.js` (keep layout coverage; add format selection and real-Roboto topology assertions)

**Interfaces:**
- Consumes: `resolveCurveFill(contours, {fillRule})` from Task 1; `font.tables.cff` / `font.tables.cff2`; the existing layout helpers.
- Produces: `textGlyphs(font, string, opts) => Array<{ outer, holes }>` — unchanged output shape, so `kernel-front.js` remains unchanged. TrueType and CFF2 select `"nonzero"`; CFF1 selects `"evenodd"`.

- [ ] **Step 1: Read the current file** — confirm the layout structure (`textGlyphs`) and the exact `flatten`/`groupContours`/per-glyph loop to replace.

Run: `sed -n '1,120p' src/framework/geometry/text2d.js`

- [ ] **Step 2: Write the failing format-selection and real-glyph tests** — add to `test/text2d.test.js`:

```js
import { fontFillRule, textGlyphs } from "../src/framework/geometry/text2d.js";
import { DEFAULT_FONT_BYTES } from "../src/framework/geometry/fonts/default-font.js";

test("selects the OpenType outline fill rule", () => {
  expect(fontFillRule({ tables: {} })).toBe("nonzero");                 // TrueType / synthetic
  expect(fontFillRule({ tables: { cff: {} } })).toBe("evenodd");      // CFF1
  expect(fontFillRule({ tables: { cff2: {} } })).toBe("nonzero");     // CFF2
});

test("real Roboto B resolves to one region with two counters", () => {
  const { buffer, byteOffset, byteLength } = DEFAULT_FONT_BYTES;
  const roboto = opentype.parse(buffer.slice(byteOffset, byteOffset + byteLength));
  const regions = textGlyphs(roboto, "B", { size: 10, align: "left", valign: "baseline" });
  expect(regions.length).toBe(1);
  expect(regions[0].holes.length).toBe(2);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `nvm use && npx vitest run test/text2d.test.js`
Expected: FAIL because `fontFillRule` is not exported and the old `groupContours` gives Roboto B only one counter.

- [ ] **Step 4: Edit `text2d.js`** — apply exactly these changes:

1. Add import at top: `import { resolveCurveFill } from "./curve-fill.js";`
2. Delete `import { pointInRing } from "./shape2d-regions.js";` (no longer used).
3. Delete the `flatten` function and the `groupContours` function entirely.
4. Add this format selector after `capHeightUnits`:

```js
// OpenType glyf and CFF2 use nonzero winding. CFF1 Type 2 CharStrings use even-odd.
// Synthetic opentype.Font fixtures have neither table and follow the TrueType default.
export const fontFillRule = (font) =>
  font.tables?.cff && !font.tables?.cff2 ? "evenodd" : "nonzero";
```

5. In `textGlyphs`, compute `const fillRule = fontFillRule(font);` once, then replace the per-glyph region loop. The current loop is:

```js
    glyphs.forEach((g, i) => {
      if (i > 0) penX += kern(glyphs[i - 1], g);
      for (const region of groupContours(glyphContours(g, font)))
        specs.push({ region, penX });                          // remember this glyph's pen origin (font units)
      penX += g.advanceWidth + (tracking / s);                  // tracking is mm → font units
    });
```

Replace it with:

```js
    glyphs.forEach((g, i) => {
      if (i > 0) penX += kern(glyphs[i - 1], g);
      for (const region of resolveCurveFill(glyphContours(g, font), { fillRule }))
        specs.push({ region, penX });                          // remember this glyph's pen origin (font units)
      penX += g.advanceWidth + (tracking / s);                  // tracking is mm → font units
    });
```

The downstream `xform(region.outer, …)` / `region.holes.map(xform)` and all layout math remain unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `nvm use && npx vitest run test/text2d.test.js`
Expected: PASS — layout tests remain green, fill-rule selection is pinned, and Roboto B has 2 holes.

- [ ] **Step 6: Commit**

```bash
git add src/framework/geometry/text2d.js test/text2d.test.js
git commit -m "feat: resolve text contours by font fill rule"
```

---

### Task 3: Backend integration + curve-exactness + worker-safety

**Files:**
- Modify: `test/text2d-manifold.test.js` (assert resolved region/hole topology and extrusion volume)
- Modify: `test/text2d-occt.test.js` (assert topology, valid extrusion, and STEP `B_SPLINE`)
- Create: `src/parts/text-smoke.js`
- Create: `src/app-text-smoke.js`
- Create: `src/text-smoke-worker.js`
- Create: `text-smoke.html`
- Modify: `.github/workflows/ci.yml` (run the text-bearing app in Chromium)

**Interfaces:**
- Consumes: `k.text2d(string, opts) => Shape2D` (unchanged signature); `bootManifoldKernel`, `bootOcctKernel` with `{ fonts }`.
- Produces: no framework API changes. The tests prove that resolved regions survive both backend adapters and that `paper-core` actually loads and runs inside the Vite geometry worker.

- [ ] **Step 1: Add the Manifold topology test** — add to `test/text2d-manifold.test.js`, using the file's existing `k` from `beforeAll`:

```js
test("real glyphs materialize with the correct regions and counters", () => {
  // [glyph, disjoint material regions, total counters]
  const cases = [["O", 1, 1], ["B", 1, 2], ["8", 1, 2], ["A", 1, 1], ["i", 2, 0]];
  for (const [ch, expectedRegions, expectedHoles] of cases) {
    const shape = k.text2d(ch, { size: 10, align: "left", valign: "baseline" });
    const regions = shape.toRegions();
    expect(regions, ch).toHaveLength(expectedRegions);
    expect(regions.reduce((n, r) => n + r.holes.length, 0), ch).toBe(expectedHoles);
    expect(shape.area(), ch).toBeGreaterThan(0);
    const solid = k.extrude({ profile: shape, h: 2 });
    expect(solid.volume(), ch).toBeCloseTo(shape.area() * 2, 2);
  }
});
```

- [ ] **Step 2: Run the Manifold test**

Run: `nvm use && npx vitest run test/text2d-manifold.test.js`
Expected: PASS.

- [ ] **Step 3: Add the OCCT topology and STEP test** — use the file's existing `k`; do not call a nonexistent `solid.toSTEP()` API:

```js
test("Roboto B has two counters and keeps B_SPLINE edges in STEP", async () => {
  const shape = k.text2d("B", { size: 10, align: "left", valign: "baseline" });
  const regions = shape.toRegions();
  expect(regions).toHaveLength(1);
  expect(regions[0].holes).toHaveLength(2);
  const solid = k.extrude({ profile: shape, h: 2 });
  expect(solid.volume()).toBeGreaterThan(0);
  expect(Math.abs(solid.volume() - shape.area() * 2) / solid.volume()).toBeLessThan(0.01);
  const step = await k.toSTEP([{ name: "B", solid }]);
  const text = new TextDecoder().decode(step);
  expect(text).toMatch(/B_SPLINE/);
});
```

OCCT measurement reports watertightness as `n/a`; do not label this assertion "watertight." Successful region materialization, extrusion, positive volume, area/volume agreement, and STEP export are the available validity signals.

- [ ] **Step 4: Run the OCCT test**

Run: `nvm use && npx vitest run test/text2d-occt.test.js`
Expected: PASS — B has two counters, extrudes to the expected positive volume, and STEP contains `B_SPLINE`.

- [ ] **Step 5: Create a real text-bearing worker smoke fixture**

Create `src/parts/text-smoke.js`:

```js
export default {
  meta: { title: "Text worker smoke", units: "mm", background: 0x15181d },
  parameters: [],
  defaults: {},
  parts: {
    text: {
      label: "Text",
      views: ["text"],
      export: { name: "text-smoke" },
      build: (k) => k.extrude({
        profile: k.text2d("B8&", { size: 10, align: "center", valign: "middle" }),
        h: 2,
      }).label("Resolved text"),
    },
  },
  views: { text: { label: "Text" } },
};
```

Create `src/app-text-smoke.js`:

```js
import part from "./parts/text-smoke.js";
import { mount } from "./framework/index.js";

mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./text-smoke-worker.js", import.meta.url), { type: "module", name }),
});
```

Create `src/text-smoke-worker.js`:

```js
import part from "./parts/text-smoke.js";
import { runWorker } from "./framework/worker.js";
runWorker(part);
```

Copy `demo.html` to `text-smoke.html`, then change the `<title>`, panel `<h1>`, `.sub`, and `.hint` text to identify the text smoke fixture, and change only the module entry to:

```html
<script type="module" src="/src/app-text-smoke.js"></script>
```

This page is a dev/CI fixture; do not add it to `vite.config.js` production `rollupOptions.input`.

- [ ] **Step 6: Run the fixture in the real Chromium worker path**

Run: `nvm use && CHECK_PORT=5182 node scripts/check-app.mjs text-smoke.html`
Expected: exit 0, `booted: true`, `hovered: true`, a triangle-count status, and `errors: 0`. This command—not a Node-only import probe—proves Paper executes inside the Vite Web Worker.

- [ ] **Step 7: Add the worker fixture to CI**

Append after the other smoke checks in `.github/workflows/ci.yml`:

```yaml
      - run: CHECK_PORT=5182 node scripts/check-app.mjs text-smoke.html
```

- [ ] **Step 8: Run the full suite and all affected smoke checks**

Run: `nvm use && npx vitest run`
Expected: PASS — the whole suite green (no regressions from the resolver swap).

Run: `nvm use && CHECK_PORT=5182 node scripts/check-app.mjs text-smoke.html`
Expected: PASS with zero browser/worker errors.

- [ ] **Step 9: Commit**

```bash
git add test/text2d-manifold.test.js test/text2d-occt.test.js src/parts/text-smoke.js src/app-text-smoke.js src/text-smoke-worker.js text-smoke.html .github/workflows/ci.yml
git commit -m "test: verify resolved text on both backends and in worker"
```

---

### Task 4: Docs, error guidance, dependency metadata, and bundle verification

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (text2d section — note curve-exact both backends)
- Modify: `docs/superpowers/specs/2026-07-18-vectortext-shape2d-design.md` (winding section — replace containment-classification with the paper.js resolver)
- Modify: `docs/ERROR-PATTERNS.md` (document the resolver's surfaced topology failure)
- Modify: `package.json` (verify `paper` is a runtime dependency and `bezier-js` is absent)
- Modify: `package-lock.json` (commit the matching lockfile change)

**Interfaces:**
- Consumes: nothing. Documentation + metadata only.
- Produces: accurate docs describing format-aware, curve-preserving text rendering and a reproducible dependency/bundle record.

- [ ] **Step 1: Update the spec's "Glyph → contours & winding" section** — replace the containment-classification paragraph with the following facts:

  - `resolveCurveFill` performs per-contour `resolveCrossings` → private-scope `CompoundPath` with the selected fill rule → `unite(self)`.
  - TrueType and CFF2 select nonzero; CFF1 selects even-odd.
  - Region grouping uses Paper's curve geometry before conversion, never endpoint-only rings.
  - The resolved `{outer,holes}` regions feed `k.shape2d`; OCCT keeps cubic B-splines and Manifold facets at mesh LOD.
  - `paper/dist/paper-core.js` is the DOM-free runtime dependency; the dependency rationale is overlap/self-intersection resolution, not text layout.

- [ ] **Step 2: Update `docs/AUTHORING-PARTS.md`** — in the text2d section, state that overlapping/self-intersecting outlines are resolved according to the font format's fill rule, curves remain exact on OCCT (STEP `B_SPLINE`) and facet at mesh LOD on Manifold, and the default font is Roboto Regular (SIL OFL 1.1). Keep the documented option defaults (`align:"center"`, `valign:"middle"`, `lineHeight` = mm/font-metric default) accurate.

- [ ] **Step 3: Add the greppable resolver failure to `docs/ERROR-PATTERNS.md`**

```markdown
## curve-fill-resolved-hole-uncontained

- **Symptom:** `curve-fill: resolved hole has no containing outer`
- **Cause:** paper.js returned an unexpected or numerically degenerate path topology for the supplied font outline; the resolver refuses to attach the hole to an arbitrary outer.
- **Fix:** reduce or normalize degenerate font contours, confirm the correct CFF/TrueType fill rule was selected, and add the glyph as a focused `curve-fill.test.js` regression before changing resolver tolerances.
```

- [ ] **Step 4: Verify dependency and version metadata**

Run: `nvm use && node -e "const p=require('./package.json'); console.log('paper', p.dependencies.paper, '| bezier-js', p.dependencies['bezier-js'] ?? 'absent')"`
Expected: `paper ^0.12.18 | bezier-js absent`.

Run: `nvm use && node -e "const p=require('./package.json'); const l=require('./package-lock.json'); console.log(p.version, l.version, l.packages[''].version, l.packages[''].dependencies.paper)"`
Expected: the three versions agree and the lockfile root reports `^0.12.18`.

Keep the current package version if it is already the unreleased `text2d` feature version (`0.20.0` in this plan's starting state); do not create a second minor bump solely for the resolver correction. Leave `CONTRACT_VERSION` untouched because no public operation was added or changed.

- [ ] **Step 5: Build and record the worker bundle cost**

Run: `nvm use && npm run build`
Expected: PASS. Record the emitted Manifold and OCCT worker chunk sizes in the implementation report/commit notes so the paper-core cost is visible; fail the task if Vite pulls `paper-full`/canvas shims instead of `paper-core`.

- [ ] **Step 6: Run the full verification gate**

Run: `nvm use && npx vitest run`
Expected: PASS (including `test/kernel-contract.test.js` — no public-op changes, so it stays green).

Run: `nvm use && CHECK_PORT=5182 node scripts/check-app.mjs text-smoke.html`
Expected: PASS with `booted: true`, `hovered: true`, and `errors: 0`.

- [ ] **Step 7: Commit**

```bash
git add docs/AUTHORING-PARTS.md docs/ERROR-PATTERNS.md docs/superpowers/specs/2026-07-18-vectortext-shape2d-design.md package.json package-lock.json
git commit -m "docs: explain format-aware curve text resolution"
```

---

## Notes for the executor

- **Oracle-driven testing:** Task 1 compares the bundled TrueType charset to Manifold NonZero and separately pins even-odd behavior. It reconstructs the actual per-region `shape2d` semantics before measuring. Keep the `<0.01` relative-area tolerance.
- **Do not reintroduce `groupContours`/`flatten` or bezier-js.**
- **paper import path:** always `paper/dist/paper-core.js` (the DOM-free core), never bare `paper` (which resolves to `paper-full` with PaperScript/canvas).
- **Fill rule:** never infer holes solely from contour order or endpoint winding. Use `fontFillRule(font)` and keep CFF1 even-odd distinct from TrueType/CFF2 nonzero.
- **Curve-aware grouping:** after Paper resolves the paths, keep area/orientation/containment decisions in Paper. Convert to `pathProfile` only after `{outer,holes}` grouping is complete.
- **Purity/isolation:** `resolveCurveFill` clears only its private `PaperScope` project in a `finally`; never clear `paper.project`, which may belong to another consumer.
- **Worker verification:** a Node import probe is insufficient. Keep the `text-smoke.html` Chromium check in CI because it executes the dependency in the real Vite Web Worker.
- **Leave `embed-test.html` / `src/app-embed-test.js` alone** (another session's untracked files).
