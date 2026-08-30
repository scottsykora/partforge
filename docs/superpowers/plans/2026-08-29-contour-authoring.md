# Contour authoring (`partforge-vector` v1, `k.vector2d`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `partforge-vector` into a format an LLM can author and edit directly — millimetre units, named shapes, primitive contours, optional `bbox` — while SVG ingest keeps producing byte-identical output into the same format.

**Architecture:** All JSON→geometry translation stays inside `src/framework/geometry/vector-format.js`, the single place the published vocabulary (`kind`, `through`, `shapes`, `units`) meets the engine's internal contour IR (`via`, implicit types, `{outer,holes}`). Primitives expand there; nothing downstream — placement, `Shape2D`, either backend, the exporters — learns they exist. Placement (`vector2d.js`) becomes units-aware: one formula, scale about the origin then translate, where "as authored" is the no-translate case.

**Tech Stack:** Plain ESM, vitest, paper.js (`^0.12.18`, ingest only), happy-dom (dev only), Manifold + OCCT WASM kernels.

**Spec:** `docs/superpowers/specs/2026-08-29-contour-authoring-design.md` (and, for the conversion pipeline it does not replace, `docs/superpowers/specs/2026-08-29-svg-vector-geometry-design.md`)

## Global Constraints

- **Node 24.** Run `nvm use` before anything. The default shell Node is too old and geometry fails confusingly.
- **The whole suite must be green at the end of every task.** No task may leave the tree red for the next one. Where a format change would invalidate the checked-in fixture, regenerating that fixture is part of the same task.
- **`src/framework/geometry/vector-format.js` and `vector2d.js` are worker-graph leaves: DOM-free, `node:`-free, `three`-free.** `test/worker-layering.test.js` greps module *source* for `document`, `window`, `localStorage`, `sessionStorage`, `HTMLElement`, `customElements`. It strips comments but **not string literals** — so the word `document` must not appear in any error message or string in these files. Use "file" instead. This has already bitten this feature once.
- **Lint is pure: no I/O, no async.** `test/lint-purity.test.js` enforces the import closure. A lint rule may never read a file; callers pass data in.
- **`build` must be a pure function of `(k, p, d)`.** No clock, no randomness, no module-level mutable state.
- **Units are millimetres** throughout the CAD frame. Vector documents with `units: "artwork"` are the one exception, and they are rescaled at placement.
- **Refuse rather than guess.** Every new option and field with more than one plausible reading throws a named error rather than falling back to a default. This is the established style of `scaleFor` and `placeRegions`.
- **Errors name the file, the shape, the region, the role, and the index** — the reader is as likely to be an agent that generated the file as a human who wrote it.
- **Version:** `package.json` goes to `0.93.0`. `0.92.0` is already published from `main`; leaving it would merge without publishing.
- **Nothing has shipped.** No aliases, no deprecation shims, no v2. `k.svg2d` and `svgs:` are removed outright.

---

### Task 1: Rename sweep and version bump

Pure mechanical rename, no behaviour change. Doing it first means every later task works in the final names and never churns them.

**Files:**
- Rename: `src/framework/svgs.js` → `src/framework/vectors.js`
- Rename: `src/framework/geometry/svg2d.js` → `src/framework/geometry/vector2d.js`
- Rename: `src/framework/lint/rules-svg.js` → `src/framework/lint/rules-vector.js`
- Rename: `src/parts/assets/emblem.svg.json` → `src/parts/assets/emblem.vector.json`
- Rename: `test/svg2d.test.js` → `test/vector2d.test.js`
- Rename: `test/svgs.test.js` → `test/vectors.test.js`
- Rename: `test/lint-svg.test.js` → `test/lint-vector.test.js`
- Rename: `test/svg2d-occt.test.js` → `test/vector2d-occt.test.js`
- Modify: `src/framework/geometry/kernel-front.js`, `src/framework/geometry/kernel.js`, `src/framework/geometry/probe.js`, `src/framework/jobs.js`, `src/framework/lint/index.js`, `src/testing/manifold.js`, `src/testing/occt.js`, `bin/cli.js`, `src/parts/emblem.js`, `scripts/ingest-svg.mjs`, `src/framework/ingest/svg-ingest.js`, `types/kernel.d.ts`, `package.json`
- Modify (references only): `docs/AUTHORING-PARTS.md`, `docs/ERROR-PATTERNS.md`, `docs/KERNEL-CONTRACT.md`, `AGENTS.md`, `test/error-patterns.test.js`, `test/worker-layering.test.js`, `test/types-surface.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveVectors(decl)`, `ensureVectors(kernel, decl)` from `src/framework/vectors.js`; `placeRegions(regions, opts)` from `src/framework/geometry/vector2d.js`; `VECTOR_RULES` from `src/framework/lint/rules-vector.js`; `k._vectors` on the kernel; `k.vector2d(name, opts)`; `vectors:` on the `PartDefinition`.

**Do NOT rename:** `src/framework/ingest/svg-ingest.js`, `src/ingest.js`, `ingestSvg`, `scripts/ingest-svg.mjs`, `src/parts/assets/emblem.svg`, the `partforge/ingest` export, `docs/VECTOR-FORMAT.md`, `src/framework/geometry/vector-format.js`, or the `svg-overlapping-subpaths` ERROR-PATTERNS id. These name SVG, and SVG is still what they handle.

- [ ] **Step 1: Rename the files with git so history follows**

```bash
git mv src/framework/svgs.js src/framework/vectors.js
git mv src/framework/geometry/svg2d.js src/framework/geometry/vector2d.js
git mv src/framework/lint/rules-svg.js src/framework/lint/rules-vector.js
git mv src/parts/assets/emblem.svg.json src/parts/assets/emblem.vector.json
git mv test/svg2d.test.js test/vector2d.test.js
git mv test/svgs.test.js test/vectors.test.js
git mv test/lint-svg.test.js test/lint-vector.test.js
git mv test/svg2d-occt.test.js test/vector2d-occt.test.js
```

- [ ] **Step 2: Apply the identifier renames across the tree**

Apply each of these, in this order, to every tracked file **except** the do-not-rename list above. Longest patterns first so shorter ones do not corrupt them.

| From | To |
|---|---|
| `resolveSvgs` | `resolveVectors` |
| `ensureSvgs` | `ensureVectors` |
| `SVG_RULES` | `VECTOR_RULES` |
| `svgCalls` | `vectorCalls` |
| `declaredSvgs` | `declaredVectors` |
| `svg-unknown-name` | `vector-unknown-name` |
| `svg-size-missing` | `vector-size-missing` |
| `Svg2dOptions` | `Vector2dOptions` |
| `Svg2dAlign` | `Vector2dAlign` |
| `Svg2dValign` | `Vector2dValign` |
| `svg2d` | `vector2d` |
| `k._svgs` | `k._vectors` |
| `_svgs` | `_vectors` |
| `svgs:` | `vectors:` |
| `part.svgs` | `part.vectors` |
| `emblem.svg.json` | `emblem.vector.json` |

Then fix prose by hand where the mechanical swap reads wrong. Specifically: the `vectors.js` header comment still says "the vector-art sibling of fonts.js and imports.js" (correct, keep); `kernel-front.js`'s comment "Regions come from k._vectors, preloaded by name from the part's ingested artwork" should become "…from the part's declared vector documents"; and `rules-vector.js`'s header "Group 10 — vector-art call well-formedness" is already right.

The error message prefix changes with `svg2d` → `vector2d` automatically. Two messages in `vectors.js` and `kernel-front.js` still say "svg" as a noun and must be reworded:

```js
// src/framework/vectors.js — resolveVectors
throw new Error("resolveVectors: `vectors` is a function — it is not resolved against params yet; pass the plain object form");
// and the resolver's type message:
"resolveVectors: a vector source must be bytes, a URL, or a thunk returning one",
```

```js
// src/framework/geometry/kernel-front.js
k._vectors ??= new Map();
k.vector2d = (name, opts = {}) => {
  if (typeof name !== "string" || !name)
    throw new Error("vector2d: first argument must be the name of an entry in the part's `vectors` field");
  const regions = k._vectors.get(name);
  if (!regions) throw new Error(`vector2d: unknown vector "${name}" — declare it in the part's \`vectors\` field`);
  return placeRegions(regions, opts).map((r) => k.shape2d(r)).reduce((a, b) => a.union(b));
};
```

- [ ] **Step 3: Bump the version**

In `package.json`, change `"version": "0.92.0"` to `"version": "0.93.0"`. This is load-bearing: `origin/main` and npm are both already at `0.92.0`, so merging without this publishes nothing.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, same count as before the rename. A rename that changes behaviour is a bug in this task.

- [ ] **Step 5: Verify no stale identifiers survive**

Run: `grep -rn "svg2d\|_svgs\|resolveSvgs\|ensureSvgs\|svgs:" src test types bin docs AGENTS.md`
Expected: no matches, except inside `docs/VECTOR-FORMAT.md` (rewritten in Task 8) and the `svg-overlapping-subpaths` id in `docs/ERROR-PATTERNS.md`.

- [ ] **Step 6: Check the CLI still works end to end**

Run: `npx partforge lint src/parts/emblem.js && npx partforge measure src/parts/emblem.js`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: rename svg2d/svgs to vector2d/vectors, bump to 0.93.0"
```

---

### Task 2: Format envelope — `units`, `shapes`, optional `bbox`, version floor

The document envelope changes shape. Ingest is updated in the same task and the fixture regenerated, so the tree never goes red.

**Files:**
- Modify: `src/framework/geometry/vector-format.js`
- Modify: `src/framework/ingest/svg-ingest.js` (the `fromInternalRegions` call, last line)
- Modify: `src/framework/vectors.js` (`parseDocument` returns a document, not a region array)
- Modify: `src/framework/geometry/kernel-front.js` (`k._vectors` now holds documents)
- Regenerate: `src/parts/assets/emblem.vector.json`
- Test: `test/vector-format.test.js`, `test/vectors.test.js`

