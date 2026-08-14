# Measure Mode In-Scene Presentation (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace measure mode's screen-space SVG overlay with in-scene three.js dimension objects (coplanar drawings riding the parts group), per the approved v2 spec.

**Architecture:** Two new modules — `dim3-place.js` (pure placement: coplanar dims, plane snapping to true extreme vertices, camera-facing side selection with hysteresis) and `dim3-scene.js` (three.js renderer: fat lines, filled triangle arrows, in-plane canvas-texture labels with readability flips) — replace `dim-layout.js` + `dim-overlay.js`. `measure-mode.js` keeps its hover/pin/raycast pipeline and swaps its render path. `capture-overlay.js` and its exports are deleted; dims render into `captureCurrent` natively and are hidden from canonical captures.

**Tech Stack:** three.js (already a dependency — `LineSegments2`/`LineMaterial` from three/addons), vitest, happy-dom for DOM-side tests. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-08-13-measure-mode-inscene-design.md` (binding). Its §Visual language constants are normative. The v1 spec `docs/superpowers/specs/2026-08-12-measure-mode-design.md` still governs everything the v2 spec lists under "What stays". The throwaway reference implementation is `src/framework/measure/dim3-spike.js` (removed in Task 7).

## Global Constraints

- Node 24 (`source ~/.nvm/nvm.sh && nvm use` before any npm/vitest command; the default shell Node is too old).
- No new npm dependencies.
- Units are millimetres; display precision 0.01 (`fmtMm` from feature-dims.js).
- Locked visual constants (spec v2 §Visual language): line width 1.5 px; standoff `max(6, 0.10·modelSize)` mm; extension gap 1.0 mm; overshoot 1.5 mm; arrows filled flat triangles, length `0.7·clamp(0.04·span, 1.2, 3)` mm, half-width `0.25·length`; text quad height `max(3.2, 0.05·modelSize)` mm, placed outside the dim line at `0.85·textHeight`; readability-flip deadband 0.08; side-selection hysteresis 15%.
- `feature-dims.js` stays pure and worker-safe (no three/DOM/node imports). `dim3-place.js` may import three's math classes only (no DOM/GL). `test/worker-layering.test.js` must stay green.
- Dim materials are never registered with the cutaway; `depthTest: false`, `transparent: true`, renderOrder 998 (labels 999).
- Rebuild-not-per-frame: dimension objects rebuild only on mode entry, geometry regen, view switch, hover change, pin change, theme change, or a side-selection flip. Per-frame work is limited to line-material resolution, label flips, and cheap choice scoring.
- Version stays **0.54.0** (already bumped on this branch; nothing published).
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## File Structure

```
Create: src/framework/measure/dim3-place.js     pure placement engine
Create: src/framework/measure/dim3-scene.js     three.js renderer
Create: test/framework/measure/dim3-place.test.js
Create: test/framework/measure/dim3-scene.test.js
Modify: src/framework/viewer.js                 onThemeChange/getTheme + canonical-capture hidden set
Modify: test/viewer-capture.test.js             hidden-objects coverage
Modify: src/framework/measure/feature-dims.js   rimDir anchor for partial arcs
Modify: test/framework/measure/feature-dims.test.js
Modify: src/framework/measure/measure-mode.js   render path rewrite
Modify: test/framework/measure/measure-mode.test.js
Delete: src/framework/measure/dim-layout.js, dim-overlay.js, capture-overlay.js (+ their test files)
Modify: src/index.js, types/index.d.ts, src/framework/app.css, src/framework/mount.js
Delete: src/framework/measure/dim3-spike.js (+ its mount.js hook)
Modify: docs/AUTHORING-PARTS.md, AGENTS.md
```

---

### Task 1: Viewer hooks — theme-change notification + canonical-capture hidden set

**Files:**
- Modify: `src/framework/viewer.js`
- Test: `test/viewer-capture.test.js`

**Interfaces:**
- Produces: `viewer.onThemeChange(cb) -> unsubscribe` (cb receives `"dark"|"light"`), `viewer.getTheme() -> "dark"|"light"`, `viewer.registerCanonicalCaptureHidden(object3D) -> unregister`. `captureViewsFromScene` gains a `hidden` option (array of objects whose `.visible` is forced false for the pass and restored).

- [ ] **Step 1: Write the failing tests**

Append to `test/viewer-capture.test.js` (it already tests `captureViewsFromScene` with a fake renderer — follow the existing fixture style in that file for `renderer`/`liveCamera`/`grid`):

```js
describe("captureViewsFromScene hidden objects", () => {
  it("hides extras for the pass and restores them", () => {
    const calls = [];
    const renderer = { renderOffscreen: () => { calls.push({ grid: grid.visible, dim: dim.visible }); return "data:,"; } };
    const liveCamera = { position: new THREE.Vector3(1, 2, 3), aspect: 1 };
    const grid = { visible: true };
    const dim = { visible: true };
    captureViewsFromScene(["iso"], {
      renderer, liveCamera, grid, hidden: [dim],
      bounds: { center: [0, 0, 0], radius: 10 },
    });
    expect(calls[0]).toEqual({ grid: false, dim: false });
    expect(dim.visible).toBe(true);
    expect(grid.visible).toBe(true);
  });

  it("restores an already-hidden extra to hidden", () => {
    const renderer = { renderOffscreen: () => "data:," };
    const liveCamera = { position: new THREE.Vector3(0, 0, 5), aspect: 1 };
    const dim = { visible: false };
    captureViewsFromScene(["iso"], {
      renderer, liveCamera, grid: null, hidden: [dim],
      bounds: { center: [0, 0, 0], radius: 10 },
    });
    expect(dim.visible).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/viewer-capture.test.js`
Expected: FAIL (hidden option unknown; `dim.visible` stays true during the pass).

- [ ] **Step 3: Implement**

In `viewer.js`, extend `captureViewsFromScene`:

```js
export function captureViewsFromScene(viewNames, { renderer, liveCamera, grid, bounds, hidden = [] }) {
  const views = (viewNames?.length ? viewNames : ["iso", "front", "top"])
    .filter((v) => CANONICAL_VIEWS.includes(v))
    .slice(0, CANONICAL_VIEWS.length);
  const before = liveCamera.position.clone();
  const gridWasVisible = grid?.visible;
  if (grid) grid.visible = false;
  const hiddenWas = hidden.map((o) => o.visible);
  for (const o of hidden) o.visible = false;
  try {
    return views.map((view) => ({
      view,
      dataUrl: renderer.renderOffscreen(cameraPoseForView(view, bounds)),
    }));
  } finally {
    if (grid) grid.visible = gridWasVisible;
    hidden.forEach((o, i) => { o.visible = hiddenWas[i]; });
    liveCamera.position.copy(before); // belt-and-suspenders: never leak camera state
  }
}
```

Inside `createViewer`, add near the theme code:

```js
  let currentTheme = "dark";
  const themeListeners = new Set();
  function onThemeChange(cb) { themeListeners.add(cb); return () => themeListeners.delete(cb); }
```

At the end of `setTheme(mode)` (after `reassertLiveFades()`):

```js
    currentTheme = THEME[mode] ? mode : "dark";
    for (const cb of [...themeListeners]) cb(currentTheme);
```

Near the capture code, the hidden registry:

```js
  // Objects excluded from CANONICAL captures only (agent renders must stay
  // dimension-free); captureCurrent — the user-framed showcase capture —
  // deliberately does NOT consult this set.
  const canonicalCaptureHidden = new Set();
  function registerCanonicalCaptureHidden(obj) {
    canonicalCaptureHidden.add(obj);
    return () => canonicalCaptureHidden.delete(obj);
  }
```

In `captureCanonicalViews`, pass it through:

```js
    return captureViewsFromScene(viewNames, {
      renderer: { renderOffscreen },
      liveCamera: camera,
      grid,
      hidden: [...canonicalCaptureHidden],
      bounds: { center, radius },
    });
```

Add to the returned handle: `onThemeChange`, `getTheme: () => currentTheme`, `registerCanonicalCaptureHidden`. In `dispose()`, add `themeListeners.clear(); canonicalCaptureHidden.clear();` beside `frameListeners.clear()`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/viewer-capture.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/viewer.js test/viewer-capture.test.js
git commit -m "viewer: theme-change listeners + canonical-capture hidden set"
```

---

### Task 2: feature-dims — `rimDir` anchor for partial arcs

**Files:**
- Modify: `src/framework/measure/feature-dims.js:220-229` (cylinderSpec return)
- Test: `test/framework/measure/feature-dims.test.js`

**Interfaces:**
- Produces: cylinder specs gain `anchors.rimDir` — unit radial direction (geometry frame) at the angular midpoint of the wall's coverage. Present for ALL cylinder specs (full circles too — a stable default direction the placer can use when the camera looks straight down the axis).

- [ ] **Step 1: Write the failing test**

Add to the cylinder describe block in `test/framework/measure/feature-dims.test.js` (reuse the existing partial-arc fixture in that file — there is one asserting `partial: true` / `R` classification):

```js
  it("partial arc carries a rimDir pointing into the covered angular range", () => {
    const spec = classifyFeature(quarterArcMesh, 1); // existing partial-arc fixture
    expect(spec.values.partial).toBe(true);
    const { rimDir, axis, center } = spec.anchors;
    // unit length, perpendicular to the axis
    expect(Math.hypot(...rimDir)).toBeCloseTo(1, 5);
    expect(Math.abs(rimDir[0] * axis[0] + rimDir[1] * axis[1] + rimDir[2] * axis[2])).toBeLessThan(1e-6);
    // points at covered wall, not the gap: some wall vertex lies within 60° of it
    // (the quarter arc spans 90°, so its angular midpoint is ≤45° from every covered vertex)
    // — reconstruct against the fixture's vertices
  });
```

Adapt the fixture names/assertions to the file's existing helpers; the three assertions above (unit, ⊥ axis, within the covered arc) are the required coverage.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/framework/measure/feature-dims.test.js`
Expected: FAIL — `rimDir` undefined.

- [ ] **Step 3: Implement**

In `cylinderSpec`, the angular-coverage pass already computes sorted `angles` and `maxGap` starting index. Track which gap is largest, then take the angular midpoint of the COVERED span (the complement of the largest gap):

```js
  let maxGap = 2 * Math.PI + angles[0] - angles[angles.length - 1];
  let gapEnd = angles[0]; // angle where the covered span begins (after the gap)
  for (let i = 1; i < angles.length; i++) {
    const g = angles[i] - angles[i - 1];
    if (g > maxGap) { maxGap = g; gapEnd = angles[i]; }
  }
  const coverageDeg = 360 - (maxGap * 180) / Math.PI;
  // Radial direction at the angular midpoint of the covered span — where the
  // wall actually is; the placer hangs R-leaders (and degenerate-view ⌀ dims)
  // off it so they always spring from real surface.
  const midAngle = gapEnd + (2 * Math.PI - maxGap) / 2;
  const rimDir = norm(add(scale(u, Math.cos(midAngle)), scale(v, Math.sin(midAngle))));
```

(`u`/`v` are the existing radial basis used for `angles`.) Add `rimDir: rimDir.map(q2)` to the returned `anchors`. Update the spec-shape comment at the top of the file (line ~10) to include `rimDir`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/framework/measure/feature-dims.test.js`
Expected: PASS (including all pre-existing cylinder tests — `rimDir` is additive).

- [ ] **Step 5: Commit**

```bash
git add src/framework/measure/feature-dims.js test/framework/measure/feature-dims.test.js
git commit -m "feature-dims: rimDir anchor at the covered-arc midpoint"
```

---

### Task 3: `dim3-place.js` — pure placement engine

**Files:**
- Create: `src/framework/measure/dim3-place.js`
- Test: `test/framework/measure/dim3-place.test.js`

**Interfaces:**
- Consumes: specs from `feature-dims.js` (`bbox`/`plane`/`cylinder` shapes, anchors already transformed into the parts frame by the caller), `fmtMm`.
- Produces (consumed by Task 4's renderer and Task 5's orchestrator):

```js
evaluateChoices(items, { camPos, center, prev }) -> choices   // cheap, per-frame safe
placeDims(items, { meshData, surfaceHit, bounds }, choices) -> drawings

// items: [{ id, tier: "static"|"hover"|"pinned", pinned?, spec, paramName, meshes?: number[] }]
//   `meshes` = indices into meshData eligible for the extreme-vertex scan
//   (overall item: all; sub-part bbox item: that mesh; feature items: omit).
// choices: plain object keyed `${itemId}|${dimKey}` -> { key, score } (or { du: [x,y,z] } for cylinders)
// drawings: [{ itemId, tier, pinned, segments: number[], triangles: number[],
//              labels: [{ text, param, center:[3], x:[3], y:[3], h }] }]
// meshData: [{ positions: Float32Array, matrix: THREE.Matrix4 }]
// surfaceHit: (origin: THREE.Vector3, dir: THREE.Vector3) -> THREE.Vector3|null   (parts frame)
```

- [ ] **Step 1: Write the implementation**

Create `src/framework/measure/dim3-place.js`:

```js
// Pure in-scene dimension placement (spec v2 §Placement). Everything works in
// the PARTS frame — the meshes' shared parent group (delivered geometry
// composed with pose matrices) — so the resulting drawing rides the pivot
// rotation and per-view recentring untouched. No DOM, no GL, no rendering
// objects: three's math classes only, so this runs under plain vitest.
//
// Split in two so the orchestrator can score cheaply every frame and rebuild
// rarely: evaluateChoices() is dot-products + hysteresis over the previous
// choices; placeDims() does the real work (vertex scans, raycasts, geometry)
// only when a choice flipped or the scene changed.
import * as THREE from "three";
import { fmtMm } from "./feature-dims.js";

// --- locked visual constants (spec v2 §Visual language) ----------------------
export const GAP = 1.0;          // mm, surface-contact point -> extension line
export const OVERSHOOT = 1.5;    // mm, extension line past the dim line
export const HYSTERESIS = 1.15;  // challenger must beat the holder by 15%
export const FLIP_DEADBAND_DEG = 25; // cylinder ⌀ direction re-aim threshold
export const standoff = (modelSize) => Math.max(6, modelSize * 0.10);
export const arrowLen = (span) => 0.7 * Math.min(3, Math.max(1.2, span * 0.04));
export const ARROW_HALF_W = 0.25; // × arrow length
export const textHeight = (modelSize) => Math.max(3.2, modelSize * 0.05);

const AXES = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
];
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

// --- candidate sides for a box-extent dim ------------------------------------
// Measuring along `axis`, the dim can extend outward along ± each of the other
// two axes; the plane normal is the remaining axis. Keys are stable across
// frames so hysteresis can hold a choice.
function boxCandidates(axis) {
  const others = [0, 1, 2].filter((i) => i !== axis);
  const out = [];
  for (const extAxis of others) {
    const nAxis = others.find((i) => i !== extAxis);
    for (const sign of [1, -1]) out.push({ key: `e${extAxis}s${sign}`, extAxis, sign, nAxis });
  }
  return out;
}

function scoreCandidate(ext, n, toCam) {
  // favour extending toward the viewer; favour a plane the viewer sees face-on
  return 0.6 * Math.max(0, ext.dot(toCam)) + 0.4 * Math.abs(n.dot(toCam));
}

// Hold the previous choice unless a challenger beats it by HYSTERESIS.
function chooseWithHysteresis(scored, prevKey) {
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const prev = prevKey != null ? scored.find((s) => s.key === prevKey) : null;
  if (prev && best.key !== prev.key && best.score < prev.score * HYSTERESIS) return prev;
  return best;
}

// --- per-frame-cheap choice scoring ------------------------------------------
export function evaluateChoices(items, { camPos, center, prev = {} }) {
  const cam = v3(camPos);
  const toCam = cam.clone().sub(v3(center)).normalize();
  const choices = {};
  for (const item of items) {
    const spec = item.spec;
    if (spec.kind === "bbox") {
      for (const axis of [0, 1, 2]) {
        const ck = `${item.id}|ax${axis}`;
        const scored = boxCandidates(axis).map((c) => ({
          ...c,
          score: scoreCandidate(AXES[c.extAxis].clone().multiplyScalar(c.sign), AXES[c.nAxis], toCam),
        }));
        choices[ck] = { key: chooseWithHysteresis(scored, prev[ck]?.key).key };
      }
    } else if (spec.kind === "plane") {
      const n = v3(spec.anchors.normal).normalize();
      for (const dimKey of ["width", "height"]) {
        const { a, b } = spec.anchors[dimKey];
        const dir = v3(b).sub(v3(a)).normalize();
        const perp = new THREE.Vector3().crossVectors(n, dir).normalize();
        const ck = `${item.id}|${dimKey}`;
        const scored = [
          { key: "p+", sign: 1, score: scoreCandidate(perp, n, toCam) },
          { key: "p-", sign: -1, score: scoreCandidate(perp.clone().negate(), n, toCam) },
        ];
        choices[ck] = { key: chooseWithHysteresis(scored, prev[ck]?.key).key };
      }
    } else if (spec.kind === "cylinder") {
      // ⌀/R direction: radial component of the view direction, re-aimed only
      // past the deadband so the drawing doesn't chase every orbit degree.
      const axis = v3(spec.anchors.axis).normalize();
      const toCamHere = cam.clone().sub(v3(spec.anchors.center)).normalize();
      let du = toCamHere.clone().addScaledVector(axis, -toCamHere.dot(axis));
      if (du.lengthSq() < 1e-6) du = v3(spec.anchors.rimDir ?? [1, 0, 0]);
      du.normalize();
      const ck = `${item.id}|du`;
      const prevDu = prev[ck]?.du ? v3(prev[ck].du) : null;
      const hold = prevDu && du.angleTo(prevDu) < (FLIP_DEADBAND_DEG * Math.PI) / 180;
      choices[ck] = { du: (hold ? prevDu : du).toArray() };
      // depth dim side: ± the chosen du (in the plane containing the axis)
      const dck = `${item.id}|depth`;
      const duHeld = hold ? prevDu : du;
      const scored = [
        { key: "d+", score: scoreCandidate(duHeld, axis, toCamHere) },
        { key: "d-", score: scoreCandidate(duHeld.clone().negate(), axis, toCamHere) },
      ];
      choices[dck] = { key: chooseWithHysteresis(scored, prev[dck]?.key).key, du: duHeld.toArray() };
    }
  }
  return choices;
}

export function choicesEqual(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const x = a[k], y = b[k];
    if (!y) return false;
    if (x.key !== y.key) return false;
    if (!!x.du !== !!y.du) return false;
    if (x.du && (x.du[0] !== y.du[0] || x.du[1] !== y.du[1] || x.du[2] !== y.du[2])) return false;
  }
  return true;
}

// --- extreme vertex scan ------------------------------------------------------
// The vertex realizing the extreme along `axis` over the posed meshes; ties
// within tolerance (a flat base is all "the minimum") break toward `near`, so
// the anchor lands on the side of the part the dimension is drawn on.
const _sv = new THREE.Vector3();
export function extremeVertex(meshData, axis, sign, near) {
  let bestVal = sign > 0 ? -Infinity : Infinity;
  for (const { positions, matrix } of meshData) {
    for (let i = 0; i < positions.length; i += 3) {
      _sv.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(matrix);
      const val = _sv.getComponent(axis);
      if (sign > 0 ? val > bestVal : val < bestVal) bestVal = val;
    }
  }
  if (!Number.isFinite(bestVal)) return null;
  let best = null, bestD = Infinity;
  for (const { positions, matrix } of meshData) {
    for (let i = 0; i < positions.length; i += 3) {
      _sv.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(matrix);
      if (Math.abs(_sv.getComponent(axis) - bestVal) > 1e-3) continue;
      const d = _sv.distanceToSquared(near);
      if (d < bestD) { bestD = d; best = _sv.clone(); }
    }
  }
  return best;
}

// --- one flat linear dimension ------------------------------------------------
// pA/pB: surface anchor points. da/db: dim-line endpoints. ext: unit in-plane
// outward direction. All coplanar by the time this runs. When `surfaceHit` is
// given, each extension line starts at the first in-plane surface hit walking
// from the dim-line endpoint back toward the part (ray nudged `nudge` inside
// the extreme plane so a grazing ray on the extreme face still registers);
// otherwise (feature dims — anchors already ON the surface) it starts at the
// anchor.
function linearDim(out, { pA, pB, da, db, ext, text, param, modelSize, surfaceHit, planeAxis, planeC }) {
  const dir = db.clone().sub(da).normalize();
  const span = db.distanceTo(da);
  const aLen = arrowLen(span);

  for (const [p, d, inwardSign] of [[pA, da, 1], [pB, db, -1]]) {
    let start = p;
    if (surfaceHit) {
      const nudged = d.clone().addScaledVector(dir, 0.05 * inwardSign);
      const toward = p.clone().sub(d).normalize();
      const hit = surfaceHit(nudged, toward);
      if (hit) {
        start = hit.clone();
        if (planeAxis != null) start.setComponent(planeAxis, planeC); // stay exactly coplanar
      }
    }
    const u = d.clone().sub(start);
    const un = u.lengthSq() > 1e-12 ? u.normalize() : ext.clone();
    const s = start.clone().addScaledVector(un, GAP);
    const e = d.clone().addScaledVector(un, OVERSHOOT);
    out.segments.push(s.x, s.y, s.z, e.x, e.y, e.z);
  }

  // dim line, inset so it never pokes through the arrowheads
  const dA = da.clone().addScaledVector(dir, aLen);
  const dB = db.clone().addScaledVector(dir, -aLen);
  out.segments.push(dA.x, dA.y, dA.z, dB.x, dB.y, dB.z);
  arrow(out, da, dir, ext, aLen);
  arrow(out, db, dir.clone().negate(), ext, aLen);

  const h = textHeight(modelSize);
  const mid = da.clone().add(db).multiplyScalar(0.5);
  const center = mid.clone().addScaledVector(ext, h * 0.85); // OUTSIDE the line
  out.labels.push({
    text, param: param ?? null,
    center: center.toArray(), x: dir.toArray(), y: ext.clone().negate().toArray(), h,
  });
}

// Filled flat triangle lying in the dim plane: tip on the endpoint, base
// toward the line's centre, spread along the in-plane perpendicular.
function arrow(out, tip, inward, perp, len) {
  const base = tip.clone().addScaledVector(inward, len);
  const halfW = len * ARROW_HALF_W;
  const p1 = base.clone().addScaledVector(perp, halfW);
  const p2 = base.clone().addScaledVector(perp, -halfW);
  out.triangles.push(tip.x, tip.y, tip.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
}

// --- per-kind placement -------------------------------------------------------
function placeBox(out, item, spec, choices, { meshData, surfaceHit, modelSize }, camAidedRefSide) {
  const min = spec.anchors.min, max = spec.anchors.max;
  const off = standoff(modelSize);
  const scan = meshData; // caller pre-filtered by item.meshes
  const valueByAxis = [spec.values.w, spec.values.d, spec.values.h];
  for (const axis of [0, 1, 2]) {
    const span = max[axis] - min[axis];
    if (span < 1e-6) continue;
    const cand = boxCandidates(axis).find((c) => c.key === choices[`${item.id}|ax${axis}`]?.key)
      ?? boxCandidates(axis)[0];
    const { extAxis, sign, nAxis } = cand;
    const ext = AXES[extAxis].clone().multiplyScalar(sign);
    // dim-line endpoints: measured coordinate at min/max, ext coordinate at the
    // near face + standoff; the plane coordinate (nAxis) is snapped below.
    const extBase = sign > 0 ? max[extAxis] : min[extAxis];
    const mk = (m) => {
      const p = new THREE.Vector3();
      p.setComponent(axis, m);
      p.setComponent(extAxis, extBase + sign * off);
      p.setComponent(nAxis, camAidedRefSide(nAxis, min, max));
      return p;
    };
    const da = mk(min[axis]), db = mk(max[axis]);
    // true extreme anchors (tie-break toward the dim line), then plane snap:
    // slide the plane along nAxis to whichever anchor sits nearer the camera
    // side; the other anchor projects into the plane.
    const ref = camAidedRefSide(nAxis, min, max);
    let pA = extremeVertex(scan, axis, -1, da) ?? new THREE.Vector3().setComponent(axis, min[axis]);
    let pB = extremeVertex(scan, axis, +1, db) ?? new THREE.Vector3().setComponent(axis, max[axis]);
    const cA = pA.getComponent(nAxis), cB = pB.getComponent(nAxis);
    const c = Math.abs(cA - ref) <= Math.abs(cB - ref) ? cA : cB;
    for (const p of [pA, pB, da, db]) p.setComponent(nAxis, c);
    linearDim(out, {
      pA, pB, da, db, ext,
      text: `${fmtMm(valueByAxis[axis])} mm`, param: item.paramName,
      modelSize, surfaceHit, planeAxis: nAxis, planeC: c,
    });
  }
}

function placePlane(out, item, spec, choices, { modelSize }) {
  const n = v3(spec.anchors.normal).normalize();
  const off = standoff(modelSize) * 0.5; // feature dims hug their feature
  const dims = [
    ["width", spec.values.width],
    ["height", spec.values.height],
  ];
  for (const [dimKey, value] of dims) {
    if (value < 1e-6) continue;
    const a = v3(spec.anchors[dimKey].a), b = v3(spec.anchors[dimKey].b);
    const dir = b.clone().sub(a).normalize();
    const perp = new THREE.Vector3().crossVectors(n, dir).normalize();
    const sign = choices[`${item.id}|${dimKey}`]?.key === "p-" ? -1 : 1;
    const ext = perp.multiplyScalar(sign);
    const da = a.clone().addScaledVector(ext, off);
    const db = b.clone().addScaledVector(ext, off);
    linearDim(out, {
      pA: a, pB: b, da, db, ext,
      text: `${fmtMm(value)} mm`, param: item.paramName, modelSize, surfaceHit: null,
    });
  }
}

function placeCylinder(out, item, spec, choices, { modelSize }) {
  const axis = v3(spec.anchors.axis).normalize();
  const top = v3(spec.anchors.top);
  const bottom = v3(spec.anchors.bottom);
  const r = spec.values.diameter / 2;
  const du = v3(choices[`${item.id}|du`]?.du ?? spec.anchors.rimDir ?? [1, 0, 0]).normalize();
  const dv = new THREE.Vector3().crossVectors(axis, du).normalize();
  const h = textHeight(modelSize);

  if (spec.values.partial) {
    // R leader from the covered-arc midpoint, radial, in the top plane
    const rim = top.clone().addScaledVector(v3(spec.anchors.rimDir ?? du.toArray()), r);
    const rd = v3(spec.anchors.rimDir ?? du.toArray()).normalize();
    const leaderLen = h * 2;
    const s = rim.clone().addScaledVector(rd, GAP);
    const e = rim.clone().addScaledVector(rd, GAP + leaderLen);
    out.segments.push(s.x, s.y, s.z, e.x, e.y, e.z);
    arrow(out, rim, rd, new THREE.Vector3().crossVectors(axis, rd).normalize(), arrowLen(r * 2));
    out.labels.push({
      text: `R${fmtMm(r)}`, param: item.paramName,
      center: e.clone().addScaledVector(rd, h * 0.85).toArray(),
      x: new THREE.Vector3().crossVectors(axis, rd).normalize().toArray(),
      y: rd.clone().negate().toArray(), h,
    });
  } else {
    // full circle: diameter line across the top circle, arrows outward at both
    // rim points, ⌀ text just outside the rim
    const rimA = top.clone().addScaledVector(du, r);
    const rimB = top.clone().addScaledVector(du, -r);
    const aLen = arrowLen(2 * r);
    const iA = rimA.clone().addScaledVector(du, -aLen);
    const iB = rimB.clone().addScaledVector(du, aLen);
    out.segments.push(iA.x, iA.y, iA.z, iB.x, iB.y, iB.z);
    arrow(out, rimA, du.clone().negate(), dv, aLen);
    arrow(out, rimB, du, dv, aLen);
    out.labels.push({
      text: `⌀${fmtMm(spec.values.diameter)}`, param: item.paramName,
      center: rimA.clone().addScaledVector(du, h * 0.85).toArray(),
      x: dv.toArray(), y: du.clone().negate().toArray(), h,
    });
  }

  // depth: linear dim along the axis, hung off the silhouette at the chosen side
  if (spec.values.depth > 1e-6) {
    const sgn = choices[`${item.id}|depth`]?.key === "d-" ? -1 : 1;
    const ext = du.clone().multiplyScalar(sgn);
    const off = standoff(modelSize) * 0.5;
    const pA = bottom.clone().addScaledVector(ext, r);
    const pB = top.clone().addScaledVector(ext, r);
    const da = pA.clone().addScaledVector(ext, off);
    const db = pB.clone().addScaledVector(ext, off);
    linearDim(out, {
      pA, pB, da, db, ext,
      text: `${fmtMm(spec.values.depth)} mm`, param: item.paramName,
      modelSize, surfaceHit: null,
    });
  }
}

// --- entry point --------------------------------------------------------------
export function placeDims(items, { meshData = [], surfaceHit = null, bounds }, choices) {
  const size = bounds
    ? Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2])
    : 10;
  // plane-snap reference: the nAxis face nearer the camera is unknowable here
  // (no camera) — the caller folded it into choices via ext side selection, so
  // use the face on the chosen ext side's half. Deterministic and adequate:
  // spec only requires "the side of the model the dim is drawn toward".
  const drawings = [];
  for (const item of items) {
    const spec = item.spec;
    if (!spec) continue;
    const out = { itemId: item.id, tier: item.tier, pinned: !!item.pinned, segments: [], triangles: [], labels: [] };
    const scan = item.meshes ? item.meshes.map((i) => meshData[i]).filter(Boolean) : meshData;
    if (spec.kind === "bbox") {
      const refSide = (nAxis, min, max) => {
        // draw-side reference along the plane normal: mid-plane — the snap then
        // picks whichever anchor is nearer the model's middle along n, keeping
        // the drawing close to where the extent actually occurs.
        return (min[nAxis] + max[nAxis]) / 2;
      };
      placeBox(out, item, spec, choices, { meshData: scan, surfaceHit, modelSize: size }, refSide);
    } else if (spec.kind === "plane") {
      placePlane(out, item, spec, choices, { modelSize: size });
    } else if (spec.kind === "cylinder") {
      placeCylinder(out, item, spec, choices, { modelSize: size });
    }
    if (out.segments.length || out.labels.length) drawings.push(out);
  }
  return drawings;
}
```

- [ ] **Step 2: Write the tests**

Create `test/framework/measure/dim3-place.test.js`:

```js
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  evaluateChoices, choicesEqual, placeDims, extremeVertex,
  GAP, OVERSHOOT, HYSTERESIS, standoff, arrowLen, ARROW_HALF_W, textHeight,
} from "../../../src/framework/measure/dim3-place.js";
import { bboxSpec } from "../../../src/framework/measure/feature-dims.js";

