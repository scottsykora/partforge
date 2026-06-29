# Faceted Planter demo + GitHub Pages showcase — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the already-built Faceted Planter demo part (and the `prism` fix it surfaced), then publish all three example apps as a live, auto-deploying GitHub Pages showcase with a landing gallery.

**Architecture:** The planter is a Manifold-backend part (prism body + in-phase clipped cavity) wired with the same four-file pattern as the existing Spacer. Deployment turns the Vite dev harness into a multi-page build (landing `index.html` + three demo pages) served under the repo's Pages subpath, deployed by a workflow mirroring the sibling Drum-Machine repo.

**Tech Stack:** Node 24, Vite 8, Manifold (manifold-3d), Playwright (smoke check), GitHub Actions Pages.

## Global Constraints

- **Node ≥ 24** — always run npm/node via nvm: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use` (the repo `.nvmrc` pins `24.16.0`).
- **This repo is `scottsykora/partforge`** — a nested independent git repo. All commits here go to partforge, NOT to the parent Robot KB repo.
- **Planter stays Manifold-only** — no fillet/chamfer (those auto-route to OCCT). Body/cavity use `prism`, `cut`, `intersect`, `box`, `cylinder` only.
- **Pages base path is `/partforge/`** and must apply to the **build only**, never to `npm run dev`.
- **The showcase is the dev harness, not the shipped package** — do NOT add `index.html` or planter files to `package.json` `files`; the published package stays plain ESM source.
- **Defaults are fixed by the spec:** planter `facets 6, dia 70, height 90, taper 1.2, wall 1.6, twist 30, drain 8, floor 3`.

---

### Task 1: Land the `prism` scalar-`scaleTop` framework fix

The fix and its test are **already written** in the working tree (`git status` shows `src/framework/geometry/manifold-backend.js` and `test/manifold-backend.test.js` modified). This task verifies, reviews, and commits them on their own — the spec flags this framework change for a `/code-review` pass before merge.

**Files:**
- Modify: `src/framework/geometry/manifold-backend.js` (prism extrude call)
- Test: `test/manifold-backend.test.js` (new uniform-taper regression test)

**Interfaces:**
- Produces: no API change — `k.prism(pts, h, { scaleTop, twist })` keeps its signature; `scaleTop` now tapers uniformly in X **and** Y instead of collapsing Y.

For an out-of-order reader, the fix is this line in `manifold-backend.js`'s `prism` (broadcast the scalar to a Vec2):

```js
const nDiv = Math.max(1, Math.ceil(Math.abs(twist) / 5));
// Manifold's extrude scaleTop is a Vec2 — a scalar is NOT broadcast (it scales
// X and drives Y to 0, squishing the top to a line). Broadcast for a uniform taper.
return T(cs.extrude(height, nDiv, twist, [scaleTop, scaleTop]));
```

and this regression test (volume alone can't catch the bug — a wedge loses volume too):

```js
test("prism scaleTop tapers uniformly — top shrinks equally in X and Y, not squished to a line", () => {
  const pos = k.prism(SQ, 10, { scaleTop: 0.5 }).toMesh().positions;
  const xs = [], ys = [];
  for (let i = 0; i < pos.length; i += 3)
    if (Math.abs(pos[i + 2] - 10) < 0.5) { xs.push(pos[i]); ys.push(pos[i + 1]); }
  const span = (a) => Math.max(...a) - Math.min(...a);
  const xSpan = span(xs), ySpan = span(ys);
  expect(xSpan).toBeCloseTo(5, 1);     // 10-wide base × scaleTop 0.5
  expect(ySpan).toBeCloseTo(xSpan, 1); // uniform — was 0 before the broadcast fix
});
```

- [ ] **Step 1: Run the regression test, confirm it passes**

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use
npx vitest run test/manifold-backend.test.js
```
Expected: PASS, including "prism scaleTop tapers uniformly…".

- [ ] **Step 2: Sanity-check that the test actually guards the fix**

Temporarily revert the broadcast to a scalar (`…twist, scaleTop)`), rerun the test, expect the new test to FAIL on `ySpan` (≈0 vs 5), then restore the `[scaleTop, scaleTop]` fix.
Expected: FAIL while reverted, PASS after restoring.

- [ ] **Step 3: Run `/code-review` on the framework diff**

Review only the two files in this task (`git diff` of `manifold-backend.js` + `test/manifold-backend.test.js`) at high effort. Address any findings inline; if none, proceed.