**Interfaces:**
- Consumes: `placeRegions(regions, opts)` (Task 1), unchanged this task.
- Produces:
  - `toInternalDocument(doc, label) → { units: "mm"|"artwork", shapes: Map<string, Region[]> }`
  - `fromInternalRegions(regions, { source = null, units = "artwork", shape = "artwork" }) → VectorDocument`
  - `validateVectorDocument(doc, label)` — unchanged signature, new rules
  - `regionsBbox(regions)` — unchanged
  - `VECTOR_UNITS = ["mm", "artwork"]`
  - `k._vectors: Map<string, { units, shapes: Map<string, Region[]> }>`

A `Region` is the internal IR: `{ outer: Contour, holes: Contour[] }`, where a `Contour` is `{ start: [x,y], segments: Array<{to} | {to,via} | {to,c1,c2}> }`.

- [ ] **Step 1: Write the failing tests**

Add to `test/vector-format.test.js`:

```js
import { describe, it, expect } from "vitest";
import { toInternalDocument, validateVectorDocument, fromInternalRegions } from "../src/framework/geometry/vector-format.js";

const square = (n) => ({
  outer: { kind: "path", start: [0, 0], segments: [
    { kind: "line", to: [n, 0] }, { kind: "line", to: [n, n] }, { kind: "line", to: [0, n] },
  ] },
});
const doc = (over = {}) => ({
  format: "partforge-vector", version: 1, units: "mm",
  shapes: { body: [square(10)] }, ...over,
});

describe("envelope", () => {
  it("accepts a document with no bbox and no source", () => {
    const d = toInternalDocument(doc(), "plate");
    expect(d.units).toBe("mm");
    expect([...d.shapes.keys()]).toEqual(["body"]);
    expect(d.shapes.get("body")).toHaveLength(1);
  });

  it("places identically with and without a bbox", () => {
    // "Optional" must mean "recomputed", not "ignored" — an implementation that
    // skipped the geometry when the header was absent would pass every other
    // test here and silently mis-size every authored file.
    const withBox = doc({ bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 } });
    expect(toInternalDocument(withBox, "plate").shapes.get("body"))
      .toEqual(toInternalDocument(doc(), "plate").shapes.get("body"));
  });

  it("still validates a bbox when one is present", () => {
    expect(() => validateVectorDocument(doc({ bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 } }), "plate")).not.toThrow();
    expect(() => validateVectorDocument(doc({ bbox: { minX: 0, minY: 0, maxX: 99, maxY: 10 } }), "plate"))
      .toThrow(/disagrees with its geometry \(maxX: header 99, actual 10\)/);
  });

  it("refuses a missing or unknown units", () => {
    const { units, ...noUnits } = doc();
    expect(() => validateVectorDocument(noUnits, "plate")).toThrow(/has no valid `units`.*"mm".*"artwork"/s);
    expect(() => validateVectorDocument(doc({ units: "inches" }), "plate")).toThrow(/"inches"/);
  });

  it("refuses version below 1 as well as above", () => {
    expect(() => validateVectorDocument(doc({ version: 0 }), "plate")).toThrow(/has version 0/);
    expect(() => validateVectorDocument(doc({ version: -1 }), "plate")).toThrow(/has version -1/);
    expect(() => validateVectorDocument(doc({ version: 2 }), "plate")).toThrow(/has version 2/);
  });

  it("refuses an empty or non-object shapes", () => {
    expect(() => validateVectorDocument(doc({ shapes: {} }), "plate")).toThrow(/has no shapes/);
    expect(() => validateVectorDocument(doc({ shapes: [] }), "plate")).toThrow(/has no shapes/);
    expect(() => validateVectorDocument(doc({ shapes: { body: [] } }), "plate")).toThrow(/shape "body" is empty/);
  });

  it("names the old flat regions array specifically", () => {
    const { shapes, ...old } = doc();
    expect(() => validateVectorDocument({ ...old, regions: [square(10)] }, "plate"))
      .toThrow(/has a "regions" array, which this build does not read/);
  });

  it("round-trips through fromInternalRegions", () => {
    const internal = toInternalDocument(doc(), "plate");
    const out = fromInternalRegions(internal.shapes.get("body"), { units: "mm", shape: "body" });
    expect(out.units).toBe("mm");
    expect(Object.keys(out.shapes)).toEqual(["body"]);
    expect(toInternalDocument(out, "plate").shapes.get("body")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/vector-format.test.js`
Expected: FAIL — `toInternalDocument` is not exported.

- [ ] **Step 3: Rewrite the validator and mapping**

In `src/framework/geometry/vector-format.js`, replace `validateVectorDocument`, `toInternalRegions`, and `fromInternalRegions`. Keep `checkContour`, `toSeg`, `toContour`, `fromSeg`, `fromContour`, `regionsBbox`, `fail`, `isPt`, `round6`, `BBOX_TOL`, and the constants as they are — Task 3 revisits `checkContour` and `toContour`.

```js
export const VECTOR_UNITS = ["mm", "artwork"];

export function validateVectorDocument(doc, label = "(unnamed)") {
  if (!doc || typeof doc !== "object") fail(label, "file", "is not an object", "expected parsed JSON");
  if (doc.format !== VECTOR_FORMAT) {
    fail(label, "file", `has format ${JSON.stringify(doc.format)}`,
      `expected ${JSON.stringify(VECTOR_FORMAT)} — this is not a partforge-vector file`);
  }
  // Floor as well as ceiling: version 0 and negatives used to load.
  if (!Number.isInteger(doc.version) || doc.version < 1 || doc.version > VECTOR_VERSION) {
    fail(label, "file", `has version ${JSON.stringify(doc.version)}`,
      `this build understands version ${VECTOR_VERSION} — re-ingest the artwork, or upgrade partforge`);
  }
  if (!VECTOR_UNITS.includes(doc.units)) {
    fail(label, "file", `has no valid \`units\` (${JSON.stringify(doc.units)})`,
      '`units` must be "mm" (coordinates are millimetres, placed as authored) or "artwork" '
      + "(coordinates have no physical meaning; a size is required at every call site)");
  }
  if (doc.note != null && typeof doc.note !== "string") fail(label, "file", "has a non-string `note`", "`note` is free text and is ignored on load");
  if (doc.source != null && typeof doc.source !== "string") fail(label, "file", "has a non-string `source`", "`source` is provenance only and may be omitted");
  // A stale draft in the pre-shapes envelope gets its own message rather than
  // the generic "has no shapes", which would send the reader looking for a typo.
  if (doc.shapes == null && Array.isArray(doc.regions)) {
    fail(label, "file", 'has a "regions" array, which this build does not read',
      'regions now live under a named shape in "shapes", e.g. { "shapes": { "artwork": [ …regions… ] } }');
  }
  const names = doc.shapes && typeof doc.shapes === "object" && !Array.isArray(doc.shapes) ? Object.keys(doc.shapes) : [];
  if (names.length === 0) {
    fail(label, "file", "has no shapes", 'a vector file needs at least one named shape: { "shapes": { "artwork": [ …regions… ] } }');
  }
  for (const name of names) {
    const regions = doc.shapes[name];
    if (!Array.isArray(regions)) fail(label, `shape ${JSON.stringify(name)}`, "is not an array of regions");
    if (regions.length === 0) fail(label, `shape ${JSON.stringify(name)}`, "is empty", "a shape needs at least one region");
    regions.forEach((rg, i) => {
      const where = `shape ${JSON.stringify(name)} region ${i + 1}`;
      if (!rg || typeof rg !== "object") fail(label, where, "is not an object");
      checkContour(label, `${where} outer`, rg.outer);
      if (rg.holes != null && !Array.isArray(rg.holes)) fail(label, where, "has a non-array `holes`");
      (rg.holes ?? []).forEach((h, j) => checkContour(label, `${where} hole ${j + 1}`, h));
    });
  }

  // bbox is a CACHE, not an authority: placement recomputes it anyway. It is
  // OPTIONAL — an author should not have to compute analytic curve extrema to
  // satisfy a checksum — but when a generator writes one, a stale value is a
  // named error rather than silently wrong sizing at build time.
  if (doc.bbox == null) return;
  if (!["minX", "minY", "maxX", "maxY"].every((k) => Number.isFinite(doc.bbox[k]))) {
    fail(label, "file", "has an invalid `bbox`", "bbox is optional, but when present it needs finite minX, minY, maxX, maxY");
  }
  const actual = regionsBbox(allRegionsUnchecked(doc));
  for (const k of ["minX", "minY", "maxX", "maxY"]) {
    if (Math.abs(actual[k] - doc.bbox[k]) > BBOX_TOL) {
      fail(label, "file", `has a bbox that disagrees with its geometry (${k}: header ${doc.bbox[k]}, actual ${round6(actual[k])})`,
        "re-ingest the artwork, or omit `bbox` — it is optional and recomputed either way");
    }
  }
}

const toRegion = (rg) => ({ outer: toContour(rg.outer), holes: (rg.holes ?? []).map(toContour) });

const allRegionsUnchecked = (doc) => Object.values(doc.shapes).flat().map(toRegion);

export function toInternalDocument(doc, label = "(unnamed)") {
  validateVectorDocument(doc, label);
  return {
    units: doc.units,
    shapes: new Map(Object.entries(doc.shapes).map(([name, regions]) => [name, regions.map(toRegion)])),
  };
}

export function fromInternalRegions(regions, { source = null, units = "artwork", shape = "artwork" } = {}) {
  const bb = regionsBbox(regions);
  return {
    format: VECTOR_FORMAT,
    version: VECTOR_VERSION,
    units,
    note: FORMAT_NOTE,
    source,
    bbox: { minX: round6(bb.minX), minY: round6(bb.minY), maxX: round6(bb.maxX), maxY: round6(bb.maxY) },
    shapes: { [shape]: regions.map((rg) => ({ outer: fromContour(rg.outer), holes: (rg.holes ?? []).map(fromContour) })) },
  };
}
```

Delete the now-unused `toInternalRegions` and `toInternalRegionsUnchecked`.

Update `FORMAT_NOTE` to describe the new envelope, keeping it one string and free of the word `document` (worker-layering greps string literals):

```js
export const FORMAT_NOTE =
  "Filled 2-D outlines for k.vector2d. `units` is \"mm\" (coordinates are millimetres, placed as "
  + "authored) or \"artwork\" (no physical meaning; a size is required at every call site). `shapes` "
  + "maps a name to a list of filled regions; each region's `outer` is its boundary and `holes` are "
  + "subtracted from it. A contour is a `kind`: \"path\", \"circle\", \"rect\", or \"polygon\". Path "
  + "segments run head-to-tail from `start`, and the contour closes implicitly from the last `to` "
  + "back to `start`. y points UP. See docs/VECTOR-FORMAT.md.";
