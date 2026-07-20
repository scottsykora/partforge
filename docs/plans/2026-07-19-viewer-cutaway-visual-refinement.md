# Viewer Cutaway Visual Refinement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refine cutaway hatching and controls with feature-edge-colored fine hatch lines, empty-side half-arcs, mutually depth-aware handles, and a z-fight-free ghost plane.

**Architecture:** Keep stencil caps and the mathematical clip plane in the main scene. Split visible handles into a controller-owned overlay scene rendered after one depth clear, while the main-scene ghost plane receives a small visual-only empty-side offset. Propagate the viewer's feature-edge color into hatch uniforms and keep smoke checks strict unless an explicit optional-host flag is supplied.

**Tech Stack:** Plain ESM JavaScript, three.js r184, Vitest 4, Vite 8, Playwright Chromium, GitHub Actions.

---

Use Node 24 for every command:

```bash
cd "/Users/scottsykora/Documents/Docs/pixite/code/Robot KB/partforge-cutaway"
nvm use
```

Follow `@superpowers:test-driven-development` for Tasks 1–4 and
`@superpowers:verification-before-completion` before publishing Task 5.

## Task 1: Feature-edge-colored fine hatch

**Files:**

- Modify: `src/framework/cutaway-render.js`
- Modify: `src/framework/cutaway.js`
- Modify: `src/framework/viewer.js`
- Test: `test/framework/cutaway-render.test.js`
- Test: `test/framework/cutaway.test.js`
- Test: `test/framework/viewer-cutaway.test.js`

### Step 1: Write failing hatch tests

Change the hatch material tests to make ink color explicit and require fivefold
frequency:

```js
const material = createHatchMaterial({
  color: 0x336699,
  opacity: 1,
  inkColor: 0x1c232d,
});

expect(material.uniforms.uInk.value.getHex()).toBe(0x1c232d);
material.userData.setHatch({ spacing: 2.5, size: 40 });
expect(material.uniforms.uScale.value).toBe(80); // (40 / 2.5) * 5

const ink = material.uniforms.uInk.value;
material.userData.setInkColor(0x33414f);
expect(material.uniforms.uInk.value).toBe(ink);
expect(ink.getHex()).toBe(0x33414f);
```

Add controller/viewer assertions that dark and light calls forward the exact
viewer feature-edge colors:

```js
expect(state.cutaway.setTheme).toHaveBeenCalledWith("dark", 0x1c232d);
viewer.setTheme("light");
expect(state.cutaway.setTheme).toHaveBeenLastCalledWith("light", 0x33414f);
```

### Step 2: Run tests and verify RED

```bash
npx vitest run test/framework/cutaway-render.test.js test/framework/cutaway.test.js test/framework/viewer-cutaway.test.js
```

Expected: FAIL because `inkColor`, `setInkColor`, fivefold frequency, and edge
color forwarding do not exist.

### Step 3: Implement the minimal color/frequency pipeline

In `cutaway-render.js`, remove the private theme palette. Initialize `uInk` from
`inkColor`, preserve the current `0.08` stripe duty-cycle threshold, and change
the scale calculation:

```js
const HATCH_DENSITY_MULTIPLIER = 5;

material.userData.setHatch = ({ spacing, size }) => {
  material.uniforms.uScale.value = size / spacing * HATCH_DENSITY_MULTIPLIER;
};
material.userData.setInkColor = (color) => {
  material.uniforms.uInk.value.set(color);
};
```

Expose `renderSet.setHatchInk(color)`. In `cutaway.js`, retain the current ink
color and accept it as the second `setTheme(mode, edgeColor)` argument. In
`viewer.js`, call:

```js
cutaway.setTheme(mode, t.line);
```

### Step 4: Run tests and verify GREEN

Run the Step 2 command. Expected: PASS.

### Step 5: Commit

```bash
git add src/framework/cutaway-render.js src/framework/cutaway.js src/framework/viewer.js test/framework/cutaway-render.test.js test/framework/cutaway.test.js test/framework/viewer-cutaway.test.js
git commit -m "refine cutaway hatch appearance"
```

## Task 2: Empty-side half-arcs and ghost-plane offset

**Files:**

