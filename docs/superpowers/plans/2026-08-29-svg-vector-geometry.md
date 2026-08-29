# SVG Vector Geometry (`k.svg2d`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SVG artwork becomes CAD geometry — converted once in a browser by `partforge/ingest` into a documented JSON format, then placed at build time by `k.svg2d(name, opts)` as a `Shape2D`.

**Architecture:** One conversion, two halves. **Ingest** (main thread, DOM required) runs paper.js's `importSVG` — which bakes transforms, resolves styles, and handles `<use>`/`<defs>`/CSS — then outlines strokes, resolves fills, flips y, recovers circular arcs, and emits JSON. **Runtime** (geometry worker) validates that JSON, scales and aligns it, and hands it to `k.shape2d`. Nothing in the conversion depends on a parameter, so it happens once instead of on every regeneration.

**Tech Stack:** Plain ESM, Node 24, vitest (happy-dom for the DOM half). Existing deps only — `paper` is already here; nothing new.

**Spec:** `docs/superpowers/specs/2026-08-29-svg-vector-geometry-design.md`

## Global Constraints

- **Node 24.** The default `node` on the dev machine is already v24.19.0. Do NOT run `nvm use` or source nvm — it is blocked in this sandbox.
- **The worker graph stays DOM-free.** Every file under `src/framework/geometry/` and anything reachable from `jobs.js` must be free of `three`, `node:`, and the DOM. `test/worker-layering.test.js` greps module SOURCE for the words `document`, `window`, `localStorage`, `sessionStorage`, `HTMLElement`, `customElements` — a file may not contain them at all, including in comments. **`src/framework/ingest/` and `src/ingest.js` are the sole exception and must never be imported from the worker graph.**
- **No new runtime dependencies.**
- **Units:** the vector format carries the artwork's own arbitrary units; `k.svg2d` converts to **millimetres** at build time. Everything else in the repo is mm.
- **`build` stays a pure function of `(k, p, d)`.** No clock, no randomness, no module-level mutable state beyond content-keyed memoization.
- **Contour IR (internal):** `{ start: [x,y], segments: [ {to} | {to,via} | {to,c1,c2} ] }` — line, circular arc (`via` is a point ON the arc), cubic. Built with `pathProfile` from `polygon.js`.
- **Region IR (internal):** `{ outer: Contour, holes: Contour[] }`, outer CCW and holes CW in the y-up frame.
- **JSON format:** `kind`-tagged segments and `through` (not `via`) for arcs — see Task 1. The mapping between the two vocabularies lives in exactly one file.
- **Commit after every task.** Do not batch.
- **Version bump belongs on this branch** (`0.91.0` → `0.92.0`), in Task 9. Forgetting it fails silently — the merge lands and the work never ships.

## File Structure

| File | Responsibility |
|---|---|
| `src/framework/geometry/vector-format.js` | **Create.** The format: constants, `validateVectorDocument`, `toInternalRegions`, `fromInternalRegions`. Pure, worker-safe — both halves use it. |
| `src/framework/geometry/arc-fit.js` | **Create.** Pure `Contour → Contour` circular-arc recovery over cubic runs. |
| `src/framework/geometry/stroke-outline.js` | **Create.** Open/closed contour + stroke style → regions. |
| `src/framework/geometry/contour-offset.js` | **Modify.** Export `joinSegs` as `_joinSegs`. One line. |
| `src/framework/geometry/svg2d.js` | **Create.** Validated regions + opts → placed regions in mm. Pure. |
| `src/framework/ingest/svg-ingest.js` | **Create.** DOM-dependent: paper `importSVG` → `VectorDocument`. |
| `src/ingest.js` | **Create.** The published `partforge/ingest` entry. |
| `src/framework/svgs.js` | **Create.** Declared sources → parsed, validated documents on `kernel._svgs`. |
| `src/framework/geometry/kernel-front.js` | **Modify.** `k._svgs` map + `k.svg2d`. |
| `src/framework/geometry/kernel.js` | **Modify.** `"svg2d"` in the op-name list. |
| `src/framework/jobs.js` | **Modify.** Register `k._svgs` in the async pre-phase. |
| `src/testing/manifold.js`, `src/testing/occt.js` | **Modify.** Accept and register `svgs`. |
| `bin/cli.js` | **Modify.** Pass `part.svgs` through to the kernel boot. |
| `test/setup/happy-dom-patches.js` | **Modify.** Stub the canvas 2D context so paper can load. |
| `src/framework/lint/rules-svg.js` + `lint/index.js` | **Create/modify.** Two static rules. |
| `src/parts/emblem.js` + `assets/emblem.svg` + `assets/emblem.svg.json` + glue | **Create.** Reference part. |
| `package.json` | **Modify.** `./ingest` export, `docs/VECTOR-FORMAT.md` in `files`, version bump. |

**Dependency direction:** `vector-format` and `arc-fit` are leaves. `stroke-outline` depends on `contour-offset`/`paper-bridge`/`curve-fill`. `svg2d` depends on `vector-format`. `svg-ingest` depends on all of them plus paper and the DOM. `svgs.js` depends only on `vector-format` and `asset-resolve` — the worker never touches ingest.

---

### Task 1: `vector-format.js` — the published format

**Files:**
- Create: `src/framework/geometry/vector-format.js`
- Test: `test/vector-format.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `VECTOR_FORMAT = "partforge-vector"`, `VECTOR_VERSION = 1`, `FORMAT_NOTE` (the header string below)
  - `validateVectorDocument(doc, label) → void` — throws `Error` starting `"svg2d: "` naming the position and the fix. `label` is the `svgs` key, for the message.
  - `toInternalRegions(doc) → Region[]` — validates, then maps `kind`/`through` to the internal implicit IR.
  - `fromInternalRegions(regions, { source }) → doc` — the ingest direction: internal regions → a complete document with `bbox` and rounded coordinates.

This file is the ONLY place the two vocabularies meet. Everything upstream of it speaks JSON (`kind`, `through`); everything downstream speaks the internal IR (implicit type, `via`).

- [ ] **Step 1: Write the failing test**

Create `test/vector-format.test.js`:

```js
import { expect, test } from "vitest";
import { validateVectorDocument, toInternalRegions, fromInternalRegions, VECTOR_FORMAT, VECTOR_VERSION }
  from "../src/framework/geometry/vector-format.js";

const doc = (over = {}) => ({
  format: VECTOR_FORMAT,
  version: VECTOR_VERSION,
  source: "x.svg",
  bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  regions: [{
    outer: { start: [0, 0], segments: [
      { kind: "line", to: [10, 0] },
      { kind: "line", to: [10, 10] },
      { kind: "line", to: [0, 10] },
    ] },
    holes: [],
  }],
  ...over,
});

const bad = (over, re) => expect(() => validateVectorDocument(doc(over), "emblem")).toThrow(re);

test("a well-formed document validates", () => {
  expect(() => validateVectorDocument(doc(), "emblem")).not.toThrow();
});

test("every message names the svgs key", () => {
  bad({ format: "something-else" }, /"emblem"/);
});

test("a wrong format is refused and names both formats", () => {
  bad({ format: "svg-json" }, /svg-json.*partforge-vector|partforge-vector.*svg-json/s);
});

test("a future version is refused and names both versions", () => {
  bad({ version: 99 }, /99/);
});

test("an unknown segment kind is refused, with the position", () => {
  const d = doc();
  d.regions[0].outer.segments[1] = { kind: "spiral", to: [1, 1] };
  expect(() => validateVectorDocument(d, "emblem")).toThrow(/region 1.*outer.*segment 2.*spiral/s);
});

test("an arc without `through` is refused and the message says what through is", () => {
  const d = doc();
  d.regions[0].outer.segments[1] = { kind: "arc", to: [1, 1] };
  expect(() => validateVectorDocument(d, "emblem")).toThrow(/through/);
  expect(() => validateVectorDocument(d, "emblem")).toThrow(/passes through/);
});

test("a cubic missing c2 is refused", () => {
  const d = doc();
  d.regions[0].outer.segments[1] = { kind: "cubic", to: [1, 1], c1: [0, 1] };
  expect(() => validateVectorDocument(d, "emblem")).toThrow(/c2/);
});

test("a non-numeric coordinate is refused, with the position", () => {
  const d = doc();
  d.regions[0].outer.segments[0].to = [10, "x"];
  expect(() => validateVectorDocument(d, "emblem")).toThrow(/region 1.*segment 1/s);
});

test("a contour with fewer than two segments is refused", () => {
  const d = doc();
  d.regions[0].outer.segments = [{ kind: "line", to: [1, 1] }];
  expect(() => validateVectorDocument(d, "emblem")).toThrow(/at least two segments|too few/i);
});

test("no regions at all is refused", () => {
  bad({ regions: [] }, /no regions|empty/i);
});

test("a bbox that disagrees with the geometry is refused", () => {
  bad({ bbox: { minX: 0, minY: 0, maxX: 999, maxY: 10 } }, /bbox/i);
});

test("note is optional and ignored", () => {
  expect(() => validateVectorDocument(doc({ note: "anything at all" }), "emblem")).not.toThrow();
  const d = doc(); delete d.note;
  expect(() => validateVectorDocument(d, "emblem")).not.toThrow();
});

test("toInternalRegions maps kind/through onto the implicit IR", () => {
  const d = doc();
  d.regions[0].outer.segments[1] = { kind: "arc", to: [10, 10], through: [11, 5] };
  d.regions[0].outer.segments[2] = { kind: "cubic", to: [0, 10], c1: [8, 12], c2: [4, 12] };
  const [r] = toInternalRegions(d);
  expect(r.outer.start).toEqual([0, 0]);
  expect(r.outer.segments[0]).toEqual({ to: [10, 0] });
  expect(r.outer.segments[1]).toEqual({ to: [10, 10], via: [11, 5] });
  expect(r.outer.segments[2]).toEqual({ to: [0, 10], c1: [8, 12], c2: [4, 12] });
});

test("toInternalRegions drops a redundant closing segment equal to start", () => {
  const d = doc();
  d.regions[0].outer.segments.push({ kind: "line", to: [0, 0] });
  const [r] = toInternalRegions(d);
  expect(r.outer.segments).toHaveLength(3);
});

test("fromInternalRegions round-trips back through toInternalRegions", () => {
  const regions = [{
    outer: { start: [0, 0], segments: [
      { to: [10, 0] }, { to: [10, 10], via: [11, 5] }, { to: [0, 10], c1: [8, 12], c2: [4, 12] },
    ] },
    holes: [{ start: [3, 3], segments: [{ to: [3, 6] }, { to: [6, 6] }, { to: [6, 3] }] }],
  }];
  const out = fromInternalRegions(regions, { source: "x.svg" });
  expect(out.format).toBe(VECTOR_FORMAT);
  expect(out.version).toBe(VECTOR_VERSION);
  expect(typeof out.note).toBe("string");
  expect(out.regions[0].outer.segments[1]).toEqual({ kind: "arc", to: [10, 10], through: [11, 5] });
  expect(() => validateVectorDocument(out, "rt")).not.toThrow();
  const back = toInternalRegions(out);
  expect(back[0].outer.segments).toEqual(regions[0].outer.segments);
  expect(back[0].holes).toHaveLength(1);
});

test("fromInternalRegions computes the tight bbox including curve extents", () => {
  const regions = [{ outer: { start: [0, 0], segments: [
    { to: [10, 0] }, { to: [10, 10] }, { to: [0, 10] },
  ] }, holes: [] }];
  const out = fromInternalRegions(regions, { source: null });
  expect(out.bbox).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
  expect(out.source).toBe(null);
});

test("fromInternalRegions rounds coordinates to 6 decimals", () => {
  const regions = [{ outer: { start: [0, 0], segments: [
    { to: [1 / 3, 0] }, { to: [1, 1] }, { to: [0, 1] },
  ] }, holes: [] }];
  const out = fromInternalRegions(regions, { source: null });
  expect(out.regions[0].outer.segments[0].to[0]).toBe(0.333333);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/vector-format.test.js`
Expected: FAIL — cannot resolve `vector-format.js`.

- [ ] **Step 3: Write the implementation**

Create `src/framework/geometry/vector-format.js`:

```js
// The `partforge-vector` JSON format: constants, validation, and the mapping to
// and from this engine's internal region IR.
//
// This is a PUBLISHED format — agents read it, and (since ingest needs a
// browser) may hand-write it — so it is explicit where the internal IR is
// implicit. The internal IR infers a segment's type from which keys are present
// (`c1` → cubic, `via` → arc, neither → line) and calls an arc's third point
// `via`. Both are fine for code and hostile to anyone writing a file by hand, so
// the JSON tags every segment with `kind` and names the arc point `through` —
// "the arc passes through here", which `via` does not say.
//
// This file is the ONLY place the two vocabularies meet. Upstream speaks JSON,
// downstream speaks the internal IR, and nothing else needs to know both.
//
// Pure leaf: DOM-free, node:-free. Both halves of the feature import it.
import { tessellateContour } from "./profile.js";

export const VECTOR_FORMAT = "partforge-vector";
export const VECTOR_VERSION = 1;

export const FORMAT_NOTE =
  "Filled 2-D outlines for k.svg2d. Coordinates are plain numbers in the artwork's own "
  + "units — k.svg2d rescales at build time. y points UP. Each region is one filled area: "
  + "`outer` is its boundary and `holes` are subtracted from it. Segments run head-to-tail "
  + "from `start`; each segment's `to` is the next point. The contour closes implicitly from "
  + "the last `to` back to `start`. See docs/VECTOR-FORMAT.md.";

const BBOX_SEGS = 64;         // curve sampling for bbox computation and its check
const BBOX_TOL = 1e-3;        // mm-free: these are artwork units, and 6dp rounding is finer
const ROUND = 1e6;            // 6 decimal places

const round6 = (n) => Math.round(n * ROUND) / ROUND;
const isPt = (v) => Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]);

