# Cutaway Screen-Space Hatch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Render the cutaway hatch as a fixed 45-degree, 5 CSS-pixel screen-space pattern with an approximately 1 CSS-pixel line at every zoom level and display density.

**Architecture:** Replace the cap shader's UV/model-scale coordinate with `gl_FragCoord` normalized by renderer pixel ratio. Propagate pixel ratio through the existing viewer resize and cutaway viewport path, retain it for current/future/replacement render sets, and remove the obsolete diagonal-derived model-space hatch spacing from cutaway poses.

**Tech Stack:** JavaScript ESM, Three.js `ShaderMaterial`, Vitest, Vite, Playwright Chromium smoke checks.

---

### Task 1: Make the hatch material screen-space aware

**Files:**
- Modify: `src/framework/cutaway-render.js`
- Test: `test/framework/cutaway-render.test.js`

**Step 1: Write failing shader-contract tests**

Replace the UV-based assertions in `createHatchMaterial` tests with assertions that prove:

```js
expect(material.vertexShader).not.toContain("vUv");
expect(material.fragmentShader).toContain("gl_FragCoord.xy");
expect(material.fragmentShader).toContain("uPixelRatio");
expect(material.fragmentShader).toContain("HATCH_PERIOD_CSS_PX");
expect(material.fragmentShader).toContain("HATCH_LINE_CSS_PX");
expect(material.fragmentShader).toContain("normalize(vec2(1.0, 1.0))");
expect(material.fragmentShader).toContain("fwidth(axisPixel)");
expect(material.uniforms.uPixelRatio.value).toBe(1);
```

Add tests for an in-place setter:

```js
material.userData.setScreenScale(2);
expect(material.uniforms.uPixelRatio.value).toBe(2);

for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
  material.userData.setScreenScale(invalid);
  expect(material.uniforms.uPixelRatio.value).toBe(1);
}
```

Assert the shader encodes a 5 CSS-pixel period and 1 CSS-pixel line, preferably through exported JS constants interpolated into the shader so the production value and test share one source of truth.

**Step 2: Run the focused test to verify RED**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 24
npx vitest run test/framework/cutaway-render.test.js
```

Expected: failures because the shader still uses `vUv`, `uScale`, and `setHatch` and has no pixel-ratio uniform.

**Step 3: Implement the minimal screen-space shader**

In `src/framework/cutaway-render.js`, replace the model-space density constant with:

```js
export const HATCH_PERIOD_CSS_PX = 5;
export const HATCH_LINE_CSS_PX = 1;
```

Remove the UV varying and emit only projected position from the vertex shader. The fragment shader should follow this structure:

```glsl
uniform float uPixelRatio;
const float HATCH_PERIOD_CSS_PX = 5.0;
const float HATCH_LINE_CSS_PX = 1.0;

vec2 cssPixel = gl_FragCoord.xy / max(uPixelRatio, 1.0);
float axisPixel = dot(cssPixel, normalize(vec2(1.0, 1.0)));
float wrapped = mod(axisPixel, HATCH_PERIOD_CSS_PX);
float distanceToLine = min(wrapped, HATCH_PERIOD_CSS_PX - wrapped);
float halfLine = HATCH_LINE_CSS_PX * 0.5;
float antialias = max(fwidth(axisPixel), 0.001);
float stripe = 1.0 - smoothstep(
  halfLine - antialias,
  halfLine + antialias,
  distanceToLine
);
```

Keep the existing base/ink mix, opacity, color-space conversion, transparency, and depth behavior. Replace `setHatch` with:

```js
material.userData.setScreenScale = (pixelRatio) => {
  material.uniforms.uPixelRatio.value = Number.isFinite(pixelRatio) && pixelRatio > 0
    ? pixelRatio
    : 1;
};
```

**Step 4: Run the focused test to verify GREEN**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 24 >/dev/null
npx vitest run test/framework/cutaway-render.test.js
```

Expected: all `cutaway-render` tests pass.

**Step 5: Mutation-check the new tests**

Temporarily remove pixel-ratio division or change the period constant, rerun the test, and confirm it fails for the intended reason. Restore production code and rerun GREEN.

**Step 6: Commit**

```bash
git add src/framework/cutaway-render.js test/framework/cutaway-render.test.js
git commit -m "render cutaway hatch in screen space"
```

### Task 2: Propagate and retain renderer pixel ratio