```

- [ ] **Step 4: Update the consumers**

`src/framework/vectors.js` — `parseDocument` returns the internal document, and the memo now holds documents:

```js
import { toInternalDocument } from "./geometry/vector-format.js";
// …
  return toInternalDocument(doc, label);
```

The `parsed` memo comment still describes the same thing (source → parsed result); update "→ Region[]" to "→ { units, shapes }" and leave the reasoning intact.

`src/framework/ingest/svg-ingest.js` — the final line becomes:

```js
  return fromInternalRegions(withArcs, { source, units: "artwork", shape: "artwork" });
```

`src/framework/geometry/kernel-front.js` — `k._vectors` now holds documents, so `vector2d` reaches through `.shapes`. Task 5 gives this its own shape selection; for now, union every shape so behaviour is unchanged:

```js
  const doc = k._vectors.get(name);
  if (!doc) throw new Error(`vector2d: unknown vector "${name}" — declare it in the part's \`vectors\` field`);
  const regions = [...doc.shapes.values()].flat();
  return placeRegions(regions, opts).map((r) => k.shape2d(r)).reduce((a, b) => a.union(b));
```

- [ ] **Step 5: Regenerate the fixture**

```bash
node scripts/ingest-svg.mjs src/parts/assets/emblem.svg > src/parts/assets/emblem.vector.json
```

Expected: the file gains `"units": "artwork"` and wraps its regions in `"shapes": { "artwork": [...] }`. The coordinates must be **unchanged** — diff it and confirm only the envelope moved.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/vector-format.test.js test/vectors.test.js test/vector2d.test.js test/emblem-part.test.js test/svg-ingest.test.js`
Expected: PASS. Update any existing test in these files that constructs a document in the old envelope.

- [ ] **Step 7: Run the full suite and the CLI**

Run: `npm test && npx partforge measure src/parts/emblem.js`
Expected: PASS, exit 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(vector): units, named shapes, optional bbox in the document envelope"
```

---

### Task 3: Contour kinds — required `kind` on paths, plus `circle`, `rect`, `polygon`

**Files:**
- Modify: `src/framework/geometry/vector-format.js`
- Regenerate: `src/parts/assets/emblem.vector.json`
- Test: `test/vector-format.test.js`, `test/svg-ingest.test.js`

**Interfaces:**
- Consumes: `toInternalDocument`, `validateVectorDocument`, `fromInternalRegions` (Task 2).
- Produces: no new exports. `checkContour` and `toContour` gain a `kind` dispatch; `fromContour` emits `kind: "path"`.

**Normative expansion** (y-up; `[cx, cy] = center`):

- `circle` — `start = [cx + r, cy]`; segments `{arc, to: [cx − r, cy], through: [cx, cy + r]}`, `{arc, to: [cx + r, cy], through: [cx, cy − r]}`. The last `to` equals `start`; it is an arc, so `toContour`'s trailing-line drop does not touch it and the implicit closing edge is zero-length. This is exactly the shape the ingested emblem circle already has.
- `rect`, no radius — `start` bottom-left, then lines to bottom-right, top-right, top-left.
- `rect`, `radius > 0` — with `hw = width/2`, `hh = height/2`, `k = radius / Math.SQRT2`, and corner arcs given by their 45° point:

  | # | kind | to | through |
  |---|---|---|---|
  | start | | `[cx − hw + r, cy − hh]` | |
  | 1 | line | `[cx + hw − r, cy − hh]` | |
  | 2 | arc | `[cx + hw, cy − hh + r]` | `[cx + hw − r + k, cy − hh + r − k]` |
  | 3 | line | `[cx + hw, cy + hh − r]` | |
  | 4 | arc | `[cx + hw − r, cy + hh]` | `[cx + hw − r + k, cy + hh − r + k]` |
  | 5 | line | `[cx − hw + r, cy + hh]` | |
  | 6 | arc | `[cx − hw, cy + hh − r]` | `[cx − hw + r − k, cy + hh − r + k]` |
  | 7 | line | `[cx − hw, cy − hh + r]` | |
  | 8 | arc | `[cx − hw + r, cy − hh]` | `[cx − hw + r − k, cy − hh + r − k]` |

  **Line segments whose endpoints coincide are omitted.** At `radius = min(w,h)/2` two or four of the lines are zero-length, and emitting them would hand degenerate edges to the boolean engine.
- `polygon` — `start = points[0]`, one `line` per remaining point. Point order is the author's; orientation is normalized downstream by `ensureRegionWinding`, same as every other contour.

- [ ] **Step 1: Write the failing tests**

Add to `test/vector-format.test.js`:

```js
import { toInternalDocument } from "../src/framework/geometry/vector-format.js";
import { profileArea, profileBounds } from "../src/framework/geometry/contour-ops.js";

const withShape = (contour) => ({
  format: "partforge-vector", version: 1, units: "mm",
  shapes: { s: [{ outer: contour }] },
});
const regions = (contour) => toInternalDocument(withShape(contour), "t").shapes.get("s");