// Every message carries the svgs key and the position, because the reader is as
// likely to be an agent that generated the file as a human who wrote it.
const fail = (label, where, what, fix) => {
  throw new Error(`svg2d: "${label}" ${where} ${what}${fix ? ` — ${fix}` : ""}`);
};

function checkContour(label, where, contour) {
  if (!contour || typeof contour !== "object") fail(label, where, "is not an object");
  if (!isPt(contour.start)) fail(label, where, 'has no valid "start"', "start must be a [x, y] pair of finite numbers");
  if (!Array.isArray(contour.segments) || contour.segments.length < 2) {
    fail(label, where, `has too few segments (${contour.segments?.length ?? 0})`,
      "a closed contour needs at least two segments; it closes implicitly from the last `to` back to `start`");
  }
  contour.segments.forEach((s, i) => {
    const at = `${where} segment ${i + 1}`;
    if (!s || typeof s !== "object") fail(label, at, "is not an object");
    if (!isPt(s.to)) fail(label, at, 'has no valid "to"', "every segment needs a `to` [x, y] pair of finite numbers");
    if (s.kind === "line") return;
    if (s.kind === "arc") {
      if (!isPt(s.through)) {
        fail(label, at, 'has "kind": "arc" but no valid "through" point',
          "an arc needs a point it passes through, between the previous point and `to`");
      }
      return;
    }
    if (s.kind === "cubic") {
      if (!isPt(s.c1)) fail(label, at, 'has "kind": "cubic" but no valid "c1"', "a cubic needs both control points, c1 and c2");
      if (!isPt(s.c2)) fail(label, at, 'has "kind": "cubic" but no valid "c2"', "a cubic needs both control points, c1 and c2");
      return;
    }
    fail(label, at, `has unknown "kind": ${JSON.stringify(s.kind)}`, 'kind must be "line", "arc", or "cubic"');
  });
}

export function validateVectorDocument(doc, label = "(unnamed)") {
  if (!doc || typeof doc !== "object") fail(label, "document", "is not an object", "expected parsed JSON");
  if (doc.format !== VECTOR_FORMAT) {
    fail(label, "document", `has format ${JSON.stringify(doc.format)}`,
      `expected ${JSON.stringify(VECTOR_FORMAT)} — this file is not a partforge vector document`);
  }
  if (!Number.isInteger(doc.version) || doc.version > VECTOR_VERSION) {
    fail(label, "document", `has version ${JSON.stringify(doc.version)}`,
      `this build understands version ${VECTOR_VERSION} — re-ingest the artwork, or upgrade partforge`);
  }
  if (doc.note != null && typeof doc.note !== "string") fail(label, "document", "has a non-string `note`", "`note` is free text and is ignored on load");
  if (!Array.isArray(doc.regions) || doc.regions.length === 0) {
    fail(label, "document", "has no regions", "a vector document needs at least one filled region");
  }
  doc.regions.forEach((rg, i) => {
    const where = `region ${i + 1}`;
    if (!rg || typeof rg !== "object") fail(label, where, "is not an object");
    checkContour(label, `${where} outer`, rg.outer);
    if (rg.holes != null && !Array.isArray(rg.holes)) fail(label, where, "has a non-array `holes`");
    (rg.holes ?? []).forEach((h, j) => checkContour(label, `${where} hole ${j + 1}`, h));
  });

  // bbox is a CACHE, not an authority: svg2d recomputes it anyway. Checking it
  // here turns a stale or hand-miscalculated header into a named error instead
  // of silently wrong sizing at build time.
  if (!doc.bbox || !["minX", "minY", "maxX", "maxY"].every((k) => Number.isFinite(doc.bbox[k]))) {
    fail(label, "document", "has no valid `bbox`", "bbox needs finite minX, minY, maxX, maxY");
  }
  const actual = bboxOf(toInternalRegionsUnchecked(doc));
  for (const k of ["minX", "minY", "maxX", "maxY"]) {
    if (Math.abs(actual[k] - doc.bbox[k]) > BBOX_TOL) {
      fail(label, "document", `has a bbox that disagrees with its geometry (${k}: header ${doc.bbox[k]}, actual ${round6(actual[k])})`,
        "re-ingest the artwork, or correct the bbox to the tight bounds of `regions`");
    }
  }
}

const toSeg = (s) =>
  s.kind === "arc" ? { to: [...s.to], via: [...s.through] }
  : s.kind === "cubic" ? { to: [...s.to], c1: [...s.c1], c2: [...s.c2] }
  : { to: [...s.to] };

function toContour(c) {
  const segments = c.segments.map(toSeg);
  // A document may spell the implicit closure out. Dropping it here keeps one
  // internal representation, so downstream never has to ask which form it got.
  const last = segments.at(-1);
  if (!last.via && !last.c1 && last.to[0] === c.start[0] && last.to[1] === c.start[1]) segments.pop();
  return { start: [...c.start], segments };
}

const toInternalRegionsUnchecked = (doc) =>
  doc.regions.map((rg) => ({ outer: toContour(rg.outer), holes: (rg.holes ?? []).map(toContour) }));

export function toInternalRegions(doc, label = "(unnamed)") {
  validateVectorDocument(doc, label);
  return toInternalRegionsUnchecked(doc);
}

