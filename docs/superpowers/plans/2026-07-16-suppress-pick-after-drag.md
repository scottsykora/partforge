# Suppress Pick After Drag Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task.

**Goal:** Prevent a camera-orbit drag that ends over the viewer canvas from being interpreted as a geometry pick.

**Architecture:** `attachPicker` remains the single owner of click-to-select behavior. It records pointer-down coordinates and marks the gesture as dragged after more than four pixels of movement, then consumes that state in the existing click handler before raycasting.

**Tech Stack:** Plain ESM JavaScript, browser Pointer Events, three.js, Vitest, Happy DOM

---

### Task 1: Add drag classification regression coverage

**Files:**
- Modify: `test/selection-pick.test.js`

**Step 1: Add a failing beyond-threshold test**

Create an active picker with a real three.js camera and box mesh. Dispatch `pointerdown` at `(100, 100)`, `pointermove` to `(110, 100)`, and `click` at `(110, 100)`. Assert that `onPick` and `flashPoint` are not called.

**Step 2: Run the focused test and verify RED**

Run: `npx vitest run test/selection-pick.test.js`

Expected: FAIL because the current click handler raycasts and calls `onPick` after the drag.

**Step 3: Add within-threshold coverage**

Add a sibling test that moves from `(100, 100)` to `(102, 102)` before clicking and asserts one selection and one flash. This protects the intentional jitter tolerance.

### Task 2: Implement gesture-aware picking

**Files:**
- Modify: `src/framework/selection/pick.js`
- Test: `test/selection-pick.test.js`

**Step 1: Track pointer gesture state**

Add private state for the current pointer identifier, its starting coordinates, and whether it crossed the drag threshold. Register `pointerdown` and `pointermove` listeners on `viewer.domElement`.

**Step 2: Suppress and consume drag clicks**

At the start of the active click path, capture and reset the gesture state. Return without raycasting when the captured gesture crossed the threshold. Preserve synthetic clicks that had no preceding pointer-down.

**Step 3: Clean up every listener**

Extend `detach()` to remove `pointerdown`, `pointermove`, and `click` handlers using the same function references that were registered.

**Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run test/selection-pick.test.js`

Expected: all selection-picker tests pass.

### Task 3: Verify and publish

**Files:**
- Review all changed files

**Step 1: Run the complete unit suite**

Run: `npm test`

Expected: all Vitest tests pass.

**Step 2: Run the production build**

Run: `npm run build`

Expected: Vite completes successfully.

**Step 3: Inspect the final diff**

Run: `git diff main...HEAD` and `git status --short`

Expected: only the design, plan, picker implementation, and focused tests are changed; the working tree is clean after commit.

**Step 4: Commit and push**

Commit the implementation with `fix: suppress picks after viewer drags`, push `codex/suppress-pick-after-drag`, and open a draft pull request against `main`.