// a 10×20×30 box as a soup of its 8 corners (enough for extreme scans)
function boxMeshData(min = [0, 0, 0], max = [10, 20, 30]) {
  const pts = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]])
    pts.push(x, y, z);
  return [{ positions: new Float32Array(pts), matrix: new THREE.Matrix4() }];
}
const CENTER = [5, 10, 15];

function overallItem() {
  return { id: "overall", tier: "static", spec: bboxSpec([0, 0, 0], [10, 20, 30]), meshes: [0] };
}

describe("evaluateChoices", () => {
  it("extends bbox dims toward the camera", () => {
    const c = evaluateChoices([overallItem()], { camPos: [5, -100, 15], center: CENTER, prev: {} });
    // measuring X: camera at -Y → ext should be -Y (extAxis 1, sign -1)
    expect(c["overall|ax0"].key).toBe("e1s-1");
  });

  it("holds the previous side within hysteresis", () => {
    const prev = evaluateChoices([overallItem()], { camPos: [5, -100, 15], center: CENTER, prev: {} });
    // nudge the camera slightly past the diagonal — not enough to beat 15%
    const near = evaluateChoices([overallItem()], { camPos: [5, -100, 30], center: CENTER, prev });
    expect(near["overall|ax0"].key).toBe(prev["overall|ax0"].key);
    // an opposite camera MUST flip
    const far = evaluateChoices([overallItem()], { camPos: [5, 100, 15], center: CENTER, prev });
    expect(far["overall|ax0"].key).toBe("e1s1");
  });

  it("choicesEqual detects change and sameness", () => {
    const a = evaluateChoices([overallItem()], { camPos: [5, -100, 15], center: CENTER, prev: {} });
    const b = evaluateChoices([overallItem()], { camPos: [5, -100, 15], center: CENTER, prev: a });
    expect(choicesEqual(a, b)).toBe(true);
    const c = evaluateChoices([overallItem()], { camPos: [5, 100, 15], center: CENTER, prev: {} });
    expect(choicesEqual(a, c)).toBe(false);
  });

  it("cylinder du holds within the deadband and re-aims past it", () => {
    const spec = {
      kind: "cylinder",
      values: { diameter: 8, depth: 10, partial: false },
      anchors: { center: [0, 0, 5], axis: [0, 0, 1], top: [0, 0, 10], bottom: [0, 0, 0], rimDir: [1, 0, 0] },
    };
    const item = { id: "h", tier: "hover", spec };
    const a = evaluateChoices([item], { camPos: [100, 0, 5], center: [0, 0, 5], prev: {} });
    expect(a["h|du"].du[0]).toBeCloseTo(1, 5);
    // 10° away: held
    const b = evaluateChoices([item], { camPos: [100, 18, 5], center: [0, 0, 5], prev: a });
    expect(b["h|du"].du[0]).toBeCloseTo(1, 5);
    // 90° away: re-aimed
    const c = evaluateChoices([item], { camPos: [0, 100, 5], center: [0, 0, 5], prev: a });
    expect(c["h|du"].du[1]).toBeCloseTo(1, 5);
  });
});