- [ ] **Step 4: Commit**

```bash
git add src/framework/geometry/manifold-backend.js test/manifold-backend.test.js
git commit -m "fix(manifold): broadcast scalar prism scaleTop to a Vec2 so taper is uniform

A scalar scaleTop scaled X and drove Y to 0, squishing tapered prisms into a
wedge. Broadcast to [s, s]; add a bbox-based regression test (volume tests
can't catch a wedge)."
```

---

### Task 2: Land the Faceted Planter part + spec

The planter and its wiring are **already written** (`git status` shows untracked `src/parts/planter.js`, `src/planter-worker.js`, `src/app-planter.js`, `planter.html`) and verified (boots clean, walls even). This task confirms and commits them together with the design spec.

**Files:**
- Create (already present): `src/parts/planter.js`, `src/planter-worker.js`, `src/app-planter.js`, `planter.html`
- Create (already present): `docs/superpowers/specs/2026-06-29-planter-demo-showcase-design.md`

**Interfaces:**
- Produces: a `planter.html` entry page (script `/src/app-planter.js`) — Task 3 (build input) and Task 5 (smoke check) depend on this exact filename.

- [ ] **Step 1: Run the full unit suite**

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use
npx vitest run
```
Expected: PASS (286+ tests).

- [ ] **Step 2: Smoke-check the planter app boots in real Chromium**

```bash
node scripts/check-app.mjs planter.html
```
Expected: a line like `booted: true   status: "… triangles · 0.0 s"   errors: 0`.

- [ ] **Step 3: Commit**

```bash
git add src/parts/planter.js src/planter-worker.js src/app-planter.js planter.html \
        docs/superpowers/specs/2026-06-29-planter-demo-showcase-design.md
git commit -m "feat: add Faceted Planter demo part + design spec

A prism-based planter/cup/vase: facets, taper, twist, even-wall cavity, optional
drainage. Second worked example alongside the Spacer; Manifold-only."
```

---

### Task 3: Multi-page Vite build with conditional Pages base

Turn the single-input dev harness into a four-page build, and apply the `/partforge/` base only when building (so `npm run dev` stays at root).

**Files:**
- Modify: `vite.config.js` (entire file)

**Interfaces:**
- Consumes: the entry HTML files `index.html` (Task 4), `demo.html`, `filleted-box.html`, `planter.html` (Task 2).
- Produces: `npm run build` emits `dist/index.html`, `dist/demo.html`, `dist/filleted-box.html`, `dist/planter.html` with assets referenced under `/partforge/`. Task 6 uploads `dist/`.

Replace the whole file with:

```js
import { defineConfig } from "vite";

// partforge dev harness + showcase build. `npm run dev` serves the example pages at
// root; `npm run build` emits the landing gallery + all three demo pages for GitHub
// Pages under the repo subpath (/partforge/). The published package is plain ESM
// source — this config is only for developing/testing the framework and the showcase.
// Replicad ships OpenCASCADE as a large WASM module; keep Vite from pre-bundling it,
// and build workers as ES modules so they can import replicad.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/partforge/" : "/",
  optimizeDeps: {
    exclude: ["replicad", "replicad-opencascadejs"],
  },
  worker: {
    format: "es",
  },
  build: {
    rollupOptions: {
      input: {
        index: "index.html",
        spacer: "demo.html",
        filletedBox: "filleted-box.html",
        planter: "planter.html",
      },
    },
  },
}));
```

> Note: Task 4 creates `index.html`. If implementing strictly in order, create a one-line placeholder `index.html` (`<!doctype html><title>partforge</title>`) before Step 2 here so the build resolves, then Task 4 fills it in. Subagent-driven execution should do Task 4 first or in the same batch.

- [ ] **Step 1: Confirm `npm run dev` still serves at root**

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use
npm run dev &  # note the printed port (e.g. 5173/5174)
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/planter.html
kill %1
```
Expected: `200` at `/planter.html` (root, NOT `/partforge/planter.html`).

- [ ] **Step 2: Build and confirm all four pages emit with the subpath base**

```bash
npm run build
ls dist/index.html dist/demo.html dist/filleted-box.html dist/planter.html
grep -o "/partforge/assets/[^\"']*" dist/planter.html | head -1
```
Expected: all four files listed; the grep prints at least one `/partforge/assets/...` reference (assets are under the base).

- [ ] **Step 3: Commit**