**Files:**
- Modify: `src/framework/viewer.js`
- Modify: `src/framework/cutaway.js`
- Modify: `src/framework/cutaway-render.js`
- Test: `test/framework/viewer-cutaway.test.js`
- Test: `test/framework/cutaway.test.js`
- Test: `test/framework/cutaway-render.test.js`

**Step 1: Write failing propagation tests**

In `viewer-cutaway.test.js`, make `FakeRenderer` retain its pixel ratio and expose it:

```js
setPixelRatio(value) { this.pixelRatio = value; }
getPixelRatio() { return this.pixelRatio; }
```

Assert the resize path forwards it:

```js
expect(state.cutaway.setViewportSize).toHaveBeenLastCalledWith(400, 300, 2);
```

Stub `devicePixelRatio` deterministically in the test setup and restore it afterward.

In `cutaway-render.test.js`, extend the viewport test:

```js
renderSet.setViewportSize(640, 480, 2);
expect(renderSet.cap.material.uniforms.uPixelRatio.value).toBe(2);
```

In `cutaway.test.js`, prove controller retention:

```js
fixture.controller.setViewportSize(640, 480, 2);
addSubpart(fixture, "body");
expect(findCap(fixture.scene).material.uniforms.uPixelRatio.value).toBe(2);

fixture.controller.setViewportSize(900, 700, 1.5);
expect(findCap(fixture.scene).material.uniforms.uPixelRatio.value).toBe(1.5);
```

Then replace the subpart and assert the new cap inherits `1.5`. Add invalid pixel-ratio coverage showing the material falls back to `1`.

**Step 2: Run the three focused files to verify RED**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 24 >/dev/null
npx vitest run test/framework/cutaway-render.test.js test/framework/cutaway.test.js test/framework/viewer-cutaway.test.js
```

Expected: failures because the resize/controller/render-set APIs currently forward only width and height.

**Step 3: Implement the propagation path**

Update `viewer.resize()`:

```js
cutaway.setViewportSize(w, h, renderer.getPixelRatio());
```

Update the cutaway controller to retain all three values:

```js
function setViewportSize(width, height, pixelRatio = 1) {
  if (disposed) return false;
  viewportSize = { width, height, pixelRatio };
  for (const { renderSet } of renderSets.values()) {
    renderSet.setViewportSize(width, height, pixelRatio);
  }
  return true;
}
```

When `setSubpart` creates a current, future, or replacement render set, replay the retained triple.

Update `createSectionRenderSet.setViewportSize` to keep its existing `LineMaterial.resolution` behavior and call:

```js
capMaterial.userData.setScreenScale(pixelRatio);
```

Ensure `refreshSourceMaterial` replays the retained width/height for cloned feature-edge materials without resetting the cap's pixel ratio.

**Step 4: Run the focused tests to verify GREEN**

Run the same three-file Vitest command. Expected: all pass.

**Step 5: Mutation-check retention**

Temporarily omit the retained replay in `setSubpart`; confirm the future/replacement test fails. Restore it and rerun GREEN.

**Step 6: Commit**

```bash
git add src/framework/viewer.js src/framework/cutaway.js src/framework/cutaway-render.js test/framework/viewer-cutaway.test.js test/framework/cutaway.test.js test/framework/cutaway-render.test.js
git commit -m "propagate cutaway screen scale"
```

### Task 3: Remove obsolete model-space hatch state

**Files:**
- Modify: `src/framework/cutaway-math.js`
- Modify: `src/framework/cutaway.js`
- Modify: `src/framework/cutaway-render.js`
- Test: `test/framework/cutaway-math.test.js`
- Test: `test/framework/cutaway.test.js`
- Test: `test/framework/cutaway-render.test.js`

**Step 1: Write failing invariance assertions**

Update the cap-pose test to prove pose changes affect transform and size but not screen scale:

```js
renderSet.setViewportSize(640, 480, 2);
renderSet.setCapPose({ position, quaternion, size: 48 });
expect(renderSet.cap.scale.toArray()).toEqual([48, 48, 48]);
expect(renderSet.cap.material.uniforms.uPixelRatio.value).toBe(2);
expect(renderSet.cap.material.uniforms.uScale).toBeUndefined();
expect(renderSet.cap.material.userData.setHatch).toBeUndefined();
```

Update `initialCutawayPose` tests to require only `position`, `quaternion`, and `size`, and remove the diagonal hatch-spacing test/import. Add a controller-level test that applies reset/drag-equivalent pose changes and proves the cap pixel-ratio uniform stays unchanged.

**Step 2: Run focused tests to verify RED**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 24 >/dev/null
npx vitest run test/framework/cutaway-math.test.js test/framework/cutaway-render.test.js test/framework/cutaway.test.js
```

