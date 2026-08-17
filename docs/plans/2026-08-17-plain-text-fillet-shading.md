# Plain-Text Fillet Shading Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the plain-text fillet lighting groove, add the Scott label reproducer, and finish PR #144's release cleanup.

**Architecture:** Keep the CSG mesh and feature-edge pass unchanged. Make `creasedNormals` resolve noisy sub-`MIN_FACE` faces per output corner against compatible healthy smoothing surfaces, and lock the behavior with both synthetic and real Roboto glyph regressions.

**Tech Stack:** JavaScript ESM, Manifold WASM, Vitest, Vite, GitHub CLI.

---

### Task 1: Add the Scott label reproducer

**Files:**
- Add: `scott-label.html`
- Add: `src/app-scott-label.js`
- Add: `src/parts/scott-label.js`
- Add: `src/scott-label-worker.js`

**Step 1: Validate the fixture**

Run `node bin/cli.js render src/parts/scott-label.js lettering --params '{"bold":0,"italic":0,"fontStyle":"roboto","text":"Scott"}' --views iso --out /tmp/partforge-pr144-before`.

Expected: render succeeds and the edge-free high-resolution diagnostic shows the dark band on the plain `t`.

**Step 2: Add the files unchanged**

Keep the cloud-part source and Vite worker wiring as the troubleshooting reference.

**Step 3: Commit**

Commit message: `test: add Scott label fillet repro`

### Task 2: Lock the shading bug with failing tests

**Files:**
- Modify: `test/creased-normals.test.js`
- Add or modify: `test/mesh-fillet-corners.test.js`

**Step 1: Add a synthetic crease-preservation test**

Construct a thin bridge touching healthy faces on two sides of a real crease. Assert
that the sliver corners follow their local side and that the two healthy sides do not
smooth together.

**Step 2: Add the real glyph regression**

Build the unbolded default-font `t` at 31 mm, extrude it 2 mm, and fillet its top rim
by 0.3 mm. Measure hard normal discontinuities whose endpoints lie strictly inside
the fillet band and assert that no long stripe remains; separately assert intended
corner feature edges and genus zero.

**Step 3: Verify RED**

Run the two focused tests.

Expected: FAIL because thin faces keep their tilted normals and create a long hard
normal discontinuity through the real glyph band.

**Step 4: Commit the failing tests**

Commit message: `test: reproduce plain glyph fillet shading groove`

### Task 3: Resolve sliver shading per corner

**Files:**
- Modify: `src/framework/geometry/creased-normals.js`

**Step 1: Build trustworthy smoothing candidates**

For each vertex, retain incident faces at or above `MIN_FACE`. Preserve the current
OID/policy compatibility and crease-angle rules.

**Step 2: Resolve thin output corners**

For a thin face corner, select a compatible healthy incident smoothing surface by
supporting-plane fit over the thin triangle. Resolve through adjacent thin faces only
when the corner has no healthy candidate. Keep the choice local to the corner.

**Step 3: Exclude noisy contributions**

When averaging a healthy corner, do not add raw normals from sub-`MIN_FACE` faces;
add only their resolved local surface normal when it belongs to the same smoothing
group.

**Step 4: Verify GREEN**

Run `npx vitest run test/creased-normals.test.js test/mesh-fillet-corners.test.js`.

Expected: PASS.

**Step 5: Run adjacent regressions**

Run `npx vitest run test/mesh-fillet-boundary-lines.test.js test/roundall-feature-lines.test.js test/offset-text-shading.test.js`.

Expected: PASS.

**Step 6: Commit**

Commit message: `fix: smooth boolean slivers per fillet surface`

### Task 4: Review and release cleanup

**Files:**
- Modify: `package.json`
- Review: all files changed from `origin/main`

**Step 1: Audit the patch**

Run `git diff --check origin/main...HEAD` and inspect all production changes for
unnecessary branches, duplicated constants, stale comments, and missing tests.

**Step 2: Apply only evidence-backed cleanup**

Keep cleanup within PR #144's roundAll, planar-rim, feature-line, and shading scope.

**Step 3: Bump the release version**

Change `package.json` from `0.67.0` to `0.67.1`.

**Step 4: Commit**

Commit message: `chore: prepare partforge 0.67.1`

### Task 5: Verify, publish the PR update, and serve the sample

**Files:**
- Verify all changed files

**Step 1: Run complete verification**

Run `npm test`, `npm run build`, and `npm run check` under Node 24.

Expected: all pass.

**Step 2: Render the fixed fixture**

Render the plain Scott lettering at high resolution with edges disabled and inspect
the result against the baseline image.

**Step 3: Update PR metadata and branch**

Retarget PR #144 to `main`, push the existing PR branch, and confirm checks start on
the new head.

**Step 4: Start the manual-check server**

Run the Vite development server bound to loopback and report the exact
`scott-label.html` URL. Leave the server running for the user.