- Modify: `src/framework/cutaway-gizmo.js`
- Modify: `src/framework/cutaway.js`
- Test: `test/framework/cutaway-gizmo.test.js`
- Test: `test/framework/cutaway.test.js`

### Step 1: Write failing geometry and pose tests

Add tests that require:

- visual ring geometries use `parameters.arc === Math.PI`;
- hit proxies also use `parameters.arc === Math.PI`;
- sampled world-space arc vertices have their centreline only on the current
  clipped-away side;
- `gizmo.setFlipped(true)` mirrors both visual and hit arcs to the other side;
- the hidden half does not raycast;
- fill and border receive an empty-side offset while `group.position` and the
  controller's `THREE.Plane` remain unchanged; and
- the offset reverses after Flip and stays within `0.01`–`0.25` mm.

Use a helper that projects arc geometry positions through the owning mesh matrix
and ignores the torus tube radius when checking the centreline side.

### Step 2: Run tests and verify RED

```bash
npx vitest run test/framework/cutaway-gizmo.test.js test/framework/cutaway.test.js
```

Expected: FAIL because the rings and proxies are full tori and there is no
flip-aware visual offset API.

### Step 3: Implement half-arcs and shared empty-side state

Create half-torus visual and hit geometry with an arc of `Math.PI`. Put the four
arc meshes under an `arcRoot` whose local-Z mirror selects the clipped-away side:

```js
function setFlipped(flipped) {
  emptySideSign = flipped ? 1 : -1;
  arcRoot.scale.z = emptySideSign;
  updateGhostOffset();
}
```

Keep the translation arrow outside `arcRoot`. Match each hit proxy's transform to
its visible arc. Offset only fill and border:

```js
const offset = THREE.MathUtils.clamp(poseSize * 0.001, 0.01, 0.25);
fill.position.z = emptySideSign * offset;
border.position.z = emptySideSign * offset;
```

Call `gizmo.setFlipped(flipped)` from enable/reset/flip pose synchronization.
Never add this offset to `pose.position` or the mathematical plane.

### Step 4: Run tests and verify GREEN

Run the Step 2 command. Expected: PASS.

### Step 5: Commit

```bash
git add src/framework/cutaway-gizmo.js src/framework/cutaway.js test/framework/cutaway-gizmo.test.js test/framework/cutaway.test.js
git commit -m "refine cutaway plane controls"
```

## Task 3: Mutually depth-aware widget overlay

**Files:**

- Modify: `src/framework/cutaway-gizmo.js`
- Modify: `src/framework/cutaway.js`
- Modify: `src/framework/viewer.js`
- Test: `test/framework/cutaway-gizmo.test.js`
- Test: `test/framework/cutaway.test.js`
- Test: `test/framework/viewer-cutaway.test.js`

### Step 1: Write failing overlay tests

Require visible red, blue, and green materials to use `depthTest: true` and
`depthWrite: true`. Require the ghost fill/border to remain in the main scene and
the handle root to belong to a separate overlay scene.

Extend the fake renderer with `autoClear`, `clearDepth`, and a render call log.
Assert one enabled frame performs:

```js
[
  ["render", mainScene, camera],
  ["clearDepth"],
  ["render", overlayScene, camera],
]
```

Also assert disabled frames render only the main scene, `autoClear` is restored
after the overlay pass, and disposal removes overlay resources.

### Step 2: Run tests and verify RED

```bash
npx vitest run test/framework/cutaway-gizmo.test.js test/framework/cutaway.test.js test/framework/viewer-cutaway.test.js
```

Expected: FAIL because handles are in the main scene with depth testing/writes
disabled and no overlay render API exists.

### Step 3: Implement the overlay pass

Create one `THREE.Scene` inside `createCutaway`, pass it to the gizmo, and keep
fill/border in the existing main scene while attaching visible handles and hit
proxies to the overlay root.

Return an idempotent `renderOverlay()` method:

```js
function renderOverlay() {
  if (!enabled || disposed) return false;
  const previousAutoClear = renderer.autoClear;
  try {
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(overlayScene, camera);
  } finally {
    renderer.autoClear = previousAutoClear;
  }
  return true;
}
```

