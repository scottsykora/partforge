# Authoring-Guidance Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document the `description`/`hidden` schema fields and how to design a good control panel (procedural/`derive` linking, progressive disclosure, descriptions, the relevance behavior), and upgrade `demo.js` into the living worked example.

**Architecture:** Docs + one example part — no framework code changes. Task 1 upgrades `src/parts/demo.js` (descriptions, a `hidden` internal param, a `derive`-driven link) and verifies it still builds soundly. Task 2 extends `AUTHORING-PARTS.md` with the schema-field docs and a new "Designing the control panel" section that references the upgraded demo.

**Tech Stack:** Markdown docs, a partforge PartDefinition (`demo.js`), Vitest + Manifold (build-soundness guard), Node 24.

## Global Constraints

- **Node 24 for tests** (`nvm use` first).
- **No framework/runtime code changes** — only `src/parts/demo.js`, `docs/AUTHORING-PARTS.md`, and (optionally) `README.md`. Do NOT touch controls.js / param-deps.js / markdown.js / mount.js / app.css.
- **Docs must match shipped behavior:** `description` is CommonMark rendered (marked + DOMPurify) in a **click-open** info-glyph popover (not hover-only); links open in a new tab; content is sanitized. `hidden: true` omits a control/feature/section from the panel but its `key` stays in `defaults` and still drives geometry. Relevance (A) is **automatic**: sections hide and controls dim when they don't affect the active view's on-screen parts.
- **`demo.js` must stay a sound part:** watertight, genus 1 (one bore), builds on Manifold.
- Commit messages follow repo convention; end with the `Co-Authored-By:`/`Claude-Session:` trailers.

---

## Task 1: Upgrade `demo.js` into the living example

Retrofit the spacer to demonstrate descriptions, a `hidden` internal constant, and a `derive`-driven dimension — while staying a valid part.

**Files:**
- Modify: `src/parts/demo.js` (full replacement of the default export)
- Test: `test/demo-part.test.js` (create — a build-soundness guard)

**Interfaces:**
- Produces: the upgraded `demo.js` PartDefinition. `derive(p) => { boreR, cutH }`; `build(k, p, d)` reads `p.od`, `p.flange_d`, `p.flange_h`, and `d.boreR`/`d.cutH`. `defaults` includes `flange_h: 2`. A control def with `hidden: true` (the `flange_h` control) and `description` strings on sections/controls/feature.

- [ ] **Step 1: Write the build-soundness guard test**

Create `test/demo-part.test.js` (boots Manifold only; guards that the new `derive`/`hidden`/`build(k,p,d)` wiring produces a valid solid):

```js
import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import part from "../src/parts/demo.js";

let k;
beforeAll(async () => { const w = await Module(); w.setup(); k = createManifoldKernel(w, { quality: "preview" }); });

const buildSpacer = (overrides = {}) => {
  const p = { ...part.defaults, ...overrides };
  const d = part.derive ? part.derive(p) : {};
  return part.parts.spacer.build(k, p, d);
};

test("demo derive feeds build: spacer meshes and has exactly one through-bore", () => {
  const s = buildSpacer();
  expect(s.toMesh().triangles).toBeGreaterThan(0);
  expect(s.genus()).toBe(1);                 // the bore
  expect(s.volume()).toBeGreaterThan(0);
});

test("flange_h is a defaulted param the build consumes when the flange is on", () => {
  expect(part.defaults.flange_h).toBeGreaterThan(0);   // present in defaults (hidden control)
  const s = buildSpacer({ flange_d: 16 });
  expect(s.volume()).toBeGreaterThan(buildSpacer({ flange_d: 0 }).volume()); // flange adds material
});

test("derive applies a print clearance: bore hole is wider than the nominal bore", () => {
  const p = { ...part.defaults };
  const d = part.derive(p);
  expect(d.boreR).toBeCloseTo((p.bore + 0.2) / 2, 6);  // nominal + 0.2mm clearance, as radius
  expect(d.cutH).toBe(p.h + 4);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nvm use && npx vitest run test/demo-part.test.js`
Expected: FAIL — the current `demo.js` has no `derive` (so `d.boreR` is undefined → `toBeCloseTo` fails / build mismatch) and no `flange_h` default.

- [ ] **Step 3: Replace `src/parts/demo.js`**

Replace the entire file with:

```js
// Example PartDefinition — a parametric spacer. Doubles as the worked example for
// docs/AUTHORING-PARTS.md "Designing the control panel": a description on every
// control, a hidden internal constant, and a derive() that turns raw inputs into the
// dependent dimensions the build consumes. The framework (viewer, controls, workers,
// STL/STEP export) is reused unchanged.
export default {
  meta: { title: "Spacer", units: "mm", background: 0x15181d },
  parameters: [
    {
      id: "body",
      title: "Body",
      description: "The spacer barrel and its through-bore. Pick a preset for a common screw size, or open **Advanced** to set exact dimensions.",
      presets: { M3: { od: 8, bore: 3.4, h: 10 }, M5: { od: 12, bore: 5.4, h: 16 } },
      advanced: [
        { key: "od", label: "Outer diameter", unit: "mm", min: 4, max: 40, step: 0.5,
          description: "Barrel outer diameter. Keep it comfortably larger than the bore so a wall remains. See the [authoring guide](https://github.com/scottsykora/partforge/blob/main/docs/AUTHORING-PARTS.md)." },
        { key: "bore", label: "Bore", unit: "mm", min: 1, max: 30, step: 0.1, control: "number",
          description: "Nominal screw clearance hole. A fixed print clearance is added automatically (see `derive`), so enter the *nominal* size." },
        { key: "h", label: "Height", unit: "mm", min: 2, max: 60, step: 1,
          description: "Spacer length along the axis." },
        { key: "flange_h", label: "Flange thickness", unit: "mm", min: 1, max: 5, step: 0.5, hidden: true,
          description: "Internal: flange plate thickness, fixed by the design. Hidden from the end user, but still drives the geometry." },
      ],
    },
    {
      id: "flange",
      title: "Flange",
      description: "Optional base flange — a wider seating plate at one end.",
      features: [
        { label: "Base flange", key: "flange_d", on: 16,
          description: "Adds a `flange_h`-thick plate of this diameter at the base.",
          sliders: [{ key: "flange_d", label: "Flange diameter", unit: "mm", min: 8, max: 50, step: 1,
            description: "Outer diameter of the base flange." }] },
      ],
    },
  ],
  defaults: { od: 8, bore: 3.4, h: 10, flange_d: 0, flange_h: 2 },
  // derive(): turn raw inputs into the dependent dimensions the build needs, so one
  // input drives the geometry consistently — here the bore gains a fixed print
  // clearance and the cut tool is sized to pierce the whole part.
  derive: (p) => ({
    boreR: (p.bore + 0.2) / 2, // nominal bore + 0.2 mm print clearance, as a radius
    cutH: p.h + 4,             // through-cut tool, taller than the part
  }),
  parts: {
    spacer: {
      label: "Spacer",
      views: ["spacer"],
      export: { name: "spacer" },
      build: (k, p, d) => {
        let s = k.cylinder(p.od / 2, p.od / 2, p.h);
        if (p.flange_d > 0) s = k.union([s, k.cylinder(p.flange_d / 2, p.flange_d / 2, p.flange_h)]);
        return s.cut(k.cylinder(d.boreR, d.boreR, d.cutH).translate([0, 0, -2]));
      },
    },
  },
  views: { spacer: { label: "Spacer" } },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `nvm use && npx vitest run test/demo-part.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify the part is geometrically sound (measure)**