describe("extremeVertex", () => {
  it("finds the posed extreme and tie-breaks toward `near`", () => {
    const md = boxMeshData();
    const nearFront = new THREE.Vector3(10, 0, 0);
    const p = extremeVertex(md, 0, +1, nearFront); // max X, tied across 4 corners
    expect(p.x).toBe(10);
    expect(p.y).toBe(0); // tie broken toward y=0, z=0
    expect(p.z).toBe(0);
  });

  it("applies the pose matrix", () => {
    const md = boxMeshData();
    md[0].matrix = new THREE.Matrix4().makeTranslation(100, 0, 0);
    const p = extremeVertex(md, 0, +1, new THREE.Vector3(110, 0, 0));
    expect(p.x).toBe(110);
  });
});

describe("placeDims — bbox", () => {
  function place(camPos = [5, -100, 15]) {
    const items = [overallItem()];
    const choices = evaluateChoices(items, { camPos, center: CENTER, prev: {} });
    return placeDims(items, {
      meshData: boxMeshData(), surfaceHit: null,
      bounds: { min: [0, 0, 0], max: [10, 20, 30] },
    }, choices)[0];
  }

  it("emits three linear dims with drafting anatomy", () => {
    const d = place();
    // 3 axes × 3 segments (2 extension + 1 dim line), 6 xyz numbers each
    expect(d.segments.length).toBe(3 * 3 * 6);
    // 3 axes × 2 arrows × 9 numbers
    expect(d.triangles.length).toBe(3 * 2 * 9);
    expect(d.labels.map((l) => l.text).sort()).toEqual(["10.00 mm", "20.00 mm", "30.00 mm"]);
  });

  it("is coplanar per dim and the label sits outside the dim line", () => {
    const d = place();
    const label = d.labels.find((l) => l.text === "10.00 mm"); // X extent
    // X dim, camera at -Y → ext = -Y: label center y must be OUTSIDE (below) min.y - standoff
    const off = standoff(30);
    expect(label.center[1]).toBeLessThan(0 - off);
    // y direction points back toward the line (+Y)
    expect(label.y[1]).toBeCloseTo(1, 5);
  });

  it("starts extension lines at the surfaceHit point when provided", () => {
    const items = [overallItem()];
    const choices = evaluateChoices(items, { camPos: [5, -100, 15], center: CENTER, prev: {} });
    const hitPoint = new THREE.Vector3(2, 0, 0);
    const d = placeDims(items, {
      meshData: boxMeshData(),
      surfaceHit: () => hitPoint,
      bounds: { min: [0, 0, 0], max: [10, 20, 30] },
    }, choices)[0];
    // every extension start is GAP away from a snapped copy of hitPoint —
    // just assert none starts at the raw bbox corner ± GAP along ext:
    // the first segment's start must derive from (2, …) not (0, …)
    const firstStartX = d.segments[0];
    expect(Math.abs(firstStartX - 2)).toBeLessThanOrEqual(GAP + 1e-6);
  });

  it("respects locked constants", () => {
    expect(standoff(100)).toBe(10);
    expect(standoff(10)).toBe(6);
    expect(arrowLen(100)).toBeCloseTo(2.1, 6); // 0.7 × 3 (clamped)
    expect(arrowLen(10)).toBeCloseTo(0.7 * 1.2, 6);
    expect(ARROW_HALF_W).toBe(0.25);
    expect(textHeight(100)).toBe(5);
    expect(textHeight(10)).toBe(3.2);
    expect(GAP).toBe(1.0);
    expect(OVERSHOOT).toBe(1.5);
    expect(HYSTERESIS).toBe(1.15);
  });
});