describe("contour kinds", () => {
  it("requires kind on a path", () => {
    expect(() => regions({ start: [0, 0], segments: [{ kind: "line", to: [1, 0] }, { kind: "line", to: [1, 1] }] }))
      .toThrow(/has no "kind"/);
  });

  it("expands a circle to two arcs with the right area and bounds", () => {
    const r = regions({ kind: "circle", center: [3, 4], r: 5 });
    expect(r[0].outer.segments).toHaveLength(2);
    expect(r[0].outer.segments.every((s) => s.via)).toBe(true);
    expect(profileArea(r)).toBeCloseTo(Math.PI * 25, 3);
    const { min, max } = profileBounds(r);
    expect(min).toEqual([-2, -1]);
    expect(max).toEqual([8, 9]);
  });

  it("expands a square rect to three line segments", () => {
    const r = regions({ kind: "rect", center: [0, 0], width: 10, height: 4 });
    expect(r[0].outer.segments).toHaveLength(3);
    expect(profileArea(r)).toBeCloseTo(40, 6);
    expect(profileBounds(r).min).toEqual([-5, -2]);
  });

  it("expands a rounded rect and matches the analytic area", () => {
    const r = regions({ kind: "rect", center: [0, 0], width: 10, height: 6, radius: 2 });
    expect(r[0].outer.segments).toHaveLength(8);
    // 10*6 minus four corner squares plus the quarter-discs that replace them.
    expect(profileArea(r)).toBeCloseTo(60 - 4 * 4 + Math.PI * 4, 3);
  });

  it("omits zero-length edges at the maximum radius", () => {
    const r = regions({ kind: "rect", center: [0, 0], width: 10, height: 10, radius: 5 });
    expect(r[0].outer.segments).toHaveLength(4);
    expect(r[0].outer.segments.every((s) => s.via)).toBe(true);
    expect(profileArea(r)).toBeCloseTo(Math.PI * 25, 3);
  });

  it("refuses a radius past half the shorter side, naming the maximum", () => {
    expect(() => regions({ kind: "rect", center: [0, 0], width: 10, height: 6, radius: 3.5 }))
      .toThrow(/radius 3\.5 exceeds the maximum 3/);
  });

  it("expands a polygon and refuses fewer than three points", () => {
    const r = regions({ kind: "polygon", points: [[0, 0], [4, 0], [4, 3]] });
    expect(r[0].outer.segments).toHaveLength(2);
    expect(profileArea(r)).toBeCloseTo(6, 6);
    expect(() => regions({ kind: "polygon", points: [[0, 0], [4, 0]] })).toThrow(/needs at least 3 points/);
  });

  it("refuses an unknown contour kind, naming the four", () => {
    expect(() => regions({ kind: "blob", center: [0, 0], r: 1 }))
      .toThrow(/kind must be "path", "circle", "rect", or "polygon"/);
  });

  it("matches the hand-written path equivalent of each primitive", () => {
    // Pins the normative expansions in the spec: a primitive is exactly the
    // contour an author would have written out by hand, never an approximation.
    const handRect = { kind: "path", start: [-5, -2], segments: [
      { kind: "line", to: [5, -2] }, { kind: "line", to: [5, 2] }, { kind: "line", to: [-5, 2] },
    ] };
    expect(regions({ kind: "rect", center: [0, 0], width: 10, height: 4 })).toEqual(regions(handRect));

    const handCircle = { kind: "path", start: [5, 0], segments: [
      { kind: "arc", to: [-5, 0], through: [0, 5] }, { kind: "arc", to: [5, 0], through: [0, -5] },
    ] };
    expect(regions({ kind: "circle", center: [0, 0], r: 5 })).toEqual(regions(handCircle));
  });

  it("gives a primitive hole the same geometry as its hand-written path", () => {
    const doc = (hole) => toInternalDocument({
      format: "partforge-vector", version: 1, units: "mm",
      shapes: { s: [{ outer: { kind: "rect", center: [0, 0], width: 20, height: 20 }, holes: [hole] }] },
    }, "t").shapes.get("s");
    const prim = doc({ kind: "circle", center: [0, 0], r: 4 });
    expect(profileArea(prim)).toBeCloseTo(400 - Math.PI * 16, 2);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/vector-format.test.js -t "contour kinds"`
Expected: FAIL — primitives are unknown, and `kind` on a path is not required yet.

- [ ] **Step 3: Implement expansion and validation**

In `vector-format.js`, add the expanders above `checkContour`, then dispatch.

```js
const EPS = 1e-12;
const CONTOUR_KINDS = '"path", "circle", "rect", or "polygon"';
const num = (v) => Number.isFinite(v);

// Every primitive expands to the SAME internal contour a hand-written "path"
// would produce, right here at the JSON boundary. Nothing downstream —
// placement, Shape2D, either backend, the exporters — knows primitives exist.
//
// circle and rect wind counter-clockwise by construction; polygon follows the
// author's point order. None of them needs to know whether it is an outer or a
// hole: ensureRegionWinding reorients from that label when the region is lifted
// into a Shape2D, so stored winding carries no information.
const expandCircle = ({ center: [cx, cy], r }) => ({
  start: [cx + r, cy],
  segments: [
    { to: [cx - r, cy], via: [cx, cy + r] },
    { to: [cx + r, cy], via: [cx, cy - r] },
  ],
});

const expandRect = ({ center: [cx, cy], width, height, radius = 0 }) => {
  const hw = width / 2, hh = height / 2;
  if (!(radius > 0)) {
    return { start: [cx - hw, cy - hh], segments: [
      { to: [cx + hw, cy - hh] }, { to: [cx + hw, cy + hh] }, { to: [cx - hw, cy + hh] },
    ] };
  }
  const r = radius, k = r / Math.SQRT2;
  const start = [cx - hw + r, cy - hh];
  const raw = [
    { to: [cx + hw - r, cy - hh] },
    { to: [cx + hw, cy - hh + r], via: [cx + hw - r + k, cy - hh + r - k] },
    { to: [cx + hw, cy + hh - r] },
    { to: [cx + hw - r, cy + hh], via: [cx + hw - r + k, cy + hh - r + k] },
    { to: [cx - hw + r, cy + hh] },
    { to: [cx - hw, cy + hh - r], via: [cx - hw + r - k, cy + hh - r + k] },
    { to: [cx - hw, cy - hh + r] },
    { to: [cx - hw + r, cy - hh], via: [cx - hw + r - k, cy - hh + r - k] },
  ];
  // At radius = min(w,h)/2 two (or four) edges collapse to a point. Emitting a
  // zero-length line would hand a degenerate edge to the boolean engine.
  const out = [];
  let prev = start;
  for (const seg of raw) {
    if (!seg.via && Math.abs(seg.to[0] - prev[0]) < EPS && Math.abs(seg.to[1] - prev[1]) < EPS) continue;
    out.push(seg);
    prev = seg.to;
  }
  return { start, segments: out };
};

const expandPolygon = ({ points }) => ({
  start: [...points[0]],
  segments: points.slice(1).map((p) => ({ to: [...p] })),
});
```

Rewrite `checkContour` to dispatch on the contour's `kind` and validate each shape's own fields, then keep the existing segment loop for `"path"`:

```js
function checkContour(label, where, c) {
  if (!c || typeof c !== "object") fail(label, where, "is not an object");
  if (typeof c.kind !== "string") {
    fail(label, where, 'has no "kind"', `every contour needs a kind — ${CONTOUR_KINDS}`);
  }
  if (c.kind === "circle") {
    if (!isPt(c.center)) fail(label, where, 'has "kind": "circle" but no valid "center"', "center must be an [x, y] pair of finite numbers");
    if (!num(c.r) || c.r <= 0) fail(label, where, `has "kind": "circle" but a non-positive r (${JSON.stringify(c.r)})`, "r must be a finite number greater than 0");
    return;
  }
  if (c.kind === "rect") {
    if (!isPt(c.center)) fail(label, where, 'has "kind": "rect" but no valid "center"', "center must be an [x, y] pair of finite numbers");
    for (const k of ["width", "height"]) {
      if (!num(c[k]) || c[k] <= 0) fail(label, where, `has "kind": "rect" but a non-positive ${k} (${JSON.stringify(c[k])})`, `${k} must be a finite number greater than 0`);
    }
    if (c.radius != null) {
      if (!num(c.radius) || c.radius < 0) fail(label, where, `has "kind": "rect" but an invalid radius (${JSON.stringify(c.radius)})`, "radius must be a finite number of 0 or more");
      const max = Math.min(c.width, c.height) / 2;
      if (c.radius > max) {
        fail(label, where, `has "kind": "rect" with radius ${c.radius} exceeds the maximum ${round6(max)}`,
          "a corner radius cannot be more than half the shorter side");
      }
    }
    return;
  }
  if (c.kind === "polygon") {
    if (!Array.isArray(c.points) || c.points.length < 3) {
      fail(label, where, `has "kind": "polygon" with ${c.points?.length ?? 0} points`, "a polygon needs at least 3 points");
    }
    c.points.forEach((p, i) => { if (!isPt(p)) fail(label, `${where} point ${i + 1}`, "is not a valid [x, y] pair of finite numbers"); });
    return;
  }
  if (c.kind !== "path") {
    fail(label, where, `has unknown "kind": ${JSON.stringify(c.kind)}`, `kind must be ${CONTOUR_KINDS}`);
  }
  // "path" — the explicit form.
  if (!isPt(c.start)) fail(label, where, 'has no valid "start"', "start must be a [x, y] pair of finite numbers");
  if (!Array.isArray(c.segments) || c.segments.length < 2) {
    fail(label, where, `has too few segments (${c.segments?.length ?? 0})`,
      "a closed contour needs at least two segments; it closes implicitly from the last `to` back to `start`");
  }
  c.segments.forEach((s, i) => { /* unchanged segment checks, `at` = `${where} segment ${i + 1}` */ });
}
```

Then dispatch in `toContour`:

```js
function toContour(c) {
  if (c.kind === "circle") return expandCircle(c);
  if (c.kind === "rect") return expandRect(c);
  if (c.kind === "polygon") return expandPolygon(c);
  const segments = c.segments.map(toSeg);
  const last = segments.at(-1);
  if (!last.via && !last.c1 && last.to[0] === c.start[0] && last.to[1] === c.start[1]) segments.pop();
  return { start: [...c.start], segments };
}
```

And make `fromContour` emit the tag, since ingest writes only `"path"`:

```js
const fromContour = (c) => ({
  kind: "path",
  start: [round6(c.start[0]), round6(c.start[1])],
  segments: c.segments.map(fromSeg),
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/vector-format.test.js`
Expected: PASS.

- [ ] **Step 5: Regenerate the fixture and add the determinism tests**

```bash
node scripts/ingest-svg.mjs src/parts/assets/emblem.svg > src/parts/assets/emblem.vector.json
```

Every contour gains `"kind": "path"`; coordinates unchanged.

Add to `test/svg-ingest.test.js` — these are the spec's §8 enforcement, and the second is what turns a `paper` bump into a failing CI run instead of a silent geometry change:

```js
import { readFileSync } from "node:fs";

it("is deterministic: ingesting twice gives identical bytes", () => {
  const svg = readFileSync("src/parts/assets/emblem.svg", "utf8");
  const a = JSON.stringify(ingestSvg(svg, { source: "emblem.svg" }), null, 2);
  const b = JSON.stringify(ingestSvg(svg, { source: "emblem.svg" }), null, 2);
  expect(a).toBe(b);
});

it("reproduces the checked-in emblem fixture byte for byte", () => {
  const svg = readFileSync("src/parts/assets/emblem.svg", "utf8");
  const fresh = `${JSON.stringify(ingestSvg(svg, { source: "emblem.svg" }), null, 2)}\n`;
  expect(fresh).toBe(readFileSync("src/parts/assets/emblem.vector.json", "utf8"));
});
```

- [ ] **Step 6: Run the full suite**

Run: `npm test && npx partforge measure src/parts/emblem.js`
Expected: PASS, exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(vector): circle, rect, and polygon contours; require kind on paths"
```

---

### Task 4: Units-driven placement

**Files:**
- Modify: `src/framework/geometry/vector2d.js`
- Modify: `src/framework/geometry/kernel-front.js` (pass `doc.units` through)
- Test: `test/vector2d.test.js`

**Interfaces:**
- Consumes: `regionsBbox` (unchanged), `toInternalDocument` (Task 2).
- Produces: `placeRegions(regions, units, opts)` — **note the new second parameter**. Task 5 calls it from `k.vector2d`.

**The rule, one formula for both:** scale uniformly about the document origin, then translate per `align`/`valign`.

| | `units: "mm"` | `units: "artwork"` |
|---|---|---|
| scale | `1` unless a size option is given | exactly one of `width`/`height`/`fit`, required |
| `align` default | none (no x translate) | `"center"` |
| `valign` default | none (no y translate) | `"middle"` |

Two or more size options is an error in both modes.

- [ ] **Step 1: Write the failing tests**

Add to `test/vector2d.test.js`:

```js
import { placeRegions } from "../src/framework/geometry/vector2d.js";
import { profileBounds } from "../src/framework/geometry/contour-ops.js";

// A 20x10 rect whose bottom-left corner sits at (5, 5) — deliberately off-origin,
// so "as authored" is distinguishable from "centred".
const boxAt = () => [{ outer: { start: [5, 5], segments: [
  { to: [25, 5] }, { to: [25, 15] }, { to: [5, 15] },
] }, holes: [] }];

describe("placement", () => {
  it("mm with no size is the identity", () => {
    const { min, max } = profileBounds(placeRegions(boxAt(), "mm", {}));
    expect(min).toEqual([5, 5]);
    expect(max).toEqual([25, 15]);
  });

  it("mm with a width scales about the origin, not the bbox centre", () => {
    const { min, max } = profileBounds(placeRegions(boxAt(), "mm", { width: 40 }));
    expect(min).toEqual([10, 10]);
    expect(max).toEqual([50, 30]);
  });

  it("mm still honours an explicit align", () => {
    const { min, max } = profileBounds(placeRegions(boxAt(), "mm", { align: "center", valign: "middle" }));
    expect(min).toEqual([-10, -5]);
    expect(max).toEqual([10, 5]);
  });

  it("artwork centres by default, as before", () => {
    const { min, max } = profileBounds(placeRegions(boxAt(), "artwork", { width: 20 }));
    expect(min).toEqual([-10, -5]);
    expect(max).toEqual([10, 5]);
  });

  it("artwork still requires a size", () => {
    expect(() => placeRegions(boxAt(), "artwork", {})).toThrow(/a size is required/);
  });

  it("refuses more than one size option in either mode", () => {
    expect(() => placeRegions(boxAt(), "mm", { width: 10, fit: 10 })).toThrow(/only one of width, height, or fit — got width, fit/);
    expect(() => placeRegions(boxAt(), "artwork", { width: 10, height: 10 })).toThrow(/only one of width, height, or fit/);
  });

  it("still refuses an unrecognized align or valign", () => {
    expect(() => placeRegions(boxAt(), "mm", { align: "centre" })).toThrow(/align must be/);
    expect(() => placeRegions(boxAt(), "mm", { valign: "centre" })).toThrow(/valign must be/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/vector2d.test.js -t "placement"`
Expected: FAIL — `placeRegions` takes `(regions, opts)`.

- [ ] **Step 3: Rewrite `placeRegions`**

```js
const SIZE_KEYS = ["width", "height", "fit"];

function scaleFor(opts, units, w, h) {
  const given = SIZE_KEYS.filter((k) => opts[k] != null);
  if (given.length > 1) {
    throw new Error(`vector2d: pass only one of width, height, or fit — got ${given.join(", ")}`);
  }
  if (given.length === 0) {
    // Millimetre coordinates already mean something; artwork units do not, so
    // there is no honest default for artwork. (k.text2d can default `size`
    // because a cap height is a real measurement; an SVG viewBox unit is not.)
    if (units === "mm") return 1;
    throw new Error("vector2d: a size is required for artwork units — pass one of { width }, { height }, or { fit } in millimetres");
  }
  const [key] = given;
  const v = opts[key];
  if (!(v > 0)) throw new Error(`vector2d: ${key} must be a positive number of millimetres`);
  const extent = key === "width" ? w : key === "height" ? h : Math.max(w, h);
  if (!(extent > EXTENT_EPS)) throw new Error(`vector2d: artwork has no ${key === "fit" ? "extent" : key} to size against`);
  return v / extent;
}

export function placeRegions(regions, units, opts = {}) {
  // An mm file places where it was drawn; only artwork has to be re-centred,
  // because its own coordinates mean nothing. `null` here is "no translate".
  const align = opts.align ?? (units === "mm" ? null : "center");
  const valign = opts.valign ?? (units === "mm" ? null : "middle");
  if (align != null && !ALIGN.has(align)) throw new Error(`vector2d: align must be "left", "center", or "right" — got ${JSON.stringify(align)}`);
  if (valign != null && !VALIGN.has(valign)) throw new Error(`vector2d: valign must be "bottom", "middle", or "top" — got ${JSON.stringify(valign)}`);
  const { minX, minY, maxX, maxY } = regionsBbox(regions);
  const s = scaleFor(opts, units, maxX - minX, maxY - minY);
  const dx = align == null ? 0 : align === "left" ? -minX * s : align === "right" ? -maxX * s : -((minX + maxX) / 2) * s;
  const dy = valign == null ? 0 : valign === "bottom" ? -minY * s : valign === "top" ? -maxY * s : -((minY + maxY) / 2) * s;
  return regions.map((r) => ({
    outer: place(r.outer, s, dx, dy),
    holes: r.holes.map((c) => place(c, s, dx, dy)),
  }));
}
```

Update the file's header comment: placement is no longer "one uniform scale then an alignment translate" unconditionally — it is that, with both steps defaulting to no-ops for millimetre files.

- [ ] **Step 4: Thread units through the kernel op**

In `kernel-front.js`:

```js
  const regions = [...doc.shapes.values()].flat();
  return placeRegions(regions, doc.units, opts).map((r) => k.shape2d(r)).reduce((a, b) => a.union(b));
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/vector2d.test.js && npm test`
Expected: PASS. `emblem` is `units: "artwork"` with a `width`, so its geometry must be byte-for-byte what it was.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(vector): units-driven placement — mm places as authored"
```

---

### Task 5: Shape selection

**Files:**
- Modify: `src/framework/geometry/kernel-front.js`
- Modify: `types/kernel.d.ts`
- Test: `test/vector2d.test.js`, `test/types-surface.test.js`

**Interfaces:**
- Consumes: `placeRegions(regions, units, opts)` (Task 4), `k._vectors` (Task 2).
- Produces: `k.vector2d(name, { shape?, width?, height?, fit?, align?, valign? })`.

- [ ] **Step 1: Write the failing test**

Add to `test/vector2d.test.js`. Use a booted Manifold kernel the way the existing `emblem`/`vector2d` tests do, registering a two-shape document on `k._vectors` directly:

```js
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { toInternalDocument } from "../src/framework/geometry/vector-format.js";

const TWO_SHAPE = {
  format: "partforge-vector", version: 1, units: "mm",
  shapes: {
    body:  [{ outer: { kind: "rect", center: [0, 0], width: 20, height: 20 } }],
    holes: [{ outer: { kind: "circle", center: [0, 0], r: 4 } }],
  },
};

describe("shape selection", () => {
  let k;
  beforeAll(async () => {
    k = await bootManifoldKernel();
    k._vectors.set("plate", toInternalDocument(TWO_SHAPE, "plate"));
  });

  it("unions every shape by default", () => {
    expect(k.vector2d("plate").area()).toBeCloseTo(400, 2);   // circle is inside the rect
  });

  it("selects one shape by name", () => {
    expect(k.vector2d("plate", { shape: "holes" }).area()).toBeCloseTo(Math.PI * 16, 2);
  });

  it("composes shapes with ordinary booleans, in the drawing's own frame", () => {
    const cut = k.vector2d("plate", { shape: "body" }).cut(k.vector2d("plate", { shape: "holes" }));
    expect(cut.area()).toBeCloseTo(400 - Math.PI * 16, 2);
  });

  it("names the available shapes when one is unknown", () => {
    expect(() => k.vector2d("plate", { shape: "rim" }))
      .toThrow(/"plate" has no shape "rim" — it declares: body, holes/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/vector2d.test.js -t "shape selection"`
Expected: FAIL — `opts.shape` is ignored, so every case returns the union.

- [ ] **Step 3: Implement selection**

```js
  k.vector2d = (name, opts = {}) => {
    if (typeof name !== "string" || !name)
      throw new Error("vector2d: first argument must be the name of an entry in the part's `vectors` field");
    const doc = k._vectors.get(name);
    if (!doc) throw new Error(`vector2d: unknown vector "${name}" — declare it in the part's \`vectors\` field`);
    // No shape named → every shape, unioned. Single-shape files therefore never
    // have to name anything, and union is commutative so key order is moot.
    let regions;
    if (opts.shape == null) {
      regions = [...doc.shapes.values()].flat();
    } else {
      regions = doc.shapes.get(opts.shape);
      if (!regions) {
        throw new Error(`vector2d: "${name}" has no shape ${JSON.stringify(opts.shape)} — it declares: ${[...doc.shapes.keys()].join(", ")}`);
      }
    }
    return placeRegions(regions, doc.units, opts).map((r) => k.shape2d(r)).reduce((a, b) => a.union(b));
  };
```

- [ ] **Step 4: Update the type surface**

In `types/kernel.d.ts`, add `shape` to `Vector2dOptions`, make the size options optional in prose, and loosen `vector2d`'s second parameter to optional:

```ts
export interface Vector2dOptions {
  /** Name of one shape in the file. Omit for the union of every shape. */
  shape?: string;
  /** Target width in mm. At most one of `width`/`height`/`fit`; required for `units: "artwork"`. */
  width?: number;
  /** Target height in mm. At most one of `width`/`height`/`fit`; required for `units: "artwork"`. */
  height?: number;
  /** Target size in mm for the larger extent. At most one of `width`/`height`/`fit`; required for `units: "artwork"`. */
  fit?: number;
  /** Defaults to `"center"` for `units: "artwork"`, and to no horizontal translate for `units: "mm"`. */
  align?: Vector2dAlign;
  /** Defaults to `"middle"` for `units: "artwork"`, and to no vertical translate for `units: "mm"`. */
  valign?: Vector2dValign;
}
```

```ts
  /**
   * Place a declared vector file as a `Shape2D`. `name` is a key in the part's
   * `vectors` field (`partforge-vector` JSON, not raw `.svg`).
   */
  vector2d(name: string, opts?: Vector2dOptions): Shape2D;
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/vector2d.test.js test/types-surface.test.js && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(vector): select a named shape with k.vector2d(name, { shape })"
```

---

### Task 5b: Shape roles

Added 2026-08-30 after design review. A shape declares whether it adds or subtracts material, so a document states its own composition instead of leaving that fact in `build`.

**Files:**
- Modify: `src/framework/geometry/vector-format.js`
- Modify: `src/framework/geometry/kernel-front.js`
- Modify: `types/kernel.d.ts`
- Test: `test/vector-format.test.js`, `test/vector2d.test.js`

**Interfaces:**
- Consumes: `toInternalDocument`, `k.vector2d(name, { shape })` (Tasks 2 and 5).
- Produces: **`toInternalDocument` now returns `{ units, shapes: Map<string, { role, regions }> }`** — the map value gains a wrapper. This is a breaking change to the shape Task 5 consumes; `kernel-front.js` is the only reader and is updated here.

**Semantics:**
- `role` is `"add"` (default when absent) or `"subtract"`. Any other value is refused by name.
- `k.vector2d(name)` with no `shape` returns `union(add shapes).cut(union(subtract shapes))`.
- `k.vector2d(name, { shape })` returns that shape's own geometry whatever its role.
- A file with no `add` shape is refused at load — an all-`subtract` file composes to nothing, and an empty `Shape2D` would only surface later as an empty extrude.
- `bbox` still covers every region, `subtract` shapes included. It checksums stored geometry, not the composed result.
- Ingest omits `role` entirely; its single `artwork` shape defaults to `"add"`. The fixture must not change.

- [ ] **Step 1: Write the failing tests**

Add to `test/vector-format.test.js`:

```js
const roleDoc = (roles) => ({
  format: "partforge-vector", version: 1, units: "mm",
  shapes: Object.fromEntries(Object.entries(roles).map(([name, role]) => [
    name,
    role === null
      ? [{ outer: { kind: "circle", center: [0, 0], r: 3 } }]
      : { role, regions: undefined } && [{ outer: { kind: "circle", center: [0, 0], r: 3 } }],
  ])),
});

describe("roles", () => {
  const doc = (shapes) => ({ format: "partforge-vector", version: 1, units: "mm", shapes });
  const body = { role: "add", regions: [{ outer: { kind: "rect", center: [0, 0], width: 20, height: 20 } }] };
  const hole = { role: "subtract", regions: [{ outer: { kind: "circle", center: [0, 0], r: 4 } }] };

  it("defaults a bare region array to the add role", () => {
    const d = toInternalDocument(doc({ s: [{ outer: { kind: "circle", center: [0, 0], r: 3 } }] }), "t");
    expect(d.shapes.get("s").role).toBe("add");
    expect(d.shapes.get("s").regions).toHaveLength(1);
  });

  it("reads an explicit role", () => {
    const d = toInternalDocument(doc({ body, hole }), "t");
    expect(d.shapes.get("body").role).toBe("add");
    expect(d.shapes.get("hole").role).toBe("subtract");
  });

  it("refuses an unknown role", () => {
    expect(() => toInternalDocument(doc({ s: { role: "erase", regions: body.regions } }), "t"))
      .toThrow(/has an unknown `role` "erase".*"add".*"subtract"/s);
  });

  it("refuses a file with no add shape", () => {
    expect(() => toInternalDocument(doc({ hole }), "t"))
      .toThrow(/has no shape with role "add"/);
  });
});
```

Add to `test/vector2d.test.js`, in the booted-kernel block:

```js
const ROLE_DOC = {
  format: "partforge-vector", version: 1, units: "mm",
  shapes: {
    body:  { role: "add", regions: [{ outer: { kind: "rect", center: [0, 0], width: 20, height: 20 } }] },
    holes: { role: "subtract", regions: [{ outer: { kind: "circle", center: [0, 0], r: 4 } }] },
  },
};

describe("roles compose", () => {
  beforeAll(() => { k._vectors.set("roled", toInternalDocument(ROLE_DOC, "roled")); });

  it("subtracts by default instead of unioning", () => {
    expect(k.vector2d("roled").area()).toBeCloseTo(400 - Math.PI * 16, 1);
  });

  it("still hands back a subtract shape when it is named explicitly", () => {
    expect(k.vector2d("roled", { shape: "holes" }).area()).toBeCloseTo(Math.PI * 16, 1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/vector-format.test.js -t "roles" && npx vitest run test/vector2d.test.js -t "roles compose"`
Expected: FAIL — a shape is still a bare array and the default call unions.

- [ ] **Step 3: Accept both shape forms in the validator**

A shape value is either a bare array of regions (role defaults to `"add"`) or an object `{ role?, regions }`. In `validateVectorDocument`, replace the per-name body:

```js
const ROLES = ["add", "subtract"];

// A shape is either a bare region array — the common case, role "add" — or
// { role, regions }. Two forms rather than one because "add" is an honest
// default: a painted region adds material, which is what every file written
// before roles existed already meant.
const shapeParts = (v) => (Array.isArray(v) ? { role: "add", regions: v } : { role: v?.role ?? "add", regions: v?.regions });

  let anyAdd = false;
  for (const name of names) {
    const where = `shape ${JSON.stringify(name)}`;
    const raw = doc.shapes[name];
    if (!raw || (typeof raw !== "object")) fail(label, where, "is not an array of regions or a { role, regions } object");
    const { role, regions } = shapeParts(raw);
    if (!ROLES.includes(role)) {
      fail(label, where, `has an unknown \`role\` ${JSON.stringify(role)}`,
        '`role` must be "add" (the default, may be omitted) or "subtract"');
    }
    if (role === "add") anyAdd = true;
    if (!Array.isArray(regions)) fail(label, where, "is not an array of regions");
    if (regions.length === 0) fail(label, where, "is empty", "a shape needs at least one region");
    regions.forEach((rg, i) => { /* unchanged region + contour checks, `${where} region ${i + 1}` */ });
  }
  if (!anyAdd) {
    fail(label, "file", 'has no shape with role "add"',
      "a file whose every shape subtracts composes to nothing — at least one shape must add material");
  }
```

`allRegionsUnchecked` must also read through the wrapper, so `bbox` keeps covering every region including subtracted ones:

```js
const allRegionsUnchecked = (doc) =>
  Object.values(doc.shapes).flatMap((v) => shapeParts(v).regions).map(toRegion);
```

And `toInternalDocument` returns the wrapper:

```js
export function toInternalDocument(doc, label = "(unnamed)") {
  validateVectorDocument(doc, label);
  return {
    units: doc.units,
    shapes: new Map(Object.entries(doc.shapes).map(([name, v]) => {
      const { role, regions } = shapeParts(v);
      return [name, { role, regions: regions.map(toRegion) }];
    })),
  };
}
```

`fromInternalRegions` is unchanged — ingest emits a bare array, so its single `artwork` shape defaults to `"add"` and the checked-in fixture must not change.

- [ ] **Step 4: Compose by role in the kernel op**

In `kernel-front.js`, `k.vector2d` now reads `.regions` through the wrapper, and the default call composes:

```js
    const lift = (regions) => placeRegions(regions, doc.units, opts).map((r) => k.shape2d(r)).reduce((a, b) => a.union(b));
    if (opts.shape != null) {
      const entry = doc.shapes.get(opts.shape);
      if (!entry) {
        throw new Error(`vector2d: "${name}" has no shape ${JSON.stringify(opts.shape)} — it declares: ${[...doc.shapes.keys()].join(", ")}`);
      }
      // Naming a shape is a request for THAT geometry; role governs only the
      // default composition below.
      return lift(entry.regions);
    }
    const adds = [...doc.shapes.values()].filter((e) => e.role === "add").flatMap((e) => e.regions);
    const subs = [...doc.shapes.values()].filter((e) => e.role === "subtract").flatMap((e) => e.regions);
    const composed = lift(adds);
    return subs.length === 0 ? composed : composed.cut(lift(subs));
```

Both groups are unioned before the cut, and union is commutative, so the result does not depend on key order. `adds` is never empty — the validator guarantees at least one `add` shape.

- [ ] **Step 5: Update the type surface**

In `types/kernel.d.ts`, document that `shape` overrides role-based composition:

```ts
  /**
   * Name of one shape in the file, returned whatever its `role`. Omit for the
   * composed result: every `"add"` shape unioned, minus every `"subtract"` one.
   */
  shape?: string;
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/vector-format.test.js test/vector2d.test.js && npm test`
Expected: PASS. The `emblem` fixture has one bare-array shape, so it defaults to `"add"` and its geometry is unchanged.

- [ ] **Step 7: Confirm the fixture did not move**

Run: `node scripts/ingest-svg.mjs src/parts/assets/emblem.svg | diff - src/parts/assets/emblem.vector.json`
Expected: no output beyond a possible trailing newline. Ingest must not have started emitting `role`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(vector): per-shape add/subtract roles so a file states its own composition"
```

---

### Task 6: Lint — the `vectorDocs` seam and the three rules

**Files:**
- Modify: `src/framework/lint/index.js`
- Modify: `src/framework/lint/rules-vector.js`
- Modify: `src/framework/vectors.js` (add `resolveVectorDocs`)
- Modify: `bin/cli.js` (supply `vectorDocs` to `lintPart`)
- Test: `test/lint-vector.test.js`, `test/lint-purity.test.js` (must still pass unchanged)

**Interfaces:**
- Consumes: `resolveDecl`, the shared asset resolver in `vectors.js`.
- Produces:
  - `resolveVectorDocs(decl) → Promise<Map<string, object|null>>` from `src/framework/vectors.js` — the **raw parsed JSON**, before validation or conversion, so lint can read `units` and `shapes` keys. A source that fails to fetch, decode, or parse maps to `null` rather than throwing; lint degrades, it never breaks a build.
  - `lintPart(part, { params?, sources?, vectorDocs? })` — `vectorDocs` is `{ name: parsedDocument }`.
  - `ctx.vectorDocs` — a null-prototype object, or `null`.

**Why the caller supplies it:** `src/framework/lint/index.js`'s header declares lint **pure: no I/O, no async**, with the closure enforced by `test/lint-purity.test.js`, because `lintPart` runs inside partforge-cloud's browser sandbox. A rule may never read a file. This is the same seam `sources` already uses.

- [ ] **Step 1: Write the failing tests**

Add to `test/lint-vector.test.js`:

```js
const DOC = (units, shapes) => ({ format: "partforge-vector", version: 1, units, shapes });
const partWith = (buildFn) => ({
  vectors: { plate: new Uint8Array() },
  defaults: {},
  parts: { main: { build: buildFn } },
});

describe("vector lint rules", () => {
  it("vector-unknown-name fires without vectorDocs", () => {
    const r = lintPart(partWith((k) => k.vector2d("nope", { width: 10 }).extrude({ h: 1 })));
    expect(r.errors.map((e) => e.id)).toContain("vector-unknown-name");
  });

  it("vector-size-missing needs vectorDocs and fires only for artwork units", () => {
    const build = (k) => k.vector2d("plate").extrude({ h: 1 });
    // No documents supplied → the rule cannot know the units, so it stays quiet.
    expect(lintPart(partWith(build)).errors.map((e) => e.id)).not.toContain("vector-size-missing");
    // mm → a size is genuinely optional.
    expect(lintPart(partWith(build), { vectorDocs: { plate: DOC("mm", { s: [] }) } })
      .errors.map((e) => e.id)).not.toContain("vector-size-missing");
    // artwork → a size is required.
    expect(lintPart(partWith(build), { vectorDocs: { plate: DOC("artwork", { artwork: [] }) } })
      .errors.map((e) => e.id)).toContain("vector-size-missing");
  });

  it("vector-unknown-shape names the shapes the file declares", () => {
    const build = (k) => k.vector2d("plate", { shape: "rim" }).extrude({ h: 1 });
    const r = lintPart(partWith(build), { vectorDocs: { plate: DOC("mm", { body: [], holes: [] }) } });
    const f = r.errors.find((e) => e.id === "vector-unknown-shape");
    expect(f.message).toMatch(/body, holes/);
  });

  it("survives a malformed vectorDocs without throwing", () => {
    const build = (k) => k.vector2d("plate", { shape: "rim" }).extrude({ h: 1 });
    for (const bad of [null, 42, "x", { plate: null }, { plate: "not a doc" }]) {
      expect(() => lintPart(partWith(build), { vectorDocs: bad })).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/lint-vector.test.js`
Expected: FAIL — `vector-size-missing` fires unconditionally and `vector-unknown-shape` does not exist.

- [ ] **Step 3: Add the normalizer and thread it into the context**

In `src/framework/lint/index.js`, mirroring `normalizeSources`:

```js
// The caller's parsed vector files, or null. Deliberately forgiving for the same
// reason normalizeSources is: hosted callers hand over user- and agent-authored
// trees, and a malformed input must mean "no document-dependent findings",
// never a throw. Lint itself never reads a file — it is pure and synchronous by
// contract (see this file's header); the caller does the I/O and passes the
// result in.
function normalizeVectorDocs(docs) {
  if (!docs || typeof docs !== "object") return null;
  const out = Object.create(null);
  let any = false;
  for (const [name, doc] of Object.entries(docs)) {
    if (!doc || typeof doc !== "object") continue;
    out[name] = doc;
    any = true;
  }
  return any ? out : null;
}
```

In `lintPart`, destructure and assign inside its own guard, exactly as `sources` does:

```js
  const { params, sources, vectorDocs } = opts ?? {};
  // …
  try { ctx.sources = normalizeSources(sources); } catch { ctx.sources = null; }
  try { ctx.vectorDocs = normalizeVectorDocs(vectorDocs); } catch { ctx.vectorDocs = null; }
```

- [ ] **Step 4: Rewrite the rules**

In `src/framework/lint/rules-vector.js`, keep `vector-unknown-name` as it is, gate `vector-size-missing` on units, and add `vector-unknown-shape`. Extract the option-object reader, since two rules now need it:

```js
// Probe args are JSON-serialized resolved VALUES (probe.js's `describe`), not
// source text — so an options object arrives as `{"width":10,"shape":"body"}`.
// Parsing it back is exact for the literal cases these rules judge; anything
// that does not parse to a plain object means "cannot tell", and the rule stays
// quiet rather than guessing.
const optsOf = (src) => {
  if (src == null) return {};
  try { const v = JSON.parse(src); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
};
```

`vector-size-missing`:

```js
  {
    id: "vector-size-missing",
    run: ({ probe, vectorDocs }) => {
      if (!vectorDocs) return [];                       // caller supplied nothing — cannot judge units
      const out = [];
      for (const call of vectorCalls(probe)) {
        const name = literalName(call.args[0]);
        if (name == null) continue;
        const doc = Object.hasOwn(vectorDocs, name) ? vectorDocs[name] : null;
        if (doc?.units !== "artwork") continue;         // mm files place as authored; a size is optional
        const opts = optsOf(call.args[1]);
        if (opts == null) continue;
        if (opts.width != null || opts.height != null || opts.fit != null) continue;
        out.push(err("vector-size-missing",
          `k.vector2d("${name}", …) declares no size, and "${name}" has units "artwork" — one of { width }, { height }, or { fit } is required, in millimetres`,
          "Artwork units have no physical meaning, so there is no safe default to fall back on (unlike k.text2d's cap-height `size`). "
          + `Add one, e.g. k.vector2d("${name}", { width: 20 }) — or re-author the file with "units": "mm" if its coordinates really are millimetres.`,
          "build"));
      }
      return out;
    },
  },
```

`vector-unknown-shape`:

```js
  {
    id: "vector-unknown-shape",
    run: ({ probe, vectorDocs }) => {
      if (!vectorDocs) return [];
      const out = [];
      for (const call of vectorCalls(probe)) {
        const name = literalName(call.args[0]);
        const opts = optsOf(call.args[1]);
        if (name == null || opts == null || typeof opts.shape !== "string") continue;
        const doc = Object.hasOwn(vectorDocs, name) ? vectorDocs[name] : null;
        const shapes = doc?.shapes;
        if (!shapes || typeof shapes !== "object" || Array.isArray(shapes)) continue;
        if (Object.hasOwn(shapes, opts.shape)) continue;
        out.push(err("vector-unknown-shape",
          `k.vector2d("${name}", { shape: "${opts.shape}" }) names a shape "${name}" does not contain: ${Object.keys(shapes).join(", ") || "(none)"}`,
          "Fix the shape name to match one the file declares, or omit `shape` to use the union of every shape.",
          "build"));
      }
      return out;
    },
  },
```

- [ ] **Step 5: Add `resolveVectorDocs` and wire the CLI**

In `src/framework/vectors.js`, beside `resolveVectors`. It shares the bytes memo, so `lint` costs no extra fetch when `measure` runs after it:

```js
// The RAW parsed JSON, before validation or conversion — what lint's
// document-dependent rules need to read `units` and `shapes`. Never throws: a
// source that will not fetch, decode, or parse maps to null, and the rules that
// depend on it stay quiet. Diagnosing a broken file is the build's job, and it
// does that with a named error; lint's job is to be fast and never wrong.
export async function resolveVectorDocs(vectorsDecl) {
  if (typeof vectorsDecl === "function") return new Map();
  const out = new Map();
  let raw;
  try { raw = await resolveDecl(vectorsDecl ?? {}, resolveOne); } catch { return out; }
  for (const [name, bytes] of raw) {
    try { out.set(name, JSON.parse(new TextDecoder().decode(bytes))); } catch { out.set(name, null); }
  }
  return out;
}
```

In `bin/cli.js`'s `lint` command, supply it:

```js
      const sources = readSources(partPath);
      const vectorDocs = Object.fromEntries(await resolveVectorDocs(part.vectors));
      const report = lintPart(part, { params, sources, vectorDocs });
```

Import `resolveVectorDocs` from `../src/framework/vectors.js` at the top of `bin/cli.js`. Leave the second `lintPart` call (inside `measure`, around line 151) supplying `vectorDocs` too, resolved the same way.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/lint-vector.test.js test/lint-purity.test.js && npm test`
Expected: PASS. **`test/lint-purity.test.js` must pass unmodified** — if it fails, a `node:` or async import leaked into the lint closure, which means `resolveVectorDocs` was imported from a lint module instead of being called by the CLI.

- [ ] **Step 7: Check the CLI reports the new rule**

Run: `npx partforge lint src/parts/emblem.js`
Expected: exit 0, no vector findings.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(lint): vectorDocs seam, units-aware size rule, unknown-shape rule"
```

---

### Task 7: Reference part — an authored plate composed against the ingested artwork

One part now exercises `units: "mm"`, named shapes, all four contour kinds, and cross-shape composition, with no new app entry, HTML page, worker, or CI port.

**Files:**
- Create: `src/parts/assets/plate.vector.json`
- Modify: `src/parts/emblem.js`
- Test: `test/emblem-part.test.js`

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the authored file**

`src/parts/assets/plate.vector.json` — hand-written, no `bbox`, no `source`. It is also the worked example Task 8's documentation quotes, so keep it legible.

```json
{
  "format": "partforge-vector",
  "version": 1,
  "units": "mm",
  "note": "Emblem backing plate. Drawn at 40 x 24 mm with M3 clearance holes on 28 mm centres. Coordinates are millimetres and place as authored, so `body` and `holes` share one frame — the cut in build lands where it is drawn.",
  "shapes": {
    "body": {
      "role": "add",
      "regions": [
        { "outer": { "kind": "rect", "center": [0, 0], "width": 40, "height": 24, "radius": 4 } }
      ]
    },
    "holes": {
      "role": "subtract",
      "regions": [
        { "outer": { "kind": "circle", "center": [-14, 0], "r": 1.7 } },
        { "outer": { "kind": "circle", "center": [14, 0], "r": 1.7 } }
      ]
    },
    "keyway": {
      "role": "subtract",
      "regions": [
        { "outer": { "kind": "polygon", "points": [[-3, 9], [3, 9], [0, 5]] } }
      ]
    }
  }
}
```

- [ ] **Step 2: Write the failing test**

Add to `test/emblem-part.test.js`:

```js
it("cuts the authored plate's holes and keyway, in the drawing's own frame", async () => {
  const k = await bootManifoldKernel({ vectors: part.vectors });
  const body = k.vector2d("plate", { shape: "body" });
  const cut = body.cut(k.vector2d("plate", { shape: "holes" })).cut(k.vector2d("plate", { shape: "keyway" }));
  // 40x24 with four r=4 corners, minus two r=1.7 discs and a 6x4 triangle.
  const bodyArea = 40 * 24 - 4 * 16 + Math.PI * 16;
  expect(body.area()).toBeCloseTo(bodyArea, 1);
  expect(cut.area()).toBeCloseTo(bodyArea - 2 * Math.PI * 1.7 ** 2 - 12, 1);
  // The whole point of roles: the file composes itself, and the result is
  // identical to doing it by hand shape by shape.
  expect(k.vector2d("plate").area()).toBeCloseTo(cut.area(), 6);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/emblem-part.test.js`
Expected: FAIL — the part declares no `plate` vector yet.

- [ ] **Step 4: Wire the part**

In `src/parts/emblem.js`, declare the second vector and build the plate from it instead of `k.box`. Replace the `vectors` block and the `plate` build:

```js
  vectors: {
    emblem: new URL("./assets/emblem.vector.json", import.meta.url),
    plate: new URL("./assets/plate.vector.json", import.meta.url),
  },
```

```js
      build: (k, p) => k
        .vector2d("plate", { shape: "body", width: p.plate_w })
        .cut(k.vector2d("plate", { shape: "holes", width: p.plate_w }))
        .cut(k.vector2d("plate", { shape: "keyway", width: p.plate_w }))
        .extrude({ h: p.plate_t })
        .union(k.vector2d("emblem", { width: p.emblem_w }).extrude({ h: p.emboss }).translate([0, 0, p.plate_t])),
```

**A note the implementer must get right:** every one of those three calls passes the same `width: p.plate_w`, and each is scaled against **its own shape's bounds** — so `holes` scaled to `plate_w` would be enormous. That is wrong on two counts. Because the file is `units: "mm"`, the correct form passes **no size at all**, letting every shape place as authored in one shared frame. And because the file declares `role` per shape, it composes *itself* — so no `shape` argument and no `.cut()` chain are needed either. The whole plate is one call, and `plate_w` drops out of the geometry:

```js
      // No shape named and no size: the file's own roles compose it (body minus
      // holes minus keyway), and units "mm" places it exactly as drawn. Passing
      // a size here would scale each shape against ITS OWN bounds — the trap
      // this format exists to prevent.
      build: (k, p) => k
        .vector2d("plate")
        .extrude({ h: p.plate_t })
        .union(k.vector2d("emblem", { width: p.emblem_w }).extrude({ h: p.emboss }).translate([0, 0, p.plate_t])),
```

This is the whole point of mm-as-authored, and it is exactly the mistake the format is meant to prevent — leave the comment in the part saying so.

Consequently `plate_w` and `plate_h` no longer drive geometry. **Remove both from `parameters` and `defaults`**, and update the `plate` group's description to say the outline is drawn in `plate.vector.json` rather than parameterized. Keep `plate_t`, `emblem_w`, and `emboss`.

Update the file header comment: the part is now the `k.vector2d` reference for **both** paths — ingested artwork (`emblem`, `units: "artwork"`) and an authored drawing (`plate`, `units: "mm"`).

- [ ] **Step 5: Retune the verify block**

The bbox envelope changes with `plate_w`/`plate_h` gone: the plate is a fixed 40 × 24 mm, so the part's extent is bounded by that and by `plate_t + emboss ≤ 14`. The volume gate must still fail if either the holes stop cutting or the emboss vanishes, so bound it from **both** sides:

```js
  verify: {
    expect: {
      plate: {
        // The plate outline is fixed by plate.vector.json (40 x 24), so this
        // envelope is tight in x/y and schema-bounded in z (plate_t + emboss <= 14).
        bbox: "<=[41,25,15]",
        // Two-sided, deliberately. The lower bound catches an emboss that
        // silently produced nothing; the upper bound catches holes or a keyway
        // that silently stopped cutting. A one-sided gate misses half of that.
        volume: ">=2900",
        watertight: true,
        // Three through-holes, not two: the two bolt circles AND the keyway
        // triangle all cut clean through the extruded plate. Confirm against
        // `measure` rather than trusting this number.
        holes: 3,
      },
      _view: { overlaps: 0 },
    },
  },
```

Run `npx partforge measure src/parts/emblem.js` to read the **actual** volume and hole count at defaults, then set `volume` a little under it and confirm `holes` matches. **Falsify both gates before moving on:** temporarily delete the two `.cut(...)` calls and confirm `measure` fails on `holes`; temporarily set `emboss` to its minimum in a scratch run and confirm the volume bound still holds. A gate that cannot fail is not a gate — this is the mistake the earlier spec's verify block already made once.

- [ ] **Step 6: Run everything**

Run: `npm test && npx partforge lint src/parts/emblem.js && npx partforge measure src/parts/emblem.js && node scripts/check-app.mjs emblem.html`
Expected: all pass, exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(parts): emblem composes an authored mm plate with ingested artwork"
```

---

### Task 8: Documentation

**Files:**
- Rewrite: `docs/VECTOR-FORMAT.md`
- Modify: `docs/AUTHORING-PARTS.md`, `docs/ERROR-PATTERNS.md`, `docs/KERNEL-CONTRACT.md`, `AGENTS.md`
- Test: `test/error-patterns.test.js` (must still pass)

**Interfaces:**
- Consumes: the final behaviour of Tasks 1–7. Write this last, against the shipped code, not against this plan.

- [ ] **Step 1: Rewrite `docs/VECTOR-FORMAT.md`**

A rewrite, not a patch — enough changes that patching would leave contradictions. Structure:

1. **What this is** — a format for filled 2-D outlines that `k.vector2d` turns into a `Shape2D`. Lead with the **authored** case; ingest is now the secondary path. State the property that justifies shipping no headless converter: this file alone is enough to write a compliant converter.
2. **A worked authored example** — `src/parts/assets/plate.vector.json` in full, with the `build` that composes its three shapes. Point out that `body` and `holes` share a frame because the file is `units: "mm"`, and that no size option appears anywhere.
3. **Schema** — the envelope table from spec §1, the four contour kinds from §2 with their normative expansions, and the three segment kinds. Cover `role` explicitly: the two shape forms (a bare region array, or `{ role, regions }`), that `"add"` is the default and why it has an honest default where `units` does not, that a file must declare at least one `add` shape, that `bbox` still covers subtracted regions, and that naming a `shape` returns that geometry whatever its role. Keep the two `through` gotchas verbatim: collinearity degenerates to a line, and which side of the chord decides sweep and major/minor.
4. **Rules that are not obvious from the schema** — y points up; `units` and what each means; a path closes implicitly; `bbox` is optional and recomputed; a stroke is never a line; a fill rule applies across one element's own subpaths.

   **Rewrite the winding rule. The current text is wrong.** It says reversed winding "produces geometry with the outer treated as a hole and vice versa, silently, no error." Measured on the shipped code: a 10 × 10 square with a 4 × 4 hole gives area 84 both ways, because `k.shape2d`'s `liftRegions` runs `ensureRegionWinding`, which forces `outer` counter-clockwise and holes clockwise **from the `outer`/`holes` labels**, ignoring stored winding entirely. The replacement text must say plainly: orientation comes from the labels, stored winding carries no information, and **an author never needs a shoelace sum.** Do not soften this into "prefer counter-clockwise" — it is a correction, and the current text costs an agent real work.
5. **A worked ingested example** — the `emblem` fixture, keeping the three observations that make it worth quoting (the circle survived as arcs; the stroked polyline became a closed filled region; y is negated).
6. **Converting an SVG by hand** — the existing step list, updated for the new envelope: emit `units: "artwork"`, wrap regions in a named shape, tag every contour `kind: "path"`, and `bbox` is now optional so step 8 becomes advice rather than a requirement.
7. **Painting order is not modelled** — unchanged.
8. **Versioning** — unchanged, plus the new floor: a version below 1 is refused as well as one above.

- [ ] **Step 2: Update `docs/AUTHORING-PARTS.md`**

- The `PartDefinition` field list: `svgs?` becomes `vectors?`, described as "declared vector files `k.vector2d()` places — authored `partforge-vector` JSON or ingested SVG; same source grammar and preload timing as fonts."
- The "Vector art (SVG)" section becomes "Vector geometry", covering `k.vector2d(name, { shape?, width?, height?, fit?, align?, valign? })`, the two units modes with the placement table from spec §3, and shape selection.
- Add the guidance sentence next to `pathProfile`: **reach for `pathProfile` when the geometry is computed from parameters, and an authored vector file when it is drawn.** Cross-link both ways.
- Note that `k.shape2d` does **not** accept the JSON dialect, and that there is no inline document form.
- The lint catalogue near the end gains `vector-unknown-shape` and notes that it and `vector-size-missing` need the caller to pass `vectorDocs`.

- [ ] **Step 3: Update `docs/ERROR-PATTERNS.md`**

Keep the `svg-overlapping-subpaths` entry and its id — it names an SVG ingest symptom that has not changed. Update every other vector entry's literal error text to the `vector2d:` prefix, and add entries for the new failures, one `##` each, symptom → cause → fix:

- `has no valid \`units\`` — the file predates `units`, or was authored without it.
- `has a "regions" array, which this build does not read` — a stale pre-`shapes` draft.
- `has "kind": "rect" with radius … exceeds the maximum …` — a corner radius past half the shorter side.
- `has no shape "…" — it declares: …` — a `{ shape }` typo.
- `pass only one of width, height, or fit` — two size options.
- **A symptom entry with no error text at all:** an authored `units: "mm"` file whose shapes come out mis-scaled relative to each other, because a size option was passed per call and each shape scaled against its own bounds. This is the mistake Task 7's build comment guards against, and it produces wrong geometry rather than an error, so it needs a symptom-keyed entry more than any of the above.

Run `npx vitest run test/error-patterns.test.js` — it reads this file and will fail on a malformed entry.

- [ ] **Step 4: Update `AGENTS.md` and `docs/KERNEL-CONTRACT.md`**

- `AGENTS.md`: the `src/parts/` inventory line for `emblem.js` becomes "the `k.vector2d` reference part — ingested vector art embossed on an authored millimetre plate, exercising both units modes, named shapes, and all four contour kinds." Update the `src/framework/ingest/` paragraph to say it produces `partforge-vector` JSON that `k.vector2d` reads.
- `docs/KERNEL-CONTRACT.md`: rename the `svg2d` op entry to `vector2d` and note that primitive contours expand at the format boundary, so the op's kernel-facing contract is unchanged. `test/kernel-contract.test.js` holds the op coverage to the code — run it.

- [ ] **Step 5: Verify the whole tree**

Run: `npm test && npx partforge lint src/parts/emblem.js && npx partforge measure src/parts/emblem.js && npm run check`
Expected: all pass.

Run: `grep -rn "svg2d\|svgs:" src test types bin docs AGENTS.md`
Expected: no matches at all — Task 1 left `docs/VECTOR-FORMAT.md` as the one exception, and this task removed it.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: rewrite VECTOR-FORMAT for authored contours; correct the winding rule"
```

---

## Final check before handing back

- [ ] `package.json` says `0.93.0`. Without it the merge publishes nothing.
- [ ] `npm test` green; `npm run check` green.
- [ ] `npx partforge lint|measure src/parts/emblem.js` exit 0.
- [ ] The emblem fixture regenerates byte-identically:
      `node scripts/ingest-svg.mjs src/parts/assets/emblem.svg | diff - src/parts/assets/emblem.vector.json`
      (allowing for the trailing newline the test accounts for).
- [ ] `test/worker-layering.test.js` and `test/lint-purity.test.js` pass **unmodified**.
- [ ] PR #183's description updated: it now ships authored contours, not only SVG import.
