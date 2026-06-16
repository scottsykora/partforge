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
| Single boolean cut, ~10 turns | ⚠️ OCCT boolean returns **empty** — robustness limit |
| Naive sequential per-turn cut loop | correct in principle but too slow in WASM |

**Conclusion: feasible.** Replicad does the sweep + cut + export the browser
tool needs. The one open engineering task is scaling the boolean to the full
~22-turn production drum.

### Known issue + next step: boolean scaling

OCCT's default boolean fails silently (empty result) on large helical tools.
The Python/FreeCAD generator cuts the full groove fine, so OCCT *can* do it —
the fix on the Replicad side is one of:

1. **Fuzzy boolean** via the raw OCCT instance (`getOC()`) — `replicad`'s
   high-level `cut()` exposes no tolerance knob; drop down to
   `BRepAlgoAPI_Cut` + `SetFuzzyValue`. Most likely the right answer.
2. **Batched cuts** (a few turns per boolean) — robust, but tune for speed.
3. Investigate why FreeCAD's tool cuts cleanly (tool quality / tolerance).

### Headless-Node note

`scripts/groove-test.mjs` shims `require`/`__dirname` so the Emscripten OCCT
module boots under Node ESM, and writes STL from the mesh directly because
`blobSTL` routes through OCCT's virtual FS (flaky headless, fine in-browser).

## Roadmap

1. Scale the boolean cut to a full drum (fuzzy boolean).
2. Vite browser app: three.js viewer + parameter controls (run Replicad in a
   Web Worker so the UI stays responsive), STEP/STL download.
3. Port the rest of `capstan_drum_generator.py` (big drum, tensioners, end
   stops, load socket, motor flange) — most of it is straightforward Replicad;
   the grooves were the risk and they're proven.

## Layout

```
.nvmrc                  Node 20
package.json            deps + scripts
scripts/groove-test.mjs helical-groove de-risk prototype
scripts/out/            generated STL/STEP (gitignored)
```