Expected: failures because pose objects still contain and forward `hatchSpacing`, and cap-pose updates still call the old hatch setter.

**Step 3: Remove the obsolete model-space path**

In `cutaway-math.js`, remove the hatch spacing constants, `hatchSpacingForDiagonal`, and `hatchSpacing` from `initialCutawayPose`.

In `cutaway.js`, remove `hatchSpacing` from retained poses and from `applyCapPose`.

In `cutaway-render.js`, change:

```js
function setCapPose({ position, quaternion, size }) {
  if (disposed) return;
  cap.position.copy(position);
  cap.quaternion.copy(quaternion);
  cap.scale.setScalar(size);
}
```

Search for leftovers:

```bash
rg -n "hatchSpacing|hatchSpacingForDiagonal|uScale|setHatch|vUv" src/framework test/framework
```

Expected: no obsolete production references; test references appear only in negative assertions where intentional.

**Step 4: Run focused and complete cutaway suites**

Run:

```bash
source ~/.nvm/nvm.sh && nvm use 24 >/dev/null
npx vitest run test/framework/cutaway.test.js test/framework/cutaway-math.test.js test/framework/viewer-cutaway.test.js test/framework/cutaway-controls.test.js test/framework/cutaway-render.test.js test/framework/cutaway-gizmo.test.js
```

Expected: 6 files pass with zero failures.

**Step 5: Commit**

```bash
git add src/framework/cutaway-math.js src/framework/cutaway.js src/framework/cutaway-render.js test/framework/cutaway-math.test.js test/framework/cutaway.test.js test/framework/cutaway-render.test.js
git commit -m "remove model-space hatch sizing"
```

### Task 4: Full verification and visual acceptance

**Files:**
- Modify only if verification exposes a defect.

**Step 1: Run static checks and focused tests**

```bash
git diff --check origin/main...HEAD
source ~/.nvm/nvm.sh && nvm use 24 >/dev/null
npx vitest run test/framework/cutaway.test.js test/framework/cutaway-math.test.js test/framework/viewer-cutaway.test.js test/framework/cutaway-controls.test.js test/framework/cutaway-render.test.js test/framework/cutaway-gizmo.test.js
```

Expected: clean diff and all focused tests pass.

**Step 2: Run the full suite**

```bash
npm test
```

Expected: all test files and tests pass with exit code 0.

**Step 3: Run the production build**

```bash
npm run build
```

Expected: Vite exits 0. Existing chunk-size and browser-externalization warnings are acceptable.

**Step 4: Run Chromium smokes sequentially**

Use unique ports and do not run in parallel:

```bash
CHECK_PORT=52241 node scripts/check-app.mjs demo.html
CHECK_PORT=52242 node scripts/check-app.mjs planter.html
CHECK_PORT=52243 node scripts/check-app.mjs filleted-box.html
CHECK_PORT=52244 node scripts/check-app.mjs text-smoke.html --allow-no-cutaway
```

Expected: each command exits 0; application pages report `cutaway: true`, the text fixture reports `cutaway control: missing`, and all report zero errors.

**Step 5: Perform interactive visual acceptance**

Use the local planter page and verify:

1. Enable cutaway in light mode and capture the hatch at the framed view.
2. Zoom substantially in and out; the repeat remains 5 CSS pixels and the line remains approximately 1 CSS pixel.
3. Orbit, translate, and rotate the cut plane; the hatch remains fixed at 45 degrees in screen space.
4. Switch to dark mode; only the feature-edge-derived ink changes, not size or angle.
5. Confirm the console remains free of errors and plane interaction does not trigger geometry regeneration.

**Step 6: Request final code review**

Use `superpowers:requesting-code-review` to audit the complete change against the approved design. Fix and re-review every Critical, Important, or Minor finding.

**Step 7: Push and monitor CI**

After fresh verification and a clean worktree:

```bash
git push origin codex/viewer-cutaway
gh pr checks 55 --watch --interval 10
```

Expected: PR #55 CI reaches `pass`. Keep the existing worktree and local server available for user testing.
