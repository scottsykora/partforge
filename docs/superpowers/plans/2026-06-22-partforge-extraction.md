# partforge Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. NOTE: this is cross-repo ops work (git, npm link, publish) — inline execution is recommended over cold subagents, since tasks depend on shared on-disk + link state.

**Goal:** Extract `src/framework/` from the Drum-Machine repo into a standalone repo + npm package `partforge`, and make Drum-Machine consume it.

**Architecture:** `partforge` is created by cloning Drum-Machine (keeping history), then reshaping down to the framework + the demo part + the authoring guide + framework tests, with a public `exports` map. Drum-Machine then deletes `src/framework/`, links `partforge` for local dev, and imports it. Published as plain ESM source; consumers use Vite.

**Tech Stack:** Vite 8, Vitest 4, Manifold (`manifold-3d`), Replicad/OpenCASCADE, three.js, npm workspaces-free `npm link`.

## Global Constraints

- Node 24 for all commands: prefix with `source ~/.nvm/nvm.sh && nvm use && …` (default shell Node is too old).
- Package name is exactly `partforge`. `"type": "module"`. Start version `0.1.0`.
- `partforge` is published as **ESM source** (no build step); it requires a Vite-based consumer (document in its README).
- OCCT and Manifold must NOT boot in the same Node process (Vitest isolates files; keep OCCT-booting tests in their own files).
- On disk: `partforge` is a sibling of `Drum Machine/`, at `/Users/scottsykora/Documents/Docs/pixite/code/Robot KB/partforge`.
- Commit messages end with these two trailer lines verbatim:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1
  ```
- Outward-facing `gh repo create` + `npm publish` are user-authorized (Phase 3).
- Spec: `docs/superpowers/specs/2026-06-22-partforge-extraction-design.md`.

Shorthand: `$DM` = `/Users/scottsykora/Documents/Docs/pixite/code/Robot KB/Drum Machine`,
`$PF` = `/Users/scottsykora/Documents/Docs/pixite/code/Robot KB/partforge`.

---

## Public API (target `exports`)

| Subpath | File | Exports |
|---|---|---|
| `partforge` | `src/index.js` | `mount`, `viewSubParts`, `piePolygon`, `hexPolygon` |
| `partforge/worker` | `src/framework/worker.js` | `runWorker` |
| `partforge/testing` | `src/testing.js` | `createManifoldKernel`, `bootOcctKernel`, `handle`, `assemblyOverlaps`, `meshVolume`, `bboxSize` |

---

# Phase 1 — Scaffold `partforge`

## Task 1: Clone Drum-Machine → partforge and detach

**Files:** new repo at `$PF` (clone of `$DM`).

- [ ] **Step 1: Clone the local repo (preserves history) and detach from Drum-Machine's remote**

```bash
cd "/Users/scottsykora/Documents/Docs/pixite/code/Robot KB"
git clone "Drum Machine" partforge
cd partforge
git remote remove origin           # detach: do NOT push partforge commits to Drum-Machine
git checkout -b main 2>/dev/null || git checkout main
git checkout -b partforge-init     # work branch
```

- [ ] **Step 2: Verify the clone has the framework + history**

Run: `ls src/framework && git log --oneline -1`
Expected: the framework files listed; the latest Drum-Machine commit shown.

- [ ] **Step 3: Commit marker (empty) to anchor the reshape**

```bash
git commit --allow-empty -m "chore: begin reshaping Drum-Machine clone into partforge

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1"
```

## Task 2: Prune drum-specific files; keep framework + demo + guide + framework tests

**Files (in `$PF`):**
- Remove (drum-specific): `src/parts/drum.js`, `src/parts/drum/`, `src/app.js`, `src/part-worker.js`, `index.html`, `scripts/gen-occt-fixtures.mjs`, `scripts/occ-probe.mjs`, `test/occt-step.test.js`, `test/parity.test.js`, `test/drum-occt.test.js`, `test/framework/jobs-drum.test.js`, `test/parts/drum-assembly.test.js`, `test/fixtures/occt-volumes.json`, `README.md` (replaced in Task 4), `vendor.repos` if present, the drum-specific `docs/` wiki pages.
- Keep: `src/framework/**`, `src/parts/demo.js`, `demo.html`, `src/app-demo.js`, `src/demo-worker.js`, `docs/AUTHORING-PARTS.md`, `test/framework/*` (except `jobs-drum.test.js`), `test/parts/` (empty after removing drum-assembly — remove dir), `test/fixtures/demo-part.js`, `test/helpers.js`, `test/occt-kernel.js`, `test/smoke.test.js`, `test/kernel-helpers.test.js`, `test/helix-tube.test.js`, `vite.config.js`, `vitest.config.js`, `.nvmrc`, `.gitignore`.

- [ ] **Step 1: Remove the drum-specific files**

```bash
cd "$PF"   # (the partforge dir)
git rm -r src/parts/drum.js src/parts/drum src/app.js src/part-worker.js index.html \
  scripts/gen-occt-fixtures.mjs scripts/occ-probe.mjs \
  test/occt-step.test.js test/parity.test.js test/drum-occt.test.js \
  test/framework/jobs-drum.test.js test/parts/drum-assembly.test.js \
  test/fixtures/occt-volumes.json
git rm -r --ignore-unmatch vendor.repos CLAUDE.md
rmdir test/parts 2>/dev/null || true
```

- [ ] **Step 2: Confirm only framework + demo remain under src/parts and the demo is intact**

Run: `ls src/parts && ls src/framework && cat src/parts/demo.js | head -3`
Expected: `demo.js` only under `src/parts`; framework files present; demo header comment shows.

- [ ] **Step 3: Commit the prune**

```bash
git add -A
git commit -m "refactor: strip drum-specific files; keep framework + demo + guide + tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1"
```

## Task 3: Move the test helpers into `src/` so they can be published

**Files (in `$PF`):**
- Move: `test/helpers.js` → `src/testing/mesh.js` (it exports `meshVolume`, `bboxSize`).
- Move: `test/occt-kernel.js` → `src/testing/occt.js` (exports `bootOcctKernel`).
- Modify: every test that imports `./helpers.js` or `./occt-kernel.js` to the new paths.

**Interfaces:**
- Produces: `src/testing/mesh.js` exports `meshVolume(positions, indices)`, `bboxSize(positions)`; `src/testing/occt.js` exports `bootOcctKernel()`.

- [ ] **Step 1: Move the helpers**

```bash
cd "$PF"
mkdir -p src/testing
git mv test/helpers.js src/testing/mesh.js
git mv test/occt-kernel.js src/testing/occt.js
```

- [ ] **Step 2: Fix internal import in `src/testing/occt.js`**

`src/testing/occt.js` imports `createOcctKernel` from the framework. It was `../src/framework/geometry/occt-backend.js` (from `test/`); now from `src/testing/` it is `../framework/geometry/occt-backend.js`. Change that import line accordingly.

- [ ] **Step 3: Repoint test imports**

In every file under `test/`, replace `from "./helpers.js"` → `from "../src/testing/mesh.js"` and `from "./occt-kernel.js"` → `from "../src/testing/occt.js"`. Find them:

```bash
grep -rln "\"\./helpers.js\"\|\"\./occt-kernel.js\"\|occt-kernel\|helpers.js" test
```
Update each (e.g. `test/kernel-helpers.test.js`, `test/smoke.test.js`, any framework test using mesh helpers).

- [ ] **Step 4: Run the framework suite**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run`
Expected: all remaining (framework + demo) tests pass. Fix any missed import path.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move mesh/occt test helpers into src/testing for publishing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1"
```

## Task 4: Package entry points, `package.json` exports, README

**Files (in `$PF`):**
- Create: `src/index.js`, `src/testing.js`
- Modify: `package.json` (name, version, exports, files), `vite.config.js` (demo entry), `README.md` (new)

**Interfaces:**
- Produces the `exports` surface in the table above.

- [ ] **Step 1: Create `src/index.js` (the main entry)**

```js
export { mount } from "./framework/index.js";
export { viewSubParts } from "./framework/jobs.js";
export { piePolygon, hexPolygon } from "./framework/geometry/polygon.js";
```

- [ ] **Step 2: Create `src/testing.js` (the part-testing surface)**

```js
export { createManifoldKernel } from "./framework/geometry/manifold-backend.js";
export { handle, viewSubParts } from "./framework/jobs.js";
export { assemblyOverlaps } from "./framework/assembly.js";
export { bootOcctKernel } from "./testing/occt.js";
export { meshVolume, bboxSize } from "./testing/mesh.js";
```

- [ ] **Step 3: Rewrite `package.json`**

```json
{
  "name": "partforge",
  "version": "0.1.0",
  "description": "Turn a declarative part definition into a parametric-CAD web app (three.js + Manifold/Replicad). Requires a Vite-based consumer.",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=24" },
  "files": ["src", "docs/AUTHORING-PARTS.md", "README.md"],
  "exports": {
    ".": "./src/index.js",
    "./worker": "./src/framework/worker.js",
    "./testing": "./src/testing.js"
  },
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "fflate": "^0.8.3",
    "manifold-3d": "^3.5.1",
    "replicad": "^0.23.1",
    "replicad-opencascadejs": "^0.23.0",
    "three": "^0.184.0"
  },
  "devDependencies": { "vite": "^8.0.16", "vitest": "^4.1.9" }
}
```

- [ ] **Step 4: Point Vite's dev/build at the demo**

Replace `vite.config.js` so the demo is the app entry (its `base` no longer needs GitHub Pages logic):

```js
import { defineConfig } from "vite";

// partforge dev harness: `npm run dev` serves /demo.html (the example part).
export default defineConfig({
  optimizeDeps: { exclude: ["replicad", "replicad-opencascadejs"] },
  worker: { format: "es" },
  build: { rollupOptions: { input: "demo.html" } },
});
```

- [ ] **Step 5: Write `README.md`**

```markdown
# partforge

Turn a declarative **part definition** into a full parametric-CAD web app — a 3-D
viewer, a control panel, geometry workers, and STL / STEP / 3MF export. You write one
script (geometry build functions + a parameter schema); partforge renders the app.

**Requires a Vite-based app** (it uses Vite's worker/WASM/CSS import handling).

```bash
npm install partforge
```

```js
import { mount } from "partforge";
import { runWorker } from "partforge/worker"; // in your part-worker entry
```

See **[docs/AUTHORING-PARTS.md](docs/AUTHORING-PARTS.md)** for the full authoring guide,
and `src/parts/demo.js` (run `npm run dev` → `/demo.html`) for a minimal example.
```

- [ ] **Step 6: Install + verify the package resolves through exports + tests pass + demo builds**

```bash
source ~/.nvm/nvm.sh && nvm use && npm install
node -e "import('partforge').then(m=>console.log('main:',Object.keys(m)))"   # mount, viewSubParts, piePolygon, hexPolygon
node -e "import('partforge/worker').then(m=>console.log('worker:',Object.keys(m)))" # runWorker
node -e "import('partforge/testing').then(m=>console.log('testing:',Object.keys(m)))"
npx vitest run
npm run build
```
Expected: each `import('partforge…')` prints the expected exports (self-resolution via the `exports` map works because `name` is `partforge`); tests pass; build succeeds (emits the demo). NOTE: `partforge/testing` boots OCCT in `bootOcctKernel` only when called, so the bare import is safe.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: partforge package — exports, entry points, README, demo dev harness

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1"
```

---

# Phase 2 — Migrate Drum-Machine to consume `partforge`

## Task 5: Link partforge and repoint Drum-Machine's imports

**Files (in `$DM`, on the `partforge-extraction` branch):**
- Delete: `src/framework/`, and the framework tests now living in partforge:
  `test/framework/{jobs,view-subparts,assembly,controls,threemf,manifold-backend,helix-tube,kernel-helpers,reuse}.test.js`, `test/smoke.test.js`, `test/fixtures/demo-part.js`, `test/helpers.js`, `test/occt-kernel.js`, `src/parts/demo.js`, `demo.html`, `src/app-demo.js`, `src/demo-worker.js`.
- Modify: `src/app.js`, `src/part-worker.js`, `src/parts/drum/bodies.js`, the kept drum tests, `package.json`, `vite.config.js`.

- [ ] **Step 1: Link the local partforge**

```bash
cd "$PF" && source ~/.nvm/nvm.sh && nvm use && npm link
cd "$DM" && npm link partforge
```

- [ ] **Step 2: Repoint Drum-Machine source imports to the package**

- `src/app.js`: `import { mount } from "./framework/index.js"` → `from "partforge"`.
- `src/part-worker.js`: `import { runWorker } from "./framework/worker.js"` → `from "partforge/worker"`.
- `src/parts/drum/bodies.js`: `import { piePolygon, hexPolygon } from "../../framework/geometry/polygon.js"` → `from "partforge"`.

```bash
grep -rn "framework/" src/app.js src/part-worker.js src/parts/drum/bodies.js
```

- [ ] **Step 3: Repoint the kept drum tests to `partforge/testing`**

In `test/occt-step.test.js`, `test/parity.test.js`, `test/drum-occt.test.js`, `test/framework/jobs-drum.test.js`, `test/parts/drum-assembly.test.js`, replace framework-internal imports with the package:
- `from "../src/framework/geometry/manifold-backend.js"` → `from "partforge/testing"` (named `createManifoldKernel`)
- `from "../../src/framework/geometry/manifold-backend.js"` → `from "partforge/testing"`
- `from "../../src/framework/jobs.js"` → `from "partforge/testing"` (named `handle`, `viewSubParts`)
- `from "../../src/framework/assembly.js"` → `from "partforge/testing"` (named `assemblyOverlaps`)
- `from "./occt-kernel.js"` → `from "partforge/testing"` (named `bootOcctKernel`)
- `from "./helpers.js"` → `from "partforge/testing"` (named `meshVolume`, `bboxSize`)

```bash
grep -rln "src/framework/\|occt-kernel\|helpers.js" test
```

- [ ] **Step 4: Delete the framework + the tests that moved to partforge**

```bash
cd "$DM"
git rm -r src/framework src/parts/demo.js demo.html src/app-demo.js src/demo-worker.js \
  test/framework/jobs.test.js test/framework/view-subparts.test.js test/framework/assembly.test.js \
  test/framework/controls.test.js test/framework/threemf.test.js test/framework/manifold-backend.test.js \
  test/framework/helix-tube.test.js test/framework/kernel-helpers.test.js test/framework/reuse.test.js \
  test/smoke.test.js test/fixtures/demo-part.js test/helpers.js test/occt-kernel.js
```
(Keep the drum tests: `occt-step`, `parity`, `drum-occt`, `framework/jobs-drum`, `parts/drum-assembly`, and `fixtures/occt-volumes.json`.)

- [ ] **Step 5: Exclude partforge from Vite pre-bundling (for live HMR on the link) + add the dep**

In `$DM/vite.config.js` `optimizeDeps.exclude`, add `"partforge"` alongside the existing entries. In `$DM/package.json` `dependencies`, add `"partforge": "^0.1.0"` (resolved by the link locally; the published version for CI).

- [ ] **Step 6: Run the drum suite against the linked package + build**

```bash
cd "$DM" && source ~/.nvm/nvm.sh && nvm use && npx vitest run && npm run build
```
Expected: the drum tests (occt-step, parity, drum-occt, jobs-drum, drum-assembly) pass importing from `partforge/testing`; build succeeds and still emits the worker + `.wasm` chunks (Vite follows the linked package's worker/WASM imports).

- [ ] **Step 7: Manual smoke**

`npm run dev`, open the printed URL, hard-reload: preview, tab switch, STL/3MF/STEP export, light/dark, typeable controls — all working through the linked `partforge`. Then edit a trivial comment in `$PF/src/framework/viewer.js` and confirm HMR reflects it (validates the live-link loop).

- [ ] **Step 8: Commit (Drum-Machine)**

```bash
cd "$DM"
git add -A
git commit -m "refactor: consume the framework from the partforge package

Deletes src/framework/ and the framework tests (now in partforge); app/worker/part
import from partforge, drum tests from partforge/testing. Linked locally for dev.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013JtsJt4EMJbxekzq84XDT1"
```

---

# Phase 3 — Publish + remote (user-authorized)

## Task 6: Create the GitHub repo, publish to npm, pin the dependency

**Files:** `$PF/.github/workflows/publish.yml`; `$DM/package.json` (pin published version).

- [ ] **Step 1: Create the GitHub repo for partforge and push**

```bash
cd "$PF"
git checkout main && git merge --no-ff partforge-init -m "Merge: initial partforge package"
gh repo create partforge --public --source=. --remote=origin --description "Declarative parametric-CAD web apps from a part definition (three.js + Manifold/Replicad)" --push
```
Expected: repo created at `github.com/<account>/partforge`, `main` pushed.

- [ ] **Step 2: Publish to npm**

```bash
cd "$PF" && source ~/.nvm/nvm.sh && nvm use
npm whoami    # confirm logged in; if not: npm login
npm publish --access public
```
Expected: `partforge@0.1.0` published. Verify: `npm view partforge version`.

- [ ] **Step 3: Add a publish-on-tag CI workflow**

Create `$PF/.github/workflows/publish.yml`:

```yaml
name: Publish
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions: { contents: read, id-token: write }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, registry-url: "https://registry.npmjs.org" }
      - run: npm ci
      - run: npm test
      - run: npm publish --access public
        env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" }
```
Commit + push. (User adds the `NPM_TOKEN` repo secret.)

- [ ] **Step 4: Confirm Drum-Machine resolves the published version (keep the link for dev)**

In `$DM`, the `package.json` already pins `"partforge": "^0.1.0"`. To verify the published package works independently of the link: `cd "$DM" && npm unlink --no-save partforge && npm install && npx vitest run && npm run build`, then re-link for ongoing dev (`npm link partforge`).
Expected: tests + build pass against the registry version.

- [ ] **Step 5: Merge Drum-Machine's branch + push**

```bash
cd "$DM"
git checkout main && git merge --no-ff partforge-extraction -m "Merge: consume framework from partforge package"
npx vitest run && npm run build   # final gate on main
git push origin main
```

---

## Final verification

- [ ] `partforge`: `npm test` green, `npm run build` ok, `exports` resolve, published on npm, repo on GitHub.
- [ ] `Drum-Machine`: `npm test` green + `npm run build` ok against the published `partforge`; `npm run dev` works; deploy on push succeeds.
- [ ] Live-link loop verified (edit partforge → HMR in Drum-Machine).
- [ ] `git grep -n "framework/" "$DM/src"` returns nothing (no internal framework imports remain).
