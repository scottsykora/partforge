# Faceted Planter demo + GitHub Pages showcase — design

**Date:** 2026-06-29
**Status:** Approved (design); prototype of the part already built + verified, deployment pending plan
**Scope:** Add a second, more compelling example part (a faceted planter/cup/vase) and
publish the example apps as a live, auto-deploying showcase on GitHub Pages — a landing
gallery linking all three demos. Plus the one framework fix the planter surfaced.

## Motivation

partforge's pitch is "one declarative part definition → a full parametric-CAD web app,
with controls you'd actually want to adjust before printing." The existing `Spacer`
example is correct but visually flat, and there's no live URL to share — the apps only
run locally via `npm run dev`. For a team pitch we want (a) an example that's fun to look
at and whose controls have obvious, relatable reasons to change, and (b) a link anyone
can open that stays current as the repo changes.

The planter hits the "why adjust before printing" story squarely: facets/twist are pure
styling, height/diameter/taper fit it to a real plant or pens, the drainage hole is a
functional planter-vs-cup choice, and **wall thickness ties directly into partforge's
min-wall DFM warning** — including the subtle case where an aggressive twist thins the
effective wall below the limit even though the nominal wall looks fine.

## In scope

- **New part `parts/planter.js`** + its app wiring (`planter-worker.js`, `app-planter.js`,
  `planter.html`) — same four-file pattern as the Spacer, so it doubles as a worked example.
- **Framework fix:** `prism` scalar `scaleTop` must be broadcast to a `[s, s]` vector for
  Manifold, plus a bbox-based regression test.
- **Multi-page build:** Vite emits a landing page + all three demo pages.
- **Landing gallery `index.html`:** intro to partforge + cards linking the three demos.
- **GitHub Pages deploy workflow:** auto-build and publish on push to `main`.
- **CI:** extend the headless smoke check to the new demo page(s).

## Out of scope

- Text/engraving parts (no font→geometry in the kernel today).
- More than the three demos.
- Changing the published npm package — the showcase is the dev harness only; it does not
  go in `package.json` `files`, and the package stays plain ESM source.

---

## Part 1 — The Faceted Planter (built; documenting the design)

**Geometry (Manifold backend — `prism` + `cut`/`intersect`, no OCCT, so it stays fast):**

- **Body:** an N-sided prism, `prism(ngon(Rout, facets), height, { scaleTop: taper, twist })`.
- **Cavity (even wall, the hard part):** built from `z = 0` sharing the body's *exact*
  twist rate and taper slope, then clipped to `z ≥ floor` by intersecting with a tall box
  so the base stays solid. Building it in-phase (rather than lifting a separate prism to
  `z = floor`) is what keeps the facets radially aligned so the wall can't pinch when
  twisted. Verified: per-facet horizontal wall is even around the perimeter
  (`[1.58 × 5]` in a twist-90°/taper-0.8 torture case).
- **Even wall under taper:** the inner polygon is offset along the *face normals*
  (`Rin = Rout − wall / cos(π/n)`), and the cavity gets a matched
  `innerTaper = 1 + Rout(taper − 1) / Rin`, so the perpendicular wall stays constant
  top-to-bottom even as the body flares.
- **Drainage:** an optional centered through-hole (a `feature` with a slider), `+0.2 mm`
  print clearance baked into the radius.