describe("placeDims — plane and cylinder", () => {
  it("plane emits width+height dims in the face plane", () => {
    const spec = {
      kind: "plane",
      values: { width: 10, height: 5 },
      anchors: {
        width: { a: [0, 0, 0], b: [10, 0, 0] },
        height: { a: [10, 0, 0], b: [10, 0, 5] },
        normal: [0, -1, 0],
      },
    };
    const item = { id: "h", tier: "hover", spec };
    const choices = evaluateChoices([item], { camPos: [5, -50, 2], center: [5, 0, 2], prev: {} });
    const d = placeDims([item], { bounds: { min: [0, 0, 0], max: [10, 0, 5] } }, choices)[0];
    expect(d.labels.map((l) => l.text).sort()).toEqual(["10.00 mm", "5.00 mm"]);
    // all points share y=0 plane-family? width dim's ext lies IN the face plane
    // (normal -Y): no segment point may leave y = 0 by more than standoff — the
    // real assertion: every y coordinate is 0 (the face plane), since ext ⊥ normal
    for (let i = 1; i < d.segments.length; i += 3) expect(d.segments[i]).toBeCloseTo(0, 6);
  });

  it("full cylinder emits ⌀ across the circle + a depth dim; partial emits R leader", () => {
    const full = {
      kind: "cylinder",
      values: { diameter: 8, depth: 10, partial: false },
      anchors: { center: [0, 0, 5], axis: [0, 0, 1], top: [0, 0, 10], bottom: [0, 0, 0], rimDir: [1, 0, 0] },
    };
    const item = { id: "h", tier: "hover", spec: full };
    const choices = evaluateChoices([item], { camPos: [100, 0, 5], center: [0, 0, 5], prev: {} });
    const d = placeDims([item], { bounds: { min: [-4, -4, 0], max: [4, 4, 10] } }, choices)[0];
    expect(d.labels.some((l) => l.text === "⌀8.00")).toBe(true);
    expect(d.labels.some((l) => l.text === "10.00 mm")).toBe(true);

    const part = { ...full, values: { ...full.values, partial: true } };
    const d2 = placeDims([{ id: "h", tier: "hover", spec: part }], { bounds: { min: [-4, -4, 0], max: [4, 4, 10] } }, choices)[0];
    expect(d2.labels.some((l) => l.text === "R4.00")).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run test/framework/measure/dim3-place.test.js`
Expected: PASS. Iterate on the implementation until green — the tests are the contract; do not weaken assertions to pass.

- [ ] **Step 4: Full suite sanity**

Run: `npx vitest run test/worker-layering.test.js`
Expected: PASS (dim3-place is not in the worker graph).

- [ ] **Step 5: Commit**

```bash
git add src/framework/measure/dim3-place.js test/framework/measure/dim3-place.test.js
git commit -m "measure: dim3-place pure in-scene placement engine"
```

---

### Task 4: `dim3-scene.js` — three.js renderer

**Files:**
- Create: `src/framework/measure/dim3-scene.js`
- Test: `test/framework/measure/dim3-scene.test.js`

**Interfaces:**
- Consumes: `drawings` from `placeDims` (Task 3), `viewer` internals (`_subMeshes` for the parent group, `camera`, `domElement`, `registerCanonicalCaptureHidden`).
- Produces:

```js
createDimScene(viewer, { paintLabel } = {}) -> {
  update(drawings),          // rebuild scene objects from a placement
  tick(),                    // per-frame: line resolution + label readability flips
  pickLabel(clientX, clientY) -> itemId|null,
  setTheme(mode),            // re-color materials, repaint labels
  clear(),                   // drop all drawings (mode off)
  group,                     // the THREE.Group (for tests / capture hiding)
  dispose(),
}
```

- [ ] **Step 1: Write the implementation**

Create `src/framework/measure/dim3-scene.js`:

```js
// In-scene dimension renderer (spec v2). Renders dim3-place drawings as
// three.js objects parented under the meshes' shared group, so the pivot
// rotation, per-view recentring and pose fast path apply for free. Text is
// painted onto canvas textures by an injectable painter (tests inject a fake;
// happy-dom has no real 2d context). Dims draw over the model
// (depthTest:false), are never cutaway-clipped (materials deliberately NOT
// registered with the cutaway), and are hidden from canonical captures.
import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

// Theme palettes for dimension ink. Deliberately hardcoded (not CSS vars):
// the scene renders to WebGL where var() can't reach, and these pair with the
// viewer THEME backgrounds. static = always-on overall dims; strong = hover +
// pinned; accent = param-linked label pill (mirrors --pf-accent).
export const DIM_THEME = {
  dark: {
    static: 0x7d93b8, strong: 0xa8c2ff,
    text: "#c9d9ff", halo: "rgba(10, 14, 20, 0.9)",
    accent: "#4da3ff", pillBg: "rgba(26, 30, 36, 0.88)",
  },
  light: {
    static: 0x5a6c8a, strong: 0x2c4a86,
    text: "#2c4a86", halo: "rgba(244, 247, 251, 0.9)",
    accent: "#1f6fd6", pillBg: "rgba(255, 255, 255, 0.88)",
  },
};

export const RENDER_ORDER_DIMS = 998;
export const RENDER_ORDER_LABELS = 999;

// Default label painter: returns a canvas whose aspect the caller turns into
// a plane. Pure DOM-canvas; swapped out in tests.
export function defaultPaintLabel({ text, param, palette }) {
  const font = "700 96px ui-monospace, Menlo, monospace";
  const paramFont = "600 60px ui-monospace, Menlo, monospace";
  const c = document.createElement("canvas");
  let ctx = c.getContext("2d");
  ctx.font = font;
  const wText = Math.ceil(ctx.measureText(text).width);
  ctx.font = paramFont;
  const wParam = param ? Math.ceil(ctx.measureText(param).width) + 24 : 0;
  const PAD = 20;
  c.width = wText + wParam + PAD * 2;
  c.height = 128;
  ctx = c.getContext("2d");
  if (param) {
    // param-linked pill: rounded accent-bordered background (v1's one loud element)
    ctx.fillStyle = palette.pillBg;
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(4, 8, c.width - 8, c.height - 16, 24);
    ctx.fill();
    ctx.stroke();
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.font = font;
  if (!param) {
    ctx.strokeStyle = palette.halo; // halo so bare text reads on the part body
    ctx.lineWidth = 10;
    ctx.strokeText(text, PAD, c.height / 2);
  }
  ctx.fillStyle = palette.text;
  ctx.fillText(text, PAD, c.height / 2);
  if (param) {
    ctx.font = paramFont;
    ctx.fillStyle = palette.accent;
    ctx.fillText(param, PAD + wText + 24, c.height / 2);
  }
  return c;
}

export function createDimScene(viewer, { paintLabel = defaultPaintLabel } = {}) {
  const group = new THREE.Group();
  group.name = "pf-dims";
  let attached = false;
  let unregisterCapture = () => {};
  function ensureAttached() {
    if (attached) return true;
    const parent = Object.values(viewer._subMeshes)[0]?.parent;
    if (!parent) return false;
    parent.add(group);
    unregisterCapture = viewer.registerCanonicalCaptureHidden?.(group) ?? (() => {});
    attached = true;
    return true;
  }

  let theme = viewer.getTheme?.() ?? "dark";
  const lineMats = {
    static: new LineMaterial({ color: DIM_THEME[theme].static, linewidth: 1.5 }),
    strong: new LineMaterial({ color: DIM_THEME[theme].strong, linewidth: 1.5 }),
  };
  const fillMats = {
    static: new THREE.MeshBasicMaterial({ color: DIM_THEME[theme].static, side: THREE.DoubleSide }),
    strong: new THREE.MeshBasicMaterial({ color: DIM_THEME[theme].strong, side: THREE.DoubleSide }),
  };
  for (const m of [...Object.values(lineMats), ...Object.values(fillMats)]) {
    m.depthTest = false;
    m.transparent = true; // draw in the late pass so depthTest:false lands on top
  }

  const matFor = (tier) => (tier === "static" ? "static" : "strong");

  // ---- label bookkeeping ----------------------------------------------------
  // labels: [{ mesh, baseQuat, mirrored, flipped, itemId }]
  let labels = [];
  const textureCache = new Map(); // `${theme}|${param ?? ""}|${text}` -> THREE.CanvasTexture

  function labelTexture(text, param) {
    const key = `${theme}|${param ?? ""}|${text}`;
    let tex = textureCache.get(key);
    if (!tex) {
      const canvas = paintLabel({ text, param, palette: DIM_THEME[theme] });
      tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8; // keep glancing-angle text legible
      textureCache.set(key, tex);
    }
    return tex;
  }

  function buildLabel(l, itemId) {
    const tex = labelTexture(l.text, l.param);
    const img = tex.image;
    const aspect = img && img.height ? img.width / img.height : 4;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(l.h * aspect, l.h),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, side: THREE.DoubleSide }),
    );
    mesh.renderOrder = RENDER_ORDER_LABELS;
    const x = new THREE.Vector3(...l.x), y = new THREE.Vector3(...l.y);
    const z = new THREE.Vector3().crossVectors(x, y).normalize();
    const baseQuat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    mesh.quaternion.copy(baseQuat);
    mesh.position.set(...l.center);
    mesh.userData.pfDimItemId = itemId;
    group.add(mesh);
    labels.push({ mesh, baseQuat, mirrored: false, flipped: false, itemId });
  }

  // ---- build / clear --------------------------------------------------------
  function disposeChildren() {
    for (const child of [...group.children]) {
      group.remove(child);
      child.geometry?.dispose?.();
      // label materials are per-mesh clones; textures live in the cache
      if (child.material && !Object.values(lineMats).includes(child.material)
          && !Object.values(fillMats).includes(child.material)) {
        child.material.dispose?.();
      }
    }
    labels = [];
  }

  function update(drawings) {
    if (!ensureAttached()) return;
    disposeChildren();
    for (const d of drawings) {
      const key = matFor(d.tier);
      if (d.segments.length) {
        const g = new LineSegmentsGeometry();
        g.setPositions(d.segments);
        const lines = new LineSegments2(g, lineMats[key]);
        lines.renderOrder = RENDER_ORDER_DIMS;
        group.add(lines);
      }
      if (d.triangles.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(d.triangles), 3));
        const mesh = new THREE.Mesh(g, fillMats[key]);
        mesh.renderOrder = RENDER_ORDER_DIMS;
        group.add(mesh);
      }
      for (const l of d.labels) buildLabel(l, d.itemId);
    }
  }

  // ---- per-frame: resolution + readability flips ----------------------------
  // Labels correct among four in-plane states so they never read mirrored or
  // upside down: Ry(π) fixes viewing the plane from behind, Rz(π) fixes the
  // reading direction. 0.08 deadband stops edge-on flicker.
  const QY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  const QZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
  const _gq = new THREE.Quaternion();
  const _wq = new THREE.Quaternion();
  const _iq = new THREE.Quaternion();
  const _n = new THREE.Vector3();
  const _x = new THREE.Vector3();
  const _wp = new THREE.Vector3();
  const _toCam = new THREE.Vector3();
  function tick() {
    if (!attached || !group.children.length) return;
    const el = viewer.domElement;
    const w = el.clientWidth || 1, h = el.clientHeight || 1;
    lineMats.static.resolution.set(w, h);
    lineMats.strong.resolution.set(w, h);
    group.getWorldQuaternion(_gq);
    _iq.copy(viewer.camera.quaternion).invert();
    for (const L of labels) {
      _wq.copy(_gq).multiply(L.baseQuat);
      if (L.mirrored) _wq.multiply(QY);
      if (L.flipped) _wq.multiply(QZ);
      L.mesh.getWorldPosition(_wp);
      _toCam.copy(viewer.camera.position).sub(_wp).normalize();
      _n.set(0, 0, 1).applyQuaternion(_wq);
      const facing = _n.dot(_toCam);
      if (Math.abs(facing) > 0.08 && facing < 0) {
        L.mirrored = !L.mirrored;
        _wq.multiply(QY);
      }
      _x.set(1, 0, 0).applyQuaternion(_wq).applyQuaternion(_iq);
      if (Math.abs(_x.x) > 0.08 && _x.x < 0) L.flipped = !L.flipped;
      L.mesh.quaternion.copy(L.baseQuat);
      if (L.mirrored) L.mesh.quaternion.multiply(QY);
      if (L.flipped) L.mesh.quaternion.multiply(QZ);
    }
  }

  // ---- label picking --------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  function pickLabel(clientX, clientY) {
    if (!attached || !labels.length) return null;
    const r = viewer.domElement.getBoundingClientRect();
    _ndc.set(((clientX - r.left) / r.width) * 2 - 1, -(((clientY - r.top) / r.height) * 2 - 1));
    raycaster.setFromCamera(_ndc, viewer.camera);
    const hits = raycaster.intersectObjects(labels.map((L) => L.mesh), false);
    return hits[0]?.object.userData.pfDimItemId ?? null;
  }

  // ---- theme ----------------------------------------------------------------
  function setTheme(mode) {
    if (!DIM_THEME[mode] || mode === theme) return;
    theme = mode;
    lineMats.static.color.set(DIM_THEME[theme].static);
    lineMats.strong.color.set(DIM_THEME[theme].strong);
    fillMats.static.color.set(DIM_THEME[theme].static);
    fillMats.strong.color.set(DIM_THEME[theme].strong);
    // repaint labels: new-theme textures come from the cache or a fresh paint
    for (const L of labels) {
      const old = L.mesh.material.map;
      // find the drawing text back off the cache key of the old texture
      const entry = [...textureCache.entries()].find(([, t]) => t === old);
      if (!entry) continue;
      const [, themePart, param, ...textParts] = ["", ...entry[0].split("|")];
      void themePart;
      L.mesh.material.map = labelTexture(textParts.join("|"), param || null);
      L.mesh.material.needsUpdate = true;
    }
  }

  function clear() { disposeChildren(); }

  function dispose() {
    disposeChildren();
    unregisterCapture();
    if (attached) group.parent?.remove(group);
    attached = false;
    for (const m of [...Object.values(lineMats), ...Object.values(fillMats)]) m.dispose();
    for (const t of textureCache.values()) t.dispose();
    textureCache.clear();
  }

  return { update, tick, pickLabel, setTheme, clear, group, dispose };
}
```

**Note on `setTheme` label repaint:** the cache-key reverse lookup above is awkward; the cleaner equivalent — store `{ text, param }` in `L` at `buildLabel` time and rebuild the material map directly — is preferred. Implement it that way: add `text`/`param` to the label record and in `setTheme` do `L.mesh.material.map = labelTexture(L.text, L.param)`. The code block above shows the fallback only in case the record was omitted; do NOT ship the reverse lookup.

- [ ] **Step 2: Write the tests**

Create `test/framework/measure/dim3-scene.test.js` (environment: happy-dom, matching the other measure DOM tests — copy the `// @vitest-environment happy-dom` pragma style used by `measure-mode.test.js`):

