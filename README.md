# Drum Machine

A web-native parametric capstan-drum generator — the goal is to tweak settings,
tap **Generate**, and see the 3D-rendered drums in the browser, with STEP/STL
export. It's a companion to the headless Python generator in the Robot KB repo
(`cad/capstan_drum_generator.py`), which builds the same geometry on
OpenCASCADE via FreeCAD.

## Why this stack

The drums are real BREP solids (helical groove sweeps + boolean cuts), not
meshes — so we need a CAD kernel, not just a 3D renderer. The browser-native
way to run OpenCASCADE is **WebAssembly**:

- **[Replicad](https://replicad.xyz)** `0.23` — code-CAD on `opencascade.js`
  (OCCT compiled to WASM). Sweeps, booleans, valid solids, STEP + STL export.
- **[three.js](https://threejs.org)** `0.184` — render the meshed result.
- **[Vite](https://vitejs.dev)** `8` — dev server / bundler for the eventual
  static, no-backend web app.
- **Node 20** (see `.nvmrc`) — the system default here is the EOL v16; run
  `nvm use` in this folder. (You can't run the existing Python generator in the
  browser — FreeCAD/OCCT isn't available in Pyodide — hence the JS/WASM port.)

## Status — de-risk prototype (the hard part is proven)

`scripts/groove-test.mjs` reproduces the make-or-break operation: a **helical
groove swept and boolean-cut into a drum blank**, at the small-drum spec
(Ø10.2 blank, 1.2 × 0.6 mm groove, 1.4 mm pitch).

```
npm run groove-test          # default 10 turns
TURNS=1 npm run groove-test  # clean, fast — writes scripts/out/*.stl + *.step
```

Findings:

| Operation | Result |
|---|---|
| `makeHelix` → `genericSweep` (helical groove tool) | ✅ valid solid at any scale (133k-tri at 10 turns) |
| Single boolean cut, few turns | ✅ valid grooved drum (12,834 tris at 1 turn), exports STL + STEP |
| Default-tolerance cut, ~10+ turns | ❌ OCCT boolean returns **empty** (near-tangent helix) |
| **Fuzzy boolean cut** (`src/fuzzy-cut.js`) | ✅ **full drum cuts** — 10 turns 13 s, 23 turns 55 s |

**Conclusion: it works.** Replicad does the sweep + fuzzy cut + export the
browser tool needs, including the full ~23-turn production small drum. Remaining
work is performance, not feasibility.

### Solved: the boolean (fuzzy)

OCCT's default boolean fails silently (empty result) on large near-tangent
helical tools. `replicad`'s high-level `cut()` runs the one-shot
`BRepAlgoAPI_Cut_3` constructor with zero fuzzy tolerance. `src/fuzzy-cut.js`
drops to the raw kernel via `getOC()`, mirrors replicad's own cut, and adds
**`SetFuzzyValue(1e-3)`** before `Build()` — which snaps near-coincident
geometry and makes the cut robust at any turn count. (Skipping `SimplifyResult`,
a slow coplanar-face merge, was also needed — it isn't required for a correct
mesh/STEP.)

### Remaining: performance

The fuzzy cut is correct but superlinear: ~13 s at 10 turns, ~55 s at 23. Fine
for a single drum with a progress indicator, slow for live tweaking. Options to
explore: batched cuts, a coarser sweep tessellation, parallel BOP, or caching.

### Headless-Node note

`scripts/groove-test.mjs` shims `require`/`__dirname` so the Emscripten OCCT
module boots under Node ESM, and writes STL from the mesh directly because
`blobSTL` routes through OCCT's virtual FS (flaky headless, fine in-browser).

## Roadmap

1. ~~Scale the boolean cut to a full drum~~ — **done** (fuzzy boolean).
2. ~~Vite browser app: three.js viewer + param controls + STL download, Replicad
   in a Web Worker~~ — **done** (`npm run dev`; see Browser app below).
3. **Performance** — bring the full-drum cut down from ~55 s (batched cuts /
   coarser tessellation / caching).
4. **Port the rest of `capstan_drum_generator.py`** — big drum, tensioners, end
   stops, load socket, motor flange. Mostly straightforward Replicad now that
   the grooves are proven.

## Browser app

```bash
nvm use && npm run dev      # http://localhost:5173
```

three.js viewer with auto-rotate, a param panel (turns / blank Ø / pitch /
groove width), live **Generate**, and **Download STL**. Geometry runs in a Web
Worker (`src/drum-worker.js`) so the UI stays responsive; OCCT boots once and
each tweak re-cuts. Default is 4 turns for a quick first paint — crank Turns up
for the full drum (slower; see Performance).

## Layout

```
.nvmrc                  Node 20
package.json            deps + scripts
scripts/groove-test.mjs helical-groove de-risk prototype
scripts/out/            generated STL/STEP (gitignored)
```