- **Floor:** a hidden internal constant (mirrors the Spacer's hidden `flange_h`).

**Controls and why each exists:**

| Control | Type | Reason to change before printing |
|---|---|---|
| Facets (3–12) | slider | Pure look; spins dramatically |
| Diameter / Height | sliders | Fit the plant, pens, or shelf |
| Top taper (0.6–1.4) | slider | Planter (taper in) vs. cup (straight) vs. vase (flare) |
| Wall thickness | slider | The DFM moment — below 1.2 mm trips the min-wall warning |
| Twist (0–180°) | slider | Spiral flourish; extreme twist thins the effective wall |
| Drainage hole | feature toggle + Ø | Functional: planter (drains) vs. watertight cup/vase |
| Floor thickness | hidden | Fixed by design; drives geometry, not shown |

**Presets:** Pen cup / Planter / Vase, each setting facets, dia, height, taper, twist, drain.

**Defaults:** facets 6, dia 70, height 90, taper **1.2**, wall 1.6, twist **30°**, drain 8, floor 3.

**`verify` block:** `process: "fdm-pla"`, expecting one drainage hole, a bed-fit bbox gate,
and zero self-overlap — same self-verification pattern as the Spacer.

## Part 2 — Framework fix: `prism` scalar `scaleTop` (built)

Manifold's `CrossSection.extrude(h, nDiv, twist, scaleTop)` takes `scaleTop` as a `Vec2`;
a scalar is **not** broadcast — it scales X and drives Y toward 0, squishing any tapered
prism into a wedge. The existing tests only asserted *volume* (a wedge loses volume too),
so it slipped through. Fix: broadcast the scalar to `[scaleTop, scaleTop]` in the Manifold
backend, and add a bbox-based regression test asserting the top shrinks equally in X and Y.
This belongs to the framework and should get a `/code-review` pass before merge (per the
project's geometry-merge practice — the parity oracle is volume+bbox only).

## Part 3 — GitHub Pages showcase (to build)

**Multi-page Vite build.** Replace the single-input `rollupOptions` with the four entry
HTML files:

```js
build: {
  rollupOptions: { input: { index: "index.html", spacer: "demo.html",
                            filletedBox: "filleted-box.html", planter: "planter.html" } },
},
```

**Base path.** Pages serves under `https://scottsykora.github.io/partforge/`, so the
production build needs `base: "/partforge/"`. Keep `npm run dev` at root by making it
conditional on the Vite command:

```js
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/partforge/" : "/",
  /* …existing optimizeDeps / worker / build… */
}));
```

**Landing gallery `index.html`.** A small, self-contained static page (no framework mount):
a one-paragraph intro to partforge ("one script → a parametric-CAD app") and three cards
linking `planter.html`, `demo.html`, `filleted-box.html`, each with a one-line description.
Styled inline to read well in a pitch; relative links so it works under the `/partforge/`
base. The Planter is featured first.

**Deploy workflow `.github/workflows/deploy-pages.yml`.** Mirror the Drum Machine's: on
push to `main` (+ `workflow_dispatch`), `npm ci` → `npm run build` → `upload-pages-artifact`
(`path: dist`) → `deploy-pages`, Node from `.nvmrc`, with `pages: write` / `id-token: write`
permissions and a `concurrency: pages` group.

**One-time manual step** (call out in the workflow header, like `publish.yml`'s
trusted-publisher note): enable Pages once at **Settings → Pages → Source: GitHub Actions**.

**CI smoke check.** `ci.yml` currently boots only `demo.html`. Extend `npm run check` (or
the CI step) to also boot `planter.html` (and ideally `filleted-box.html`), so a broken
showcase page fails CI before it deploys.

## Components / files

| File | Change | Status |
|---|---|---|
| `src/parts/planter.js` | new part definition | built |
| `src/planter-worker.js`, `src/app-planter.js`, `planter.html` | app wiring | built |
| `src/framework/geometry/manifold-backend.js` | broadcast scalar `scaleTop` → `[s,s]` | built |
| `test/manifold-backend.test.js` | bbox regression test for uniform taper | built |
| `vite.config.js` | multi-page input + conditional `base` | to build |
| `index.html` | landing gallery | to build |
| `.github/workflows/deploy-pages.yml` | Pages deploy on push to main | to build |
| `.github/workflows/ci.yml` | smoke-check the new page(s) | to build |
| `README.md` | mention the planter example + live showcase URL | to build |

## Testing / verification

- Unit + smoke: `npm test` (incl. the new regression test) and `npm run check <page>` for
  each entry page — all green locally (286 tests; planter boots clean).
- Build: `npm run build` emits `index.html` + three demo pages under `dist/` with the
  `/partforge/` base; `npm run preview` serves the gallery and all links resolve.
- Deploy: first push to `main` after Pages is enabled publishes to
  `https://scottsykora.github.io/partforge/`; subsequent pushes auto-update.

## Risks / notes

- **Base-path breakage** is the classic Pages footgun (assets 404 under the repo subpath).
  The conditional `base` and a `preview` check before merge mitigate it.
- The showcase build pulls the large OCCT WASM into `dist/`; acceptable for a static demo,
  and `optimizeDeps.exclude` already keeps it out of dev pre-bundling.
- Pages must be enabled manually once; until then the workflow runs but the deploy step
  errors — documented in the workflow header.