```js
// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { createDimScene, DIM_THEME, RENDER_ORDER_DIMS, RENDER_ORDER_LABELS }
  from "../../../src/framework/measure/dim3-scene.js";

function fakeViewer() {
  const parts = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BufferGeometry());
  parts.add(mesh);
  const scene = new THREE.Scene();
  scene.add(parts);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 100);
  camera.updateMatrixWorld();
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 800 });
  Object.defineProperty(canvas, "clientHeight", { value: 600 });
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  return {
    _subMeshes: { body: mesh },
    camera,
    domElement: canvas,
    getTheme: () => "dark",
    registerCanonicalCaptureHidden: vi.fn(() => vi.fn()),
    __parts: parts,
  };
}

// fake painter: never touches a 2d context
const fakePaint = ({ text }) => {
  const c = document.createElement("canvas");
  c.width = 40 * text.length;
  c.height = 128;
  return c;
};

const DRAWING = {
  itemId: "overall", tier: "static", pinned: false,
  segments: [0, 0, 0, 10, 0, 0],
  triangles: [0, 0, 0, 1, 0.5, 0, 1, -0.5, 0],
  labels: [{ text: "10.00 mm", param: null, center: [5, -2, 0], x: [1, 0, 0], y: [0, 1, 0], h: 4 }],
};

describe("createDimScene", () => {
  it("parents a group under the parts group and registers capture hiding", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    expect(viewer.__parts.children).toContain(scene.group);
    expect(viewer.registerCanonicalCaptureHidden).toHaveBeenCalledWith(scene.group);
  });

  it("builds lines, arrow fills and a label with the right render flags", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    const kids = scene.group.children;
    expect(kids.length).toBe(3); // lines + triangles + 1 label
    for (const k of kids) {
      expect(k.material.depthTest).toBe(false);
      expect(k.renderOrder === RENDER_ORDER_DIMS || k.renderOrder === RENDER_ORDER_LABELS).toBe(true);
    }
    const label = kids.find((k) => k.userData.pfDimItemId);
    expect(label.userData.pfDimItemId).toBe("overall");
  });

  it("update replaces previous drawings; clear empties", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    scene.update([DRAWING]);
    expect(scene.group.children.length).toBe(3);
    scene.clear();
    expect(scene.group.children.length).toBe(0);
  });

  it("tick mirrors a label viewed from behind (and holds within the deadband)", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    viewer.__parts.updateMatrixWorld(true);
    scene.tick(); // facing camera (+Z toward camera at z=100): no flip
    const label = scene.group.children.find((k) => k.userData.pfDimItemId);
    const q0 = label.quaternion.clone();
    viewer.camera.position.set(0, 0, -100);
    viewer.camera.updateMatrixWorld();
    scene.tick(); // viewed from behind: mirrored
    expect(label.quaternion.equals(q0)).toBe(false);
  });

  it("pickLabel finds the label under the pointer, null elsewhere", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    viewer.__parts.updateMatrixWorld(true);
    viewer.camera.lookAt(5, -2, 0);
    viewer.camera.updateMatrixWorld();
    // center of the viewport now aims at the label center
    expect(scene.pickLabel(400, 300)).toBe("overall");
    expect(scene.pickLabel(5, 5)).toBe(null);
  });

  it("setTheme recolors materials and repaints labels", () => {
    const viewer = fakeViewer();
    const paint = vi.fn(fakePaint);
    const scene = createDimScene(viewer, { paintLabel: paint });
    scene.update([DRAWING]);
    const before = paint.mock.calls.length;
    scene.setTheme("light");
    expect(paint.mock.calls.length).toBeGreaterThan(before);
    const lines = scene.group.children.find((k) => k.isLineSegments2 || k.type === "LineSegments2" || k.material.isLineMaterial);
    expect(lines.material.color.getHex()).toBe(DIM_THEME.light.static);
  });

  it("dispose detaches, unregisters and disposes", () => {
    const viewer = fakeViewer();
    const unregister = vi.fn();
    viewer.registerCanonicalCaptureHidden = vi.fn(() => unregister);
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    scene.dispose();
    expect(viewer.__parts.children).not.toContain(scene.group);
    expect(unregister).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run test/framework/measure/dim3-scene.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/framework/measure/dim3-scene.js test/framework/measure/dim3-scene.test.js
git commit -m "measure: dim3-scene in-scene renderer"
```