function bboxOf(regions) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const rg of regions) {
    for (const [x, y] of tessellateContour(rg.outer, BBOX_SEGS)) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

const fromSeg = (s) =>
  s.via ? { kind: "arc", to: [round6(s.to[0]), round6(s.to[1])], through: [round6(s.via[0]), round6(s.via[1])] }
  : s.c1 ? { kind: "cubic", to: [round6(s.to[0]), round6(s.to[1])],
             c1: [round6(s.c1[0]), round6(s.c1[1])], c2: [round6(s.c2[0]), round6(s.c2[1])] }
  : { kind: "line", to: [round6(s.to[0]), round6(s.to[1])] };

const fromContour = (c) => ({ start: [round6(c.start[0]), round6(c.start[1])], segments: c.segments.map(fromSeg) });

export function fromInternalRegions(regions, { source = null } = {}) {
  const bb = bboxOf(regions);
  return {
    format: VECTOR_FORMAT,
    version: VECTOR_VERSION,
    note: FORMAT_NOTE,
    source,
    bbox: { minX: round6(bb.minX), minY: round6(bb.minY), maxX: round6(bb.maxX), maxY: round6(bb.maxY) },
    regions: regions.map((rg) => ({ outer: fromContour(rg.outer), holes: (rg.holes ?? []).map(fromContour) })),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/vector-format.test.js`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/vector-format.js test/vector-format.test.js
git commit -m "svg: the partforge-vector JSON format, validation, and IR mapping"
```

---

### Task 2: `arc-fit.js` — circular-arc recovery

**Files:**
- Create: `src/framework/geometry/arc-fit.js`
- Test: `test/arc-fit.test.js`

**Interfaces:**
- Consumes: `arcCenterAndSweep` from `./paper-bridge.js`, `cubicAt` from `./contour-ops.js`.
- Produces: `recoverArcs(contour: Contour) → Contour` — replaces maximal runs of cubic segments that lie on a common circle with `{to, via}` arcs, split at ≤180°. Non-cubic segments and runs that fail the fit pass through untouched.

**Why this exists:** paper.js has no arc primitive, so `importSVG` returns everything as cubics — a `<circle>` becomes four. Without this pass, OCCT gets a spline where a circle should be. Recovering at the *format* level rather than special-casing `<circle>` means arcs from `A` commands, rounded-rect corners, and transformed circles all come back through one mechanism.

**Why the fit is exact, not approximate:** paper's kappa construction pins each cubic's endpoints to the true circle; only the interior deviates. So fitting through segment *endpoints* recovers the original circle to float precision, and the tolerance is only an acceptance test on the interiors.

- [ ] **Step 1: Write the failing test**

Create `test/arc-fit.test.js`:

```js
import { expect, test } from "vitest";
import { recoverArcs } from "../src/framework/geometry/arc-fit.js";
import { arcCenterAndSweep } from "../src/framework/geometry/paper-bridge.js";

// A circle the way paper.js builds one: four cubics with the standard kappa
// handle. This is the exact shape importSVG hands back for a <circle>.
const KAPPA = 0.5522847498307936;
function paperCircle(cx, cy, r) {
  const k = KAPPA * r;
  const pts = [[cx + r, cy], [cx, cy + r], [cx - r, cy], [cx, cy - r]];
  const tans = [[0, k], [-k, 0], [0, -k], [k, 0]];
  const segments = [];
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4], ta = tans[i], tb = tans[(i + 1) % 4];
    segments.push({ to: b, c1: [a[0] + ta[0], a[1] + ta[1]], c2: [b[0] - tb[0], b[1] - tb[1]] });
  }
  return { start: pts[0], segments };
}

test("a paper-style circle collapses to arcs", () => {
  const out = recoverArcs(paperCircle(5, 7, 3));
  expect(out.segments.every((s) => s.via)).toBe(true);
  expect(out.segments.every((s) => s.c1 === undefined)).toBe(true);
});

test("the recovered circle has the exact original centre and radius", () => {
  const out = recoverArcs(paperCircle(5, 7, 3));
  let prev = out.start;
  for (const s of out.segments) {
    const c = arcCenterAndSweep(prev, s.via, s.to);
    expect(c.center[0]).toBeCloseTo(5, 6);
    expect(c.center[1]).toBeCloseTo(7, 6);
    expect(c.r).toBeCloseTo(3, 6);
    prev = s.to;
  }
});

test("a full circle is split into arcs of at most 180 degrees", () => {
  const out = recoverArcs(paperCircle(0, 0, 1));
  expect(out.segments.length).toBeGreaterThanOrEqual(2);
  let prev = out.start;
  for (const s of out.segments) {
    const c = arcCenterAndSweep(prev, s.via, s.to);
    expect(Math.abs(c.dA)).toBeLessThanOrEqual(Math.PI + 1e-9);
    prev = s.to;
  }
});

test("an ellipse does not collapse — it is not a circle", () => {
  const c = paperCircle(0, 0, 4);
  const squash = (p) => [p[0], p[1] / 2];
  const flat = { start: squash(c.start), segments: c.segments.map((s) => ({ to: squash(s.to), c1: squash(s.c1), c2: squash(s.c2) })) };
  const out = recoverArcs(flat);
  expect(out.segments.some((s) => s.c1)).toBe(true);
});

test("a freeform curve does not collapse", () => {
  const wiggle = { start: [0, 0], segments: [
    { to: [10, 0], c1: [2, 8], c2: [8, -8] },
    { to: [20, 4], c1: [12, 6], c2: [18, -2] },
  ] };
  const out = recoverArcs(wiggle);
  expect(out.segments).toEqual(wiggle.segments);
});

test("lines and existing arcs pass through untouched", () => {
  const mixed = { start: [0, 0], segments: [
    { to: [5, 0] }, { to: [10, 5], via: [9, 1] }, { to: [0, 5] },
  ] };
  expect(recoverArcs(mixed)).toEqual(mixed);
});

test("a circular run collapses while its non-circular neighbours stay cubic", () => {
  const c = paperCircle(0, 0, 2);
  const mixed = { start: [0, 0], segments: [
    { to: c.start },                                   // a line into the arc run
    ...c.segments.slice(0, 2),                         // half the circle
    { to: [40, 40], c1: [20, 0], c2: [30, 30] },       // a freeform cubic out of it
  ] };
  const out = recoverArcs(mixed);
  expect(out.segments[0].via).toBeUndefined();         // line untouched
  expect(out.segments.some((s) => s.via)).toBe(true);  // the run collapsed
  expect(out.segments.at(-1).c1).toEqual([20, 0]);     // freeform untouched
});

test("a single cubic that is a quarter circle collapses on its own", () => {
  const c = paperCircle(0, 0, 5);
  const one = { start: c.start, segments: [c.segments[0], { to: c.start }] };
  const out = recoverArcs(one);
  expect(out.segments[0].via).toBeDefined();
});

test("endpoints are preserved exactly", () => {
  const c = paperCircle(3, 4, 2);
  const out = recoverArcs(c);
  expect(out.start).toEqual(c.start);
  expect(out.segments.at(-1).to).toEqual(c.segments.at(-1).to);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/arc-fit.test.js`
Expected: FAIL — cannot resolve `arc-fit.js`.

- [ ] **Step 3: Write the implementation**

Create `src/framework/geometry/arc-fit.js`:

```js
// Circular-arc recovery: runs of cubic segments that lie on a common circle
// become symbolic {to, via} arcs.
//
// paper.js has no arc primitive, so importSVG returns every curve as a cubic —
// a <circle> arrives as four of them. Without this pass the OCCT backend would
// build a spline where the artwork had a circle. Recovering at the CONTOUR level
// rather than special-casing <circle> means arcs from `A` commands, rounded-rect
// corners, and transformed circles all come back through one mechanism.
//
// The fit is exact, not approximate. Paper's kappa construction pins each
// cubic's ENDPOINTS to the true circle and only the interior deviates, so a
// three-point fit through endpoints recovers the original centre and radius to
// float precision. ARC_TOL is therefore an acceptance test on the interiors, not
// the accuracy of the result — and it sits above paper's own kappa error
// (~2.7e-4 * r), because a tighter threshold would reject genuine circles.
//
// Pure leaf: DOM-free, node:-free.
import { arcCenterAndSweep } from "./paper-bridge.js";
import { cubicAt } from "./contour-ops.js";

const ARC_TOL = 1e-3;            // relative to radius
const PROBE_TS = [0.25, 0.5, 0.75];
const MAX_SWEEP = Math.PI;       // split arcs at 180° so the 3-point form stays unambiguous

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Does every probed interior point of every cubic in `run` lie on the circle?
function runFits(run, from, center, r) {
  const tol = ARC_TOL * r;
  let p = from;
  for (const s of run) {
    for (const t of PROBE_TS) {
      const q = cubicAt(p, s.c1, s.c2, s.to, t);
      if (Math.abs(dist(q, center) - r) > tol) return false;
    }
    p = s.to;
  }
  return true;
}

// Fit through the run's first, middle and last ENDPOINT — all exact on the
// source circle. A two-cubic run has three endpoints and uses them directly.
function fitCircle(run, from) {
  const pts = [from, ...run.map((s) => s.to)];
  const mid = pts[Math.floor(pts.length / 2)];
  const c = arcCenterAndSweep(pts[0], mid, pts.at(-1));
  if (!c || !Number.isFinite(c.r) || c.r <= 0) return null;
  return c;
}

// One arc from `from` to `to` about `center`, split so no piece exceeds 180°.
// `via` is placed at each piece's angular midpoint, which is what makes the
// three-point form recoverable.
function arcsBetween(from, to, center, r, sweepSign) {
  const ang = (p) => Math.atan2(p[1] - center[1], p[0] - center[0]);
  const a0 = ang(from);
  let dA = ang(to) - a0;
  const twoPi = 2 * Math.PI;
  while (dA <= 0) dA += twoPi;
  while (dA > twoPi) dA -= twoPi;
  if (sweepSign < 0) dA -= twoPi;
  const pieces = Math.max(1, Math.ceil(Math.abs(dA) / MAX_SWEEP - 1e-9));
  const out = [];
  for (let i = 0; i < pieces; i++) {
    const s0 = a0 + dA * (i / pieces), s1 = a0 + dA * ((i + 1) / pieces);
    const m = (s0 + s1) / 2;
    const P = (t) => [center[0] + r * Math.cos(t), center[1] + r * Math.sin(t)];
    out.push({ to: P(s1), via: P(m) });
  }
  out.at(-1).to = [to[0], to[1]];    // pin the exact endpoint
  return out;
}

// The direction the run actually travels, from the first cubic's own geometry.
function sweepSignOf(run, from, center) {
  const a = [from[0] - center[0], from[1] - center[1]];
  const q = cubicAt(from, run[0].c1, run[0].c2, run[0].to, 0.5);
  const b = [q[0] - center[0], q[1] - center[1]];
  return a[0] * b[1] - a[1] * b[0] >= 0 ? 1 : -1;
}

export function recoverArcs(contour) {
  const segs = contour.segments;
  const out = [];
  let from = contour.start;
  let i = 0;

  while (i < segs.length) {
    if (!segs[i].c1) { out.push(segs[i]); from = segs[i].to; i++; continue; }

    // Greedy: extend the cubic run while it still fits one circle.
    const runFrom = from;
    let best = null, bestEnd = i;
    let j = i;
    while (j < segs.length && segs[j].c1) {
      const run = segs.slice(i, j + 1);
      const c = fitCircle(run, runFrom);
      if (c && runFits(run, runFrom, c.center, c.r)) { best = c; bestEnd = j; }
      j++;
    }

    if (!best) { out.push(segs[i]); from = segs[i].to; i++; continue; }

    const run = segs.slice(i, bestEnd + 1);
    const end = run.at(-1).to;
    out.push(...arcsBetween(runFrom, end, best.center, best.r, sweepSignOf(run, runFrom, best.center)));
    from = end;
    i = bestEnd + 1;
  }

  return { start: [...contour.start], segments: out };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/arc-fit.test.js`
Expected: PASS, 9 tests.

If the "single cubic that is a quarter circle" case fails, check `fitCircle`: a one-cubic run has only two endpoints, so `pts[Math.floor(2/2)]` is the *last* point and the three-point fit degenerates. Fix by probing the cubic's own midpoint (`cubicAt(from, s.c1, s.c2, s.to, 0.5)`) as the middle point when `run.length === 1` — that point is NOT exact on the circle, so re-fit through endpoints once a second segment joins the run. Report the change if you make it.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/arc-fit.js test/arc-fit.test.js
git commit -m "svg: recover symbolic circular arcs from cubic runs"
```

---

### Task 3: `stroke-outline.js` — strokes become geometry

**Files:**
- Modify: `src/framework/geometry/contour-offset.js` (export `joinSegs` as `_joinSegs` — one line)
- Create: `src/framework/geometry/stroke-outline.js`
- Test: `test/stroke-outline.test.js`

**Interfaces:**
- Consumes: `_offsetSegment`, `_offsetContour`, `_joinSegs` from `./contour-offset.js`; `segTangent`, `SMOOTH_JOINT_DEG` from `./contour-ops.js`; `reverseContour`, `closeContourGap` from `./profile.js`; `resolveCurveFill` from `./curve-fill.js`.
- Produces: `outlineStroke(contour, closed, style) → Region[]` in the input's coordinate space, where `style` is `{ strokeWidth, linecap: "butt"|"round"|"square", linejoin: "miter"|"round"|"bevel" }`. Throws `Error` starting `"svg: "` when the outline collapses or the width is zero.

**Why `_offsetContour` is reused for the closed case but not the open one.** A closed stroked contour is exactly an annulus: offset the ring one way, offset the *reversed* ring the same way, and nonzero winding does the rest — so the closed case is two calls and no new geometry code. The open case has no closed ring to hand it, so it gets a small purpose-built chain walker built from the same lower-level parts. `_offsetContour` is ring-oriented throughout (wrap-around indexing, a whole-ring collapse predicate, an overlap-side trim gate with pinned performance numbers); threading an "open" flag through it would put every one of those invariants at risk for no gain.

**Note:** `stroke-miterlimit` is deliberately NOT honored. `joinSegs` carries a fixed `MITER_LIMIT = 2` (`contour-offset.js:89`) and takes no parameter for it. Do not add a test asserting SVG's default of 4 — it is not implemented, by decision.

- [ ] **Step 1: Write the failing test**

Create `test/stroke-outline.test.js`:

```js
import { expect, test } from "vitest";
import { outlineStroke } from "../src/framework/geometry/stroke-outline.js";
import { pathProfile } from "../src/framework/geometry/polygon.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const style = (o) => ({ strokeWidth: 2, linecap: "butt", linejoin: "miter", ...o });
const netArea = (regions) => regions.reduce((a, r) =>
  a + Math.abs(ringArea(tessellateContour(r.outer, 256)))
    - r.holes.reduce((h, c) => h + Math.abs(ringArea(tessellateContour(c, 256))), 0), 0);

const openLine = pathProfile([0, 0]).lineTo([10, 0]).close();
const square = pathProfile([0, 0]).lineTo([10, 0]).lineTo([10, 10]).lineTo([0, 10]).lineTo([0, 0]).close();

test("round caps: a length-10 stroke of width 2 has area 20 + pi", () => {
  expect(netArea(outlineStroke(openLine, false, style({ linecap: "round" })))).toBeCloseTo(20 + Math.PI, 1);
});

test("butt caps: the same stroke is a plain 10 x 2 rectangle", () => {
  expect(netArea(outlineStroke(openLine, false, style()))).toBeCloseTo(20, 1);
});

test("square caps add a half-width block at each end", () => {
  expect(netArea(outlineStroke(openLine, false, style({ linecap: "square" })))).toBeCloseTo(24, 1);
});

test("stroke width scales the outline linearly", () => {
  const a = netArea(outlineStroke(openLine, false, style({ strokeWidth: 1 })));
  const b = netArea(outlineStroke(openLine, false, style({ strokeWidth: 4 })));
  expect(b / a).toBeCloseTo(4, 4);
});

test("a closed square stroked width 2 with miter joins is a 144 - 64 annulus", () => {
  const regions = outlineStroke(square, true, style());
  expect(netArea(regions)).toBeCloseTo(80, 1);
  expect(regions).toHaveLength(1);
  expect(regions[0].holes).toHaveLength(1);
});

test("a closed square with round joins loses the mitre corners", () => {
  const regions = outlineStroke(square, true, style({ linejoin: "round" }));
  expect(netArea(regions)).toBeCloseTo(144 - (4 - Math.PI) - 64, 1);
});

test("an L-shaped open stroke is a single region", () => {
  const L = pathProfile([0, 0]).lineTo([10, 0]).lineTo([10, 10]).close();
  const regions = outlineStroke(L, false, style());
  expect(regions).toHaveLength(1);
  expect(netArea(regions)).toBeCloseTo(20 + 20 - 4, 1);   // two arms sharing a 2x2 corner
});

test("an open arc stroke keeps positive area and one region", () => {
  const arc = pathProfile([2, 0]).arcTo([-2, 0], [0, 2]).close();
  const regions = outlineStroke(arc, false, style({ strokeWidth: 1 }));
  expect(regions).toHaveLength(1);
  expect(netArea(regions)).toBeCloseTo(2 * Math.PI, 1);   // pi/2*(2.5^2 - 1.5^2)
});

test("a self-crossing open stroke normalizes rather than double-counting", () => {
  const cross = pathProfile([0, 0]).lineTo([10, 10]).lineTo([10, 0]).lineTo([0, 10]).close();
  const regions = outlineStroke(cross, false, style({ strokeWidth: 1 }));
  expect(regions.length).toBeGreaterThanOrEqual(1);
  expect(netArea(regions)).toBeGreaterThan(0);
  expect(netArea(regions)).toBeLessThan(4 * Math.hypot(10, 10) * 1);
});

test("a zero-width stroke throws rather than returning nothing", () => {
  expect(() => outlineStroke(openLine, false, style({ strokeWidth: 0 }))).toThrow(/svg: /);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/stroke-outline.test.js`
Expected: FAIL — cannot resolve `stroke-outline.js`.

- [ ] **Step 3a: Export `joinSegs` from `contour-offset.js`**

Immediately after `joinSegs`' closing brace (just before the `// Offset one explicitly-closed ring.` comment), add:

```js
// Exposed for stroke-outline.js, which walks OPEN chains and so cannot use
// _offsetContour's ring loop, but needs exactly this join vocabulary
// (round/chamfer/sharp + miter limit) at its interior vertices.
export const _joinSegs = joinSegs;
```

- [ ] **Step 3b: Write `stroke-outline.js`**

```js
// Stroke → filled geometry. The half of paperjs-offset that contour-offset.js
// did not port: `offsetStroke`.
//
// Both cases reduce to "offset the path, offset its reverse, let nonzero winding
// assemble the result":
//
//   CLOSED  outer = offset(contour, +w/2), inner = offset(reverse(contour), +w/2).
//           Two rings of opposite handedness -> an annulus. _offsetContour
//           already does closed rings correctly, so this adds no geometry code.
//   OPEN    the same two offsets as open CHAINS, joined end to end by caps into
//           one closed ring.
//
// Pure leaf: DOM-free, node:-free.
import { _joinSegs, _offsetContour, _offsetSegment } from "./contour-offset.js";
import { SMOOTH_JOINT_DEG, segTangent } from "./contour-ops.js";
import { closeContourGap, reverseContour } from "./profile.js";
import { resolveCurveFill } from "./curve-fill.js";

const JOIN_EPS = 1e-6;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const scl = (v, s) => [v[0] * s, v[1] * s];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const rightOf = ([x, y]) => [y, -x];        // matches contour-offset.js:31 exactly

// SVG's linejoin vocabulary is contour-offset.js's `corners` vocabulary under
// different names.
const CORNERS = { miter: "sharp", round: "round", bevel: "chamfer" };

// Each segment's start point, with zero-length lines dropped (no direction, so
// no offset).
function chainParts(contour) {
  const segs = [], froms = [];
  let p = contour.start;
  for (const s of contour.segments) {
    if (s.c1 || s.via || dist(p, s.to) > 1e-9) { segs.push(s); froms.push(p); }
    p = s.to;
  }
  return { segs, froms, end: p };
}

// Offset an OPEN chain, joining at interior vertices only. Mirrors
// _offsetContour's join decision (gap side gets a join, overlap side gets a
// bevel the winding rule then cancels) minus the wrap-around and the whole-ring
// collapse predicate, neither of which means anything for a chain.
function offsetOpenChain(contour, delta, corners) {
  const { segs, froms } = chainParts(contour);
  if (segs.length === 0) return null;
  const pieces = segs.map((s, i) => _offsetSegment(froms[i], s, delta));
  const out = [];
  for (let i = 0; i < pieces.length; i++) {
    if (i > 0) {
      const aEnd = pieces[i - 1].segments.at(-1).to, bStart = pieces[i].start;
      const inTan = segTangent(froms[i - 1], segs[i - 1], false);
      const outTan = segTangent(froms[i], segs[i], true);
      const turn = cross(inTan, outTan);
      const turnDeg = (Math.atan2(Math.abs(turn), Math.max(-1, Math.min(1, dot(inTan, outTan)))) * 180) / Math.PI;
      if (dist(aEnd, bStart) > JOIN_EPS && turnDeg >= SMOOTH_JOINT_DEG) {
        // turn === 0 with a large turnDeg is an exact 180 degree reversal — the
        // same ambiguity _offsetContour calls out; treat it as gap side so a
        // round join is honored rather than flat-capped.
        if (turn * delta > 0 || turn === 0) out.push(..._joinSegs(froms[i], aEnd, bStart, inTan, outTan, delta, corners));
        else out.push({ to: [bStart[0], bStart[1]] });
      }
    }
    out.push(...pieces[i].segments);
  }
  return { start: pieces[0].start, segments: out };
}

// Bridge to `to` around the path endpoint `tip`, where `tangent` points OUT of
// the path at that end and `hw` is the half stroke width. The current position
// on entry is tip + hw*rightOf(tangent).
function capSegments(tip, tangent, hw, linecap, to) {
  if (linecap === "round") return [{ via: add(tip, scl(tangent, hw)), to }];
  if (linecap === "square") {
    const ext = scl(tangent, hw), n = scl(rightOf(tangent), hw);
    return [{ to: add(add(tip, n), ext) }, { to: add(sub(tip, n), ext) }, { to }];
  }
  return [{ to }];                                            // butt
}

export function outlineStroke(contour, closed, style) {
  const hw = style.strokeWidth / 2;
  if (!(hw > 0)) throw new Error("svg: cannot outline a stroke of zero width");
  const corners = CORNERS[style.linejoin] ?? "sharp";

  if (closed) {
    const ring = closeContourGap(contour);
    const a = _offsetContour(ring, hw, corners).contour;
    const b = _offsetContour(closeContourGap(reverseContour(ring)), hw, corners).contour;
    const rings = [a, b].filter(Boolean);
    if (rings.length < 2) throw new Error("svg: stroke outline collapsed — stroke-width is too large for this shape");
    return resolveCurveFill(rings, { fillRule: "nonzero" });
  }

  const fwd = offsetOpenChain(contour, hw, corners);
  const rev = offsetOpenChain(reverseContour(contour), hw, corners);
  if (!fwd || !rev) throw new Error("svg: stroke path has no length to outline");

  const { segs, froms, end } = chainParts(contour);
  const endTan = segTangent(froms.at(-1), segs.at(-1), false);
  const startTanIn = segTangent(contour.start, segs[0], true);
  const startTanOut = [-startTanIn[0], -startTanIn[1]];

  const segments = [
    ...fwd.segments,
    ...capSegments(end, endTan, hw, style.linecap, rev.start),
    ...rev.segments,
    ...capSegments(contour.start, startTanOut, hw, style.linecap, fwd.start),
  ];

  // A stroke path that crosses itself makes this ring self-intersecting.
  // resolveCurveFill under nonzero is exactly the normalizer for that — the same
  // one the fill path uses, not a second mechanism.
  return resolveCurveFill([{ start: fwd.start, segments }], { fillRule: "nonzero" });
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/stroke-outline.test.js test/contour-offset.test.js
```

Expected: `stroke-outline` PASS (10 tests) and `contour-offset` still PASS. The `20 + pi` case is the load-bearing one — it is the stadium figure `joinSegs`' own comment pins, and it proves the round caps survived.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/stroke-outline.js src/framework/geometry/contour-offset.js test/stroke-outline.test.js
git commit -m "svg: stroke outlining on the existing offset engine"
```

---

### Task 4: `svg-ingest.js` — the browser half

**Files:**
- Modify: `test/setup/happy-dom-patches.js` (canvas 2D context stub)
- Create: `src/framework/ingest/svg-ingest.js`
- Create: `src/ingest.js`
- Test: `test/svg-ingest.test.js`

**Interfaces:**
- Consumes: `paper/dist/paper-core.js`; `toContour`, `toOpenContour`, `paperScope` from `../geometry/paper-bridge.js`; `outlineStroke` (Task 3); `recoverArcs` (Task 2); `fromInternalRegions` (Task 1); `resolveCurveFill` from `../geometry/curve-fill.js`.
- Produces: `ingestSvg(svgText, { strokes = "outline", source = null } = {}) → VectorDocument`, re-exported from `src/ingest.js` as the `partforge/ingest` entry.

**This is the only DOM-dependent file in the feature.** It must never be reachable from `jobs.js`. `test/worker-layering.test.js` enforces that implicitly and completely: it walks the worker's import closure and fails on any module that so much as names `document`.

**Two facts established by a spike against the real paper build**, so you can tell a bug from expected behaviour:
- `importSVG` **bakes ancestor transforms into point coordinates**. `M0,0 L10,0 L10,10` under `transform="translate(2 0) scale(2)"` comes back as `[[2,0],[22,0],[22,20]]`. You do not apply matrices yourself.
- Per-item style survives as `item.fillColor`, `item.fillRule`, `item.strokeColor`, `item.strokeWidth`, `item.strokeCap`, `item.strokeJoin`; `fill="none"` surfaces as `fillColor` **undefined**; `item.closed` carries open/closed. `importSVG` also emits one extra `Shape` leaf with neither fill nor stroke (the root clip) — the "skip items with no paint" rule drops it.

- [ ] **Step 1: Write the failing test**

Create `test/svg-ingest.test.js`:

```js
// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { ingestSvg } from "../src/framework/ingest/svg-ingest.js";
import { toInternalRegions } from "../src/framework/geometry/vector-format.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const svg = (body, attrs = 'viewBox="0 0 48 48"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
const netArea = (doc) => toInternalRegions(doc).reduce((a, r) =>
  a + Math.abs(ringArea(tessellateContour(r.outer, 256)))
    - r.holes.reduce((h, c) => h + Math.abs(ringArea(tessellateContour(c, 256))), 0), 0);

test("a filled rect ingests to a valid document with the right bbox and area", () => {
  const doc = ingestSvg(svg('<rect x="4" y="6" width="20" height="10" fill="#111"/>'), { source: "r.svg" });
  expect(doc.format).toBe("partforge-vector");
  expect(doc.source).toBe("r.svg");
  expect(doc.bbox.maxX - doc.bbox.minX).toBeCloseTo(20, 3);
  expect(doc.bbox.maxY - doc.bbox.minY).toBeCloseTo(10, 3);
  expect(netArea(doc)).toBeCloseTo(200, 1);
});

test("y is flipped from SVG's y-down to model y-up", () => {
  // a wide bar at SVG y=0 (the top) and a small square at SVG y=40 (the bottom)
  const doc = ingestSvg(svg('<rect x="0" y="0" width="40" height="4" fill="#111"/><rect x="0" y="40" width="4" height="4" fill="#111"/>'));
  const regions = toInternalRegions(doc);
  const widest = regions.map((r) => tessellateContour(r.outer, 8))
    .map((pts) => ({ w: Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])),
                     top: Math.max(...pts.map((p) => p[1])) }))
    .sort((a, b) => b.w - a.w)[0];
  expect(widest.top).toBeCloseTo(doc.bbox.maxY, 3);   // the wide bar is the HIGH one
});

test("ancestor transforms are baked in", () => {
  const doc = ingestSvg(svg('<g transform="translate(2 0) scale(2)"><rect width="10" height="10" fill="#111"/></g>'));
  expect(doc.bbox.maxX - doc.bbox.minX).toBeCloseTo(20, 3);
  expect(doc.bbox.minX).toBeCloseTo(2, 3);
});

test("fill=none with a stroke yields the stroke outline only", () => {
  const doc = ingestSvg(svg('<path fill="none" stroke="#111" stroke-width="2" stroke-linecap="butt" d="M0,0 L10,0"/>'));
  expect(netArea(doc)).toBeCloseTo(20, 1);
});

test("strokes:'ignore' drops stroke geometry", () => {
  const body = '<rect width="10" height="10" fill="#111" stroke="#111" stroke-width="4"/>';
  expect(netArea(ingestSvg(svg(body), { strokes: "ignore" }))).toBeCloseTo(100, 1);
  expect(netArea(ingestSvg(svg(body)))).toBeGreaterThan(100);
});

test("evenodd makes a hole where nonzero does not", () => {
  const d = "M0,0 L30,0 L30,30 L0,30 Z M10,10 L20,10 L20,20 L10,20 Z";
  expect(netArea(ingestSvg(svg(`<path fill="#111" fill-rule="evenodd" d="${d}"/>`)))).toBeCloseTo(800, 1);
  expect(netArea(ingestSvg(svg(`<path fill="#111" fill-rule="nonzero" d="${d}"/>`)))).toBeCloseTo(900, 1);
});

test("overlapping filled shapes union rather than double-count", () => {
  const doc = ingestSvg(svg('<rect width="10" height="10" fill="#111"/><rect x="5" width="10" height="10" fill="#111"/>'));
  expect(netArea(doc)).toBeCloseTo(150, 1);
});

test("a circle survives as symbolic arcs, not cubics", () => {
  const doc = ingestSvg(svg('<circle cx="24" cy="24" r="10" fill="#111"/>'));
  const [region] = toInternalRegions(doc);
  expect(region.outer.segments.every((s) => s.via)).toBe(true);
  expect(netArea(doc)).toBeCloseTo(Math.PI * 100, 0);
});

test("<use> and <defs> resolve — the capability this architecture bought", () => {
  const doc = ingestSvg(svg(
    '<defs><rect id="r" width="10" height="10"/></defs>'
    + '<use href="#r" fill="#111"/><use href="#r" x="20" fill="#111"/>'));
  expect(netArea(doc)).toBeCloseTo(200, 1);
  expect(doc.bbox.maxX - doc.bbox.minX).toBeCloseTo(30, 1);
});

test("a CSS class in a <style> block resolves", () => {
  const doc = ingestSvg(svg('<style>.a { fill: #111; }</style><rect class="a" width="10" height="10"/>'));
  expect(netArea(doc)).toBeCloseTo(100, 1);
});

test("an SVG with no painted geometry throws", () => {
  expect(() => ingestSvg(svg('<rect width="10" height="10" fill="none"/>'))).toThrow(/svg: /);
});

test("the emitted document always validates", () => {
  const doc = ingestSvg(svg('<circle cx="10" cy="10" r="5" fill="#111"/><path fill="none" stroke="#111" stroke-width="2" d="M0,30 L40,30"/>'));
  expect(() => toInternalRegions(doc, "x")).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svg-ingest.test.js`
Expected: FAIL — cannot resolve `svg-ingest.js`.

- [ ] **Step 3a: Stub the canvas context in `test/setup/happy-dom-patches.js`**

paper-core builds a canvas at **module load** time, and happy-dom has no canvas backend. A static `import paper from "paper/..."` in a test hoists above any in-test stub, so the stub has to be here — setup files run before test-module imports. Append:

```js
// paper-core creates a canvas and asks for a 2D context at MODULE LOAD time.
// happy-dom has no canvas backend, so that throws and any test importing paper
// fails before its first line runs. Geometry never touches the raster context —
// paper only wants it to construct a CanvasView — so a no-op stub is enough, and
// it keeps ingest tests on a plain static import. Real browsers have a real
// context and never reach this.
if (typeof HTMLCanvasElement !== "undefined" && !HTMLCanvasElement.prototype.getContext) {
  HTMLCanvasElement.prototype.getContext = () => ({
    save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    bezierCurveTo() {}, quadraticCurveTo() {}, arc() {}, rect() {}, fill() {}, stroke() {},
    clip() {}, translate() {}, scale() {}, rotate() {}, transform() {}, setTransform() {},
    clearRect() {}, fillRect() {}, strokeRect() {}, setLineDash() {},
    measureText: () => ({ width: 0 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData() {}, drawImage() {}, isPointInPath: () => false,
    createLinearGradient: () => ({ addColorStop() {} }),
    canvas: { width: 1, height: 1 },
  });
}
```

If happy-dom already defines `getContext` (returning null rather than being absent), change the guard to overwrite it unconditionally under happy-dom and say so in your report.

- [ ] **Step 3b: Write `src/framework/ingest/svg-ingest.js`**

```js
// SVG -> the partforge-vector JSON format. The browser half of k.svg2d, run ONCE
// per artwork by the host — never at build time, never in the geometry worker.
//
// This is the ONLY DOM-dependent file in the feature, and that is the whole
// point: with a real DOM, paper.js's importSVG does the work six hand-rolled
// modules would otherwise do. It bakes ancestor transforms into coordinates,
// resolves per-item style, and handles <use>, <defs> and CSS — none of which a
// DOM-free parser could reach.
//
// Never import this from the worker graph. test/worker-layering.test.js proves
// you have not: it walks the worker's import closure and fails on any module
// that so much as names `document`.
import paper from "paper/dist/paper-core.js";
import { toContour, toOpenContour } from "../geometry/paper-bridge.js";
import { resolveCurveFill } from "../geometry/curve-fill.js";
import { outlineStroke } from "../geometry/stroke-outline.js";
import { recoverArcs } from "../geometry/arc-fit.js";
import { fromInternalRegions } from "../geometry/vector-format.js";

// A private scope, never paper's package-global project — another consumer in
// the same page may import paper too. Same rule paper-bridge.js follows.
let _scope = null;
function scope() {
  if (!_scope) { _scope = new paper.PaperScope(); _scope.setup(new _scope.Size(1, 1)); }
  return _scope;
}

// SVG is y-down; the model frame is y-up. Applied after paper has baked
// transforms and before arc recovery, so everything downstream is in one frame.
const flipContour = (c) => ({
  start: [c.start[0], -c.start[1]],
  segments: c.segments.map((s) => {
    const m = { to: [s.to[0], -s.to[1]] };
    if (s.via) m.via = [s.via[0], -s.via[1]];
    if (s.c1) { m.c1 = [s.c1[0], -s.c1[1]]; m.c2 = [s.c2[0], -s.c2[1]]; }
    return m;
  }),
});

const flipRegion = (r) => ({ outer: flipContour(r.outer), holes: r.holes.map(flipContour) });

// A paper Path/CompoundPath -> this engine's contours, one per subpath.
function itemContours(item) {
  const paths = item.className === "CompoundPath" ? item.children : [item];
  return paths
    .filter((p) => p.segments && p.segments.length >= 2)
    .map((p) => ({ contour: p.closed ? toContour(p) : toOpenContour(p), closed: !!p.closed }));
}

const LINECAP = { butt: "butt", round: "round", square: "square" };
const LINEJOIN = { miter: "miter", round: "round", bevel: "bevel" };

export function ingestSvg(svgText, { strokes = "outline", source = null } = {}) {
  if (typeof svgText !== "string" || !svgText.trim()) {
    throw new Error("svg: ingestSvg needs the SVG document as a non-empty string");
  }
  const sc = scope();
  let root;
  try {
    root = sc.project.importSVG(svgText, { expandShapes: true, insert: false });
  } catch (e) {
    throw new Error(`svg: could not parse the SVG document — ${e?.message ?? e}`);
  }
  if (!root) throw new Error("svg: could not parse the SVG document");

  const resolved = [];
  const visit = (item) => {
    if (item.children && item.children.length) { item.children.forEach(visit); return; }
    if (!item.segments && item.className !== "CompoundPath") return;   // the root clip Shape lands here

    const subpaths = itemContours(item);
    if (subpaths.length === 0) return;

    // Colour is read only as present-or-absent: this produces geometry, not paint.
    if (item.fillColor) {
      // Per ITEM, not per subpath: a fill rule applies across an item's own
      // subpaths, which is what makes the counter of an "O" a hole.
      resolved.push(...resolveCurveFill(subpaths.map((s) => s.contour),
        { fillRule: item.fillRule === "evenodd" ? "evenodd" : "nonzero" }));
    }
    if (strokes !== "ignore" && item.strokeColor && item.strokeWidth > 0) {
      const style = {
        strokeWidth: item.strokeWidth,
        linecap: LINECAP[item.strokeCap] ?? "butt",
        linejoin: LINEJOIN[item.strokeJoin] ?? "miter",
      };
      // Per SUBPATH: each is stroked on its own, with its own open/closed sense.
      for (const { contour, closed } of subpaths) resolved.push(...outlineStroke(contour, closed, style));
    }
  };
  visit(root);

  if (resolved.length === 0) {
    throw new Error('svg: no painted geometry — every element is fill="none" with no stroke, hidden, or empty');
  }

  // One union across every item. The regions already carry the storage winding
  // invariant, so nonzero over the flattened contour list IS the union, holes
  // included.
  const union = resolveCurveFill(resolved.flatMap((r) => [r.outer, ...r.holes]), { fillRule: "nonzero" });
  if (union.length === 0) throw new Error("svg: geometry cancelled to nothing under the fill rule");

  const flipped = union.map(flipRegion);
  const withArcs = flipped.map((r) => ({ outer: recoverArcs(r.outer), holes: r.holes.map(recoverArcs) }));
  return fromInternalRegions(withArcs, { source });
}
```

- [ ] **Step 3c: Write `src/ingest.js`**

```js
// The published `partforge/ingest` entry: SVG -> the partforge-vector JSON
// format. DOM-required and main-thread only — a host runs it once per artwork
// and stores the result, the same division of labour as `fontCatalog`.
// partforge does not write files.
//
// Deliberately NOT re-exported from `partforge` (the main entry) or from
// `partforge/geometry`: this must stay unreachable from the geometry worker.
export { ingestSvg } from "./framework/ingest/svg-ingest.js";
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/svg-ingest.test.js test/worker-layering.test.js
```

Expected: `svg-ingest` PASS (12 tests), `worker-layering` PASS. If the `<use>` or CSS tests fail, that is happy-dom's SVG support falling short of a real browser, not a defect in this file — report it and say which cases; the capability is still real in the browser this actually runs in.

- [ ] **Step 5: Commit**

```bash
git add src/framework/ingest/svg-ingest.js src/ingest.js test/setup/happy-dom-patches.js test/svg-ingest.test.js
git commit -m "svg: browser-side ingest to the partforge-vector format"
```

---

### Task 5: `svg2d.js` — placement

**Files:**
- Create: `src/framework/geometry/svg2d.js`
- Test: `test/svg2d.test.js`

**Interfaces:**
- Consumes: `tessellateContour` from `./profile.js`.
- Produces: `placeRegions(regions: Region[], opts) → Region[]` — scales uniformly and aligns internal regions, in millimetres. `opts` is `{ width?, height?, fit?, align?, valign? }`. Throws `Error` starting `"svg2d: "` for a missing or non-positive size and for a degenerate extent.

Input is already-validated internal regions (from `toInternalRegions`), so this file does no format work at all — it is pure placement.

- [ ] **Step 1: Write the failing test**

Create `test/svg2d.test.js`:

```js
import { expect, test } from "vitest";
import { placeRegions } from "../src/framework/geometry/svg2d.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";

// a 20 x 10 box in artwork units
const BOX = [{ outer: { start: [0, 0], segments: [
  { to: [20, 0] }, { to: [20, 10] }, { to: [0, 10] },
] }, holes: [] }];

const bbox = (rs) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rs) for (const [x, y] of tessellateContour(r.outer, 128)) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
};

test("width sizes the tight bbox and preserves aspect", () => {
  const b = bbox(placeRegions(BOX, { width: 40 }));
  expect(b.w).toBeCloseTo(40, 4);
  expect(b.h).toBeCloseTo(20, 4);
});

test("height sizes the other axis", () => {
  const b = bbox(placeRegions(BOX, { height: 5 }));
  expect(b.h).toBeCloseTo(5, 4);
  expect(b.w).toBeCloseTo(10, 4);
});

test("fit sizes the longer edge", () => {
  expect(Math.max(...Object.values({ w: bbox(placeRegions(BOX, { fit: 30 })).w, h: bbox(placeRegions(BOX, { fit: 30 })).h })))
    .toBeCloseTo(30, 4);
});

test("omitting all three size options throws and names them", () => {
  expect(() => placeRegions(BOX, {})).toThrow(/width.*height.*fit/s);
});

test("a non-positive size throws", () => {
  expect(() => placeRegions(BOX, { width: 0 })).toThrow(/svg2d: /);
  expect(() => placeRegions(BOX, { height: -3 })).toThrow(/svg2d: /);
});

test("placement ignores where the artwork sits in its own coordinate space", () => {
  const far = [{ outer: { start: [400, 700], segments: [
    { to: [420, 700] }, { to: [420, 710] }, { to: [400, 710] },
  ] }, holes: [] }];
  const b = bbox(placeRegions(far, { width: 40 }));
  expect(b.w).toBeCloseTo(40, 4);
  expect((b.minX + b.maxX) / 2).toBeCloseTo(0, 6);
});

test("default alignment centres on the origin", () => {
  const b = bbox(placeRegions(BOX, { width: 20 }));
  expect((b.minX + b.maxX) / 2).toBeCloseTo(0, 6);
  expect((b.minY + b.maxY) / 2).toBeCloseTo(0, 6);
});

test("align left and valign bottom put those edges on the origin", () => {
  const b = bbox(placeRegions(BOX, { width: 20, align: "left", valign: "bottom" }));
  expect(b.minX).toBeCloseTo(0, 6);
  expect(b.minY).toBeCloseTo(0, 6);
});

test("align right and valign top put the far edges on the origin", () => {
  const b = bbox(placeRegions(BOX, { width: 20, align: "right", valign: "top" }));
  expect(b.maxX).toBeCloseTo(0, 6);
  expect(b.maxY).toBeCloseTo(0, 6);
});

test("holes are scaled and aligned with their outer", () => {
  const withHole = [{
    outer: BOX[0].outer,
    holes: [{ start: [5, 2], segments: [{ to: [5, 8] }, { to: [15, 8] }, { to: [15, 2] }] }],
  }];
  const [r] = placeRegions(withHole, { width: 40, align: "left", valign: "bottom" });
  expect(r.holes).toHaveLength(1);
  expect(r.holes[0].start).toEqual([10, 4]);          // scale 2, origin at the corner
});

test("arcs stay symbolic through placement", () => {
  const arcs = [{ outer: { start: [2, 0], segments: [
    { to: [-2, 0], via: [0, 2] }, { to: [2, 0], via: [0, -2] },
  ] }, holes: [] }];
  const [r] = placeRegions(arcs, { width: 8 });
  expect(r.outer.segments.every((s) => s.via)).toBe(true);
  expect(r.outer.segments[0].via).toEqual([0, 4]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svg2d.test.js`
Expected: FAIL — cannot resolve `svg2d.js`.

- [ ] **Step 3: Write the implementation**

```js
// Place ingested vector regions: one uniform scale to the requested millimetre
// size, then an alignment translate. That is the entire runtime half of
// k.svg2d — everything else happened once, at ingest.
//
// The transform is uniform by construction, so arcs stay arcs and the OCCT
// backend still gets true circular B-rep edges.
//
// Pure leaf: DOM-free, node:-free.
import { tessellateContour } from "./profile.js";

const BBOX_SEGS = 64;
const EXTENT_EPS = 1e-9;

function bboxOf(regions) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of regions) {
    for (const [x, y] of tessellateContour(r.outer, BBOX_SEGS)) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

function scaleFor({ width, height, fit }, w, h) {
  const need = (extent, label) => {
    if (!(extent > EXTENT_EPS)) throw new Error(`svg2d: artwork has no ${label} to size against`);
  };
  const positive = (v, name) => {
    if (!(v > 0)) throw new Error(`svg2d: ${name} must be a positive number of millimetres`);
  };
  if (width != null) { positive(width, "width"); need(w, "width"); return width / w; }
  if (height != null) { positive(height, "height"); need(h, "height"); return height / h; }
  if (fit != null) { positive(fit, "fit"); need(Math.max(w, h), "extent"); return fit / Math.max(w, h); }
  // No honest default exists: an artwork's units have no physical meaning, unlike
  // a font's cap height — which is why k.text2d can default `size` and this cannot.
  throw new Error("svg2d: a size is required — pass one of { width }, { height }, or { fit } in millimetres");
}

const place = (c, s, dx, dy) => {
  const T = ([x, y]) => [x * s + dx, y * s + dy];
  return {
    start: T(c.start),
    segments: c.segments.map((seg) => {
      const m = { to: T(seg.to) };
      if (seg.via) m.via = T(seg.via);
      if (seg.c1) { m.c1 = T(seg.c1); m.c2 = T(seg.c2); }
      return m;
    }),
  };
};

export function placeRegions(regions, opts = {}) {
  const { align = "center", valign = "middle" } = opts;
  const { minX, minY, maxX, maxY } = bboxOf(regions);
  const s = scaleFor(opts, maxX - minX, maxY - minY);
  const dx = align === "left" ? -minX * s : align === "right" ? -maxX * s : -((minX + maxX) / 2) * s;
  const dy = valign === "bottom" ? -minY * s : valign === "top" ? -maxY * s : -((minY + maxY) / 2) * s;
  return regions.map((r) => ({
    outer: place(r.outer, s, dx, dy),
    holes: r.holes.map((c) => place(c, s, dx, dy)),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/svg2d.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/svg2d.js test/svg2d.test.js
git commit -m "svg: scale and align ingested regions at build time"
```

---

### Task 6: Wiring — `svgs.js`, `k.svg2d`, and every kernel boot path

**Files:**
- Create: `src/framework/svgs.js`
- Modify: `src/framework/geometry/kernel-front.js`, `src/framework/geometry/kernel.js` (op list, ~line 24), `src/framework/jobs.js` (after the `ensureImports` call, ~line 228)
- Modify: `src/testing/manifold.js`, `src/testing/occt.js`, `bin/cli.js` (`bootKernel`, ~line 104)
- Modify: `docs/KERNEL-CONTRACT.md`
- Test: `test/svgs.test.js`

**Interfaces:**
- Consumes: `makeAssetResolver`/`resolveDecl` from `./asset-resolve.js`; `toInternalRegions` (Task 1); `placeRegions` (Task 5).
- Produces: `resolveSvgs(decl) → Promise<Map<name, Region[]>>`, `ensureSvgs(kernel, decl) → Promise<void>`, and `k.svg2d(name, opts) → Shape2D`.

**Why the Node boot paths matter.** `bin/cli.js` boots its own kernel through `src/testing/manifold.js` / `occt.js` — it does not go through `jobs.js`. Wiring only `jobs.js` gives a part that builds in the browser and dies under `partforge measure` with `svg2d: unknown svg`, which is exactly the failure `bin/cli.js:96` records for fonts.

- [ ] **Step 1: Write the failing test**

Create `test/svgs.test.js`:

```js
import { expect, test } from "vitest";
import { resolveSvgs, ensureSvgs } from "../src/framework/svgs.js";
import { fromInternalRegions } from "../src/framework/geometry/vector-format.js";

const box = (w = 10) => fromInternalRegions([{ outer: { start: [0, 0], segments: [
  { to: [w, 0] }, { to: [w, 10] }, { to: [0, 10] },
] }, holes: [] }], { source: null });
const bytes = (doc) => new TextEncoder().encode(JSON.stringify(doc));

test("resolves JSON bytes to internal regions", async () => {
  const map = await resolveSvgs({ a: bytes(box()) });
  expect(map.get("a")).toHaveLength(1);
  expect(map.get("a")[0].outer.segments).toHaveLength(3);
});

test("resolves a thunk returning bytes", async () => {
  const map = await resolveSvgs({ a: () => bytes(box()) });
  expect(map.get("a")).toHaveLength(1);
});

test("memoizes by source identity — one parse per source", async () => {
  let calls = 0;
  const src = () => { calls++; return bytes(box()); };
  await resolveSvgs({ a: src });
  await resolveSvgs({ b: src });
  expect(calls).toBe(1);
});

test("malformed JSON rejects with a message naming the key", async () => {
  await expect(resolveSvgs({ logo: new TextEncoder().encode("{ not json") })).rejects.toThrow(/logo/);
});

test("a structurally invalid document rejects through the format validator", async () => {
  const d = box(); d.regions[0].outer.segments[0] = { kind: "spiral", to: [1, 1] };
  await expect(resolveSvgs({ logo: bytes(d) })).rejects.toThrow(/spiral/);
});

test("a source that is not bytes, a URL, or a thunk rejects", async () => {
  await expect(resolveSvgs({ bad: 42 })).rejects.toThrow(/must be bytes, a URL, or a thunk/);
});

test("ensureSvgs registers on the kernel and prunes stale names", async () => {
  const kernel = { _svgs: new Map() };
  await ensureSvgs(kernel, { a: bytes(box()), b: bytes(box(20)) });
  expect([...kernel._svgs.keys()].sort()).toEqual(["a", "b"]);
  await ensureSvgs(kernel, { a: bytes(box()) });
  expect([...kernel._svgs.keys()]).toEqual(["a"]);
});

test("ensureSvgs is a no-op on a kernel with no _svgs map", async () => {
  await expect(ensureSvgs({}, { a: bytes(box()) })).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svgs.test.js`
Expected: FAIL — cannot resolve `svgs.js`.

- [ ] **Step 3a: Create `src/framework/svgs.js`**

```js
// Resolve a part's declared `svgs` ({ name: source }) to internal regions before
// the synchronous build — the vector-art sibling of fonts.js and imports.js:
// same source grammar and identity-memoization rule, built on the shared core in
// asset-resolve.js. The source resolves to JSON in the partforge-vector format,
// not to SVG; conversion happened once, in a browser, at ingest.
//
// No content digest, deliberately. It looks like a missing piece next to
// imports.js and is not: k.svg2d lowers to k.shape2d(regions) and the Shape2D
// hash keys on the actual coordinates, so different artwork gives a different
// cache entry automatically. Imports need a digest because a Solid master is
// registered by NAME and is opaque to that hash; parsed regions are not. Same
// argument kernel-front.js:117-121 records for text2d.
//
// DOM-free and node:-free.
import { makeAssetResolver, resolveDecl } from "./asset-resolve.js";
import { toInternalRegions } from "./geometry/vector-format.js";

const cache = new Map();   // source → Promise<Region[]>

function parseDocument(bytes, label) {
  let text;
  try { text = new TextDecoder().decode(bytes); }
  catch { throw new Error(`svg2d: "${label}" could not be decoded as UTF-8 text`); }
  let doc;
  try { doc = JSON.parse(text); }
  catch (e) {
    throw new Error(`svg2d: "${label}" is not valid JSON — ${e.message}. `
      + "An svgs source is an ingested partforge-vector document, not an .svg file; see docs/VECTOR-FORMAT.md");
  }
  return toInternalRegions(doc, label);
}

// The resolver memoizes by source identity and cannot see the declared name, so
// the name is bound per declaration below rather than baked into the resolver.
const resolveOne = makeAssetResolver(
  cache,
  (bytes) => bytes,
  "resolveSvgs: an svg source must be bytes, a URL, or a thunk returning one",
);

export async function resolveSvgs(svgsDecl) {
  const raw = await resolveDecl(svgsDecl, resolveOne);
  const out = new Map();
  for (const [name, bytes] of raw) out.set(name, parseDocument(bytes, name));
  return out;
}

// Register a part's svgs on a booted kernel. Called in the async phase before
// every job's synchronous build — worker (jobs.js) and Node boots alike.
export async function ensureSvgs(kernel, svgsDecl) {
  if (!kernel?._svgs) return;
  const declared = svgsDecl ?? {};
  for (const [name, regions] of await resolveSvgs(declared)) kernel._svgs.set(name, regions);
  // Drop names this declaration does not supply. `_svgs` is the kernel's and the
  // kernel outlives the job (worker-rebind, many parts), so without this a name
  // from a previous part stays resolvable — the stale-registration bug jobs.js's
  // font prune exists to prevent.
  for (const name of [...kernel._svgs.keys()]) {
    if (!Object.hasOwn(declared, name)) kernel._svgs.delete(name);
  }
}
```

- [ ] **Step 3b: Add `k.svg2d` in `kernel-front.js`**

Add the import beside the existing `textGlyphs` one:

```js
import { placeRegions } from "./svg2d.js";
```

Then, immediately after the `k.text2d = (string, opts = {}) => { ... };` block:

```js
  // 2-D vector art as a Shape2D. Backend-agnostic for the same reason text2d is:
  // it lowers to k.shape2d + union, so both backends get identical curve regions.
  // Regions come from k._svgs, preloaded by name from the part's ingested
  // artwork — this op does no SVG parsing at all, by design.
  k._svgs ??= new Map();
  k.svg2d = (name, opts = {}) => {
    if (typeof name !== "string" || !name)
      throw new Error("svg2d: first argument must be the name of an entry in the part's `svgs` field");
    const regions = k._svgs.get(name);
    if (!regions) throw new Error(`svg2d: unknown svg "${name}" — declare it in the part's \`svgs\` field`);
    return placeRegions(regions, opts).map((r) => k.shape2d(r)).reduce((a, b) => a.union(b));
  };
```

- [ ] **Step 3c: Add the op name in `kernel.js`**

In the op-name list at `src/framework/geometry/kernel.js:24`, add `"svg2d"` immediately after `"text2d"`.

- [ ] **Step 3d: Register in `jobs.js`**

Add `import { ensureSvgs } from "./svgs.js";` beside the imports one, then immediately after the existing `if (part.imports) await ensureImports(...)` line:

```js
    // Vector art, the third asset family after fonts and imports. Same pre-build
    // timing; ensureSvgs owns the prune, so this stays one line.
    if (part.svgs) await ensureSvgs(kernel, part.svgs);
```

- [ ] **Step 3e: Wire the Node boots**

In `src/testing/manifold.js`: add `import { ensureSvgs } from "../framework/svgs.js";`, add `svgs` to the destructured options, and add this immediately before `return kernel;`:

```js
  if (svgs) await ensureSvgs(kernel, nodeAssetSources(svgs));
```

Make the identical three changes in `src/testing/occt.js`.

- [ ] **Step 3f: Pass `svgs` from the CLI**

In `bin/cli.js`'s `bootKernel`, change

```js
  const opts = { fonts: fontsFor(part, p), imports: part.imports };
```

to

```js
  const opts = { fonts: fontsFor(part, p), imports: part.imports, svgs: part.svgs };
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/svgs.test.js test/worker-layering.test.js test/kernel-contract.test.js
```

`svgs` PASS (8 tests). `worker-layering` PASS — this is the assertion that the new worker-side files are DOM-free AND that ingest has not leaked into the worker graph.

`kernel-contract.test.js` will FAIL until `docs/KERNEL-CONTRACT.md` documents the new op — that test holds the doc's op coverage to the code. Read the failure, then add an `svg2d` row to the contract's op table in the same shape as the neighbouring `text2d` row, recording: **conformance — both backends** (it lowers to `shape2d`), **semantics — identical across backends by construction** (curve-native regions, no sampling). Bump the contract's version header if the test asks. Re-run until green.

- [ ] **Step 5: Commit**

```bash
git add src/framework/svgs.js src/framework/geometry/kernel-front.js src/framework/geometry/kernel.js \
        src/framework/jobs.js src/testing/manifold.js src/testing/occt.js bin/cli.js \
        docs/KERNEL-CONTRACT.md test/svgs.test.js
git commit -m "svg: k.svg2d, the svgs declaration, and every kernel boot path"
```

---

### Task 7: Lint rules

**Files:**
- Create: `src/framework/lint/rules-svg.js`
- Modify: `src/framework/lint/index.js:11-22`
- Test: `test/lint-svg.test.js`

**Interfaces:**
- Consumes: `err` from `./finding.js`; the lint context's `part` and `probe()` (whose `.calls` entries are `{ scope, op, args }` with `args` as raw **source text**, exactly as `rules-imports.js` uses them).
- Produces: `SVG_RULES` — two rule objects.

`partforge/lint` has zero runtime dependencies and never imports geometry. Both rules read only the part module's source and its `svgs` field.

- [ ] **Step 1: Write the failing test**

Create `test/lint-svg.test.js`:

```js
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const ids = (findings) => findings.map((f) => f.rule);
const find = (r, rule) => [...r.errors, ...r.warnings].find((f) => f.rule === rule);
const partWith = (build, extra = {}) => ({
  meta: { title: "T" },
  defaults: {},
  parts: { body: { views: ["main"], build } },
  views: { main: { label: "Main" } },
  ...extra,
});
const withArt = (build) => partWith(build, { svgs: { badge: new URL("file:///badge.svg.json") } });

test("a k.svg2d call naming an undeclared svg is an error", () => {
  const r = lintPart(withArt((k) => k.svg2d("logo", { width: 10 }).extrude(1)));
  expect(ids(r.errors)).toContain("svg-unknown-name");
  expect(find(r, "svg-unknown-name").message).toContain("logo");
  expect(find(r, "svg-unknown-name").message).toContain("badge");
});

test("a part with no svgs field at all still reports the unknown name", () => {
  expect(ids(lintPart(partWith((k) => k.svg2d("logo", { width: 10 }).extrude(1))).errors))
    .toContain("svg-unknown-name");
});

test("a declared name is clean", () => {
  expect(ids(lintPart(withArt((k) => k.svg2d("badge", { width: 10 }).extrude(1))).errors))
    .not.toContain("svg-unknown-name");
});

test("a non-literal name is skipped rather than guessed at", () => {
  const part = partWith((k, p) => k.svg2d(p.which, { width: 10 }).extrude(1),
    { svgs: { badge: new URL("file:///badge.svg.json") }, defaults: { which: "badge" } });
  expect(ids(lintPart(part).errors)).not.toContain("svg-unknown-name");
});

test("the same unknown name is reported once, not per call", () => {
  const r = lintPart(partWith((k) => k.svg2d("logo", { width: 10 }).extrude(1)
    .union(k.svg2d("logo", { width: 5 }).extrude(1))));
  expect(ids(r.errors).filter((i) => i === "svg-unknown-name")).toHaveLength(1);
});

test("a k.svg2d call with no options object is an error naming the three options", () => {
  const r = lintPart(withArt((k) => k.svg2d("badge").extrude(1)));
  expect(ids(r.errors)).toContain("svg-size-missing");
  expect(find(r, "svg-size-missing").message).toMatch(/width|height|fit/);
});

test("an options literal with none of width/height/fit is an error", () => {
  expect(ids(lintPart(withArt((k) => k.svg2d("badge", { align: "left" }).extrude(1))).errors))
    .toContain("svg-size-missing");
});

test("each of width, height and fit clears the rule", () => {
  for (const opt of ["{ width: 10 }", "{ height: 10 }", "{ fit: 10 }"]) {
    const build = new Function("k", `return k.svg2d("badge", ${opt}).extrude(1)`);
    expect(ids(lintPart(withArt(build)).errors)).not.toContain("svg-size-missing");
  }
});

test("a non-literal options argument is skipped", () => {
  const part = partWith((k, p) => k.svg2d("badge", p.opts).extrude(1),
    { svgs: { badge: new URL("file:///badge.svg.json") }, defaults: { opts: { width: 10 } } });
  expect(ids(lintPart(part).errors)).not.toContain("svg-size-missing");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lint-svg.test.js`
Expected: FAIL — no `svg-unknown-name` finding is produced.

- [ ] **Step 3a: Create `src/framework/lint/rules-svg.js`**

```js
// Group 10 — vector-art call well-formedness. Both conditions throw at build
// time anyway; these rules move them ahead of the kernel boot, which is where an
// authoring agent wants them.
//
// Both are conservative in the same way rules-imports.js is: only LITERAL
// arguments are judged. A name computed from a param, or an options object
// passed by reference, carries no statically-visible answer, and guessing would
// produce false errors on good parts. Those cases still fail correctly at build
// time — this catches the common case early, it does not replace that authority.
import { err } from "./finding.js";

const declaredSvgs = (part) => Object.keys(part?.svgs ?? {});

// A name is only knowable when it is a string literal — which JSON.parse
// recognizes and nothing else does (import-unknown-name reads its name the same way).
const literalName = (src) => {
  try { const v = JSON.parse(src); return typeof v === "string" ? v : null; } catch { return null; }
};

const svgCalls = (probe) => probe().calls.filter((c) => c.scope === "kernel" && c.op === "svg2d");

export const SVG_RULES = [
  {
    id: "svg-unknown-name",
    run: ({ part, probe }) => {
      const known = new Set(declaredSvgs(part));
      const seen = new Set();
      const out = [];
      for (const call of svgCalls(probe)) {
        const name = literalName(call.args[0]);
        if (name == null || known.has(name) || seen.has(name)) continue;
        seen.add(name);
        out.push(err("svg-unknown-name",
          `build calls k.svg2d with name "${name}", which the part's svgs field does not declare: ${[...known].join(", ") || "(nothing)"}`,
          "Declare the ingested artwork under svgs: { name: source }, or fix the name to match an existing entry.",
          "svgs"));
      }
      return out;
    },
  },
  {
    id: "svg-size-missing",
    run: ({ probe }) => {
      const out = [];
      for (const call of svgCalls(probe)) {
        const opts = call.args[1]?.trim();
        if (opts != null && !opts.startsWith("{")) continue;      // not a literal — skip
        if (opts && /\b(width|height|fit)\s*:/.test(opts)) continue;
        const name = literalName(call.args[0]) ?? "…";
        out.push(err("svg-size-missing",
          `k.svg2d("${name}", …) declares no size — one of { width }, { height }, or { fit } is required, in millimetres`,
          "An artwork's units have no physical meaning, so there is no safe default to fall back on (unlike k.text2d's cap-height `size`). "
          + `Add one, e.g. k.svg2d("${name}", { width: 20 }).`,
          "build"));
      }
      return out;
    },
  },
];
```

- [ ] **Step 3b: Register in `src/framework/lint/index.js`**

Add `import { SVG_RULES } from "./rules-svg.js";` beside the others, and `...SVG_RULES` to the `RULES` array after `...FONT_RULES`.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/lint-svg.test.js test/lint-registry.test.js
```

`lint-svg` PASS (9 tests). `lint-registry.test.js` enforces that every rule id is registered and documented — if it fails it will name what it wants (typically the rule-catalog entries Task 9 adds). If it demands the doc entry now, add the catalog lines from Task 9's Step 3 here instead and say so in your report.

- [ ] **Step 5: Commit**

```bash
git add src/framework/lint/rules-svg.js src/framework/lint/index.js test/lint-svg.test.js
git commit -m "svg: lint rules for unknown names and missing sizes"
```

---

### Task 8: The `emblem` reference part

**Files:**
- Create: `scripts/ingest-svg.mjs`
- Create: `src/parts/assets/emblem.svg`, `src/parts/assets/emblem.svg.json`
- Create: `src/parts/emblem.js`, `emblem.html`, `src/app-emblem.js`, `src/emblem-worker.js`
- Modify: `vite.config.js` (`rollupOptions.input`), `.github/workflows/ci.yml`
- Test: `test/emblem-part.test.js`, `test/svg2d-occt.test.js`

**The artwork is chosen so its numbers are checkable by hand.** A filled `<circle>` (r=10 at 24,24 → spans 14–34 both axes) plus a stroked open `<polyline>` at y=42, width 4 with round caps (→ spans x 4–44, y 40–44). Their union's tight bbox is **40 × 30 artwork units** — a figure that comes out wrong if strokes are dropped, if caps are missed, or if sizing reads the `viewBox` instead of the geometry. The `viewBox` is deliberately larger than the art, to catch that last one.

- [ ] **Step 1: Write the failing test**

Create `test/emblem-part.test.js`:

```js
// The k.svg2d reference part. Manifold-booting only; never boot OCCT in this
// file (AGENTS.md — the two WASM kernels must not share a process).
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import part from "../src/parts/emblem.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel({ svgs: part.svgs }); });

const build = (over = {}) => {
  const p = { ...part.defaults, ...over };
  return part.parts.plate.build(k, p, part.derive ? part.derive(p) : {});
};

test("the part declares its ingested artwork under svgs", () => {
  expect(Object.keys(part.svgs)).toEqual(["emblem"]);
});

test("the plate builds, is solid, and carries the emboss", () => {
  const s = build();
  expect(s.toMesh().triangles).toBeGreaterThan(0);
  expect(s.volume()).toBeGreaterThan(
    k.box({ min: [-20, -16, 0], max: [20, 16, 3] }).volume());
});

test("the artwork's aspect is 40:30 — fill unioned with stroke, not the viewBox", () => {
  const { min, max } = k.svg2d("emblem", { width: 40 }).extrude(1).boundingBox();
  expect(max[0] - min[0]).toBeCloseTo(40, 1);
  expect(max[1] - min[1]).toBeCloseTo(30, 1);
});

test("the circle survived ingest as symbolic arcs", () => {
  const [region] = k._svgs.get("emblem");
  const all = [region, ...k._svgs.get("emblem")].flatMap((r) => r.outer.segments);
  expect(all.some((s) => s.via)).toBe(true);
});

test("emblem_w drives the emboss size", () => {
  expect(build({ emblem_w: 30 }).volume()).toBeGreaterThan(build({ emblem_w: 15 }).volume());
});
```

Create `test/svg2d-occt.test.js`:

```js
// Cross-backend agreement for k.svg2d. It lowers to k.shape2d, which both
// backends implement, and the regions are curve-native — so the extruded bbox
// must match the Manifold figure to within meshing tolerance.
// OCCT-booting: this file must contain NO Manifold boot (AGENTS.md).
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing.js";
import part from "../src/parts/emblem.js";

let k;
beforeAll(async () => { k = await bootOcctKernel({ svgs: part.svgs }); });

test("the emblem extrudes to the same bbox on OCCT as on Manifold", () => {
  const { min, max } = k.svg2d("emblem", { width: 40 }).extrude(2).boundingBox();
  expect(max[0] - min[0]).toBeCloseTo(40, 1);
  expect(max[1] - min[1]).toBeCloseTo(30, 1);
  expect(max[2] - min[2]).toBeCloseTo(2, 3);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/emblem-part.test.js`
Expected: FAIL — cannot resolve `src/parts/emblem.js`.

- [ ] **Step 3a: Create the dev ingest script**

Create `scripts/ingest-svg.mjs`. It is **dev-only**: it is not in `package.json`'s `files`, nothing shipped imports it, and it exists to regenerate this repo's fixtures and to serve as a worked reference for anyone converting artwork with their own tooling.

```js
#!/usr/bin/env node
// Dev-only: run partforge's browser-side SVG ingest headlessly, over the
// happy-dom devDependency, and print the resulting partforge-vector JSON.
//
//   node scripts/ingest-svg.mjs src/parts/assets/emblem.svg > src/parts/assets/emblem.svg.json
//
// This is NOT part of the published package — `partforge/ingest` is browser-side
// by design (see the spec). It exists so repo fixtures are reproducible instead
// of being magic checked-in blobs, and as a worked example for agents.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Window } from "happy-dom";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/ingest-svg.mjs <file.svg> [--strokes ignore]");
  process.exit(2);
}
const strokes = process.argv.includes("--strokes") ? process.argv[process.argv.indexOf("--strokes") + 1] : "outline";

// paper-core builds a canvas and asks for a 2D context at module load; happy-dom
// has no canvas backend, and paper never touches the raster context for geometry.
const window = new Window();
Object.assign(globalThis, {
  window, self: window, document: window.document, navigator: window.navigator,
  DOMParser: window.DOMParser, HTMLCanvasElement: window.HTMLCanvasElement,
  Image: window.Image, SVGElement: window.SVGElement,
});
globalThis.HTMLCanvasElement.prototype.getContext = () => ({
  save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
  bezierCurveTo() {}, quadraticCurveTo() {}, arc() {}, rect() {}, fill() {}, stroke() {},
  clip() {}, translate() {}, scale() {}, rotate() {}, transform() {}, setTransform() {},
  clearRect() {}, fillRect() {}, strokeRect() {}, setLineDash() {},
  measureText: () => ({ width: 0 }),
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  putImageData() {}, drawImage() {}, isPointInPath: () => false,
  createLinearGradient: () => ({ addColorStop() {} }),
  canvas: { width: 1, height: 1 },
});

// Dynamic import: a static one would hoist above the globals above.
const { ingestSvg } = await import("../src/framework/ingest/svg-ingest.js");
const doc = ingestSvg(readFileSync(file, "utf8"), { strokes, source: basename(file) });
process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
```

- [ ] **Step 3b: Create the artwork and ingest it**

Create `src/parts/assets/emblem.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <!-- A filled shape and a stroked OPEN shape, so this one file exercises both
       of ingest's geometry paths. The union's tight bbox is 40 x 30 artwork
       units: the circle spans 14..34 in both axes, and the stroked bar spans
       4..44 in x (round caps add half the 4-unit width at each end) and 40..44
       in y. Deliberately NOT centred in the viewBox, so anything that sizes from
       the viewBox instead of the geometry gets a visibly wrong answer. -->
  <circle cx="24" cy="24" r="10" fill="#111"/>
  <polyline points="6 42 42 42" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round"/>
</svg>
```

Then generate the ingested document:

```bash
node scripts/ingest-svg.mjs src/parts/assets/emblem.svg > src/parts/assets/emblem.svg.json
```

Check the result by eye before continuing: `bbox` must be 40 wide and 30 tall, and at least one segment must have `"kind": "arc"` (the circle). If either is wrong, stop and report — that is a defect in Task 2 or Task 4, not something to work around here.

- [ ] **Step 3c: Create `src/parts/emblem.js`**

```js
// The k.svg2d reference part — ingested vector art embossed on a plate.
//
// `svgs` is declared with `new URL(..., import.meta.url)`, the same form
// import-demo.js uses for its STL: Vite turns it into a bundled asset URL, and
// in Node it is a file: URL that src/testing/assets.js reads off disk. A bare
// `() => import("./assets/emblem.svg.json")` would work in Vite and fail in the CLI.
//
// The source artwork lives beside it as emblem.svg, and the .json is regenerated
// with `node scripts/ingest-svg.mjs src/parts/assets/emblem.svg`.
export default {
  meta: { title: "Emblem", units: "mm", background: 0x15181d },
  svgs: {
    emblem: new URL("./assets/emblem.svg.json", import.meta.url),
  },
  parameters: [
    {
      id: "plate",
      title: "Plate",
      description: "The backing plate the artwork is embossed on.",
      advanced: [
        { key: "plate_w", label: "Width", unit: "mm", min: 20, max: 80, step: 1, description: "Plate width." },
        { key: "plate_h", label: "Depth", unit: "mm", min: 16, max: 60, step: 1, description: "Plate depth." },
        { key: "plate_t", label: "Thickness", unit: "mm", min: 1, max: 10, step: 0.5, description: "Plate thickness." },
      ],
    },
    {
      id: "art",
      title: "Artwork",
      description: "The embossed vector art. `emblem.svg` carries a filled circle and a stroked bar, so both of ingest's geometry paths are exercised.",
      advanced: [
        { key: "emblem_w", label: "Emblem width", unit: "mm", min: 8, max: 70, step: 1,
          description: "Width of the artwork's **tight bounding box** in mm — not its `viewBox`. Stroke thickness scales with it." },
        { key: "emboss", label: "Emboss height", unit: "mm", min: 0.4, max: 4, step: 0.2,
          description: "How far the artwork stands proud of the plate." },
      ],
    },
  ],
  defaults: { plate_w: 40, plate_h: 32, plate_t: 3, emblem_w: 30, emboss: 1 },
  parts: {
    plate: {
      label: "Plate",
      views: ["plate"],
      export: { name: "emblem-plate" },
      build: (k, p) => k
        .box({ min: [-p.plate_w / 2, -p.plate_h / 2, 0], max: [p.plate_w / 2, p.plate_h / 2, p.plate_t] })
        .union(k.svg2d("emblem", { width: p.emblem_w }).extrude(p.emboss).translate([0, 0, p.plate_t])),
    },
  },
  views: { plate: { label: "Plate" } },
  verify: {
    expect: {
      plate: { bbox: "<=[81,61,15]" },
      _view: { overlaps: 0 },
    },
  },
};
```

- [ ] **Step 3d: The three glue files**

`src/emblem-worker.js`:

```js
import part from "./parts/emblem.js";
import { runWorker } from "./framework/worker.js";
runWorker(part);
```

`src/app-emblem.js`:

```js
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import emblemPart from "./parts/emblem.js";
import { mount } from "./framework/index.js";

// Dev-only example app for the emblem part (the k.svg2d reference).
// `npm run dev`, then open /emblem.html.
window.__pfRuntime = mount(emblemPart, {
  createWorker: (name) =>
    new Worker(new URL("./emblem-worker.js", import.meta.url), { type: "module", name }),
});
```

`emblem.html` — copy `demo.html` verbatim, then change exactly four things: `<title>` to `Emblem — SVG reference part`, `<h1>` to `Emblem`, `<p class="sub">` to `k.svg2d reference · ingested vector art embossed on a plate`, and the final `<script type="module" src="…">` to `/src/app-emblem.js`. Leave every id and class untouched — mount binds to them by name.

- [ ] **Step 3e: Register the page and the CI check**

In `vite.config.js`, add `emblem: "emblem.html",` to `rollupOptions.input` after the `screw` line.

In `.github/workflows/ci.yml`, after the `lofted-bottle.html` line:

```yaml
      - run: CHECK_PORT=5189 node scripts/check-app.mjs emblem.html # k.svg2d reference part (ingested vector art)
```

- [ ] **Step 4: Run everything**

```bash
npx vitest run test/emblem-part.test.js
npx vitest run test/svg2d-occt.test.js
npx partforge lint src/parts/emblem.js
npx partforge measure src/parts/emblem.js
node scripts/check-app.mjs emblem.html
```

Expected: both test files PASS; `lint` exits 0 with no findings; `measure` exits 0 reporting a watertight plate whose bbox is 40 × 32 × 4; the smoke check passes.

- [ ] **Step 5: Commit**

```bash
git add scripts/ingest-svg.mjs src/parts/emblem.js src/parts/assets/emblem.svg src/parts/assets/emblem.svg.json \
        src/app-emblem.js src/emblem-worker.js emblem.html vite.config.js .github/workflows/ci.yml \
        test/emblem-part.test.js test/svg2d-occt.test.js
git commit -m "svg: emblem reference part, dev ingest script, and CI wiring"
```

---

### Task 9: Documentation and release

**Files:**
- Create: `docs/VECTOR-FORMAT.md`
- Modify: `docs/AUTHORING-PARTS.md`, `docs/ERROR-PATTERNS.md`, `docs/REFERENCE-PARTS.md`, `skills/partforge/SKILL.md`, `AGENTS.md`, `package.json`

- [ ] **Step 1: Write `docs/VECTOR-FORMAT.md`**

This is the normative format spec, and it is what makes the loss of headless ingest acceptable — an agent must be able to produce a valid document from it without reading partforge's source. Write it with these sections, in this order:

1. **What this is** — the output of `partforge/ingest`, the input to `k.svg2d`; one conversion, done in a browser, stored beside the part.
2. **A complete worked example** — copy `src/parts/assets/emblem.svg` and enough of its ingested JSON to show a filled region, a hole, and all three segment kinds.
3. **Schema** — every field, its type, and whether it is required: `format`, `version`, `note` (optional, ignored on load), `source` (provenance only), `bbox`, `regions[].outer`, `regions[].holes[]`, and the three segment kinds. State that `through` is **a point the arc passes through**, not a control point.
4. **Rules that are not obvious from the schema** — y points UP (SVG is y-down; ingest flips); coordinates are in the artwork's own units and `k.svg2d` rescales; contours close implicitly from the last `to` back to `start`; `outer` is CCW and holes are CW; `bbox` is the tight bounds of `regions` and is validated against a recomputation.
5. **Converting an SVG by hand** — the steps that are easy to get wrong: flip y, resolve transforms into coordinates, outline strokes into filled outlines (a stroke is not a line in this format), apply each element's fill rule across its own subpaths, union everything, then compute the bbox. Name `scripts/ingest-svg.mjs` as the worked reference implementation.
6. **Painting order is not modelled** — every region adds material; an SVG that fakes a hole by painting a background-coloured shape over another gives a solid. Say what to do instead (a real hole in `holes`, or `.cut()` in the part).
7. **Versioning** — `version` is an integer; a document whose version exceeds what the running partforge understands is refused by name.

- [ ] **Step 2: AUTHORING-PARTS.md**

- Add to the PartDefinition table, after the `imports?` line:
  `svgs?,                                   // { name: source } — ingested vector artwork k.svg2d() places; same source grammar and preload timing as fonts`
- Add a matching bullet after the `imports` bullet, pointing at the new section.
- Add a **"Vector art (SVG)"** section immediately after the `k.text2d` section, as its sibling, covering in this order: the op and its options; the two-step story (ingest once in a browser with `partforge/ingest`, then reference the JSON); the `new URL(..., import.meta.url)` source form and why a bare dynamic import fails in the CLI; sizing on the **tight geometric bbox, not the `viewBox`**, and why there is no default size; that strokes are outlined at ingest and `<use>`/`<defs>`/CSS all work; that painting order is not modelled; and a pointer to `VECTOR-FORMAT.md` and `src/parts/emblem.js`.
- Update the "Editing profiles" line (~1231) so its "imported SVG" reference points at the new section instead of being aspirational.
- Add to the Linting rule catalog, after the **Font controls** paragraph:

```
**Vector art** — `svg-unknown-name` (a build calls `k.svg2d` with a name the
part's `svgs` field doesn't declare — this throws at build time) (error);
`svg-size-missing` (a `k.svg2d` call whose options literal carries none of
`width`/`height`/`fit`; an artwork's units have no physical meaning, so there is
no default to fall back on) (error). Both judge only literal arguments — a name
or options object computed at build time is skipped, and still fails correctly
at build time.
```

- [ ] **Step 3: ERROR-PATTERNS.md**

One `##` section per pattern, each in the file's existing symptom → cause → fix shape:

- `svg-unknown-name` — literal text `svg2d: unknown svg "…"`.
- `svg-size-required` — literal text `svg2d: a size is required`.
- `svg-invalid-document` — the `svg2d: "<name>" …` validation failures from `vector-format.js`, including the "is not valid JSON" case whose usual cause is pointing `svgs` at the `.svg` file instead of the ingested `.svg.json`.
- `svg-stroke-collapsed` — literal text `svg: stroke outline collapsed`.
- `svg-no-geometry` — literal text `svg: no painted geometry`.
- `svg-painting-order` — **no error text**; a "my part looks wrong" entry. Symptom: a shape that is a hole in the editor comes out solid. Cause: the artwork paints a background-coloured shape on top instead of using a fill rule. Fix: make it a real hole (one path, two subpaths, `fill-rule="evenodd"`), or subtract it in the part with `.cut()`.

- [ ] **Step 4: Inventories and package metadata**

- `docs/REFERENCE-PARTS.md` — add `emblem.js` as the `k.svg2d` reference part, in the shape the neighbouring entries use.
- `skills/partforge/SKILL.md` — add `svg2d` to the op vocabulary next to `text2d`.
- `AGENTS.md` — the "`src/parts/` now has fifteen" sentence becomes **sixteen**, with `emblem.js` described as "(the `k.svg2d` reference part — ingested vector art embossed on a plate)". Also add one sentence to the Architecture section noting that `src/framework/ingest/` is DOM-dependent, main-thread-only, and deliberately outside the worker graph.
- `package.json`:
  - add to `exports`: `"./ingest": { "types": "./types/ingest.d.ts", "default": "./src/ingest.js" }` and the matching `typesVersions` entry (create `types/ingest.d.ts` alongside, in the shape of the neighbouring `.d.ts` files);
  - add `"docs/VECTOR-FORMAT.md"` to `files`;
  - bump `"version"` from `0.91.0` to `0.92.0`.

**The version bump is not optional and not a release-day step.** The publish workflow tags and publishes on merge; if the version is unchanged the merge lands, npm already has that version, the workflow correctly does nothing, and the work silently never ships. See AGENTS.md "Releasing".

- [ ] **Step 5: Run the full suite**

```bash
npm test
npm run typecheck
npx partforge lint src/parts/emblem.js
node scripts/check-app.mjs emblem.html
```

Expected: all green. `test/error-patterns.test.js` reads `docs/ERROR-PATTERNS.md` and fails if a pattern id referenced in code has no `##` section — that is the check on Step 3.

- [ ] **Step 6: Commit**

```bash
git add docs/VECTOR-FORMAT.md docs/AUTHORING-PARTS.md docs/ERROR-PATTERNS.md docs/REFERENCE-PARTS.md \
        skills/partforge/SKILL.md AGENTS.md package.json types/ingest.d.ts
git commit -m "svg: document the vector format and k.svg2d, bump to 0.92.0"
```

---

## Notes for the executor

- **Do not add an `svgs` content digest.** It looks like a missing piece next to `imports.js`; it is not. `kernel-front.js:117-121` records the argument — the `Shape2D` hash keys on coordinates, so different artwork already invalidates its own cache node.
- **Never boot OCCT and Manifold in the same process.** `test/svg2d-occt.test.js` is OCCT-only for that reason; vitest isolates per file.
- **If a stroke test's area is short by exactly the cap area**, the 180°-reversal branch in `offsetOpenChain` is not firing. `contour-offset.js:117-126` documents the same bug and the same symptom; the `turn === 0` clause is what fixes it.
- **If `resolveCurveFill` throws `"curve-fill: resolved hole has no containing outer"`** during ingest, check the y flip happens after the fill resolve, not before — flipping mid-pipeline inverts winding relative to what the resolver just decided.
- **`src/framework/ingest/` and `src/ingest.js` must never be imported from the worker graph.** `test/worker-layering.test.js` is the enforcement; if it starts failing after a change in those files, the fix is the import, not the test.
