# Mesh Fillet Review Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix small circular-blend topology, make arc `near` selectors tessellation-independent, and synchronize all shipped contract guidance in PR #133.

**Architecture:** Keep the existing sharp-edge extraction and tangent-tool CSG pipeline. Add analytic point-distance logic for fitted arc chains, and bound revolve robustness allowances so they cross the faceted flank without overwhelming the requested blend. Lock both behaviors with real Manifold regression tests before changing production code.

**Tech Stack:** JavaScript ESM, Manifold WASM, Vitest, Markdown/TypeScript declaration documentation.

---

### Task 1: Analytic `near` selection for circular chains

**Files:**
- Modify: `test/mesh-fillet.test.js`
- Modify: `src/framework/geometry/mesh-fillet.js:303-329`

**Step 1: Write the failing test**

Add a test that fillets the top rim of a radius-10 cylinder using exact 30° and 45° points and asserts both builds remain on Manifold, retain genus zero, and have the same volume as the 0° selection.

**Step 2: Verify RED**

Run: `npx vitest run test/mesh-fillet.test.js -t "matches analytic near points"`

Expected: FAIL because the 30°/45° calls throw `KernelCapabilityError: selector matched no sharp edges`.

**Step 3: Implement the minimum fix**

For `chain.kind === "arc"`, compute axial distance and radial error from `chain.O`/`chain.w`/`chain.R`, then check the query azimuth against `chain.span` for open arcs. Keep segment distance for non-arcs.

**Step 4: Verify GREEN**

Run the same focused test and then `npx vitest run test/mesh-fillet.test.js`.

Expected: PASS.

**Step 5: Commit**

Commit message: `fix: match near selectors against analytic arcs`

### Task 2: Preserve topology for small circular blends

**Files:**
- Modify: `test/mesh-fillet.test.js`
- Modify: `src/framework/geometry/mesh-fillet.js:420-440`

**Step 1: Write the failing tests**

Add tests for a radius-10 cylinder top rim asserting:

- `fillet({r: 0.01})` and `chamfer({d: 0.1})` have genus zero;
- their removed volumes stay close to the analytic Pappus values;
- the same assertions hold with a print-quality kernel.

**Step 2: Verify RED**

Run: `npx vitest run test/mesh-fillet.test.js -t "small circular"`

Expected: FAIL because preview results report nonzero genus and small-feature volume exceeds tolerance.

**Step 3: Implement the minimum fix**

Scale/cap the tangent overshoot and chamfer burial relative to `magnitude`, while retaining enough overlap to cross the known facet sag. If the required overlap cannot fit within the feature tolerance, use a cutter construction that crosses the flank without extending the visible blend surface.

**Step 4: Verify GREEN**

Run the focused test, the entire mesh-fillet test file, and the Manifold measurement/capability tests.

Expected: PASS with genus zero at preview and print quality.

**Step 5: Commit**

Commit message: `fix: preserve topology for small circular blends`

### Task 3: Synchronize contract v3 documentation

**Files:**
- Modify: `src/framework/geometry/kernel.js`
- Modify: `src/framework/backend-select.js`
- Modify: `types/kernel.d.ts`
- Modify: `README.md`
- Modify: `docs/AUTHORING-PARTS.md`
- Modify: `docs/ERROR-PATTERNS.md`
- Modify: `test/kernel-contract.test.js` or a focused documentation test

**Step 1: Write the failing contract check**

Add a focused assertion that shipped type declarations and troubleshooting guidance do not describe Solid fillet/chamfer as OCCT-only or probe-routed.

**Step 2: Verify RED**

Run the focused contract test.

Expected: FAIL on the stale declaration/error-pattern text.

**Step 3: Update the shipped guidance**

Describe fillet/chamfer as mesh-native for supported straight/circular edges with runtime OCCT fallback; reserve up-front probe routing for shell. Remove stale section names and comments.

**Step 4: Verify GREEN**

Run the focused contract test plus lint/probe/type-surface tests.

Expected: PASS.

**Step 5: Commit**

Commit message: `docs: align public fillet routing guidance`

### Task 4: Final verification and publish

**Files:**
- Review all changes relative to `origin/main`

**Step 1: Run focused verification**

Run the mesh-fillet, capability, probe, calling-convention, contract, lint, and type-surface tests under Node 24.

**Step 2: Run complete verification**

Run `npm test` and `npm run check`. If loopback tests are blocked by sandbox policy, rerun that file outside the sandbox and record both results.

**Step 3: Inspect scope**

Run `git status -sb`, `git diff --check`, and inspect `git diff origin/main...HEAD` for unintended changes.

**Step 4: Push**

Push `claude/manifold-fillet-operations-8ab4cd` to `origin` and confirm PR #133 points at the new head with passing checks queued.