```bash
git add vite.config.js
git commit -m "build: multi-page Vite build + conditional /partforge/ Pages base"
```

---

### Task 4: Landing gallery `index.html`

A self-contained, dark-themed static page that introduces partforge and links the three demos. No framework mount — plain HTML/CSS so it loads instantly.

**Files:**
- Create: `index.html`

**Interfaces:**
- Consumes: the demo pages `planter.html`, `demo.html`, `filleted-box.html` via **relative** hrefs (so they resolve under the `/partforge/` base on Pages and at root in dev).
- Produces: `index.html` — the `index` build input named in Task 3.

- [ ] **Step 1: Create `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>partforge — one script → a parametric-CAD app</title>
    <meta name="description" content="Live example parts built with partforge: a 3-D viewer, control panel, and STL/STEP/3MF export from one declarative part definition." />
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body { margin: 0; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
             background: #15181d; color: #e7e9ee; -webkit-font-smoothing: antialiased; }
      .wrap { max-width: 860px; margin: 0 auto; padding: 64px 24px 96px; }
      h1 { font-size: 2.4rem; margin: 0 0 .3em; letter-spacing: -0.02em; }
      .lede { font-size: 1.15rem; color: #aab1bd; margin: 0 0 2.5em; max-width: 62ch; }
      .lede strong { color: #e7e9ee; }
      .grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); }
      a.card { display: block; padding: 22px; border: 1px solid #2a2f38; border-radius: 12px;
               background: #1a1e24; color: inherit; text-decoration: none;
               transition: border-color .15s ease, transform .15s ease; }
      a.card:hover { border-color: #4c8bf5; transform: translateY(-2px); }
      a.card.feature { border-color: #34507e; }
      .card h2 { margin: 0 0 .35em; font-size: 1.15rem; }
      .card p { margin: 0; color: #9aa2af; font-size: .95rem; }
      .tag { display: inline-block; font-size: .7rem; text-transform: uppercase; letter-spacing: .08em;
             color: #4c8bf5; margin-bottom: .6em; }
      footer { margin-top: 3em; color: #6b7280; font-size: .85rem; }
      footer a { color: #8aa0c0; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>partforge</h1>
      <p class="lede">Write one declarative <strong>part definition</strong> — geometry build
        functions plus a parameter schema — and partforge renders a full parametric-CAD web app:
        a 3-D viewer, a control panel, geometry workers, and STL / STEP / 3MF export. The pages
        below are live example parts. Drag to orbit, tweak the controls, download a printable file.</p>
      <div class="grid">
        <a class="card feature" href="planter.html">
          <span class="tag">Featured</span>
          <h2>🪴 Faceted Planter</h2>
          <p>Facets, twist, taper, and an optional drainage hole — every control has an obvious
             reason to change it before printing. Thin the wall and watch the DFM warning fire.</p>
        </a>
        <a class="card" href="demo.html">
          <h2>Spacer</h2>
          <p>The minimal worked example: a parametric standoff with screw-size presets, an
             optional base flange, and a clearance bore.</p>
        </a>
        <a class="card" href="filleted-box.html">
          <h2>Filleted Box</h2>
          <p>Native fillet and chamfer that auto-route to the OCCT backend for exact STEP export.</p>
        </a>
      </div>
      <footer>
        Built with <a href="https://github.com/scottsykora/partforge">partforge</a> ·
        three.js + Manifold / Replicad.
      </footer>
    </div>
  </body>
</html>
```

- [ ] **Step 2: Build and confirm the gallery emits and links all three demos**

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use
npm run build
ls dist/index.html
# the gallery must link all three demos; grep is tolerant of how Vite rewrites the hrefs
for p in planter.html demo.html filleted-box.html; do
  grep -oq "$p" dist/index.html && echo "links $p" || echo "MISSING $p"
done
```
Expected: `dist/index.html` listed, and `links planter.html` / `links demo.html` / `links filleted-box.html` all print.

> Why not `vite preview`: with `base` conditional on `command`, `vite preview` runs as `command: "serve"` (base `/`) while the built pages reference `/partforge/`, so a preview curl under `/partforge/` is unreliable. Asset-base correctness was already verified on `dist/planter.html` in Task 3; here we only need the gallery to emit and link the demos. Relative `href`s resolve correctly under the real Pages base.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: landing gallery linking the three live demos"
```

---

### Task 5: Smoke-check the showcase pages in CI