---

### Task 5: `measure-mode.js` — swap the render path onto place/scene

**Files:**
- Modify: `src/framework/measure/measure-mode.js`
- Test: `test/framework/measure/measure-mode.test.js`

**Interfaces:**
- Consumes: `evaluateChoices`/`choicesEqual`/`placeDims` (Task 3), `createDimScene` (Task 4), viewer hooks (Task 1).
- Produces: same handle as v1 MINUS `getOverlaySvg`: `{ setEnabled, isEnabled, clearPins, pinCount, onPinsChange, onModeChange, detach }`. Task 6 updates mount/types to match.

- [ ] **Step 1: Rewrite measure-mode.js**

Keep (verbatim from the current file): the module structure, `specCache`/`featureSpec`, `readsFor`/`readKeysFor`/`linkFor`, `resolvePin`, drag tracker + `onMove` scheduling + cutaway-handle suppression, `hitToHover`'s key derivation, `togglePin`, pins/mode listener plumbing, `setEnabled`'s general shape, `detach`.

Remove: `projectorFor`, `layout`/`createDimOverlay` imports and use, `prevLayout`, `frameSig`'s camera hashing, `onChipClick`, `getOverlaySvg`, the overlay-relative `onLeave` guard.

New render path:

```js
import * as THREE from "three";
import { raycastViewer } from "../selection/raycast.js";
import { createFeatureHighlight } from "../selection/feature-highlight.js";
import { createDragTracker } from "../selection/drag-tracker.js";
import { subPartReadKeys, RELEVANT_ALL } from "../param-deps.js";
import { classifyFeature, bboxSpec, unionBounds } from "./feature-dims.js";
import { linkParam } from "./param-link.js";
import { createPinStore, occurrenceOf } from "./pins.js";
import { evaluateChoices, choicesEqual, placeDims } from "./dim3-place.js";
import { createDimScene } from "./dim3-scene.js";
```

