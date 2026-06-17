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

### Performance

The original ~55 s for the full drum turned out to be dominated by **meshing**,
not the boolean — at print-grade tolerance (0.01 mm) the mesh alone was ~31 s
(219 k triangles). Phase breakdown at 23 turns: sweep 0.6 s · cut 16 s · mesh
31 s.

Fixes:
- **Coarse display mesh** (0.05 mm — plenty smooth for a Ø10 mm part on screen):
  meshing drops from ~31 s to ~1.6 s (≈29 k triangles).
- **Lazy STL** — the fine print-grade mesh runs only on **Download STL**, not on
  every generate.

Result (per-generate, kernel already booted): **4 turns ≈ 2 s · 8 ≈ 5 s · full
23-turn drum ≈ 18 s** (the fuzzy cut is now the ~16 s remainder at max turns).
Further cut speedups (batched cuts) are a future option, no longer urgent.

### Headless-Node note

`scripts/groove-test.mjs` shims `require`/`__dirname` so the Emscripten OCCT
module boots under Node ESM, and writes STL from the mesh directly because
`blobSTL` routes through OCCT's virtual FS (flaky headless, fine in-browser).

## Roadmap

1. ~~Scale the boolean cut to a full drum~~ — **done** (fuzzy boolean).
2. ~~Vite browser app: three.js viewer + param controls + STL download, Replicad
   in a Web Worker~~ — **done** (`npm run dev`; see Browser app below).
3. ~~Performance~~ — **mostly done** (coarse display mesh + lazy STL; full drum
   ~18 s, default 4-turn ~2 s). Optional: batched cuts to trim the ~16 s cut.
4. **Geometry port** — small + big drum cores **done** (groove / bore / stub /
   flange; stripe grooves / bearing seats / bolt circle). Remaining: rope-lock
   holes, tensioner pockets, end stops, load socket, motor counterbores.
5. **Sectioned preset/advanced controls + part selector** — **done**
   (`src/params.js` schema → `src/controls.js`).

## Browser app

```bash
nvm use && npm run dev      # http://localhost:5173
```

three.js viewer with auto-rotate, a **part selector** (Small / Big / Both), and
a **sectioned control panel** — Rope · Reduction · Motor mount · Small drum ·
Big drum. Each section offers **presets** (the easy choice) and an expandable
**Advanced** block with the full per-part controls (schema in `src/params.js`,
rendered by `src/controls.js`). Hit **Generate** to build; **Download STL**
exports a print-grade mesh on demand.

Geometry runs in a Web Worker (`src/drum-worker.js`) so the UI stays responsive,
and a spinner overlay shows the live phase (booting · sweeping · cutting ·
meshing) fed by progress messages. OCCT boots once; each Generate re-cuts.
Typical generate: small drum ~6 s, big drum ~9 s, both ~15 s.

### What's ported

- **Small drum:** helical rope groove · mid-rope lock weave hole · **blind**
  motor-shaft bore · 608ZZ support stub (root cone + tip chamfer) · motor-mount
  flange + standoff + bolt holes.
- **Big drum:** worm-gear stripe grooves (N left-handed helices) · center bore ·
  6808 bearing seats (both faces) · link bolt circle · **travel end stops** ·
  **load-test socket (1/2" PVC)** · **sliding-block tensioner pockets** — toggle
  each in the "Big-drum features" section (set its key to 0 to disable).
- **Tensioner block** (print 2): the sliding block with captured-nut hex trap,
  jack-screw bore, and rope feed. Shown beside the big drum in Big/Both views and
  exported as its own file (so a Big export becomes a zip: drum + block).
- **Both:** drums placed at the real gear centre distance, motor tucked under.

Not yet ported: sector (<360°) drums and the rope-lock bend-relief channels.

## Layout

```
.nvmrc                  Node 20
package.json            deps + scripts
scripts/groove-test.mjs helical-groove de-risk prototype
scripts/out/            generated STL/STEP (gitignored)
```