`ci.yml` currently boots only `demo.html`. Boot the planter and filleted-box pages too, so a broken showcase page fails CI before it can deploy.

**Files:**
- Modify: `.github/workflows/ci.yml` (replace the final `npm run check` step)

**Interfaces:**
- Consumes: `scripts/check-app.mjs <entry.html>` (starts its own dev server on port 5179, boots the page in Chromium, exits non-zero on any console/worker error).

Replace the single trailing step:

```yaml
      - run: npm run check
```

with one explicit check per showcase page (each invocation starts and tears down its own server, so they run sequentially):

```yaml
      - run: node scripts/check-app.mjs demo.html
      - run: node scripts/check-app.mjs planter.html
      - run: node scripts/check-app.mjs filleted-box.html
```

- [ ] **Step 1: Make the edit above in `.github/workflows/ci.yml`.**

- [ ] **Step 2: Reproduce the CI checks locally**

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use
node scripts/check-app.mjs demo.html
node scripts/check-app.mjs planter.html
node scripts/check-app.mjs filleted-box.html
```
Expected: each prints `booted: true … errors: 0` and exits 0.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: smoke-check all three showcase pages, not just the spacer"
```

---

### Task 6: GitHub Pages deploy workflow + README

Add the auto-deploy workflow (mirrors the sibling Drum-Machine repo) and point the README at the live showcase.

**Files:**
- Create: `.github/workflows/deploy-pages.yml`
- Modify: `README.md` (the "Use" / example section — mention the planter and the live URL)

**Interfaces:**
- Consumes: `npm run build` → `dist/` (Task 3).

- [ ] **Step 1: Create `.github/workflows/deploy-pages.yml`**

```yaml
name: Deploy to GitHub Pages
# Builds the example apps (landing gallery + the three demo parts) and publishes them
# to https://scottsykora.github.io/partforge/ on every push to main.
#
# One-time setup: in the repo, Settings → Pages → Build and deployment → Source =
# "GitHub Actions". Until that's set, this workflow runs but the deploy step errors.

on:
  push:
    branches: [main]
  workflow_dispatch:

# Allow the GITHUB_TOKEN to deploy to Pages, and serialize deploys.
permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-pages-artifact@v5
        with:
          path: dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v5
```

- [ ] **Step 2: Validate the build the workflow will run**

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use
npm ci && npm run build
test -f dist/index.html && echo "dist OK"
```
Expected: `dist OK`.

- [ ] **Step 3: Update `README.md`**

In the section that currently says to run `npm run dev` and open `/demo.html`, add a line pointing at the live showcase and the planter example. Add (adapting to the surrounding prose):

```markdown
**Live showcase:** https://scottsykora.github.io/partforge/ — the landing gallery links
three live example apps (Faceted Planter, Spacer, Filleted Box), auto-deployed from `main`.
Locally, `npm run dev` then open `/demo.html`, `/planter.html`, or `/filleted-box.html`.
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy-pages.yml README.md
git commit -m "ci: deploy the example apps to GitHub Pages on push to main"
```

- [ ] **Step 5: One-time manual enablement (record, don't automate)**

In the repo: **Settings → Pages → Build and deployment → Source = "GitHub Actions"**. After this, push `main` (or run the workflow via `workflow_dispatch`) and confirm the deploy job succeeds and `https://scottsykora.github.io/partforge/` serves the gallery with all three demos working.

---

## Self-Review

**Spec coverage:**
- New part + wiring → Task 2. ✓
- Framework `prism` fix + regression test → Task 1. ✓
- Multi-page build + conditional base → Task 3. ✓
- Landing gallery `index.html` → Task 4. ✓
- Deploy workflow + one-time Pages enablement → Task 6. ✓
- CI smoke check of new pages → Task 5. ✓
- README mention of planter + live URL → Task 6 Step 3. ✓
- "Showcase not in npm `files`" → Global Constraints (no task adds it). ✓

**Placeholder scan:** No TBD/TODO; every code/config step shows complete content. The only forward-reference (Task 3 needs Task 4's `index.html`) is called out with a concrete placeholder + ordering note.

**Type/name consistency:** Entry filenames (`index.html`, `demo.html`, `filleted-box.html`, `planter.html`) and the build input keys are identical across Tasks 2–6. The base string `/partforge/` matches the repo name and the README/workflow URL. `npm run check`/`scripts/check-app.mjs <entry>` usage matches the script's actual arg handling.
