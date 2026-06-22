# Extracting the framework as `partforge` — design

**Date:** 2026-06-22
**Status:** Approved (design); pending implementation plan

## Goal

Separate the reusable parametric-CAD framework (today `src/framework/` in the
Drum-Machine repo) into its own repository and npm package, **`partforge`**, so that
anyone — human or LLM — can build parts by depending on the package and following the
authoring guide. The Drum-Machine app becomes a consumer of `partforge`.

The framework is already cleanly decoupled (it imports nothing from `parts/`), so this
is packaging + repo work, not untangling.

## Decisions

- **Name:** `partforge` (free on npm and the GitHub org namespace).
- **Distribution:** two separate repos now. `partforge` (npm-published library) and
  `Drum-Machine` (consumer). The user accepts the co-development friction (mitigated
  below) for a clean, point-at-it artifact.
- **On disk:** `partforge` lives as a sibling folder to `Drum Machine/`, i.e.
  `…/Robot KB/partforge/`.
- **History:** `partforge` is created by **cloning Drum-Machine** (a "fork") and
  reshaping it down to the framework. The shared history (including some Drum-Machine
  part specs) carrying over into the public repo is acceptable.
- **Auth:** the user has authorized the outward-facing actions — creating the GitHub
  repo and `npm publish` — to be performed in this work (with their `gh`/`npm` logins).

## Package shape

Published as **plain ESM source** (no build step); consumers use Vite, which resolves
the WASM / worker / CSS imports. Requiring a Vite-based consumer is documented.

`package.json` highlights:
- `"name": "partforge"`, `"type": "module"`, a starting version (e.g. `0.1.0`).
- Dependencies: `three`, `manifold-3d`, `replicad`, `replicad-opencascadejs`, `fflate`.
- `"files"`: the published tarball includes the library source (`src/`), the chrome CSS,
  the README, and `AUTHORING-PARTS.md` — not the demo app or tests.
- `"exports"` map (the only public surface):

| Subpath | Exports |
|---|---|
| `partforge` | `mount`, `viewSubParts`, `piePolygon`, `hexPolygon` |
| `partforge/worker` | `runWorker` |
| `partforge/testing` | `createManifoldKernel`, `bootOcctKernel`, `handle`, `assemblyOverlaps`, `meshVolume`, `bboxSize` |

The chrome CSS rides along automatically (`mount` imports it).

## What moves where

**Into `partforge`:**
- `src/framework/**` → the library source.
- The demo part as the canonical example + the framework's own runnable smoke:
  `parts/demo.js`, `demo.html`, the demo app + worker entries.
- `docs/AUTHORING-PARTS.md` (it documents the framework).
- Framework tests: `manifold-backend`, `helix-tube`, `kernel-helpers`, `threemf`,
  `assembly`, `controls`, `view-subparts`, `jobs`, `reuse` (+ the shared test helpers
  `test/helpers.js`, `test/occt-kernel.js`, exposed via `partforge/testing`).
- Its own `vite.config`, `vitest.config`, README.

**Stays in `Drum-Machine`:**
- The drum part + app: `parts/drum*`, `app.js`, `part-worker.js`, `index.html`.
- Drum-specific tests: `occt-step`, `parity`, `drum-occt`, `drum-assembly`, `jobs-drum`,
  `smoke`, OCCT fixtures, `scripts/gen-occt-fixtures.mjs` — repointed to import the
  framework surface from `partforge` / `partforge/testing`.

After migration `src/framework/` is deleted from Drum-Machine, and its imports become:

```js
import { mount } from "partforge";                  // app.js
import { runWorker } from "partforge/worker";        // part-worker.js
import { piePolygon, hexPolygon } from "partforge";  // parts/drum/bodies.js
import { createManifoldKernel, assemblyOverlaps } from "partforge/testing"; // tests
```

## Co-development workflow

Sibling folders, linked for local dev:
- In `partforge`: `npm link` (or Drum-Machine uses a `file:../partforge` dependency).
- In `Drum-Machine`: `npm link partforge`, plus `partforge` added to Vite's
  `optimizeDeps.exclude` so edits to the framework are **live with HMR** — close to the
  current single-repo loop.
- For releases/CI, Drum-Machine pins the **published** `partforge` version. Local dev =
  the link; deploy = the published version.

## Phasing

1. **Scaffold `partforge`** (sibling repo, cloned from Drum-Machine and reshaped):
   keep `src/framework/**`, the demo, the guide, and framework tests; add
   `package.json`/`exports`/README, public entry files (`src/index.js`, `src/testing.js`,
   and the existing `src/framework/worker.js` surfaced as `partforge/worker`); strip the
   drum part/app/tests/fixtures. Verify `partforge` tests pass and the demo runs.
2. **Migrate `Drum-Machine`**: link `partforge`, replace `./framework/*` imports with the
   package, delete `src/framework/` + the moved tests, repoint drum tests at
   `partforge/testing`, exclude `partforge` from `optimizeDeps`. Verify the drum builds,
   the suite passes against the linked package, and `npm run dev` works.
3. **Publish + remote** (authorized): create the GitHub repo, `npm publish` `partforge`,
   switch Drum-Machine's dependency to the published version (keep the link for local
   dev), add a publish CI workflow to `partforge`.
4. *(Later, optional)* an authoring skill that points at the `partforge` package + guide.

## Testing posture

- `partforge` keeps the framework's existing tests (retargeted at its own paths) — they
  already pass; nothing new to prove except the package resolves through its `exports`.
- `Drum-Machine`'s drum tests pass against the linked/published `partforge`.
- Node 24 for tests in both; OCCT and Manifold must not boot in the same process.
- A green `npm run build` in each repo gates the browser-only seams.