In the viewer animation loop, render the main scene first and call
`cutaway.renderOverlay()` afterward. Keep hit materials non-rendering/transparent;
set only visible handle materials to depth test and write.

### Step 4: Run tests and verify GREEN

Run the Step 2 command. Expected: PASS.

### Step 5: Commit

```bash
git add src/framework/cutaway-gizmo.js src/framework/cutaway.js src/framework/viewer.js test/framework/cutaway-gizmo.test.js test/framework/cutaway.test.js test/framework/viewer-cutaway.test.js
git commit -m "render cutaway handles with shared depth"
```

## Task 4: Preserve strict smoke checks for optional hosts

**Files:**

- Modify: `scripts/check-app.mjs`
- Modify: `.github/workflows/ci.yml`

### Step 1: Verify the existing RED compatibility case

```bash
CHECK_PORT=51931 node scripts/check-app.mjs text-smoke.html --allow-no-cutaway
```

Expected: FAIL with `cutaway control: missing` because the option is not yet
implemented. This is the same failure recorded by PR #55 CI.

### Step 2: Implement the explicit optional-host flag

Parse the flag without weakening the default:

```js
const allowNoCutaway = process.argv.includes("--allow-no-cutaway");
const cutawaySatisfied = cutaway || (allowNoCutaway && cutawayControl === "missing");
process.exit(booted && hovered && cutawaySatisfied && errors.length === 0 ? 0 : 1);
```

Update only the text fixture CI command:

```yaml
- run: CHECK_PORT=5182 node scripts/check-app.mjs text-smoke.html --allow-no-cutaway
```

### Step 3: Verify GREEN and strict-default RED

```bash
CHECK_PORT=51931 node scripts/check-app.mjs text-smoke.html --allow-no-cutaway
CHECK_PORT=51932 node scripts/check-app.mjs text-smoke.html
CHECK_PORT=51933 node scripts/check-app.mjs demo.html
```

Expected: optional text smoke PASS; strict text smoke FAIL; strict demo PASS with
`cutaway: true`.

### Step 4: Commit

```bash
git add scripts/check-app.mjs .github/workflows/ci.yml
git commit -m "fix optional cutaway smoke compatibility"
```

## Task 5: Full verification, interactive acceptance, and PR update

**Files:**

- Modify only if verification exposes a defect; add a failing regression first.

### Step 1: Run the combined focused suite

```bash
npx vitest run test/framework/cutaway-math.test.js test/framework/cutaway-render.test.js test/framework/cutaway-gizmo.test.js test/framework/cutaway.test.js test/framework/cutaway-controls.test.js test/framework/mount.test.js test/framework/viewer-cutaway.test.js test/selection-raycast.test.js test/selection-hover.test.js
```

Expected: PASS.

### Step 2: Run all unit tests and build

```bash
npm test
npm run build
```

Expected: PASS.

### Step 3: Run smoke checks sequentially

```bash
CHECK_PORT=51941 node scripts/check-app.mjs demo.html
CHECK_PORT=51942 node scripts/check-app.mjs planter.html
CHECK_PORT=51943 node scripts/check-app.mjs filleted-box.html
CHECK_PORT=51944 node scripts/check-app.mjs text-smoke.html --allow-no-cutaway
```

Expected: all PASS; the three cutaway pages report `cutaway: true`; text smoke
reports the control missing but exits zero.

### Step 4: Perform interactive Chromium acceptance

Using the already-running server at `http://127.0.0.1:5173/`:

- inspect hatch color against feature edges in both themes;
- confirm fivefold finer spacing/thickness without aliasing;
- orbit and tilt until red, blue, and green handles cross, confirming nearest
  surfaces win regardless of color;
- Flip and confirm both visible and interactive half-arcs move to the empty side;
- grab the green arrow at formerly obstructed angles;
- inspect ghost-plane stability without visible separation from the cut; and
- confirm no busy state or worker regeneration during interaction.

### Step 5: Verify repository state and publish

```bash
git status --short
git diff origin/main...HEAD --check
git push origin codex/viewer-cutaway
gh pr checks 55 --watch
```

Expected: clean worktree, no whitespace errors, push succeeds, and PR #55 CI is
green.
