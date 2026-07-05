# Error-Pattern Library (issue #28) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **EXECUTED 2026-07-04 — do not re-execute.** Historical record only. Final review
> corrected two claims embedded below (commit c13cc45): the production build compiles
> every page in `build.rollupOptions.input` (five today), NOT "index.html only"; and
> `boolean-not-watertight`'s Fix cites § "Verifying a part headlessly (render + measure)",
> not § "Testing a part". The shipped `docs/ERROR-PATTERNS.md` is authoritative over the
> entry texts embedded in this plan.

**Goal:** Create `docs/ERROR-PATTERNS.md` — a symptom-indexed error→solution lookup with stable pattern IDs — wire it into the agent-facing docs, and guard its format with a lint test.

**Architecture:** Plain Markdown, one pattern per `##` heading whose text is a permanent kebab-case ID; a vitest parses the file and enforces the entry shape. Core patterns are bare slugs; the `hardware-*` prefix is reserved for issue #30. Spec: `docs/superpowers/specs/2026-07-04-error-patterns-design.md`.

**Tech Stack:** Markdown, vitest (Node 24 — run `nvm use` before any npm/npx command).

## Global Constraints

- Node 24 required: `nvm use` before `npm`/`npx` commands or they fail confusingly.
- Pattern IDs are permanent once committed — never rename or reuse one.
- Symptom lines carry the literal error string verbatim in backticks where one exists.
- Entry shape is exactly three labeled list lines — Symptom, Cause, Fix — in that order; optional plain note paragraphs may follow.
- Cause is one sentence. Fix links the governing AUTHORING-PARTS.md section instead of restating the rule.
- No tables inside pattern entries.
- Every symptom claim must be verified against source before committing (source refs are given per entry; if the source contradicts the entry text, fix the entry and note it in the commit message).
- This repo commits directly to `main`; keep the commit granularity of this plan.

---

### Task 1: Format-lint test + ERROR-PATTERNS.md skeleton

**Files:**
- Create: `test/error-patterns.test.js`
- Create: `docs/ERROR-PATTERNS.md`

**Interfaces:**
- Produces: `docs/ERROR-PATTERNS.md` with the preamble contract and the first entry (`worker-imports-main-entry`). Tasks 2–3 append entries to its "Core framework" section; Task 4 links to it from three docs.
- Produces: `test/error-patterns.test.js`, which every later task re-runs after editing the doc.

- [ ] **Step 1: Write the failing lint test**

Create `test/error-patterns.test.js`:

```js
// Format lint for docs/ERROR-PATTERNS.md — the symptom-indexed error→pattern
// library (issue #28). External consumers (issue #27 diagnostics, HARDWARE.md)
// cite entries as ERROR-PATTERNS.md#<id>, so this test keeps the contract honest:
// stable kebab-case IDs, uniform Symptom/Cause/Fix shape.
import { readFileSync } from "node:fs";
import { describe, test, expect } from "vitest";

const doc = readFileSync(new URL("../docs/ERROR-PATTERNS.md", import.meta.url), "utf8");

// An entry = a `## <id>` heading plus everything until the next heading (any level).
function parseEntries(md) {
  const entries = [];
  const re = /^## (.+)$/gm;
  let m;
  const marks = [];
  while ((m = re.exec(md)) !== null) marks.push({ id: m[1], start: m.index + m[0].length });
  for (let i = 0; i < marks.length; i++) {
    const end = md.slice(marks[i].start).search(/^#{1,2} /m);
    const body = end === -1 ? md.slice(marks[i].start) : md.slice(marks[i].start, marks[i].start + end);
    entries.push({ id: marks[i].id, body });
  }
  return entries;
}

const entries = parseEntries(doc);

describe("ERROR-PATTERNS.md format contract", () => {
  test("has at least 15 patterns", () => {
    expect(entries.length).toBeGreaterThanOrEqual(15);
  });

  test("every heading is a kebab-case ID", () => {
    for (const e of entries) expect(e.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test("IDs are unique", () => {
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every entry has Symptom, Cause, Fix lines in order, non-empty", () => {
    for (const e of entries) {
      const iS = e.body.indexOf("- **Symptom:**");
      const iC = e.body.indexOf("- **Cause:**");
      const iF = e.body.indexOf("- **Fix:**");
      expect(iS, `${e.id}: missing Symptom`).toBeGreaterThanOrEqual(0);
      expect(iC, `${e.id}: missing Cause`).toBeGreaterThan(iS);
      expect(iF, `${e.id}: missing Fix`).toBeGreaterThan(iC);
      for (const [label, i] of [["Symptom", iS], ["Cause", iC], ["Fix", iF]]) {
        const line = e.body.slice(i).split("\n")[0];
        expect(line.replace(/- \*\*\w+:\*\*/, "").trim().length,
          `${e.id}: empty ${label} line`).toBeGreaterThan(0);
      }
    }
  });

  test("non-core patterns are namespaced with a known prefix", () => {
    // Core patterns are bare slugs; subsystem patterns must use a reserved prefix.
    // Today only hardware-* is reserved (issue #30). Extend this list, never repurpose.
    const reserved = ["hardware"];
    for (const e of entries) {
      const prefix = e.id.split("-")[0];
      if (reserved.includes(prefix)) {
        expect(e.id.startsWith(`${prefix}-`)).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nvm use && npx vitest run test/error-patterns.test.js`
Expected: FAIL — `ENOENT: no such file or directory` reading `docs/ERROR-PATTERNS.md` (the readFileSync throws at collection time).

- [ ] **Step 3: Create the skeleton with preamble + first entry**

Create `docs/ERROR-PATTERNS.md`. (Only one entry now, so the ≥15 test still fails — that gate goes green in Task 3; every other test must pass after this step.)

```markdown
# Error patterns — symptom-indexed lookup

When a build, test, `measure`, or `verify` run fails confusingly: **grep this file
for the symptom first** — the literal error text, or a phrase describing the
misbehavior — before debugging from scratch.

**How to add a pattern** (`##` headings are reserved for pattern entries — the lint
test parses every one; keep prose like this as plain paragraphs):

- One pattern per `## <id>` heading. The heading is a **stable kebab-case ID**:
  permanent once committed — never renamed, never reused. External consumers
  (issue #27 diagnostics, HARDWARE.md, skills) cite `ERROR-PATTERNS.md#<id>`.
- **Namespaces:** core framework patterns are bare slugs. Subsystem patterns take
  a reserved prefix — `hardware-*` is reserved for the parts library (issue #30).
  One `#`-level section per namespace.
- Entry shape — exactly these three list lines, then optional note paragraphs:
  - **Symptom:** the literal string an agent would see, verbatim in backticks,
    when one exists; otherwise the observable misbehavior. This is the grep target.
  - **Cause:** one sentence.
  - **Fix:** the concrete change, linking the governing rule
    ([AUTHORING-PARTS.md](AUTHORING-PARTS.md) section) rather than restating it.
- No tables inside entries.
- Code that throws should throw greppable strings: an error message thrown by
  partforge should appear verbatim, in backticks, within its pattern's Symptom line.
- `test/error-patterns.test.js` lints this file's structure.

# Core framework

## worker-imports-main-entry

- **Symptom:** `ReferenceError: document is not defined` thrown from a worker build.
- **Cause:** The part (or a helper it imports) imports `partforge` instead of `partforge/geometry`, and the main entry pulls in the DOM viewer/controls.
- **Fix:** Import geometry helpers only from `partforge/geometry` in anything a worker loads. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Geometry: the kernel / `Solid` API".

# Hardware library

Reserved for `hardware-*` patterns (issue #30). No entries yet.
```

- [ ] **Step 4: Run the test — everything except the count gate passes**

Run: `npx vitest run test/error-patterns.test.js`
Expected: 4 of 5 tests PASS; "has at least 15 patterns" FAILS with `expected 1 to be greater than or equal to 15`. (The parser treats `# Core framework` as a section break, not an entry — verify the passing tests prove that.)

- [ ] **Step 5: Commit**

```bash
git add test/error-patterns.test.js docs/ERROR-PATTERNS.md
git commit -m "docs: ERROR-PATTERNS.md skeleton + format-lint test (#28)"
```

---

### Task 2: Seed the 10 core patterns from the issue body

**Files:**
- Modify: `docs/ERROR-PATTERNS.md` (append to the "Core framework" section, before "# Hardware library")

**Interfaces:**
- Consumes: the skeleton and entry shape from Task 1 (`worker-imports-main-entry` already exists — do not duplicate it; this task adds the other 9 of the issue's 10).
- Produces: pattern IDs `impure-build-stale-preview`, `replicad-consumed-operand`, `probe-routed-to-occt`, `boolean-not-watertight`, `dual-kernel-same-process`, `view-dependent-display-place`, `wrong-node-version`, `worker-url-not-inline`, `minwall-sliver-triangles` — cited by Task 4's doc edits.

- [ ] **Step 1: Verify each symptom claim against source**

Check each reference below; where behavior differs from the entry text in Step 2, correct the entry:

- `src/framework/geometry/solid-cache.js` / AUTHORING-PARTS.md § "Caching & determinism" — content-hash memoization (entry 2).
- OCCT transform consumption: `src/framework/geometry/occt-backend.js` (transforms delete the operand; `.clone()` is the escape) (entry 3).
- `src/framework/geometry/probe.js` + `kernel.js:32` — probe routes to OCCT when `build` *references* a CAD-only op, even in a dead branch (entry 4).
- `bin/cli.js:115` — the exact strings `NOT watertight ✗` and `watertight n/a` (entries 5 and Task 3's `occt-holes-watertight-na`).
- `test/occt-backend.test.js` + CLAUDE.md invariant — OCCT/Manifold same-process crash mode (entry 6). Run the crash if cheap: a scratch test file booting both kernels; otherwise cite the invariant.
- `src/framework/mesh-cache.js` / AUTHORING-PARTS.md § the `place` rule — display meshes cached across views (entry 7).
- `.nvmrc` — pins Node 24 (entry 8).
- AUTHORING-PARTS.md § "Wiring a part into a runnable app" — inline `new Worker(new URL(...))` requirement (entry 9).
- `src/testing/min-wall.js` + `src/testing/verify.js:16` — minWall is `kind: "warn"`, never gates; `bin/cli.js:131` renders it with `⚠` (entry 10).

- [ ] **Step 2: Append the 9 entries**

Append to `docs/ERROR-PATTERNS.md` inside "# Core framework" (after `worker-imports-main-entry`):

```markdown
## impure-build-stale-preview

- **Symptom:** Preview geometry doesn't change after editing the part's `build` (or changes once, then sticks), with no error anywhere.
- **Cause:** The preview kernel memoizes geometry by content hash, and an impure `build` (`Math.random`, clock, module-level mutable state) silently defeats it.
- **Fix:** Make `build` a pure function of `(k, p, d)`; move randomness/state into `derive` inputs or delete it. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Caching & determinism".

## replicad-consumed-operand

- **Symptom:** On the OCCT backend a solid is unexpectedly empty, or the build crashes, right after the same solid was transformed or used in a boolean — often only in STEP export, with the Manifold preview fine.
- **Cause:** replicad transforms and booleans (`translate`/`rotate`/`mirror`/`cut`/…) consume their operand — the input solid is deleted and a new one returned.
- **Fix:** Never reuse a solid after transforming it; take a `.clone()` first when you need the original again. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Conventions & gotchas".

## probe-routed-to-occt

- **Symptom:** A part builds far slower than expected (preview takes seconds instead of milliseconds), and the worker logs show it running on the `occt` worker.
- **Cause:** The geometry-free probe found a CAD-only op (`fillet`/`chamfer`/`shell`) referenced in `build` — even in a dead or conditional branch — and routed the whole part to OCCT.
- **Fix:** Remove the unused CAD-only call, or force the backend with `meta.backend: "manifold"` (or `"occt"`). See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Fillet & chamfer (automatic OCCT backend)".

## boolean-not-watertight

- **Symptom:** `NOT watertight ✗` from `partforge measure` (non-zero exit) after adding a boolean cut or union.
- **Cause:** A coplanar-face or grazing-cut degeneracy — the tool surface exactly touches the body surface, leaving zero-thickness geometry.
- **Fix:** Overcut: extend the tool past the faces it pierces (e.g. the demo's cut tool is `h + 4` starting at `z = -2`) and avoid exactly-flush faces in unions. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Testing a part".

## dual-kernel-same-process

- **Symptom:** A test file crashes or hangs (WASM abort) when it boots both geometry kernels.
- **Cause:** OCCT and Manifold WASM must not boot in the same process.
- **Fix:** Keep OCCT-booting tests in their own files (vitest isolates per file) and boot via `bootOcctKernel()` in a `beforeAll`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Testing a part".

## view-dependent-display-place

- **Symptom:** A sub-part renders correctly in one view but appears misplaced (usually in its other-view pose) after switching views.
- **Cause:** A `place` that depends on `ctx.view` for `purpose: "display"` — display meshes are built once per sub-part and cached across views.
- **Fix:** Make display placement view-independent; only `place(..., { purpose: "export" })` may branch on `view`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "The `PartDefinition` contract".

## wrong-node-version

- **Symptom:** Confusing failures during `npm install`, tests, or CLI runs — WASM load errors, syntax errors in dependencies, or kernels that never boot — on a machine that built fine before.
- **Cause:** The shell's default Node is older than the required Node 24 (`.nvmrc` pins it).
- **Fix:** Run `nvm use` before `npm install`, tests, or any `npx partforge` command. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Quickstart".

## worker-url-not-inline

- **Symptom:** The app loads but geometry never builds — the worker 404s or is missing from the production bundle (works in `npm run dev`, breaks in `npm run build`).
- **Cause:** The `new Worker(new URL(...))` call was moved out of the app entry file (into a helper or variable), so Vite's static analysis can't see and bundle the worker.
- **Fix:** Keep `new Worker(new URL("./<part>-worker.js", import.meta.url), ...)` inline in `src/app-<part>.js`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Wiring a part into a runnable app".

## minwall-sliver-triangles

- **Symptom:** `⚠` minWall warnings from `verify` on a faceted part whose walls are clearly thicker than the profile minimum.
- **Cause:** The ray-shot wall-thickness measurement can catch sliver triangles at facet seams, reading a near-zero "wall" that isn't a designed wall.
- **Fix:** Check where the reported thin spot is: at a facet seam or chamfer transition it's a sliver artifact (minWall is a warning, never a gate — safe to note and move on); along a real wall, thicken the wall. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Self-verification (the `verify` block)".
```

- [ ] **Step 3: Run the lint test**

Run: `npx vitest run test/error-patterns.test.js`
Expected: 4 of 5 PASS; the count gate still FAILS (`expected 10 to be greater than or equal to 15`).

- [ ] **Step 4: Commit**

```bash
git add docs/ERROR-PATTERNS.md
git commit -m "docs: seed the 10 core error patterns from issue #28"
```

---

### Task 3: Add the 9 mined patterns

**Files:**
- Modify: `docs/ERROR-PATTERNS.md` (append to "Core framework")

**Interfaces:**
- Consumes: entry shape from Task 1.
- Produces: pattern IDs `param-key-missing-from-defaults`, `dimmed-control-vestigial-param`, `linked-checkout-wasm-403`, `ring-sector-full-circle`, `occt-closed-loop-unsupported`, `smooth-geometry-faceted-preview`, `scale-moved-the-part`, `occt-holes-watertight-na`, `html-page-missing-in-prod`. After this task the count gate passes (19 entries).

- [ ] **Step 1: Verify each symptom claim against source**

- `src/framework/controls.js` — what actually happens when a schema `key` is absent from `defaults` (control renders with `undefined`? throws?). **Adjust the Symptom line of `param-key-missing-from-defaults` to the observed behavior** — reproduce by temporarily deleting a key from `src/parts/demo.js` defaults and loading `/demo.html` (or find the code path in `controls.js`).
- `src/framework/param-deps.js` — dimming semantics (entry 2).
- AUTHORING-PARTS.md § "Developing against a local (linked) partforge" — 403/`server.fs.allow` (entry 3).
- `src/framework/geometry/polygon.js:91` — verbatim: `ringSectorPolygon: arcDeg must be < 360 (use a cut for a full ring)` (entry 4).
- `src/framework/geometry/occt-backend.js:136,159` — verbatim: `loft: closed:true loops are only supported on the Manifold backend` and `sweep: closed:true loops are only supported on the Manifold backend` (entry 5).
- `src/framework/geometry/loft.js:51` — `ruled:false` honoured only by OCCT (entry 6).
- `src/framework/geometry/solid-sugar.js:41-43` — `scale(factor, center = ORIGIN)` (entry 7).
- `bin/cli.js:115` — `watertight n/a`; `src/testing/verify.js:11` — `manifoldOnly: true` skip (entry 8).
- `vite.config.js` — production input is `index.html` only (entry 9).

- [ ] **Step 2: Append the 9 entries**

Append inside "# Core framework":

```markdown
## param-key-missing-from-defaults

- **Symptom:** A control panel section renders broken or a control shows an empty/`undefined` value, or edits to a control do nothing to the geometry.
- **Cause:** A `key` used in the `parameters` schema (slider, feature, or preset override) doesn't exist in `defaults` — every key must, including `hidden` ones.
- **Fix:** Add the key to `defaults` with a sensible starting value. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Parameters: the control-panel schema".

## dimmed-control-vestigial-param

- **Symptom:** A control renders dimmed (but still editable) and changing it does nothing on screen.
- **Cause:** No sub-part visible in the active view reads that parameter — the relevance-aware panel dims controls with no on-screen effect.
- **Fix:** This is a signal, not a bug: either the parameter is vestigial (delete it), the control is in the wrong section/view scope, or you're in a view that legitimately doesn't use it. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "The relevance-aware panel".

## linked-checkout-wasm-403

- **Symptom:** In a consuming app using an `npm link`ed partforge checkout, the kernel never boots and the dev-server network tab shows `403` on the Manifold/OCCT `.wasm` files.
- **Cause:** The linked checkout lives outside the app's project root, so Vite's dev server refuses to serve its files.
- **Fix:** Allow-list it: `server: { fs: { allow: ["./", "../partforge"] } }` in the app's `vite.config.js`. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Developing against a local (linked) partforge".

## ring-sector-full-circle

- **Symptom:** `ringSectorPolygon: arcDeg must be < 360 (use a cut for a full ring)`
- **Cause:** A full annulus can't be a single simple polygon — it's a contour-with-hole.
- **Fix:** Cut an inner cylinder from an outer one (or `k.extrude({ outer, holes })`); use `ringSectorPolygon` only for partial arcs. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Profiles & patterns".

## occt-closed-loop-unsupported

- **Symptom:** `loft: closed:true loops are only supported on the Manifold backend` (or the same message from `sweep:`) — typically during STEP export of a part that previews fine.
- **Cause:** Capless closed loops are a Manifold-only capability; the OCCT backend rejects them, and STEP export always runs on OCCT.
- **Fix:** Keep the part on Manifold (no STEP) or model the loop as a capped solid both backends support. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Geometry: the kernel / `Solid` API".

## smooth-geometry-faceted-preview

- **Symptom:** A `ruled:false` loft or `smooth:true` sweep looks faceted/straight-walled in the viewer even though the options are set.
- **Cause:** Smooth blending is OCCT-native; the Manifold preview always tessellates ruled straight walls — only STEP export carries the smooth surface.
- **Fix:** Nothing is wrong — verify smoothness in the exported STEP, not the preview. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Geometry: the kernel / `Solid` API".

## scale-moved-the-part

- **Symptom:** After `s.scale(f)` a part is resized but also relocated — features drift away from where they were built.
- **Cause:** `scale(factor, center?)` defaults its center to the origin, so scaling an off-origin solid about the origin also translates it.
- **Fix:** Pass the center you mean, e.g. `s.scale(f, s.boundingBox().center)` to resize in place. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Geometry: the kernel / `Solid` API".

## occt-holes-watertight-na

- **Symptom:** `watertight n/a` in `partforge measure` output, and `holes`/`watertight` assertions in a `verify` block don't run, on a part with fillets/chamfers.
- **Cause:** `holes` and `watertight` are Manifold-only topology facts, and this part auto-routed to OCCT — the assertions skip rather than fail.
- **Fix:** Expected behavior: assert on backend-independent facts (`bbox`, `volume`, `overlaps`) for OCCT parts, or split topology assertions into a Manifold-buildable configuration. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Self-verification (the `verify` block)".

## html-page-missing-in-prod

- **Symptom:** A part's page 404s in the production deploy while working fine under `npm run dev`.
- **Cause:** The production build compiles `index.html` only — extra root `*.html` part pages are dev-only conveniences Vite serves without building.
- **Fix:** Add the page to `build.rollupOptions.input` in `vite.config.js` if it should ship. See [AUTHORING-PARTS.md](AUTHORING-PARTS.md) § "Wiring a part into a runnable app".
```

- [ ] **Step 3: Run the lint test — all gates pass now**

Run: `npx vitest run test/error-patterns.test.js`
Expected: all 5 tests PASS (19 entries ≥ 15).

- [ ] **Step 4: Commit**

```bash
git add docs/ERROR-PATTERNS.md
git commit -m "docs: add 9 mined error patterns (panel, vite, backend-capability footguns)"
```

---

### Task 4: Wire the pattern library into the agent surface

**Files:**
- Modify: `CLAUDE.md` (the "Non-obvious invariants" section, line ~78)
- Modify: `skills/partforge/SKILL.md` (append a note)
- Modify: `docs/AUTHORING-PARTS.md` (the "Conventions & gotchas" section, line ~622)

**Interfaces:**
- Consumes: pattern IDs from Tasks 1–3 (exact IDs listed there).
- Produces: the three cross-references issue #28's acceptance requires.

- [ ] **Step 1: Add the grep-first rule to CLAUDE.md**

In `CLAUDE.md`, change the section heading paragraph:

```markdown
### Non-obvious invariants (these bite if violated)
```

to:

```markdown
### Non-obvious invariants (these bite if violated)

**On any build/measure/test failure, grep `docs/ERROR-PATTERNS.md` for the symptom
first** — it maps literal error text / misbehavior → cause → fix, one `##` per pattern.
```

- [ ] **Step 2: Add the pointer note to the skill**

Append to `skills/partforge/SKILL.md` (after the "## Notes" section):

```markdown
## Related: debugging failures

If a build, test, or `measure` run fails while you're working on a part, grep
`docs/ERROR-PATTERNS.md` for the symptom (literal error text) before debugging —
it's the symptom-indexed cause→fix lookup for the whole framework.
```

- [ ] **Step 3: Slim AUTHORING-PARTS.md gotchas to link pattern IDs**

In `docs/AUTHORING-PARTS.md`, replace the "## Conventions & gotchas" section body (the six bullets, lines ~624–638, ending just before the `---` above "## Interactive clarification") with:

```markdown
When something fails confusingly, **grep [ERROR-PATTERNS.md](ERROR-PATTERNS.md) for the
symptom first** — it maps error text → cause → fix. The invariants, one line each:

- **replicad (OCCT) transforms consume their input** — never reuse a transformed solid;
  `.clone()` first ([replicad-consumed-operand](ERROR-PATTERNS.md#replicad-consumed-operand)).
- **Part modules are DOM-free and side-effect-free** — they load in both the main thread
  and the worker ([worker-imports-main-entry](ERROR-PATTERNS.md#worker-imports-main-entry)).
- **`build` is a pure function of `(k, p, d)`** — impurity silently defeats the geometry
  cache ([impure-build-stale-preview](ERROR-PATTERNS.md#impure-build-stale-preview)).
- **Units are millimetres** throughout.
- **Preview vs print quality:** builds are quality-agnostic; the export path uses a
  separate high-res kernel.
- **Display placement is view-independent**; only `place(..., { purpose: "export" })` may
  depend on `view` ([view-dependent-display-place](ERROR-PATTERNS.md#view-dependent-display-place)).
- **Keep geometry backend-agnostic** (kernel calls only); only STEP requires OCCT
  ([probe-routed-to-occt](ERROR-PATTERNS.md#probe-routed-to-occt),
  [occt-holes-watertight-na](ERROR-PATTERNS.md#occt-holes-watertight-na)).
```

Keep the section heading and the surrounding `---` separators untouched.

- [ ] **Step 4: Verify links and run the suite**

Run: `grep -o "ERROR-PATTERNS.md#[a-z-]*" docs/AUTHORING-PARTS.md | sort -u` and confirm every cited anchor exists as a `## ` heading in `docs/ERROR-PATTERNS.md`.
Run: `npx vitest run test/error-patterns.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md skills/partforge/SKILL.md docs/AUTHORING-PARTS.md
git commit -m "docs: wire ERROR-PATTERNS.md into CLAUDE.md, skill, and authoring guide (#28)"
```

---

### Task 5: Acceptance check against issue #28

**Files:**
- None (verification only; fix-forward if anything fails).

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Run the full test suite**

Run: `nvm use && npm test`
Expected: all files pass, including `test/error-patterns.test.js`. (If an unrelated test was already failing before this work, note it; don't fix it here.)

- [ ] **Step 2: Walk the issue's acceptance list**

- `docs/ERROR-PATTERNS.md` exists with ≥15 patterns in the uniform shape — `grep -c "^## " docs/ERROR-PATTERNS.md` reports ≥15 (expected: 19).
- Each Symptom line contains the literal string where one exists — spot-check `ring-sector-full-circle` and `occt-closed-loop-unsupported` against `src/framework/geometry/polygon.js:91` and `occt-backend.js:136`.
- SKILL.md and AUTHORING-PARTS.md reference it; CLAUDE.md carries the grep-first rule — `grep -l "ERROR-PATTERNS" CLAUDE.md skills/partforge/SKILL.md docs/AUTHORING-PARTS.md` lists all three.

- [ ] **Step 3: Comment on the issue**

If the change lands via a PR whose description says `Closes #28`, skip this — the PR
body already tells the story. Otherwise comment in plain language (per the PR-tone
preference in the user CLAUDE.md), e.g.:

```bash
gh issue comment 28 --repo scottsykora/partforge --body "Done — the repo now has a grep-first error lookup: docs/ERROR-PATTERNS.md maps the error text you actually see to what went wrong and how to fix it (19 entries to start). The debugging docs point there instead of repeating themselves, and a small test keeps the entries consistently shaped. Conventions for adding patterns (and the reserved hardware-* namespace for #30) are in the file's intro."
```

Then close it: `gh issue close 28 --repo scottsykora/partforge`