Spec transformation into the parts frame (feature/cylinder/plane anchors are in the mesh's own geometry frame; compose the pose):

```js
  const _m3 = new THREE.Matrix3();
  const _tv = new THREE.Vector3();
  function transformSpec(spec, matrix) {
    // identity fast path: poses are identity outside animations
    if (matrix.determinant() === 1 && matrix.elements[12] === 0 && matrix.elements[13] === 0
        && matrix.elements[14] === 0 && matrix.elements[0] === 1 && matrix.elements[5] === 1
        && matrix.elements[10] === 1) return spec;
    const pt = (p) => _tv.set(p[0], p[1], p[2]).applyMatrix4(matrix).toArray();
    const dir = (d) => _tv.set(d[0], d[1], d[2]).applyMatrix3(_m3.setFromMatrix4(matrix)).normalize().toArray();
    if (spec.kind === "plane") {
      return { ...spec, anchors: {
        width: { a: pt(spec.anchors.width.a), b: pt(spec.anchors.width.b) },
        height: { a: pt(spec.anchors.height.a), b: pt(spec.anchors.height.b) },
        normal: dir(spec.anchors.normal),
      } };
    }
    if (spec.kind === "cylinder") {
      return { ...spec, anchors: {
        center: pt(spec.anchors.center), axis: dir(spec.anchors.axis),
        top: pt(spec.anchors.top), bottom: pt(spec.anchors.bottom),
        rimDir: spec.anchors.rimDir ? dir(spec.anchors.rimDir) : undefined,
      } };
    }
    if (spec.kind === "bbox") {
      const b = new THREE.Box3(
        new THREE.Vector3(...spec.anchors.min), new THREE.Vector3(...spec.anchors.max),
      ).applyMatrix4(matrix); // AABB of the posed box, same as viewer.frameTo
      return bboxSpec(b.min.toArray(), b.max.toArray());
    }
    return spec;
  }
```

`buildItems` (replaces the projector-based version; `_key` retained for pin toggling by label pick):

```js
  function buildItems() {
    const items = [];
    const meshes = visibleMeshes();
    if (meshes.length === 0) return { items, meshes };
    const boundsList = meshes.map(([, m]) => {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox.clone().applyMatrix4(m.matrix);
      return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
    });
    const u = unionBounds(boundsList);
    items.push({
      id: "overall", tier: "static", spec: bboxSpec(u.min, u.max),
      meshes: meshes.map((_, i) => i),
    });
    const { view } = getContext();
    pins.list(view).forEach((key) => {
      const live = resolvePin(key);
      if (!live) return; // dormant
      const meshIndex = meshes.findIndex(([n]) => n === key.subPart);
      items.push({
        id: `pin:${key.subPart}:${key.featureLabel ?? "bbox"}:${key.occurrence}`,
        tier: "pinned", pinned: true,
        spec: transformSpec(live.spec, live.mesh.matrix),
        meshes: meshIndex >= 0 ? [meshIndex] : [],
        paramName: linkFor(key.subPart, live.spec), _key: key,
      });
    });
    if (hover) {
      const meshIndex = meshes.findIndex(([n]) => n === hover.subPart);
      items.push({
        ...hover.item,
        spec: transformSpec(hover.item.spec, hover.mesh.matrix),
        meshes: meshIndex >= 0 ? [meshIndex] : [],
      });
    }
    return { items, meshes, bounds: u };
  }
```

(`resolvePin` loses its unused `index` parameter; `hitToHover`'s item drops `project` and keeps `{ id: "hover", tier: "hover", spec, paramName }`.)

The placement environment + rebuild:

```js
  let scene = null;            // created on first enable
  let choices = {};
  let lastItems = [];          // for label-pick resolution
  const _rc = new THREE.Raycaster();
  const _origin = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _camLocal = new THREE.Vector3();

  function partsParent(meshes) { return meshes[0]?.[1].parent ?? null; }

  function buildEnv(meshes) {
    const parent = partsParent(meshes);
    parent?.updateWorldMatrix(true, false);
    const meshData = meshes.map(([, m]) => ({
      positions: m.geometry.getAttribute("position").array,
      matrix: m.matrix,
    }));
    const hittable = meshes.map(([, m]) => m);
    for (const m of hittable) m.updateWorldMatrix(true, false);
    const surfaceHit = (origin, dir) => {
      if (!parent) return null;
      _origin.copy(origin).applyMatrix4(parent.matrixWorld);
      _dir.copy(dir).transformDirection(parent.matrixWorld);
      _rc.set(_origin, _dir);
      const hit = _rc.intersectObjects(hittable, false)[0];
      return hit ? parent.worldToLocal(hit.point.clone()) : null;
    };
    const camPos = parent
      ? _camLocal.copy(viewer.camera.position).applyMatrix4(parent.matrixWorld.clone().invert()).toArray()
      : viewer.camera.position.toArray();
    return { meshData, surfaceHit, camPos };
  }

  function rebuild() {
    if (!enabled || !scene) return;
    const { items, meshes, bounds } = buildItems();
    lastItems = items;
    if (!items.length || !bounds) { scene.clear(); return; }
    const env = buildEnv(meshes);
    const center = [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ];
    choices = evaluateChoices(items, { camPos: env.camPos, center, prev: choices });
    scene.update(placeDims(items, { meshData: env.meshData, surfaceHit: env.surfaceHit, bounds }, choices));
  }
```

The frame loop (mesh signature keeps regen/visibility detection; camera moves only re-score choices):

```js
  let lastSig = "";
  function meshSig() {
    let sig = "";
    for (const [name, m] of Object.entries(viewer._subMeshes)) {
      sig += `|${name}:${m.visible ? 1 : 0}:${m.geometry.id}:${m.matrix.elements[12]},${m.matrix.elements[13]},${m.matrix.elements[14]},${m.matrix.elements[0]},${m.matrix.elements[5]}`;
    }
    return sig;
  }
  const offFrame = viewer.onFrame(() => {
    if (!enabled || !scene) return;
    const sig = meshSig();
    if (sig !== lastSig) {
      lastSig = sig;
      const m = viewer._subMeshes[hover?.subPart];
      if (hover && (!m || !m.visible || hover.geometry !== m.geometry)) {
        hover = null;
        highlight.clear();
      }
      rebuild();
    } else if (lastItems.length) {
      // cheap per-frame: has a side choice flipped?
      const meshes = visibleMeshes();
      const parent = partsParent(meshes);
      if (parent) {
        parent.updateWorldMatrix(true, false);
        const camPos = viewer.camera.position.clone()
          .applyMatrix4(parent.matrixWorld.clone().invert()).toArray();
        const bounds = lastBounds;
        if (bounds) {
          const center = [
            (bounds.min[0] + bounds.max[0]) / 2,
            (bounds.min[1] + bounds.max[1]) / 2,
            (bounds.min[2] + bounds.max[2]) / 2,
          ];
          const next = evaluateChoices(lastItems, { camPos, center, prev: choices });
          if (!choicesEqual(next, choices)) { choices = next; rebuild(); }
        }
      }
    }
    scene.tick();
  });
```

(`lastBounds` is set inside `rebuild` next to `lastItems` — add `let lastBounds = null;` and `lastBounds = bounds;`.)

Click handling — label pick first, then geometry (replaces `onChipClick`):

```js
  function onClick(ev) {
    const wasDragged = drag.consumeClick();
    if (!enabled || wasDragged) return;
    const labelId = scene?.pickLabel(ev.clientX, ev.clientY);
    if (labelId) {
      if (labelId === "hover") {
        if (hover) togglePin(hover.key, hover.item.paramName);
        return;
      }
      const item = lastItems.find((i) => i.id === labelId);
      if (item?._key) togglePin(item._key, null); // toggling off: no reveal
      return;
    }
    const hit = raycastViewer(viewer, ev.clientX, ev.clientY);
    if (!hit) return;
    const h = hitToHover(hit);
    togglePin(h.key, h.item.paramName);
  }
```

`setEnabled` / theme / detach:

```js
  const offTheme = viewer.onThemeChange?.((mode) => { scene?.setTheme(mode); rebuild(); }) ?? (() => {});

  function setEnabled(on) {
    if (detached || on === enabled) return;
    enabled = !!on;
    if (enabled) {
      scene ??= createDimScene(viewer);
      highlight ??= createFeatureHighlight(viewer);
      lastSig = "";
      rebuild();
    } else {
      hover = null;
      highlight?.clear();
      scene?.clear();
      lastItems = [];
      lastBounds = null;
    }
    notifyMode();
  }
```

`onLeave` simplifies to `const onLeave = () => { hover = null; highlight?.clear(); rebuild(); };` and every previous `renderNow()` call site becomes `rebuild()`. `detach()` adds `offTheme(); scene?.dispose();` and drops `overlay?.dispose()`. The returned handle drops `getOverlaySvg`.

- [ ] **Step 2: Update measure-mode tests**

Rework `test/framework/measure/measure-mode.test.js`: its fake viewer needs a real `THREE.Group` parent for its fake sub-meshes (position attribute + `matrix`), plus `onThemeChange`/`getTheme`/`registerCanonicalCaptureHidden` stubs; a `paintLabel` cannot be injected through `createMeasureMode` (measure-mode owns `createDimScene`), so give the fake canvas a minimal `getContext("2d")` stub returning `{ font: "", measureText: () => ({ width: 40 }), fillText() {}, strokeText() {}, beginPath() {}, roundRect() {}, fill() {}, stroke() {} }` — happy-dom's `document.createElement("canvas")` allows patching `HTMLCanvasElement.prototype.getContext` at the top of the file.

Assertions change from SVG DOM to scene state — the pattern per behavior:

```js
const dimGroup = () => partsGroup.children.find((c) => c.name === "pf-dims");
// mode on → group exists with children (overall dims)
// hover → child count grows; unhover → shrinks
// pin persists across setEnabled(false)/setEnabled(true)
// clearPins() → pinned children gone
// detach() → group removed from the parent
```

Keep every existing behavioral case (mode toggle, hover flow, pin toggle + reveal on linked, pin persistence across regen with label re-resolution and dormancy, cutaway-handle suppression, stale-hover invalidation on geometry/visibility change) — only the observation surface changes. Cases that asserted `getOverlaySvg`, chip DOM semantics (`role="button"`), or offscreen edge-chips are DELETED (spec v2 drops those features).

- [ ] **Step 3: Run**

Run: `npx vitest run test/framework/measure/measure-mode.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/framework/measure/measure-mode.js test/framework/measure/measure-mode.test.js
git commit -m "measure-mode: render through dim3-place/dim3-scene"
```

---

### Task 6: Deletions and API trim

**Files:**
- Delete: `src/framework/measure/dim-layout.js`, `src/framework/measure/dim-overlay.js`, `src/framework/measure/capture-overlay.js`
- Delete: `test/framework/measure/dim-layout.test.js`, `test/framework/measure/dim-overlay.test.js`, `test/framework/measure/capture-overlay.test.js`
- Modify: `src/index.js`, `types/index.d.ts`, `src/framework/app.css`, `src/framework/mount.js`, `test/framework/measure/measure-controls.test.js` (only if it referenced the overlay — check)

- [ ] **Step 1: Delete the modules and their tests**

```bash
git rm src/framework/measure/dim-layout.js src/framework/measure/dim-overlay.js src/framework/measure/capture-overlay.js
git rm test/framework/measure/dim-layout.test.js test/framework/measure/dim-overlay.test.js test/framework/measure/capture-overlay.test.js
```

- [ ] **Step 2: Trim `src/index.js`**

Remove the two-line comment and the `export { compositeOverlay, overlaySvgString } from "./framework/measure/capture-overlay.js";` line (currently around line 7-9).

- [ ] **Step 3: Trim `types/index.d.ts`**

- `MeasureRuntime` becomes:

```ts
/**
 * Measurement mode runtime controls. Dimensioned captures come straight from
 * `captureCurrent()` while the mode is enabled — in-scene dims render into
 * the frame natively (canonical-view captures and thumbnails never include
 * them).
 */
export interface MeasureRuntime {
  isEnabled(): boolean;
  setEnabled(on: boolean): void;
  clearPins(): void;
  pinCount(): number;
}
```

- Delete the `compositeOverlay` and `overlaySvgString` function declarations and their doc comments.

- [ ] **Step 4: Trim `src/framework/app.css`**

Delete (current line numbers ~347-387): the `.pf-stage { --pf-dim-ink... }` token line, `.pf-dim-overlay` block, `pf-dim-in` keyframes + its reduced-motion line, `.pf-dim-ext/.pf-dim-line/.pf-dim-leader`, `.pf-dim-arrow`, all `.tier-hover`/`.tier-pinned` dim selectors, `.pf-dim-chip*`, `.pf-dim-text`, `.pf-dim-param`. Keep: `.pf-measure-actions` rules, `.pf-measure-unit`, `.pf-param-flash` + its keyframes/reduced-motion.

- [ ] **Step 5: Update `src/framework/mount.js`**

- Line ~39: `const NOOP_MEASURE = { isEnabled: () => false, setEnabled: () => {}, clearPins: () => {}, pinCount: () => 0 };`
- The `makeHandle` doc comment (~line 79) drops the `getOverlaySvg` sentence; replace with: dims render into `captureCurrent()` natively while the mode is on.
- The runtime handle block (~line 738):

```js
      measure: {
        isEnabled: measureMode.isEnabled,
        setEnabled: measureMode.setEnabled,
        clearPins: measureMode.clearPins,
        pinCount: measureMode.pinCount,
      },
```

- [ ] **Step 6: Check measure-controls tests**

Run: `grep -n "overlay\|OverlaySvg" src/framework/measure/measure-controls.js test/framework/measure/measure-controls.test.js`
Expected: no hits (chrome never touched the overlay). If any test stubs a measure-mode handle including `getOverlaySvg`, drop the property.

- [ ] **Step 7: Run the whole suite**

Run: `npx vitest run`
Expected: PASS — notably `mount.test.js` / `mount-capture.test.js` (runtime handle shape) and `types` consumers. Fix any straggler references to the deleted modules (search: `grep -rn "dim-layout\|dim-overlay\|capture-overlay\|getOverlaySvg\|compositeOverlay\|overlaySvgString" src/ test/ types/` must return zero hits outside docs).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "measure: delete SVG overlay modules and capture-composite API"
```

---

### Task 7: Spike removal, docs, full verification

**Files:**
- Delete: `src/framework/measure/dim3-spike.js`
- Modify: `src/framework/mount.js` (remove the `?dim3spike` hook), `docs/AUTHORING-PARTS.md`, `AGENTS.md`

- [ ] **Step 1: Remove the spike**

```bash
git rm src/framework/measure/dim3-spike.js
```

In `mount.js`, delete the block:

```js
    // THROWAWAY SPIKE (in-scene 3D dimensions evaluation) — remove before merge.
    if (new URLSearchParams(location.search).has("dim3spike")) { ... }
```

- [ ] **Step 2: Docs**

- `AGENTS.md` architecture bullet for `measure/`: replace the parenthetical `(the ruler-button measurement mode: pure dimension engines + SVG overlay; feature-dims.js/dim-layout.js/pins.js/param-link.js are pure leaves, measure-mode.js orchestrates, measure-controls.js is the viewbar chrome)` with `(the ruler-button measurement mode: in-scene 3D dimension objects; feature-dims.js/dim3-place.js/pins.js/param-link.js are pure leaves, dim3-scene.js renders into the viewer scene, measure-mode.js orchestrates, measure-controls.js is the viewbar chrome)`.
- `docs/AUTHORING-PARTS.md`: find the measurement/host-wiring passages (grep `measure`): update the capture guidance — dimensioned captures come from `runtime.captureCurrent()` with measure mode enabled; remove any mention of `getOverlaySvg`/`compositeOverlay`. The `Solid.label()`-powers-measurement note stays.

- [ ] **Step 3: Full verification**

```bash
source ~/.nvm/nvm.sh && nvm use && npx vitest run
```

Expected: full suite green.

```bash
source ~/.nvm/nvm.sh && nvm use && npm run check
```

Expected: smoke check green on all apps.

- [ ] **Step 4: Live visual verification (controller does this, not a subagent)**

Dev server → `/planter.html` → ruler on: overall dims render as in-scene coplanar drawings matching the spike's look; orbit — dims hold their anchors, side selection keeps them camera-facing, labels never mirror; hover a wall → feature dims; hover the drainage hole feature (if labeled) → ⌀; click a linked dim → rail control flashes and focuses; pin → persists across a param drag; theme toggle → dims recolor; cutaway on → dims not clipped.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "measure: remove dim3 spike; update docs for in-scene dims"
```

---

## Self-Review Notes

- **Spec coverage**: coplanarity/plane-snap/surface-contact (Task 3 `linearDim`/`placeBox`), side selection + hysteresis (Task 3 `evaluateChoices`), locked constants (Task 3 exports + test), in-plane text outside the line + flips (Tasks 3/4), narrow filled arrows (Task 3 `arrow`), theme palettes + repaint (Tasks 1/4/5), capture inclusion/exclusion (Tasks 1/4), API trim (Task 6), rebuild-not-per-frame (Task 5 frame loop), cylinder ⌀/R/depth + `rimDir` (Tasks 2/3), spike removal + docs (Task 7).
- **Known judgment calls** (rule against the spec if a reviewer flags them): plane-snap reference uses the model mid-plane rather than a camera-side face (deterministic, keeps `placeDims` camera-free; the spec's requirement is "the side of the model the dim is drawn toward", which the ext-side choice already encodes); feature-dim standoff is halved (`×0.5`) so hover dims hug their feature rather than sitting at overall-dim distance — spec is silent on feature standoff, and overall dims keep the locked constant exactly.
- The `dim3-scene.setTheme` note in Task 4 is binding: store `{text, param}` on the label record; never ship the cache reverse lookup.
