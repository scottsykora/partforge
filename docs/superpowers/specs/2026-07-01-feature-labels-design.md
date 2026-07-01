# Feature labels with hover inspection — design

**Date:** 2026-07-01
**Status:** approved

## Purpose

Let a user hover the model and see a cursor-following tooltip naming the sub-part
and the specific **feature** under the pointer ("Drainage hole · Planter"), with
that feature's surface highlighted in the viewer. Feature names are unique,
human-readable, and authored in the part definition, so they (a) teach CAD
vocabulary in context and (b) give the user and the agent a shared reference
vocabulary — "Make the Fillet on Upright B 3mm". The same feature identity feeds
the existing click-picker / pick-serve Selection, built on shared code.

## Decisions (from brainstorming)

- **Granularity:** a feature = a named build-step solid, not an individual CAD face.
- **Activation:** hover labeling is always on (mouse pointers only; no hover on touch).
- **Picker tie-in:** click Selections and pick-serve prompts include the feature name.
- **Backends:** both Manifold and OCCT in v1.
- **Mechanism:** kernel provenance labels (approach 1), not declarative selectors or
  automatic geometric classification. Automatic face descriptors ("cylindrical face
  Ø8") could layer on later as a secondary tooltip line — out of scope here.

## 1. Authoring API

A new chainable method on `Solid`, available in `build()` on both backends:

```js
build: (k, p, d) => {
  const body = k.prism(d.outerPts, p.height, {...}).label("Faceted wall");
  const cavity = k.prism(...).intersect(...).label("Cavity");
  let s = body.cut(cavity);
  if (p.drain > 0) s = s.cut(k.cylinder(...).at([0,0,-2]).label("Drainage hole"));
  return s;
}
```

- A label names the solid's **surface** wherever it survives into the final part,
  including faces a cutting tool leaves behind (a drilled hole's wall carries the
  cutting cylinder's label).
- Labels ride through transforms (`at`, `translate`, `rotate`, `mirror`, `scale`, …)
  and are registered when the labeled solid participates in a boolean or is returned
  from `build()`.
- Unlabeled geometry falls back to the sub-part's `label` (e.g. "Planter").
- Labels must be unique within a sub-part. A duplicate label logs a console warning
  and last-one-wins. The full human reference combines feature + sub-part:
  "Fillet on Upright B".
- The probe kernel must accept `.label()` (its catch-all Proxy already tolerates
  unknown methods; we additionally teach it the method explicitly so param-relevance
  analysis stays exact).
- `docs/AUTHORING-PARTS.md` gains a "Naming features" section. `planter.js` and
  `filleted-box.js` get labels as worked examples (`demo.js` stays minimal).

## 2. Backend plumbing — feature attribution

The worker mesh payload gains two fields, flowing through `mesh-cache.js` and
`viewer.setSubGeometry` alongside positions/normals/edges:

- `featureIds` — one small integer per triangle (`Uint16Array`, one entry per tri).
- `features` — table `[{ id, label }]`. Id `0` = unlabeled → sub-part fallback.

**Manifold:** `.label()` stamps the solid via `asOriginal()` (fresh `originalID`) and
records `originalID → label`. The mesh extraction already walks `runIndex` /
`runOriginalID` per triangle for creased normals (`manifold-backend.js`); the same
walk fills `featureIds`. Exact attribution, no extra geometry work.

**OCCT:** replicad's `mesh()` exposes face→triangle groups. After building, each
result face is classified by sampling its triangle centroids and testing distance to
each labeled solid's surface within tolerance — a cut face lies exactly on its
tool's surface. If a face matches multiple labeled solids (coplanar overlap), the
most recently applied label wins, deterministically. Labeled solids' geometry is
snapshotted at the moment they're consumed by a boolean (replicad transforms consume
their operand, so the label lives on the wrapper and propagates to the transformed
wrapper).

**Caching:** the label participates in the solid-cache content hash so a relabel
can't be served stale attribution. Cached display meshes carry their `featureIds`
across views like the rest of the payload.

## 3. Viewer — hover tooltip + highlight

- A `pointermove` handler on the viewer canvas, throttled to one raycast per
  animation frame, raycasts the visible sub-meshes (same set the click-picker uses).
  Hit triangle index → `featureIds[tri]` → label.
- Tooltip: a DOM element following the cursor, text **"Drainage hole · Planter"**
  (feature emphasized, sub-part secondary; sub-part only when unlabeled). Hidden
  while orbiting/dragging, when nothing is hit, and on touch pointers. Styled in
  `app.css`, theme-aware like the rest of the chrome.
- Highlight: the hovered feature's triangles (all triangles sharing its id in that
  sub-part) are extracted into an overlay `THREE.Mesh` with a tinted, slightly
  emissive material and polygon offset, shown while hovered. Overlays are cached per
  (sub-part, feature id) and invalidated when that sub-part's geometry regenerates.
- Performance: three.js raycasting is O(triangles) per frame; current part meshes
  are small enough at preview quality. If a future part makes this visible, add
  three-mesh-bvh — out of scope now.

## 4. Shared selection refactor + picker integration

- Extract the raycast logic from `selection/pick.js` into `selection/raycast.js`:
  NDC math, intersect visible sub-meshes, hit → `{ subPart, triIndex, pointLocal,
  normalLocal }`. The click-picker and the hover-labeler both consume it.
- `resolveSelection` (pure core) gains the feature: the dormant `hit.face` slot
  becomes real — `selection.feature = { label }` resolved from `triIndex` + the
  mesh's `featureIds`/`features` table.
- `formatSelection` includes the feature in all three styles. Prompt style:
  *"On sub-part **planter**, the user pointed at **Drainage hole**, local point
  (…), normal …, with params {…}."* Pick-serve agents and the clipboard copy button
  therefore emit exactly the vocabulary the tooltip teaches.

## 5. Error handling

- Part with no labels → identical to today's behavior; tooltip shows the sub-part
  label only.
- Mesh payloads without `featureIds` (stale cache entries, older workers) degrade to
  sub-part-level labels; nothing throws.
- Duplicate label within a sub-part → console warning, last-one-wins.
- OCCT face matching multiple labeled solids → most recently applied label wins.

## 6. Testing

- **Pure units:** triId → label resolution; `formatSelection` with a feature;
  duplicate-label warning; payloads missing `featureIds`.
- **Manifold backend:** build a labeled cut (box minus labeled cylinder), assert the
  hole-wall triangles are attributed to the label and outer faces to the fallback.
- **OCCT backend:** same shape, own test file via `bootOcctKernel()` (OCCT and
  Manifold must not boot in the same process).
- **Smoke:** the Playwright check gains a hover assertion on demo.html — move the
  mouse over the canvas, assert the tooltip element appears. demo.js is unlabeled,
  so the expected text is the sub-part fallback label (this doubles as a fallback
  test); planter.html can assert a real feature label if the smoke harness allows.