Run: `nvm use && npx partforge measure src/parts/demo.js`
Expected: exits 0; report shows the spacer watertight with `holes: 1` (the bore).

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `nvm use && npx vitest run`
Expected: PASS. (The pre-existing `test/cli-occt.test.js` parallel-run flake is unrelated; if it's the only failure, confirm `test/demo-part.test.js` passes in isolation and proceed.)

- [ ] **Step 7: App smoke (the upgraded demo boots, popover code path loads)**

If Playwright + Chromium are installed:
Run: `nvm use && node scripts/check-app.mjs demo.html`
Expected: booted, 0 console errors. (If not installed, skip and note it.)

- [ ] **Step 8: Commit**

```bash
git add src/parts/demo.js test/demo-part.test.js
git commit -m "feat: upgrade demo.js into the worked authoring example (descriptions, hidden, derive)"
```

---

## Task 2: Document descriptions, `hidden`, and control-panel design

Extend `AUTHORING-PARTS.md`. Docs-only; verified by accuracy review.

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (Parameters section + a new section after it)
- Modify: `README.md` (optional one-line pointer)

**Interfaces:** none (docs).

- [ ] **Step 1: Document `description` & `hidden` in the Parameters section**

In `docs/AUTHORING-PARTS.md`, find the line near the end of the "Parameters: the control-panel schema" section (currently):

```markdown
Every `key` used must exist in `defaults`. (The drum's schema is exported as `SECTIONS`
in `src/parts/drum/params.js` if you want a large reference.)
```

Replace it with (fixes the stale `drum` reference and adds the metadata docs):

```markdown
Every `key` used must exist in `defaults`. `src/parts/demo.js` is the worked example for
everything below.

**Control metadata (optional — on any control def, feature, or section):**

- `description` — a CommonMark string shown in a click-open **ⓘ** popover beside the
  label. Supports **bold/italic**, lists, `code`, links, and images (for diagrams);
  links open in a new tab and the rendered HTML is sanitized. Write one for every
  control — see "A description for every control" below.
- `hidden: true` — omits the control/feature/section from the panel. Its `key` must still
  exist in `defaults` and still drives the geometry: use it for internal constants the
  end user shouldn't edit (it is *no UI*, not *no parameter*). A section left with no
  presets and no visible controls doesn't render at all.

```js
advanced: [
  { key: "od", label: "Outer diameter", unit: "mm", min: 4, max: 40, step: 0.5,
    description: "Barrel OD. Keep it larger than the bore so a wall remains. See the [guide](https://example.com)." },
  { key: "wall_seg", min: 8, max: 256, step: 1, hidden: true,   // internal constant; no UI, still in defaults
    description: "Facet count — fixed by the design." },
],
```
```

- [ ] **Step 2: Add the "Designing the control panel" section**

In `docs/AUTHORING-PARTS.md`, immediately before the `## Profiles & patterns` heading, insert this new section:

```markdown
## Designing the control panel

A good part exposes a **simple** interface — a handful of controls most users will
touch — while still giving deep, correct adjustability underneath. `src/parts/demo.js`
is the worked example for the patterns below.

### Procedural & parametric parts

Drive many features from a few controls, so tweaking one control reshapes the part
coherently:

- **`derive(p) => d`** computes shared/dependent values once per build; sub-part `build`
  functions read `d`. Put the "design intent" math here — clearances, ratios, wall
  thicknesses — so a single input feeds everything downstream. In the demo, `derive`
  turns the nominal `bore` into `boreR` (with a fixed print clearance) and `h` into the
  cut-tool height `cutH`; `build(k, p, d)` reads those.
- **Reuse a param `key`** across sub-parts/features so one slider moves all of them.
- **`enabled(p)`** gates a whole sub-part on a toggle param (the part appears/disappears
  with the control).

### Progressive disclosure (simple, but deep)

Tier the controls so the default view is uncluttered:

1. **Presets** for the common cases — the first thing most users pick.
2. A **few primary sliders** for the dimensions users change most.
3. **`Advanced`** (the collapsible block) for the rest.
4. **`hidden`** for internal constants the end user shouldn't edit.

Aim for a panel with a few visible controls that still exposes the full design when
someone opens Advanced.

### A description for every control

Give every section and control a `description`. Keep each one short and make it cover:

- **what** the control does,
- its **units**,
- a **sensible range** (and what's typical),
- **when it matters** (what it interacts with).

Use Markdown links or images for diagrams and deeper reference. These are the tooltips
end users rely on — treat writing them as part of authoring the control, not an
afterthought.

### The relevance-aware panel

The panel updates itself to match what's on screen: a **section is hidden** when none of
its controls affect the active view's visible parts, and a **control is dimmed** (but
still usable) when it doesn't currently affect them — recomputed as the view and the
parameters change. You don't wire this up; it's automatic. To get the most from it:

- Group controls into **sections by the sub-parts they affect**, so whole sections drop
  away in views that don't use them.
- Scope a parameter to the **views/sub-parts that read it** — a control read by no
  on-screen part shows dimmed, which is a useful signal that it's vestigial or
  misplaced.
```

- [ ] **Step 3: (Optional) Add a README pointer**

In `README.md`, in the "Authoring guide" blurb, you may add one sentence pointing at the
new section, e.g. after the existing AUTHORING-PARTS.md link:

```markdown
See **Designing the control panel** in that guide for how to write descriptions, hide
internal params, and keep the interface simple while staying deeply adjustable.
```

(Skip if it doesn't read cleanly; it's not required.)

- [ ] **Step 4: Verify the docs render and are internally consistent**

Run: `nvm use && npx vitest run`
Expected: PASS (docs don't affect tests; this confirms nothing else broke). Visually skim
the edited Markdown: code fences balanced, links well-formed, no broken headings.

- [ ] **Step 5: Commit**

```bash
git add docs/AUTHORING-PARTS.md README.md
git commit -m "docs: document description/hidden + a Designing the control panel guide"
```

---

## Self-review notes

- **Spec coverage:** `description`/`hidden` documented (Task 2 Step 1); "Designing the control panel" with procedural/`derive`, progressive disclosure, description-recipe, and relevance behavior (Task 2 Step 2); demo.js upgraded with descriptions + `hidden` + `derive` link (Task 1); README pointer optional (Task 2 Step 3); verification via guard test + measure + smoke + suite (Task 1) and accuracy skim (Task 2). All spec sections covered.
- **Placeholder scan:** none — full demo.js, full Markdown blocks, and test code provided.
- **Type/behavior consistency:** docs describe the click-popover + sanitized Markdown + `hidden`-keeps-param + automatic relevance exactly as shipped in B/A; demo's `derive` shape `{ boreR, cutH }` matches the test and the build's reads. No framework files touched.
- **Accuracy fix:** the stale `src/parts/drum/params.js` reference (drum isn't in this repo) is replaced with a pointer to `demo.js`.
