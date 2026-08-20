# View-Orientation Cube + Projection Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a ghost-cube orientation widget above the viewbar whose 26 regions tween the camera to canonical angles, with model-frame X/Y/Z arrows drawn in front of it and a one-button perspective/orthographic toggle beneath.

**Architecture:** A pure, DOM-free, three-free geometry leaf (`cube-geom.js`) owns the cube's 26 regions, their projection by a camera quaternion, the painter sort, and point-in-polygon hit-testing. A thin renderer (`cube-canvas.js`) paints a small 2D canvas from that projection through an injectable 2D context. An orchestrator (`viewcube-mode.js`) wires the viewer's frame loop, pointer input, and mode rules. Separately, the viewer gains a second `OrthographicCamera` and an `activeCamera` binding, with `viewer.camera` becoming a getter.

**Tech Stack:** Plain ESM, three.js r184, vitest (node env for pure modules, `// @vitest-environment happy-dom` for DOM ones), Vite for the dev apps.

**Spec:** `docs/superpowers/specs/2026-08-19-view-orientation-cube-design.md`

## Global Constraints

- **Node 24.** `.nvmrc` pins it; the default shell Node is too old. Run `nvm use` before `npm install`, tests, or the CLI, or geometry/tests fail confusingly. If `source nvm.sh` is blocked in your sandbox, PATH-prefix the pinned Node from `~/.nvm/versions`.
- **Units are millimetres** throughout the viewer's world space.
- **Pure modules stay pure.** `cube-geom.js`, `camera-orbit.js`, and `projection.js` import nothing — no DOM, no `three`, no `node:`.
- **Part modules are DOM-free and side-effect-free.** Nothing in this plan touches `src/parts/`.
- **The model pivot is fixed:** `pivot.rotation.x = -Math.PI / 2`, mapping model (x, y, z) → world (x, z, −y). Model +Z is world +Y (up).
- **Model-frame face names:** `right` = model +X, `left` = model −X, `back` = model +Y, `front` = model −Y, `top` = model +Z, `bottom` = model −Z.
- **Canonical id ordering** is vertical, then depth, then side: `top-front-right`, never `right-front-top`.
- **`CANONICAL_VIEWS` must remain exactly 7 entries** — `captureViewsFromScene` slices against its length, the CLI takes a view name from it, and partforge-cloud's render tool names them.
- **`captureCanonicalViews`, `renderMeshPayloads`, and the CLI stay perspective unconditionally.** Only the live view and `captureCurrent` follow the projection toggle.
- **Commit after every task.** Tests must pass before each commit: `npx vitest run <file>` for the task's own tests, `npm test` before the final task.

---

### Task 1: The 26-orientation map in `view-angles.js`

The cube needs 26 camera directions. `CANONICAL_VIEWS` stays at 7 because other systems slice against its length; a separate `ORIENTATIONS` map carries the full set, and the 7 canonical names resolve to identical poses.

**Files:**
- Modify: `src/framework/view-angles.js`
- Test: `test/framework/view-angles.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ORIENTATIONS: Record<string, { id: string, parts: string[], dir: [number,number,number], up: [number,number,number] }>` — 26 entries, world-space directions.
  - `ORIENTATION_IDS: string[]` — the 26 ids.
  - `cameraPoseForView(view, { center, radius })` now accepts any of the 26 ids as well as the existing 7.
  - `CANONICAL_VIEWS` unchanged, still 7 entries.

- [ ] **Step 1: Write the failing test**

Create `test/framework/view-angles.test.js`:

```js
// The 26-orientation map that the view cube clicks through. CANONICAL_VIEWS is
// deliberately NOT this list — captureViewsFromScene slices against its length
// and the CLI names it, so growing it would change those contracts.
import { describe, expect, it } from "vitest";
import {
  CANONICAL_VIEWS,
  ORIENTATIONS,
  ORIENTATION_IDS,
  cameraPoseForView,
} from "../../src/framework/view-angles.js";

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};

describe("ORIENTATIONS", () => {
  it("has exactly 26 entries: 6 faces, 12 edges, 8 corners", () => {
    expect(ORIENTATION_IDS).toHaveLength(26);
    const byArity = { 1: 0, 2: 0, 3: 0 };
    for (const id of ORIENTATION_IDS) byArity[ORIENTATIONS[id].parts.length]++;
    expect(byArity).toEqual({ 1: 6, 2: 12, 3: 8 });
  });

  it("leaves CANONICAL_VIEWS at its 7 entries", () => {
    expect(CANONICAL_VIEWS).toHaveLength(7);
  });

  it("gives every orientation a non-degenerate direction", () => {
    for (const id of ORIENTATION_IDS) {
      expect(Math.hypot(...ORIENTATIONS[id].dir)).toBeGreaterThan(0.5);
    }
  });

  it("maps the model frame onto world space through the pivot", () => {
    // front = model -Y = world +Z; top = model +Z = world +Y; right = model +X.
    expect(ORIENTATIONS.front.dir).toEqual([0, 0, 1]);
    expect(ORIENTATIONS.back.dir).toEqual([0, 0, -1]);
    expect(ORIENTATIONS.top.dir).toEqual([0, 1, 0]);
    expect(ORIENTATIONS.bottom.dir).toEqual([0, -1, 0]);
    expect(ORIENTATIONS.right.dir).toEqual([1, 0, 0]);
    expect(ORIENTATIONS.left.dir).toEqual([-1, 0, 0]);
  });

  it("orders compound ids vertical, then depth, then side", () => {
    expect(ORIENTATIONS["top-front-right"]).toBeDefined();
    expect(ORIENTATIONS["right-front-top"]).toBeUndefined();
    expect(ORIENTATIONS["front-left"]).toBeDefined();
    expect(ORIENTATIONS["left-front"]).toBeUndefined();
  });

  it("keeps the special up vectors on pure top and bottom only", () => {
    expect(ORIENTATIONS.top.up).toEqual([0, 0, -1]);
    expect(ORIENTATIONS.bottom.up).toEqual([0, 0, 1]);
    expect(ORIENTATIONS["top-front"].up).toEqual([0, 1, 0]);
    expect(ORIENTATIONS.front.up).toEqual([0, 1, 0]);
  });

  it("makes top-front-right the same pose as the existing iso view", () => {
    const opts = { center: [0, 0, 0], radius: 10 };
    const iso = cameraPoseForView("iso", opts);
    const corner = cameraPoseForView("top-front-right", opts);
    for (let i = 0; i < 3; i++) {
      expect(corner.position[i]).toBeCloseTo(iso.position[i], 10);
    }
    expect(norm(ORIENTATIONS["top-front-right"].dir)).toEqual(norm([1, 1, 1]));
  });

  it("still throws on an unknown id", () => {
    expect(() => cameraPoseForView("sideways", { center: [0, 0, 0], radius: 1 }))
      .toThrow(/unknown canonical view/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/framework/view-angles.test.js`
Expected: FAIL — `ORIENTATIONS` and `ORIENTATION_IDS` are not exported.

- [ ] **Step 3: Implement the orientation map**

Append to `src/framework/view-angles.js`, after the existing `DIRS` object and before `norm`:

```js
// The view cube's 26 orientations: 6 faces, 12 edges, 8 corners. Deliberately
// SEPARATE from CANONICAL_VIEWS, which stays at 7 — captureViewsFromScene
// slices against its length and the CLI names it, so growing that list would
// change contracts the cube has no business touching. The seven canonical
// names resolve to identical poses (iso === top-front-right).
//
// Face names are MODEL-frame (parts are authored Z-up); the world directions
// below already carry the pivot's rotation.x = -PI/2, which maps model
// (x, y, z) -> world (x, z, -y).
const FACE_DIRS = {
  right:  [1, 0, 0],   // model +X
  left:   [-1, 0, 0],  // model -X
  top:    [0, 1, 0],   // model +Z
  bottom: [0, -1, 0],  // model -Z
  front:  [0, 0, 1],   // model -Y
  back:   [0, 0, -1],  // model +Y
};

// Canonical id ordering. A compound id always reads vertical, then depth, then
// side — "top-front-right", never "right-front-top" — so cube-geom.js can
// assemble an id from three independent axis choices and land on the same
// string every time.
const VERTICAL = ["top", "bottom"];
const DEPTH = ["front", "back"];
const SIDE = ["left", "right"];

// A pure top or bottom view is degenerate against a +Y up vector, so those two
// keep the special-cased ups DIRS already used. Every compound orientation has
// a well-defined +Y up.
function upFor(parts) {
  if (parts.length === 1 && parts[0] === "top") return [0, 0, -1];
  if (parts.length === 1 && parts[0] === "bottom") return [0, 0, 1];
  return [0, 1, 0];
}

function buildOrientations() {
  const out = {};
  const add = (parts) => {
    const dir = [0, 0, 0];
    for (const part of parts) {
      const d = FACE_DIRS[part];
      dir[0] += d[0];
      dir[1] += d[1];
      dir[2] += d[2];
    }
    const id = parts.join("-");
    out[id] = { id, parts: [...parts], dir, up: upFor(parts) };
  };
  for (const face of Object.keys(FACE_DIRS)) add([face]);
  for (const v of VERTICAL) for (const other of [...DEPTH, ...SIDE]) add([v, other]);
  for (const d of DEPTH) for (const s of SIDE) add([d, s]);
  for (const v of VERTICAL) for (const d of DEPTH) for (const s of SIDE) add([v, d, s]);
  return out;
}

export const ORIENTATIONS = buildOrientations();
export const ORIENTATION_IDS = Object.keys(ORIENTATIONS);
```

Then widen the lookup in `cameraPoseForView` — replace the existing first line of its body:

```js
  const a = DIRS[view];
```

with:

```js
  // DIRS first so the seven canonical names keep their exact existing poses;
  // ORIENTATIONS covers the other nineteen the cube can reach.
  const a = DIRS[view] ?? ORIENTATIONS[view];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/framework/view-angles.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Confirm nothing that consumed the old module broke**

Run: `npx vitest run test/framework/viewer-capture-view.test.js test/framework/mount-capture-view.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/framework/view-angles.js test/framework/view-angles.test.js
git commit -m "feat(view-angles): 26-orientation map for the view cube

CANONICAL_VIEWS stays at 7 — captureViewsFromScene slices against its
length and the CLI names it. ORIENTATIONS carries the cube's full set,
with the seven canonical names resolving to identical poses."
```

---

### Task 2: `cube-geom.js` — regions, projection, painter sort, hit test

The pure leaf. Each of the cube's 6 faces is a 3×3 grid of cells: the centre cell is the face, the 4 edge cells belong to the 12 edges (each edge appears on 2 faces), the 4 corner cells belong to the 8 corners (each corner appears on 3 faces). That is 54 cells mapping onto 26 ids.

**Files:**
- Create: `src/framework/viewcube/cube-geom.js`
- Test: `test/framework/viewcube/cube-geom.test.js` (create)

**Interfaces:**
- Consumes: nothing (imports nothing at all).
- Produces:
  - `CUBE_CONSTANTS: { faceHalf: number, arrowLength: number, labelOffset: number, tailFraction: number }` — mutable-by-edit tuning block; Task 4 locks the values.
  - `PIVOT_QUAT: [number, number, number, number]` — the model→world quaternion, `[x, y, z, w]`.
  - `cubeCells(): Array<{ id, axis, sign, corners: number[][], normal: number[] }>` — the 54 cells in model space.
  - `projectCube(cameraQuat, { size }): { back: Cell2D[], front: Cell2D[], arrows: Arrow2D[] }` where `Cell2D = { id, points: [number,number][], depth: number }` and `Arrow2D = { axis: "X"|"Y"|"Z", from: [number,number], tail: [number,number], tip: [number,number], label: [number,number], depth: number }`. `cameraQuat` is `[x, y, z, w]`.
  - `hitRegion(px, py, projected): string | null`.

- [ ] **Step 1: Write the failing test**

Create `test/framework/viewcube/cube-geom.test.js`:

```js
// The view cube's pure geometry: 54 surface cells mapping onto 26 orientation
// ids, projected by a camera quaternion and hit-tested by point-in-polygon.
// No DOM, no three, no GL — this is the module that carries the widget's
// correctness, so it carries the coverage too.
import { describe, expect, it } from "vitest";
import {
  CUBE_CONSTANTS,
  cubeCells,
  projectCube,
  hitRegion,
} from "../../../src/framework/viewcube/cube-geom.js";
import { ORIENTATION_IDS } from "../../../src/framework/view-angles.js";

const SIZE = 100;
const IDENTITY = [0, 0, 0, 1];

// Camera looking straight down world +Z at the origin is the identity
// quaternion, which — through the pivot — puts the model's -Y face
// ("front") toward the viewer.
const centre = () => [SIZE / 2, SIZE / 2];

// Probe a cell by its own centroid rather than a hardcoded pixel. The cube
// occupies only the middle of the canvas (the scale leaves room for the arrows
// and their labels), and Task 4 retunes every constant that decides how much —
// so any hardcoded probe would be both wrong now and fragile later.
function centroidOf(projected, id) {
  const cell = projected.front.find((c) => c.id === id);
  if (!cell) throw new Error(`no camera-facing cell "${id}" — cannot probe it`);
  const n = cell.points.length;
  return [
    cell.points.reduce((s, p) => s + p[0], 0) / n,
    cell.points.reduce((s, p) => s + p[1], 0) / n,
  ];
}

describe("cubeCells", () => {
  it("emits 54 cells: 6 faces x 3x3", () => {
    expect(cubeCells()).toHaveLength(54);
  });

  it("uses only ids from the 26-orientation map", () => {
    for (const cell of cubeCells()) expect(ORIENTATION_IDS).toContain(cell.id);
  });

  it("covers all 26 ids, with faces once, edges twice, corners three times", () => {
    const counts = new Map();
    for (const cell of cubeCells()) counts.set(cell.id, (counts.get(cell.id) ?? 0) + 1);
    expect(counts.size).toBe(26);
    expect(counts.get("front")).toBe(1);
    expect(counts.get("front-right")).toBe(2);
    expect(counts.get("top-front-right")).toBe(3);
  });

  it("gives every cell four non-degenerate corners on the cube surface", () => {
    for (const cell of cubeCells()) {
      expect(cell.corners).toHaveLength(4);
      for (const c of cell.corners) {
        expect(Math.max(Math.abs(c[0]), Math.abs(c[1]), Math.abs(c[2]))).toBeCloseTo(1, 10);
      }
    }
  });
});

describe("projectCube", () => {
  it("splits cells into camera-facing and away-facing halves", () => {
    const p = projectCube(IDENTITY, { size: SIZE });
    expect(p.front.length).toBeGreaterThan(0);
    expect(p.back.length).toBeGreaterThan(0);
    expect(p.front.length + p.back.length).toBe(54);
  });

  it("sorts each half back-to-front so a painter can just draw in order", () => {
    const p = projectCube([0.2, 0.3, 0.1, 0.927], { size: SIZE });
    for (const list of [p.back, p.front]) {
      for (let i = 1; i < list.length; i++) {
        expect(list[i].depth).toBeGreaterThanOrEqual(list[i - 1].depth);
      }
    }
  });

  it("puts the model's front face toward the camera at identity", () => {
    const p = projectCube(IDENTITY, { size: SIZE });
    expect(p.front.some((c) => c.id === "front")).toBe(true);
    expect(p.back.some((c) => c.id === "back")).toBe(true);
  });

  it("keeps every projected point inside the canvas box", () => {
    const p = projectCube([0.2, 0.3, 0.1, 0.927], { size: SIZE });
    for (const cell of [...p.back, ...p.front]) {
      for (const [x, y] of cell.points) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(SIZE);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(SIZE);
      }
    }
  });

  it("emits three axis arrows, all starting at the projected origin", () => {
    const p = projectCube(IDENTITY, { size: SIZE });
    expect(p.arrows.map((a) => a.axis)).toEqual(["X", "Y", "Z"]);
    for (const arrow of p.arrows) {
      expect(arrow.from[0]).toBeCloseTo(SIZE / 2, 6);
      expect(arrow.from[1]).toBeCloseTo(SIZE / 2, 6);
    }
  });

  it("draws Z upward on screen at identity (model +Z is world up)", () => {
    const p = projectCube(IDENTITY, { size: SIZE });
    const z = p.arrows.find((a) => a.axis === "Z");
    expect(z.tip[1]).toBeLessThan(SIZE / 2); // screen y grows downward
  });
});

describe("hitRegion", () => {
  it("returns the front face at the centre of the canvas", () => {
    const p = projectCube(IDENTITY, { size: SIZE });
    expect(hitRegion(...centre(), p)).toBe("front");
  });

  it("returns a corner id on the corner cell", () => {
    const p = projectCube(IDENTITY, { size: SIZE });
    // At identity, model -X projects screen-left and model +Z projects
    // screen-up, so the front face's upper-left cell is "top-front-left".
    expect(hitRegion(...centroidOf(p, "top-front-left"), p)).toBe("top-front-left");
  });

  it("returns an edge id on the edge cell", () => {
    const p = projectCube(IDENTITY, { size: SIZE });
    expect(hitRegion(...centroidOf(p, "top-front"), p)).toBe("top-front");
  });

  it("places the corner cells where the axis directions say they should be", () => {
    // Guards the projection's screen orientation, which the centroid probes
    // above would otherwise satisfy no matter how the cube were mirrored.
    const p = projectCube(IDENTITY, { size: SIZE });
    const [leftX, topY] = centroidOf(p, "top-front-left");
    const [rightX] = centroidOf(p, "top-front-right");
    const [, bottomY] = centroidOf(p, "bottom-front-left");
    expect(leftX).toBeLessThan(rightX);   // model -X is screen-left
    expect(topY).toBeLessThan(bottomY);   // model +Z is screen-up (y grows down)
  });

  it("returns null outside the cube silhouette", () => {
    const p = projectCube(IDENTITY, { size: SIZE });
    expect(hitRegion(-5, -5, p)).toBeNull();
    expect(hitRegion(SIZE + 20, SIZE / 2, p)).toBeNull();
  });

  it("never returns an away-facing cell", () => {
    const p = projectCube(IDENTITY, { size: SIZE });
    const backIds = new Set(p.back.map((c) => c.id));
    const frontIds = new Set(p.front.map((c) => c.id));
    for (let x = 0; x <= SIZE; x += 5) {
      for (let y = 0; y <= SIZE; y += 5) {
        const hit = hitRegion(x, y, p);
        if (hit && backIds.has(hit)) expect(frontIds.has(hit)).toBe(true);
      }
    }
  });
});

describe("CUBE_CONSTANTS", () => {
  it("keeps the face cell smaller than the whole face", () => {
    expect(CUBE_CONSTANTS.faceHalf).toBeGreaterThan(0);
    expect(CUBE_CONSTANTS.faceHalf).toBeLessThan(1);
  });

  it("pushes the arrows outside the cube so they read in front of it", () => {
    expect(CUBE_CONSTANTS.arrowLength).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/framework/viewcube/cube-geom.test.js`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the pure geometry module**

Create `src/framework/viewcube/cube-geom.js`:

```js
// The view cube's geometry, hit model, and projection — the pure leaf of the
// viewcube trio (cf. ink.js under annotate/, dim3-place.js under measure/).
// No DOM, no three, no node:. Everything here is plain numbers so the whole
// widget's correctness is testable without a GL context.
//
// The cube is modelled as 6 faces x a 3x3 grid = 54 surface cells. The centre
// cell of a face IS that face; the 4 edge cells belong to the 12 edges (each
// edge shows up on 2 faces); the 4 corner cells belong to the 8 corners (each
// corner shows up on 3 faces). 6 + 24 + 24 = 54 cells over 26 ids.
//
// Coordinates are MODEL space (parts are authored Z-up), so a cell's id can be
// assembled directly from the model axes it touches. PIVOT_QUAT carries the
// viewer's fixed pivot (rotation.x = -PI/2) so the drawing always agrees with
// the part on screen.

// Tuning block. Locked by the look-and-feel spike (see the plan's Task 4);
// every visual proportion the widget has lives here and nowhere else.
export const CUBE_CONSTANTS = {
  faceHalf: 0.62,      // half-width of the centre (face) cell, cube half-extent = 1
  arrowLength: 1.45,   // axis arrow tip, in cube half-extents — >1 so arrows clear the cube
  labelOffset: 0.22,   // label sits this far beyond the tip
  tailFraction: 0.72,  // arrow tail is drawn to this fraction of the tip, head covers the rest
};

// The viewer's pivot is rotation.x = -PI/2: quaternion (sin(-PI/4), 0, 0, cos(-PI/4)).
const HALF_SQRT2 = Math.SQRT1_2;
export const PIVOT_QUAT = [-HALF_SQRT2, 0, 0, HALF_SQRT2];

// Model axis -> face name for each sign. Mirrors FACE_DIRS in view-angles.js;
// kept here as the model-space twin so this module needs no import.
const AXIS_FACE = {
  x: { 1: "right", "-1": "left" },
  y: { 1: "back", "-1": "front" },
  z: { 1: "top", "-1": "bottom" },
};
const AXIS_INDEX = { x: 0, y: 1, z: 2 };

// Canonical id ordering: vertical, then depth, then side (see view-angles.js).
const ORDER = { top: 0, bottom: 0, front: 1, back: 1, left: 2, right: 2 };
const idFor = (parts) => [...parts].sort((a, b) => ORDER[a] - ORDER[b]).join("-");

// The two in-plane axes for each face normal, in a fixed order so cell
// enumeration is deterministic.
const IN_PLANE = { x: ["y", "z"], y: ["x", "z"], z: ["x", "y"] };

// Cell bounds along one in-plane axis for grid index -1 / 0 / +1.
function span(index, half) {
  if (index < 0) return [-1, -half];
  if (index > 0) return [half, 1];
  return [-half, half];
}

// The 54 cells, in model space. Recomputed per call rather than cached: it is a
// few hundred arithmetic ops, and a cached array would be mutable shared state
// in a module the rest of the framework expects to be pure.
export function cubeCells({ faceHalf = CUBE_CONSTANTS.faceHalf } = {}) {
  const cells = [];
  for (const axis of ["x", "y", "z"]) {
    for (const sign of [1, -1]) {
      const [uAxis, vAxis] = IN_PLANE[axis];
      const n = AXIS_INDEX[axis], u = AXIS_INDEX[uAxis], v = AXIS_INDEX[vAxis];
      const normal = [0, 0, 0];
      normal[n] = sign;
      for (const i of [-1, 0, 1]) {
        for (const j of [-1, 0, 1]) {
          const [u0, u1] = span(i, faceHalf);
          const [v0, v1] = span(j, faceHalf);
          const parts = [AXIS_FACE[axis][String(sign)]];
          if (i !== 0) parts.push(AXIS_FACE[uAxis][String(Math.sign(i))]);
          if (j !== 0) parts.push(AXIS_FACE[vAxis][String(Math.sign(j))]);
          // Wound consistently so the projected polygon is convex in order.
          const corners = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([uu, vv]) => {
            const p = [0, 0, 0];
            p[n] = sign;
            p[u] = uu;
            p[v] = vv;
            return p;
          });
          cells.push({ id: idFor(parts), axis, sign, normal, corners });
        }
      }
    }
  }
  return cells;
}

// --- quaternion helpers (plain arrays, [x, y, z, w]) ------------------------
function qMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];

function qApply(q, v) {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}

// Project the cube as seen by a camera with world quaternion `cameraQuat`.
// Model -> world is the fixed pivot; world -> view is the camera's inverse
// rotation. The projection is deliberately ORTHOGRAPHIC regardless of the
// viewer's own projection: a widget that foreshortened would read as a bug.
//
// View space follows three.js: the camera looks down -Z, so a LARGER z is
// NEARER. Both halves are sorted ascending, which is exactly painter order.
export function projectCube(cameraQuat, {
  size,
  faceHalf = CUBE_CONSTANTS.faceHalf,
  arrowLength = CUBE_CONSTANTS.arrowLength,
  labelOffset = CUBE_CONSTANTS.labelOffset,
  tailFraction = CUBE_CONSTANTS.tailFraction,
} = {}) {
  const toView = qMul(qConj(cameraQuat), PIVOT_QUAT);
  // Scale so the cube's longest diagonal still fits the box at any rotation.
  const scale = (size / 2) / (Math.sqrt(3) * Math.max(arrowLength + labelOffset, 1));
  const cx = size / 2, cy = size / 2;
  const project = (p) => {
    const v = qApply(toView, p);
    return { xy: [cx + v[0] * scale, cy - v[1] * scale], z: v[2] };
  };

  const back = [], front = [];
  for (const cell of cubeCells({ faceHalf })) {
    const projected = cell.corners.map(project);
    const normalView = qApply(toView, cell.normal);
    const depth = projected.reduce((s, p) => s + p.z, 0) / projected.length;
    const entry = { id: cell.id, points: projected.map((p) => p.xy), depth };
    // normalView[2] > 0 means the face's outward normal points at the camera.
    (normalView[2] > 0 ? front : back).push(entry);
  }
  back.sort((a, b) => a.depth - b.depth);
  front.sort((a, b) => a.depth - b.depth);

  const origin = project([0, 0, 0]);
  const arrows = [["X", [1, 0, 0]], ["Y", [0, 1, 0]], ["Z", [0, 0, 1]]].map(([axis, dir]) => {
    const tip = project(dir.map((c) => c * arrowLength));
    const tail = project(dir.map((c) => c * arrowLength * tailFraction));
    const label = project(dir.map((c) => c * (arrowLength + labelOffset)));
    return { axis, from: origin.xy, tail: tail.xy, tip: tip.xy, label: label.xy, depth: tip.z };
  });

  return { back, front, arrows };
}

// Convex point-in-polygon: every cross product keeps the same sign.
function inside(px, py, points) {
  let positive = false, negative = false;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (cross > 0) positive = true;
    if (cross < 0) negative = true;
    if (positive && negative) return false;
  }
  return true;
}

// Which orientation is under the cursor. Only camera-facing cells are
// candidates — you cannot click the far side of a cube — and they are tested
// nearest-first so an overlap resolves to the one actually on top.
export function hitRegion(px, py, projected) {
  const cells = projected?.front ?? [];
  for (let i = cells.length - 1; i >= 0; i--) {
    if (inside(px, py, cells[i].points)) return cells[i].id;
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/framework/viewcube/cube-geom.test.js`
Expected: PASS, 16 tests.

If the "returns an edge id along a face border" or "returns a corner id" cases fail, the likely cause is the screen-y sign or the in-plane axis order for the `y` face, not the id assembly — print `projectCube(IDENTITY, { size: 100 }).front.map(c => c.id)` and check which cell actually contains the probe point before changing anything else.

- [ ] **Step 5: Commit**

```bash
git add src/framework/viewcube/cube-geom.js test/framework/viewcube/cube-geom.test.js
git commit -m "feat(viewcube): pure cube geometry, projection, and hit model

54 surface cells over 26 orientation ids, projected by a camera
quaternion through the viewer's fixed pivot, painter-sorted, and
hit-tested by convex point-in-polygon. No DOM, no three, no GL."
```

---

### Task 3: `cube-canvas.js` — the 2D canvas renderer

Paints the projection. The 2D context is injectable exactly as `createInkCanvas`'s is, because happy-dom has no real 2D context.

**Files:**
- Create: `src/framework/viewcube/cube-canvas.js`
- Test: `test/framework/viewcube/cube-canvas.test.js` (create)

**Interfaces:**
- Consumes: `projectCube`'s return shape from Task 2.
- Produces: `createCubeCanvas(host, { getContext2d?, createCanvas?, size? }) => { element, draw(projected, { hover }), setTheme(mode), size, dispose() }`. Also exports `CUBE_SIZE: number` and `CUBE_PALETTE: { dark: {...}, light: {...} }`.

- [ ] **Step 1: Write the failing test**

Create `test/framework/viewcube/cube-canvas.test.js`:

```js
// @vitest-environment happy-dom
// The view cube's renderer. happy-dom has no real 2d context, so the context is
// injected and the assertions are on the DRAW ORDER and the fills chosen — the
// two things that decide whether a ghost cube with arrows in front of it reads
// correctly (the ink-canvas.js / dim3-scene paintLabel precedent).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCubeCanvas, CUBE_PALETTE } from "../../../src/framework/viewcube/cube-canvas.js";

function fakeContext() {
  const calls = [];
  const ctx = {
    calls,
    canvas: { width: 0, height: 0 },
    setTransform: (...a) => calls.push(["setTransform", ...a]),
    clearRect: (...a) => calls.push(["clearRect", ...a]),
    beginPath: () => calls.push(["beginPath"]),
    moveTo: (...a) => calls.push(["moveTo", ...a]),
    lineTo: (...a) => calls.push(["lineTo", ...a]),
    closePath: () => calls.push(["closePath"]),
    fill: () => calls.push(["fill", ctx.fillStyle]),
    stroke: () => calls.push(["stroke", ctx.strokeStyle]),
    fillText: (...a) => calls.push(["fillText", a[0], ctx.fillStyle]),
    set fillStyle(v) { this._fill = v; },
    get fillStyle() { return this._fill; },
    set strokeStyle(v) { this._stroke = v; },
    get strokeStyle() { return this._stroke; },
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
  };
  return ctx;
}

const projection = {
  back: [{ id: "back", points: [[0, 0], [10, 0], [10, 10], [0, 10]], depth: -1 }],
  front: [
    { id: "front", points: [[2, 2], [8, 2], [8, 8], [2, 8]], depth: 1 },
    { id: "top-front", points: [[2, 0], [8, 0], [8, 2], [2, 2]], depth: 1.1 },
  ],
  arrows: [
    { axis: "X", from: [5, 5], tail: [9, 5], tip: [10, 5], label: [11, 5], depth: 0.5 },
    { axis: "Y", from: [5, 5], tail: [5, 9], tip: [5, 10], label: [5, 11], depth: 0.4 },
    { axis: "Z", from: [5, 5], tail: [5, 1], tip: [5, 0], label: [5, -1], depth: 0.6 },
  ],
};

let host, handle, ctx;
beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  ctx = fakeContext();
  handle = createCubeCanvas(host, { getContext2d: () => ctx });
});
afterEach(() => handle?.dispose());

const order = () => ctx.calls.map((c) => c[0]);
const fills = () => ctx.calls.filter((c) => c[0] === "fill").map((c) => c[1]);
const texts = () => ctx.calls.filter((c) => c[0] === "fillText").map((c) => c[1]);

describe("createCubeCanvas", () => {
  it("appends a canvas to the host", () => {
    expect(host.querySelector("canvas")).toBe(handle.element);
    expect(handle.element.className).toContain("pf-viewcube-canvas");
  });

  it("clears before drawing anything", () => {
    handle.draw(projection, {});
    expect(order()[0]).toBe("setTransform");
    expect(order()[1]).toBe("clearRect");
  });

  it("sizes the backing store by DPR while the CSS box stays in CSS px", () => {
    // Sizing the backing store in CSS px while scaling the context by DPR
    // renders everything at 2x on a retina display and clips the cube to its
    // top-left quarter — silent on a 1x test machine, obvious on a laptop.
    const original = globalThis.devicePixelRatio;
    globalThis.devicePixelRatio = 2;
    try {
      handle.draw(projection, {});
      expect(handle.element.width).toBe(handle.size * 2);
      expect(handle.element.height).toBe(handle.size * 2);
      expect(handle.element.style.width).toBe(`${handle.size}px`);
      // The context is scaled by the same factor, so draw code stays in CSS px.
      expect(ctx.calls[0]).toEqual(["setTransform", 2, 0, 0, 2, 0, 0]);
    } finally {
      globalThis.devicePixelRatio = original;
    }
  });

  it("draws back faces, then arrow tails, then front faces, then heads, then labels", () => {
    handle.draw(projection, {});
    const backFace = ctx.calls.findIndex((c) => c[0] === "fill" && c[1] === CUBE_PALETTE.dark.backFill);
    const tail = ctx.calls.findIndex((c) => c[0] === "stroke" && c[1] === CUBE_PALETTE.dark.axisX);
    const frontFace = ctx.calls.findIndex((c) => c[0] === "fill" && c[1] === CUBE_PALETTE.dark.frontFill);
    const head = ctx.calls.findIndex((c) => c[0] === "fill" && c[1] === CUBE_PALETTE.dark.axisX);
    const label = ctx.calls.findIndex((c) => c[0] === "fillText");
    expect(backFace).toBeGreaterThan(-1);
    expect(backFace).toBeLessThan(tail);
    expect(tail).toBeLessThan(frontFace);
    expect(frontFace).toBeLessThan(head);
    expect(head).toBeLessThan(label);
  });

  it("labels the three model axes", () => {
    handle.draw(projection, {});
    expect(texts()).toEqual(["X", "Y", "Z"]);
  });

  it("paints the hovered region in the highlight fill and leaves the others alone", () => {
    handle.draw(projection, { hover: "top-front" });
    expect(fills()).toContain(CUBE_PALETTE.dark.hoverFill);
    expect(fills()).toContain(CUBE_PALETTE.dark.frontFill);
  });

  it("uses no highlight fill when nothing is hovered", () => {
    handle.draw(projection, {});
    expect(fills()).not.toContain(CUBE_PALETTE.dark.hoverFill);
  });

  it("repaints in the light palette after a theme change", () => {
    handle.draw(projection, {});
    ctx.calls.length = 0;
    handle.setTheme("light");
    expect(fills()).toContain(CUBE_PALETTE.light.frontFill);
  });

  it("removes its canvas on dispose", () => {
    handle.dispose();
    expect(host.querySelector("canvas")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/framework/viewcube/cube-canvas.test.js`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the renderer**

Create `src/framework/viewcube/cube-canvas.js`:

```js
// The view cube's renderer: one small 2D canvas, repainted only when the camera
// actually moved (viewcube-mode.js owns that decision). A canvas rather than
// SVG because the alternative rewrites ~26 polygon `points` attributes inside
// the rAF callback, and each write re-parses a string and invalidates style and
// paint for the subtree — spent during orbit, which is the worst time to spend
// it. Here an idle frame costs literally nothing.
//
// The 2D context is injected (happy-dom has no real one) — the createInkCanvas
// and dim3-scene paintLabel precedent.

export const CUBE_SIZE = 90; // CSS px; the backing store is this x devicePixelRatio

// Deliberately hardcoded rather than read from CSS vars: this paints into a
// bitmap where var() cannot reach, exactly like DIM_THEME in dim3-scene.js.
// Locked by the look-and-feel spike (plan Task 4).
export const CUBE_PALETTE = {
  dark: {
    backFill: "rgba(124, 143, 176, 0.10)",
    frontFill: "rgba(159, 180, 204, 0.22)",
    hoverFill: "rgba(122, 162, 247, 0.55)",
    edge: "rgba(190, 205, 226, 0.45)",
    axisX: "#e06c75",
    axisY: "#98c379",
    axisZ: "#61afef",
    label: "#d6e2ff",
  },
  light: {
    backFill: "rgba(70, 88, 118, 0.08)",
    frontFill: "rgba(90, 108, 138, 0.18)",
    hoverFill: "rgba(43, 108, 214, 0.45)",
    edge: "rgba(56, 72, 98, 0.45)",
    axisX: "#c0392b",
    axisY: "#2f7d32",
    axisZ: "#1f6feb",
    label: "#182a4e",
  },
};

const HEAD_HALF_WIDTH = 0.34; // arrowhead half-width as a fraction of its length

export function createCubeCanvas(host, {
  getContext2d = (canvas) => canvas.getContext("2d"),
  createCanvas = () => document.createElement("canvas"),
  size = CUBE_SIZE,
} = {}) {
  const canvas = createCanvas();
  canvas.className = "pf-viewcube-canvas";
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  host.appendChild(canvas);
  const ctx = getContext2d(canvas);

  let theme = "dark";
  let last = null; // the most recent { projected, hover }, so setTheme can repaint
  let backingDpr = 0;

  // The BACKING STORE is size x dpr while the CSS box stays `size` — and draw()
  // scales the context by the same dpr so it can keep working in CSS px. Sizing
  // the backing store in CSS px while scaling the context is the classic
  // version of this bug: everything renders at 2x on a retina display and the
  // cube is clipped to its top-left quarter. Re-checked per draw because a
  // window can move between displays of different density.
  function syncBackingStore(dpr) {
    if (dpr === backingDpr) return;
    backingDpr = dpr;
    canvas.width = Math.max(1, Math.round(size * dpr));
    canvas.height = Math.max(1, Math.round(size * dpr));
  }

  function polygon(points) {
    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
  }

  function head(arrow, colour) {
    const [tx, ty] = arrow.tip;
    const [bx, by] = arrow.tail;
    const dx = tx - bx, dy = ty - by;
    const nx = -dy * HEAD_HALF_WIDTH, ny = dx * HEAD_HALF_WIDTH;
    ctx.fillStyle = colour;
    polygon([[tx, ty], [bx + nx, by + ny], [bx - nx, by - ny]]);
    ctx.fill();
  }

  function draw(projected, { hover } = {}) {
    if (!ctx || !projected) return;
    last = { projected, hover };
    const p = CUBE_PALETTE[theme] ?? CUBE_PALETTE.dark;
    const dpr = globalThis.devicePixelRatio || 1;
    syncBackingStore(dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.lineWidth = 1;

    for (const cell of projected.back) {
      ctx.fillStyle = p.backFill;
      ctx.strokeStyle = p.edge;
      polygon(cell.points);
      ctx.fill();
      ctx.stroke();
    }

    const axisColour = { X: p.axisX, Y: p.axisY, Z: p.axisZ };
    for (const arrow of projected.arrows) {
      ctx.strokeStyle = axisColour[arrow.axis];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(arrow.from[0], arrow.from[1]);
      ctx.lineTo(arrow.tail[0], arrow.tail[1]);
      ctx.stroke();
    }
    ctx.lineWidth = 1;

    for (const cell of projected.front) {
      ctx.fillStyle = cell.id === hover ? p.hoverFill : p.frontFill;
      ctx.strokeStyle = p.edge;
      polygon(cell.points);
      ctx.fill();
      ctx.stroke();
    }

    for (const arrow of projected.arrows) head(arrow, axisColour[arrow.axis]);

    ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const arrow of projected.arrows) {
      ctx.fillStyle = p.label;
      ctx.fillText(arrow.axis, arrow.label[0], arrow.label[1]);
    }
  }

  function setTheme(mode) {
    theme = CUBE_PALETTE[mode] ? mode : "dark";
    if (last) draw(last.projected, { hover: last.hover });
  }

  function dispose() {
    canvas.remove();
    last = null;
  }

  return { element: canvas, draw, setTheme, size, dispose };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/framework/viewcube/cube-canvas.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/framework/viewcube/cube-canvas.js test/framework/viewcube/cube-canvas.test.js
git commit -m "feat(viewcube): 2D canvas renderer with an injectable context

Draw order is back faces, arrow tails, translucent front faces,
arrowheads, labels — the ordering that makes a ghost cube with arrows in
front of it read correctly. Palette hardcoded per dim3-scene's DIM_THEME
precedent: this paints a bitmap, where var() cannot reach."
```

---

### Task 4: Look-and-feel spike — lock the visual constants

**This task has a human checkpoint and produces no shipped code.** Everything it builds is deleted before the commit. Its output is chosen numbers written into `CUBE_CONSTANTS`, `CUBE_PALETTE`, and `CUBE_SIZE`, plus two measurements recorded in the spec.

**Files:**
- Create (throwaway, deleted in Step 6): `viewcube-spike.html`, `src/app-viewcube-spike.js`
- Modify: `src/framework/viewcube/cube-geom.js` (the `CUBE_CONSTANTS` block only)
- Modify: `src/framework/viewcube/cube-canvas.js` (the `CUBE_SIZE` and `CUBE_PALETTE` blocks only)
- Modify: `docs/superpowers/specs/2026-08-19-view-orientation-cube-design.md` (the *Sequencing* section)

**Interfaces:**
- Consumes: `projectCube`, `CUBE_CONSTANTS` (Task 2); `createCubeCanvas`, `CUBE_PALETTE`, `CUBE_SIZE` (Task 3).
- Produces: no new API. Later tasks depend only on the constants existing, not on their values.

- [ ] **Step 1: Build the throwaway A/B page**

Create `viewcube-spike.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>View cube — look-and-feel spike (THROWAWAY)</title>
    <style>
      body { margin: 0; display: flex; font: 13px system-ui, sans-serif; }
      #stage { flex: 1; height: 100vh; background: #15181d; position: relative; }
      #stage.light { background: #e9edf2; }
      #mount { position: absolute; right: 24px; bottom: 24px; }
      #panel { width: 280px; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
      label { display: flex; justify-content: space-between; gap: 8px; }
      output { font-variant-numeric: tabular-nums; }
    </style>
  </head>
  <body>
    <div id="stage"><div id="mount"></div></div>
    <div id="panel">
      <strong>THROWAWAY spike</strong>
      <label>size <input id="size" type="range" min="56" max="140" step="2" /><output id="size-o"></output></label>
      <label>faceHalf <input id="faceHalf" type="range" min="0.3" max="0.9" step="0.01" /><output id="faceHalf-o"></output></label>
      <label>arrowLength <input id="arrowLength" type="range" min="1" max="2" step="0.01" /><output id="arrowLength-o"></output></label>
      <label>labelOffset <input id="labelOffset" type="range" min="0" max="0.5" step="0.01" /><output id="labelOffset-o"></output></label>
      <label>tailFraction <input id="tailFraction" type="range" min="0.4" max="0.95" step="0.01" /><output id="tailFraction-o"></output></label>
      <label>frontFill α <input id="frontA" type="range" min="0" max="1" step="0.01" /><output id="frontA-o"></output></label>
      <label>backFill α <input id="backA" type="range" min="0" max="1" step="0.01" /><output id="backA-o"></output></label>
      <label>hoverFill α <input id="hoverA" type="range" min="0" max="1" step="0.01" /><output id="hoverA-o"></output></label>
      <button id="theme">toggle theme</button>
      <button id="dump">dump values to console</button>
      <p id="fps"></p>
    </div>
    <script type="module" src="/src/app-viewcube-spike.js"></script>
  </body>
</html>
```

Create `src/app-viewcube-spike.js`:

```js
// THROWAWAY look-and-feel spike for the view cube. Deleted at the end of the
// plan's Task 4 — do not import anything from here, and do not add it to
// vite.config.js's rollupOptions.input.
import { CUBE_CONSTANTS, projectCube } from "./framework/viewcube/cube-geom.js";
import { createCubeCanvas, CUBE_PALETTE, CUBE_SIZE } from "./framework/viewcube/cube-canvas.js";

const state = { ...CUBE_CONSTANTS, size: CUBE_SIZE, frontA: 0.22, backA: 0.10, hoverA: 0.55 };
let theme = "dark";
let cube = null;
let hover = null;
// A slow idle spin so every angle gets looked at; the cube is drawn from a
// quaternion, so this is exactly the input the real orchestrator supplies.
let t = 0;

const alpha = (rgba, a) => rgba.replace(/[\d.]+\)$/, `${a})`);

function rebuild() {
  cube?.dispose();
  CUBE_PALETTE.dark.frontFill = alpha(CUBE_PALETTE.dark.frontFill, state.frontA);
  CUBE_PALETTE.dark.backFill = alpha(CUBE_PALETTE.dark.backFill, state.backA);
  CUBE_PALETTE.dark.hoverFill = alpha(CUBE_PALETTE.dark.hoverFill, state.hoverA);
  CUBE_PALETTE.light.frontFill = alpha(CUBE_PALETTE.light.frontFill, state.frontA);
  CUBE_PALETTE.light.backFill = alpha(CUBE_PALETTE.light.backFill, state.backA);
  CUBE_PALETTE.light.hoverFill = alpha(CUBE_PALETTE.light.hoverFill, state.hoverA);
  cube = createCubeCanvas(document.getElementById("mount"), { size: state.size });
  cube.setTheme(theme);
  cube.element.addEventListener("pointermove", (e) => {
    const r = cube.element.getBoundingClientRect();
    hover = { x: e.clientX - r.left, y: e.clientY - r.top };
  });
  cube.element.addEventListener("pointerleave", () => { hover = null; });
}

for (const key of ["size", "faceHalf", "arrowLength", "labelOffset", "tailFraction", "frontA", "backA", "hoverA"]) {
  const input = document.getElementById(key);
  input.value = state[key];
  document.getElementById(`${key}-o`).textContent = state[key];
  input.addEventListener("input", () => {
    state[key] = Number(input.value);
    document.getElementById(`${key}-o`).textContent = input.value;
    if (key === "size") rebuild();
  });
}
document.getElementById("theme").addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark";
  document.getElementById("stage").classList.toggle("light", theme === "light");
  cube.setTheme(theme);
});
document.getElementById("dump").addEventListener("click", () => console.log(JSON.stringify(state, null, 2)));

rebuild();

let frames = 0, since = performance.now();
function tick() {
  t += 0.004;
  const s = Math.sin(t / 2), c = Math.cos(t / 2);
  const quat = [s * 0.35, s * 0.9, 0, c];
  const len = Math.hypot(...quat);
  const projected = projectCube(quat.map((v) => v / len), { size: state.size, ...state });
  const { hitRegion } = window.__geom ?? {};
  cube.draw(projected, { hover: hover && hitRegion ? hitRegion(hover.x, hover.y, projected) : null });
  frames++;
  const now = performance.now();
  if (now - since > 1000) {
    document.getElementById("fps").textContent = `${frames} draws/s`;
    frames = 0;
    since = now;
  }
  requestAnimationFrame(tick);
}
import("./framework/viewcube/cube-geom.js").then((m) => { window.__geom = m; });
requestAnimationFrame(tick);
```

- [ ] **Step 2: Run the spike and tune with the user**

```bash
nvm use && npm run dev
```

Open `http://localhost:5173/viewcube-spike.html`. **Ask the user to tune the sliders and toggle the theme, then confirm the values.** Do not pick these yourself — the whole point of this task is that the constants are chosen by eye in a real browser rather than guessed. Click "dump values to console" and record the JSON.

- [ ] **Step 3: Measure the two things the design asserts but does not know**

In Chrome DevTools, with the spike running:

1. **Phone redraw cost.** Performance panel → CPU throttling "4× slowdown" → record 5 seconds → confirm the scripting time attributable to `draw` stays under ~2 ms per frame. Record the observed number.
2. **Idle cost.** Temporarily comment out the `t += 0.004` line so the quaternion stops changing, reload, and confirm the "draws/s" readout goes to 0 once the orchestrator's dirty-check is in place. In the spike itself the draw is unconditional, so what this establishes is the *baseline* cost of one draw; the dirty-check itself is asserted by a test in Task 9. Record the baseline.

- [ ] **Step 4: Write the chosen constants into the real modules**

Edit `CUBE_CONSTANTS` in `src/framework/viewcube/cube-geom.js`, and `CUBE_SIZE` plus the alpha values in `CUBE_PALETTE` in `src/framework/viewcube/cube-canvas.js`, to the confirmed values. Change nothing else in either file.

- [ ] **Step 5: Record the outcome in the spec**

In `docs/superpowers/specs/2026-08-19-view-orientation-cube-design.md`, replace the *Sequencing* section's body with the chosen constants (as a small table) and the two measured numbers, and note that the spike has been discarded.

- [ ] **Step 6: Delete the spike and verify nothing references it**

```bash
rm viewcube-spike.html src/app-viewcube-spike.js
grep -rn "viewcube-spike" --exclude-dir=node_modules --exclude-dir=.git .
```

Expected: no matches. Confirm `vite.config.js`'s `rollupOptions.input` was never touched.

- [ ] **Step 7: Run the tests to verify the new constants did not break the geometry**

Run: `npx vitest run test/framework/viewcube/`
Expected: PASS. If the `CUBE_CONSTANTS` assertions fail, the chosen `faceHalf` left `(0, 1)` or `arrowLength` dropped to `1` or below — both are genuine constraints, so re-tune rather than relaxing the test.

- [ ] **Step 8: Commit**

```bash
git add src/framework/viewcube/cube-geom.js src/framework/viewcube/cube-canvas.js docs/superpowers/specs/2026-08-19-view-orientation-cube-design.md
git commit -m "polish(viewcube): lock the cube's visual constants from the spike

Constants chosen by eye in a real browser rather than guessed. The spike
app itself is discarded; the spec records the chosen values and the two
measurements it existed to take."
```

---

### Task 5: `camera-orbit.js` + `viewer.orbitBy()`

Dragging the cube must orbit the real camera. This is spherical math about the camera's own `up`, matching what OrbitControls does internally, kept pure so the widget never touches three.

**Files:**
- Create: `src/framework/camera-orbit.js`
- Modify: `src/framework/viewer.js`
- Test: `test/framework/camera-orbit.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `orbitPose({ position, target, up }, { dx, dy }, { radiansPerPx?, minPolar?, maxPolar? }) => { position: number[], target: number[] }`
  - `viewer.orbitBy(dx, dy)` on the viewer handle.

- [ ] **Step 1: Write the failing test**

Create `test/framework/camera-orbit.test.js`:

```js
// The spherical math behind "drag the view cube to orbit". Pure, so the widget
// never touches three; the sign convention matches OrbitControls (drag right
// decreases theta, drag down decreases phi).
import { describe, expect, it } from "vitest";
import { orbitPose } from "../../src/framework/camera-orbit.js";

const Y_UP = [0, 1, 0];
const base = { position: [0, 0, 10], target: [0, 0, 0], up: Y_UP };
const dist = (p, t) => Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);

describe("orbitPose", () => {
  it("is exactly a no-op for a zero delta", () => {
    const out = orbitPose(base, { dx: 0, dy: 0 });
    expect(out.position[0]).toBeCloseTo(0, 10);
    expect(out.position[1]).toBeCloseTo(0, 10);
    expect(out.position[2]).toBeCloseTo(10, 10);
  });

  it("never changes the orbit radius", () => {
    for (const d of [{ dx: 40, dy: 0 }, { dx: 0, dy: 30 }, { dx: -25, dy: -60 }]) {
      const out = orbitPose(base, d, { radiansPerPx: 0.01 });
      expect(dist(out.position, out.target)).toBeCloseTo(10, 8);
    }
  });

  it("never moves the target", () => {
    const out = orbitPose({ ...base, target: [1, 2, 3] }, { dx: 50, dy: 20 }, { radiansPerPx: 0.01 });
    expect(out.target).toEqual([1, 2, 3]);
  });

  it("swings the camera one way for a rightward drag and back for a leftward one", () => {
    const right = orbitPose(base, { dx: 30, dy: 0 }, { radiansPerPx: 0.01 });
    const left = orbitPose(base, { dx: -30, dy: 0 }, { radiansPerPx: 0.01 });
    expect(Math.sign(right.position[0])).toBe(-Math.sign(left.position[0]));
    expect(right.position[0]).not.toBeCloseTo(0, 3);
  });

  it("round-trips: equal and opposite drags return to the start", () => {
    const there = orbitPose(base, { dx: 33, dy: 17 }, { radiansPerPx: 0.01 });
    const back = orbitPose({ ...there, up: Y_UP }, { dx: -33, dy: -17 }, { radiansPerPx: 0.01 });
    for (let i = 0; i < 3; i++) expect(back.position[i]).toBeCloseTo(base.position[i], 8);
  });

  it("clamps at the top pole rather than flipping over it", () => {
    // OrbitControls' convention: phi -= dy, so a DOWNWARD drag (positive dy)
    // raises the camera. An unbounded drag pins it just short of straight up.
    const out = orbitPose(base, { dx: 0, dy: 100000 }, { radiansPerPx: 0.01 });
    expect(dist(out.position, out.target)).toBeCloseTo(10, 8);
    expect(out.position[1]).toBeGreaterThan(9.9);
  });

  it("clamps at the bottom pole too", () => {
    const out = orbitPose(base, { dx: 0, dy: -100000 }, { radiansPerPx: 0.01 });
    expect(dist(out.position, out.target)).toBeCloseTo(10, 8);
    expect(out.position[1]).toBeLessThan(-9.9);
  });

  it("orbits about a non-Y up vector without changing the radius", () => {
    const topView = { position: [0, 10, 0], target: [0, 0, 0], up: [0, 0, -1] };
    const out = orbitPose(topView, { dx: 20, dy: 10 }, { radiansPerPx: 0.01 });
    expect(dist(out.position, out.target)).toBeCloseTo(10, 8);
  });

  it("returns the pose untouched when the camera sits on the target", () => {
    const degenerate = { position: [5, 5, 5], target: [5, 5, 5], up: Y_UP };
    const out = orbitPose(degenerate, { dx: 10, dy: 10 });
    expect(out.position).toEqual([5, 5, 5]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/framework/camera-orbit.test.js`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement `camera-orbit.js`**

Create `src/framework/camera-orbit.js`:

```js
// Spherical orbit math, pure. Exists so the view cube can orbit the real camera
// by handing the viewer a pixel delta, without importing three itself.
//
// The frame is the camera's own `up`, not world +Y — after a tween to the top
// view the up vector is [0, 0, -1], and orbiting about +Y there would swing the
// camera sideways instead of around the part. OrbitControls solves this the same
// way (it builds a quaternion taking object.up to +Y); this is that, by hand.
//
// Sign convention follows OrbitControls exactly: dragging right decreases theta,
// dragging down decreases phi.

const EPS = 1e-8;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Rodrigues rotation of v about unit axis k by angle t.
function rotate(v, k, t) {
  const c = Math.cos(t), s = Math.sin(t);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [
    v[0] * c + kv[0] * s + k[0] * kd,
    v[1] * c + kv[1] * s + k[1] * kd,
    v[2] * c + kv[2] * s + k[2] * kd,
  ];
}

// A pair of functions taking `up` onto +Y and back again.
function upFrame(up) {
  const l = length(up);
  if (l < EPS) return { to: (v) => v, from: (v) => v };
  const u = [up[0] / l, up[1] / l, up[2] / l];
  const axis = cross(u, [0, 1, 0]);
  const al = length(axis);
  if (al < EPS) {
    // Parallel (already +Y) or antiparallel (upside down): a half turn about X.
    if (dot(u, [0, 1, 0]) > 0) return { to: (v) => v, from: (v) => v };
    const k = [1, 0, 0];
    return { to: (v) => rotate(v, k, Math.PI), from: (v) => rotate(v, k, Math.PI) };
  }
  const k = [axis[0] / al, axis[1] / al, axis[2] / al];
  const angle = Math.acos(clamp(dot(u, [0, 1, 0]), -1, 1));
  return { to: (v) => rotate(v, k, angle), from: (v) => rotate(v, k, -angle) };
}

export function orbitPose(
  { position, target, up = [0, 1, 0] },
  { dx = 0, dy = 0 } = {},
  { radiansPerPx = 0.005, minPolar = 1e-4, maxPolar = Math.PI - 1e-4 } = {},
) {
  const offset = sub(position, target);
  const radius = length(offset);
  // A camera sitting exactly on its target has no orbit to speak of; returning
  // the pose untouched beats emitting NaN.
  if (radius < EPS) return { position: [...position], target: [...target] };

  const frame = upFrame(up);
  const o = frame.to(offset);
  const theta = Math.atan2(o[0], o[2]) - dx * radiansPerPx;
  const phi = clamp(Math.acos(clamp(o[1] / radius, -1, 1)) - dy * radiansPerPx, minPolar, maxPolar);
  const sinPhi = Math.sin(phi);
  const next = [
    radius * sinPhi * Math.sin(theta),
    radius * Math.cos(phi),
    radius * sinPhi * Math.cos(theta),
  ];
  return { position: add(target, frame.from(next)), target: [...target] };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/framework/camera-orbit.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Add `orbitBy` to the viewer**

In `src/framework/viewer.js`, add to the imports at the top:

```js
import { orbitPose } from "./camera-orbit.js";
```

Then, immediately after the `const cancelCameraTween = () => camTween.cancel();` line, insert:

```js
  // Orbit from a pixel delta — the view cube's drag. Routed through the viewer
  // rather than done in the widget so the two things a real orbit owes its
  // subscribers happen: an in-flight camera cue is cancelled, and the
  // camera-start listeners fire (the animation driver disarms remaining cues).
  // Same contract as grabbing the canvas, which OrbitControls' "start" event
  // gives us for free.
  function orbitBy(dx, dy) {
    camTween.cancel();
    for (const cb of [...cameraStartListeners]) cb();
    const next = orbitPose(
      {
        position: camera.position.toArray(),
        target: controls.target.toArray(),
        up: camera.up.toArray(),
      },
      { dx, dy },
      // Match OrbitControls' own feel: a full drag down the viewport is a half
      // turn, so the cube and the canvas rotate at the same rate.
      { radiansPerPx: (2 * Math.PI) / Math.max(1, container.clientHeight || 1) },
    );
    camera.position.fromArray(next.position);
    controls.update();
  }
```

Add `orbitBy,` to the returned handle object, right after `cancelCameraTween,`.

> **Note for Task 7:** that body references `camera` directly. Task 7 renames every internal camera reference in `viewer.js` to `activeCamera`; this function is included in that sweep.

- [ ] **Step 6: Run the viewer tests**

Run: `npx vitest run test/framework/viewer-pose.test.js test/framework/viewer-active.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/framework/camera-orbit.js src/framework/viewer.js test/framework/camera-orbit.test.js
git commit -m "feat(viewer): orbitBy for external drag sources

Pure spherical math about the camera's own up vector, so a tween to the
top view still orbits around the part. Routed through the viewer so a
cube drag cancels camera cues exactly as a canvas drag does."
```

---

### Task 6: `projection.js` — the framing conversion pair

Perspective framing is a distance; orthographic framing is a frustum height plus a zoom. These two functions are what make the toggle visually seamless in both directions.

**Files:**
- Create: `src/framework/projection.js`
- Test: `test/framework/projection.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `orthoFrustum({ fovDeg, distance, aspect }) => { halfW, halfH, left, right, top, bottom }`
  - `perspectiveDistance({ halfH, zoom, fovDeg }) => number`

- [ ] **Step 1: Write the failing test**

Create `test/framework/projection.test.js`:

```js
// The perspective <-> orthographic framing pair. Getting this wrong is visible
// as a jump in part size the instant the user hits the projection toggle, so
// the round trip is asserted in both directions and through a dolly.
import { describe, expect, it } from "vitest";
import { orthoFrustum, perspectiveDistance } from "../../src/framework/projection.js";

const FOV = 45;

describe("orthoFrustum", () => {
  it("matches the perspective frustum's half-height at the target distance", () => {
    const { halfH } = orthoFrustum({ fovDeg: FOV, distance: 100, aspect: 1 });
    expect(halfH).toBeCloseTo(100 * Math.tan((FOV * Math.PI) / 360), 10);
  });

  it("widens with aspect and leaves the height alone", () => {
    const square = orthoFrustum({ fovDeg: FOV, distance: 50, aspect: 1 });
    const wide = orthoFrustum({ fovDeg: FOV, distance: 50, aspect: 2 });
    expect(wide.halfH).toBeCloseTo(square.halfH, 10);
    expect(wide.halfW).toBeCloseTo(square.halfW * 2, 10);
  });

  it("emits a symmetric frustum", () => {
    const f = orthoFrustum({ fovDeg: FOV, distance: 30, aspect: 1.5 });
    expect(f.left).toBeCloseTo(-f.right, 12);
    expect(f.bottom).toBeCloseTo(-f.top, 12);
    expect(f.right).toBeCloseTo(f.halfW, 12);
    expect(f.top).toBeCloseTo(f.halfH, 12);
  });
});

describe("perspectiveDistance", () => {
  it("round-trips an unzoomed frustum back to the original distance", () => {
    const { halfH } = orthoFrustum({ fovDeg: FOV, distance: 137.5, aspect: 1.77 });
    expect(perspectiveDistance({ halfH, zoom: 1, fovDeg: FOV })).toBeCloseTo(137.5, 8);
  });

  it("treats an ortho zoom as a proportionally closer camera", () => {
    const { halfH } = orthoFrustum({ fovDeg: FOV, distance: 100, aspect: 1 });
    expect(perspectiveDistance({ halfH, zoom: 2, fovDeg: FOV })).toBeCloseTo(50, 8);
    expect(perspectiveDistance({ halfH, zoom: 0.5, fovDeg: FOV })).toBeCloseTo(200, 8);
  });

  it("defaults zoom to 1", () => {
    const { halfH } = orthoFrustum({ fovDeg: FOV, distance: 42, aspect: 1 });
    expect(perspectiveDistance({ halfH, fovDeg: FOV })).toBeCloseTo(42, 8);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/framework/projection.test.js`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement `projection.js`**

Create `src/framework/projection.js`:

```js
// The perspective <-> orthographic framing pair. Pure, so the swap's only
// interesting property — that the part does not change size the instant the
// user hits the toggle — is unit-testable without a renderer.
//
// Perspective frames by DISTANCE; orthographic frames by a frustum height plus
// a zoom (OrbitControls dollies an ortho camera by changing camera.zoom, not by
// moving it). These two functions convert between the two descriptions.

const halfHeightAt = (fovDeg, distance) => distance * Math.tan((fovDeg * Math.PI) / 360);

export function orthoFrustum({ fovDeg, distance, aspect = 1 }) {
  const halfH = halfHeightAt(fovDeg, distance);
  const halfW = halfH * aspect;
  return { halfW, halfH, left: -halfW, right: halfW, top: halfH, bottom: -halfH };
}

export function perspectiveDistance({ halfH, zoom = 1, fovDeg }) {
  return halfH / (zoom * Math.tan((fovDeg * Math.PI) / 360));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/framework/projection.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/framework/projection.js test/framework/projection.test.js
git commit -m "feat(projection): pure perspective/orthographic framing pair

Round-trips a frustum height back to a camera distance, carrying the
ortho zoom, so toggling projection never resizes the part on screen."
```

---

### Task 7: Dual camera in `viewer.js`

**Files:**
- Modify: `src/framework/viewer.js`
- Test: `test/framework/viewer-projection.test.js` (create)

**Interfaces:**
- Consumes: `orthoFrustum`, `perspectiveDistance` (Task 6).
- Produces on the viewer handle:
  - `camera` — now a **getter** returning the active camera.
  - `setProjection(mode: "perspective" | "orthographic") => string`
  - `getProjection() => string`
  - `onProjectionChange(cb) => () => void`
  - `captureCurrentFromScene(opts, deps)` gains `projection` and `orthoHalfH` in `deps`.

- [ ] **Step 1: Write the failing test**

Create `test/framework/viewer-projection.test.js`:

```js
// @vitest-environment happy-dom
// The projection swap. happy-dom has no WebGL, so this asserts the pure
// framing half of captureCurrentFromScene plus the camera-identity contract
// that every downstream consumer (measure, annotate, selection) depends on.
import { describe, expect, it, vi } from "vitest";
import { captureCurrentFromScene } from "../../src/framework/viewer.js";
import { orthoFrustum } from "../../src/framework/projection.js";

function liveCamera({ ortho = false } = {}) {
  const cam = {
    aspect: 2,
    fov: 45,
    position: { toArray: () => [0, 0, 100], clone: () => ({ copy: () => {} }), copy: () => {} },
    up: { toArray: () => [0, 1, 0] },
  };
  if (ortho) {
    cam.isOrthographicCamera = true;
    cam.fov = undefined;
    cam.top = 20;
    cam.bottom = -20;
    cam.zoom = 1;
  }
  return cam;
}

describe("captureCurrentFromScene", () => {
  it("captures in perspective by default, carrying the live fov", () => {
    const renderOffscreen = vi.fn(() => "data:image/jpeg;base64,x");
    captureCurrentFromScene({}, {
      renderer: { renderOffscreen },
      liveCamera: liveCamera(),
      target: [0, 0, 0],
      grid: null,
      maxTextureSize: 4096,
    });
    const opts = renderOffscreen.mock.calls[0][1];
    expect(opts.fov).toBe(45);
    expect(opts.projection ?? "perspective").toBe("perspective");
  });

  it("captures orthographically, with the live half-height, when told to", () => {
    const renderOffscreen = vi.fn(() => "data:image/jpeg;base64,x");
    captureCurrentFromScene({}, {
      renderer: { renderOffscreen },
      liveCamera: liveCamera({ ortho: true }),
      target: [0, 0, 0],
      grid: null,
      maxTextureSize: 4096,
      projection: "orthographic",
      orthoHalfH: 20,
    });
    const opts = renderOffscreen.mock.calls[0][1];
    expect(opts.projection).toBe("orthographic");
    expect(opts.orthoHalfH).toBe(20);
  });

  it("still honours the long-edge clamp in either projection", () => {
    const renderOffscreen = vi.fn(() => "x");
    captureCurrentFromScene({ size: 99999 }, {
      renderer: { renderOffscreen },
      liveCamera: liveCamera({ ortho: true }),
      target: [0, 0, 0],
      grid: null,
      maxTextureSize: 4096,
      projection: "orthographic",
      orthoHalfH: 20,
    });
    expect(renderOffscreen.mock.calls[0][1].width).toBe(4096);
  });
});

describe("orthoFrustum round trip through a resize", () => {
  it("holds the vertical extent when only the aspect changes", () => {
    const before = orthoFrustum({ fovDeg: 45, distance: 100, aspect: 1 });
    const after = orthoFrustum({ fovDeg: 45, distance: 100, aspect: 2.5 });
    expect(after.halfH).toBeCloseTo(before.halfH, 12);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/framework/viewer-projection.test.js`
Expected: FAIL — `projection` is not passed through to `renderOffscreen`.

- [ ] **Step 3: Extend `captureCurrentFromScene`**

In `src/framework/viewer.js`, change the `captureCurrentFromScene` signature's second parameter and the `renderOffscreen` call. Replace:

```js
export function captureCurrentFromScene(
  { size = 2048, hideGrid = true, quality = 0.9 } = {},
  { renderer, liveCamera, target, grid, maxTextureSize },
) {
```

with:

```js
export function captureCurrentFromScene(
  { size = 2048, hideGrid = true, quality = 0.9 } = {},
  { renderer, liveCamera, target, grid, maxTextureSize, projection = "perspective", orthoHalfH },
) {
```

and replace the `return renderer.renderOffscreen(...)` call inside its `try` with:

```js
    return renderer.renderOffscreen(
      { position: liveCamera.position.toArray(), up: liveCamera.up.toArray(), target },
      // fov is meaningless under an ortho camera; orthoHalfH replaces it. The
      // CANONICAL capture path deliberately never passes either — agent-facing
      // renders stay perspective regardless of what the user is looking at.
      { width, height, fov: liveCamera.fov ?? 45, quality, projection, orthoHalfH },
    );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/framework/viewer-projection.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the orthographic camera and the swap**

All of the following are inside `createViewer` in `src/framework/viewer.js`.

**5a.** Replace the camera construction block:

```js
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camera.position.set(18, 12, 18);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
```

with:

```js
  // Two cameras, one active. The perspective camera stays the source of truth
  // for fov and aspect; the ortho camera borrows both through projection.js so
  // a toggle never changes the part's size on screen.
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camera.position.set(18, 12, 18);
  const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
  orthoCamera.position.copy(camera.position);
  let activeCamera = camera;
  let projectionMode = "perspective";
  const projectionListeners = new Set();

  const controls = new OrbitControls(activeCamera, renderer.domElement);
  controls.enableDamping = true;
```

**5b.** Replace every remaining internal use of `camera` **as the live camera** with `activeCamera`. Those sites are: the `createCutaway({ ... camera, ... })` argument; `tweenCameraTo`'s `camera.position.toArray()`; `orbitBy`'s three references (added in Task 5); `frameTo`'s `camera.position.setLength(...)`; `resize`'s `camera.aspect`/`camera.updateProjectionMatrix()` (see 5c, which rewrites that block wholesale); `renderFrame`'s `camera.position.fromArray(tw.position)`, `renderer.render(scene, camera)` and `cutaway.renderOverlay(renderer, camera)`; `getCameraState`/`setCameraState`; `captureCanonicalViews`'s `liveCamera: camera`; and `captureCurrent`'s `liveCamera: camera`.

Leave alone: `renderOffscreen`'s local `cam`, `renderMeshPayloads`'s `fov: camera.fov` (canonical captures stay perspective, so the perspective camera's fov is the right source), and the `RT_OPTIONS`/`_rt` machinery.

**5c.** Replace the body of `resize()`'s camera lines. Change:

```js
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
```

to:

```js
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Hold the ortho camera's VERTICAL extent across a resize and let the width
    // follow the aspect — the same thing the perspective camera does, so a
    // window drag never rescales the part under either projection.
    const halfH = (orthoCamera.top - orthoCamera.bottom) / 2 || 1;
    applyOrthoFrustum({ halfH, halfW: halfH * (w / h) });
```

**5d.** Add the frustum helper and the swap. Insert immediately before `function frameTo(visibleNames) {`:

```js
  function applyOrthoFrustum({ halfW, halfH }) {
    orthoCamera.left = -halfW;
    orthoCamera.right = halfW;
    orthoCamera.top = halfH;
    orthoCamera.bottom = -halfH;
    orthoCamera.updateProjectionMatrix();
  }

  // Re-derive the ortho frustum from the perspective camera's fov at the
  // camera's CURRENT distance from the orbit target. Called on every swap into
  // ortho and after any reframe, which is what keeps the two projections
  // showing the same amount of part.
  function syncOrthoToPerspectiveFraming() {
    const distance = activeCamera.position.distanceTo(controls.target) || 1;
    applyOrthoFrustum(orthoFrustum({
      fovDeg: camera.fov,
      distance,
      aspect: camera.aspect || 1,
    }));
    orthoCamera.zoom = 1;
    orthoCamera.updateProjectionMatrix();
  }

  // Swap which camera is live. Everything downstream reads viewer.camera fresh
  // at call time, so the only wiring that has to move is OrbitControls' own
  // object and the cutaway's captured reference.
  function setProjection(mode) {
    const next = mode === "orthographic" ? "orthographic" : "perspective";
    if (next === projectionMode) return projectionMode;
    const from = activeCamera;
    const to = next === "orthographic" ? orthoCamera : camera;
    to.position.copy(from.position);
    to.up.copy(from.up);
    to.quaternion.copy(from.quaternion);
    if (next === "orthographic") {
      syncOrthoToPerspectiveFraming();
    } else {
      // Recover whatever dolly the user did while in ortho: OrbitControls
      // changes camera.zoom there rather than moving the camera, so the zoom
      // has to come back as a distance or the part jumps size.
      const halfH = (orthoCamera.top - orthoCamera.bottom) / 2 || 1;
      const distance = perspectiveDistance({ halfH, zoom: orthoCamera.zoom, fovDeg: camera.fov });
      const direction = from.position.clone().sub(controls.target).normalize();
      camera.position.copy(controls.target).addScaledVector(direction, distance);
    }
    to.updateProjectionMatrix();
    activeCamera = to;
    controls.object = to;
    controls.update();
    cutaway.setCamera(to);
    projectionMode = next;
    for (const cb of [...projectionListeners]) cb(projectionMode);
    return projectionMode;
  }

  function onProjectionChange(cb) {
    projectionListeners.add(cb);
    return () => projectionListeners.delete(cb);
  }
```

Add to the imports at the top of the file:

```js
import { orthoFrustum, perspectiveDistance } from "./projection.js";
```

**5e.** Make `frameTo` projection-aware. At the very end of `frameTo`, after `controls.target.set(0, 0, 0);`, add:

```js
    // Framing under ortho is a frustum, not a distance — without this the
    // reframe button moves the camera and nothing visibly changes.
    if (projectionMode === "orthographic") syncOrthoToPerspectiveFraming();
```

**5f.** Feed the projection into `captureCurrent`. Replace its `captureCurrentFromScene` call's dependency object with:

```js
    return captureCurrentFromScene(opts, {
      renderer: { renderOffscreen },
      liveCamera: activeCamera,
      target: controls.target.toArray(),
      grid,
      maxTextureSize: renderer.capabilities?.maxTextureSize,
      projection: projectionMode,
      orthoHalfH: (orthoCamera.top - orthoCamera.bottom) / 2,
    });
```

**5g.** Teach `renderOffscreen` to build an ortho temp camera. Replace:

```js
    const cam = new THREE.PerspectiveCamera(fov, width / height, 0.1, 1000);
```

with:

```js
    // Canonical captures never pass `projection`, so agent-facing renders and
    // the CLI stay perspective no matter what the user is looking at.
    const cam = projection === "orthographic"
      ? new THREE.OrthographicCamera(
          -orthoHalfH * (width / height), orthoHalfH * (width / height),
          orthoHalfH, -orthoHalfH, 0.1, 1000)
      : new THREE.PerspectiveCamera(fov, width / height, 0.1, 1000);
```

and widen its options destructuring:

```js
  function renderOffscreen({ position, up, target },
                           { width = _rtSize, height = _rtSize, fov = 45, quality = 0.9,
                             projection = "perspective", orthoHalfH = 1 } = {},
                           renderScene = scene) {
```

**5h.** Dispose the new listeners. In `dispose()`, beside `themeListeners.clear();`, add:

```js
    projectionListeners.clear();
```

**5i.** Export the new surface. In the returned object, replace the bare `camera,` entry with:

```js
    // A GETTER, not a value: the active camera changes when the projection is
    // toggled, and every consumer (measure/dim3-scene.js, selection/raycast.js,
    // annotate/annotate-mode.js, measure/measure-mode.js) reads viewer.camera
    // fresh at call time — so this is transparent to all of them.
    get camera() { return activeCamera; },
    setProjection,
    getProjection: () => projectionMode,
    onProjectionChange,
```

- [ ] **Step 6: Run the viewer suite**

Run: `npx vitest run test/framework/viewer-projection.test.js test/framework/viewer-pose.test.js test/framework/viewer-active.test.js test/framework/viewer-cutaway.test.js test/framework/viewer-capture-view.test.js test/framework/viewer-opacity.test.js test/framework/viewer-frame-guard.test.js`
Expected: PASS. `viewer-cutaway.test.js` may fail on `cutaway.setCamera` not existing — that is Task 8; if so, note it and proceed, then re-run at the end of Task 8.

- [ ] **Step 7: Commit**

```bash
git add src/framework/viewer.js test/framework/viewer-projection.test.js
git commit -m "feat(viewer): orthographic camera beside the perspective one

viewer.camera becomes a getter for the active camera; setProjection
swaps which one OrbitControls and the render loop use, carrying the
framing across in both directions. captureCurrent follows the toggle;
canonical captures and the CLI stay perspective."
```

---

### Task 8: The two silent-wrong call sites — `cutaway.setCamera` and ortho `worldPerPx`

Both of these fail quietly rather than loudly under an ortho camera, which is why they get their own task and their own tests.

**Files:**
- Modify: `src/framework/cutaway.js`
- Modify: `src/framework/cutaway-gizmo.js`
- Modify: `src/framework/measure/dim3-scene.js`
- Test: `test/framework/measure/dim3-scene.test.js` (extend)
- Test: `test/framework/cutaway.test.js` (extend)

**Interfaces:**
- Consumes: `viewer.setProjection` (Task 7).
- Produces:
  - `cutaway.setCamera(camera)` on the object returned by `createCutaway`.
  - `gizmo.setCamera(camera)` on the object returned by the gizmo factory in `cutaway-gizmo.js`.
  - `orthoWorldPerPx(top, bottom, zoom, viewportPx) => number` exported from `dim3-scene.js`.

- [ ] **Step 1: Write the failing tests**

Append to `test/framework/measure/dim3-scene.test.js`:

```js
describe("worldPerPx under an orthographic camera", () => {
  it("derives scale from the frustum, not from a fov that does not exist", () => {
    // A 40-unit-tall frustum across a 400px viewport is 0.1 world units per px,
    // at any distance — the property perspective's fov formula cannot express.
    expect(orthoWorldPerPx(20, -20, 1, 400)).toBeCloseTo(0.1, 12);
  });

  it("scales inversely with the ortho zoom", () => {
    expect(orthoWorldPerPx(20, -20, 2, 400)).toBeCloseTo(0.05, 12);
    expect(orthoWorldPerPx(20, -20, 0.5, 400)).toBeCloseTo(0.2, 12);
  });

  it("does not divide by zero on a degenerate zoom", () => {
    expect(Number.isFinite(orthoWorldPerPx(20, -20, 0, 400))).toBe(true);
  });

  it("takes no distance at all, unlike the perspective formula", () => {
    // The whole reason this function exists: perspective scale varies with
    // distance, ortho scale does not, so substituting a fov into worldPerPx
    // can never produce the right answer under an ortho camera.
    expect(orthoWorldPerPx.length).toBe(4); // (top, bottom, zoom, viewportPx)
    expect(worldPerPx(10, 45, 400)).not.toBeCloseTo(worldPerPx(1000, 45, 400), 6);
  });
});
```

Update that file's import line to include `orthoWorldPerPx` alongside `worldPerPx`.

Append to `test/framework/cutaway.test.js` (the file's own `createFixture` helper builds the controller; `THREE` is already imported there):

```js
describe("setCamera", () => {
  test("re-points the cutaway at a swapped camera", () => {
    // A cutaway built against one camera must follow a projection swap, or its
    // plane math and its gizmo keep sizing against a camera nobody renders.
    const { controller } = createFixture();
    const ortho = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 1000);
    ortho.position.set(0, 0, 20);
    ortho.lookAt(0, 0, 0);
    ortho.updateMatrixWorld(true);
    expect(() => controller.setCamera(ortho)).not.toThrow();
    // The swap must survive a real render pass, which is where a stale camera
    // reference would surface as a wrong section rather than an exception.
    expect(() => controller.renderOverlay(makeRenderer(), ortho)).not.toThrow();
  });

  test("ignores a null camera rather than blanking its reference", () => {
    const { controller, camera } = createFixture();
    controller.setCamera(null);
    expect(() => controller.renderOverlay(makeRenderer(), camera)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/framework/measure/dim3-scene.test.js test/framework/cutaway.test.js`
Expected: FAIL — `orthoWorldPerPx` is not exported; `cutaway.setCamera` is not a function.

- [ ] **Step 3: Add the ortho branch in `dim3-scene.js`**

Immediately after the existing `worldPerPx` export, add:

```js
// The orthographic twin of worldPerPx. An ortho camera's scale is a property of
// its frustum and zoom alone — distance does not enter — which is exactly why
// the perspective formula cannot be reused with a substituted fov.
export function orthoWorldPerPx(top, bottom, zoom, viewportPx) {
  return Math.abs(top - bottom) / Math.max(zoom, 1e-6) / Math.max(viewportPx, 1);
}
```

Then, inside `tick()`, replace:

```js
    group.getWorldPosition(_gp);
    const dist = viewer.camera.position.distanceTo(_gp);
    const wpp = worldPerPx(dist, viewer.camera.fov ?? 45, h);
```

with:

```js
    group.getWorldPosition(_gp);
    // `viewer.camera.fov ?? 45` was the bug this branch removes: under an ortho
    // camera fov is undefined, so the fallback produced a plausible-but-wrong
    // scale and every label, arrow and standoff drifted as the user dollied.
    // The ortho formula matches cutaway-gizmo.js:485's worldUnitsPerPixelAt.
    const cam = viewer.camera;
    const wpp = cam.isOrthographicCamera
      ? orthoWorldPerPx(cam.top, cam.bottom, cam.zoom, h)
      : worldPerPx(cam.position.distanceTo(_gp), cam.fov ?? 45, h);
```

- [ ] **Step 4: Add `setCamera` to the cutaway and its gizmo**

In `src/framework/cutaway-gizmo.js`, change the factory's destructured `camera` parameter into a reassignable binding. If it currently reads `export function createCutawayGizmo({ camera, ... })`, change the parameter to `camera: initialCamera` and add as the first line of the body:

```js
  // Reassignable: the viewer swaps cameras when the projection toggle flips,
  // and this module holds fifteen references to it. One binding to move beats
  // threading a getter through all of them.
  let camera = initialCamera;
```

Add to that factory's returned object:

```js
    setCamera(next) { if (next) camera = next; },
```

In `src/framework/cutaway.js`, apply the same change: rename the destructured `camera` option to `camera: initialCamera`, add `let camera = initialCamera;` as the first statement of the body, and add to the returned object:

```js
    setCamera(next) {
      if (!next) return;
      camera = next;
      gizmo?.setCamera(next);
    },
```

> Use whatever local name `cutaway.js` already gives its gizmo instance instead of `gizmo` if it differs — read line 222's construction call to confirm.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/framework/measure/dim3-scene.test.js test/framework/cutaway.test.js test/framework/cutaway-gizmo.test.js test/framework/viewer-cutaway.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/framework/cutaway.js src/framework/cutaway-gizmo.js src/framework/measure/dim3-scene.js test/framework/measure/dim3-scene.test.js test/framework/cutaway.test.js
git commit -m "fix: the two call sites that fail silently under an ortho camera

dim3-scene's `fov ?? 45` produced a plausible-but-wrong scale for every
dimension; the cutaway captured its camera at construction and would
have kept sizing against one nobody renders."
```

---

### Task 9: Annotation payload v2

**Files:**
- Modify: `src/framework/annotate/annotate-mode.js`
- Test: `test/framework/annotate/annotate-mode.test.js` (extend)

**Interfaces:**
- Consumes: `viewer.camera` as a getter (Task 7).
- Produces: `ANNOTATION_VERSION === 2`; the payload's camera block gains `projection`, `orthoHeight`, and `fov` may now be `null`.

- [ ] **Step 1: Write the failing test**

Append to `test/framework/annotate/annotate-mode.test.js`:

```js
describe("camera block under each projection", () => {
  it("is version 2 and reports a perspective camera by name", () => {
    // A consumer reconstructing the camera must be told which projection it is
    // looking at — an fov-shaped hole is how that fails silently.
    const { payload } = sendOneStroke({ ortho: false }); // see the helper below
    expect(payload.version).toBe(2);
    expect(payload.camera.projection).toBe("perspective");
    expect(payload.camera.fov).toBe(45);
    expect(payload.camera.orthoHeight).toBeNull();
  });

  it("reports an orthographic camera with its frustum height and no fov", () => {
    const { payload } = sendOneStroke({ ortho: true });
    expect(payload.camera.projection).toBe("orthographic");
    expect(payload.camera.fov).toBeNull();
    expect(payload.camera.orthoHeight).toBeCloseTo(40, 6);
  });
});
```

> Add a `sendOneStroke({ ortho })` helper next to the file's existing fixtures. It must build the same stub viewer the neighbouring tests use, override its `camera` with either `{ fov: 45, up, position, quaternion }` or `{ isOrthographicCamera: true, top: 20, bottom: -20, zoom: 1, up, position, quaternion }`, draw one stroke, call `send()`, and return the payload the `onSend` spy received. Read the top of the file and reuse its existing stub factory rather than writing a second one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/framework/annotate/annotate-mode.test.js`
Expected: FAIL — version is 1 and `projection` is undefined.

- [ ] **Step 3: Bump the version and widen the camera block**

In `src/framework/annotate/annotate-mode.js`, change:

```js
export const ANNOTATION_VERSION = 1;
```

to:

```js
// v2 added the camera block's `projection` / `orthoHeight` and made `fov`
// nullable: the viewer gained an orthographic camera, and a user can switch to
// it and THEN open Sketch. An additive optional field alone would have left any
// consumer that reconstructs the camera from `fov` silently wrong rather than
// loudly broken, so the version moves.
export const ANNOTATION_VERSION = 2;
```

Replace the `const world = { ... }` line near `:88` with:

```js
    const cam = viewer.camera;
    const ortho = !!cam.isOrthographicCamera;
    const world = {
      pos,
      target,
      up: cam.up.toArray(),
      projection: ortho ? "orthographic" : "perspective",
      fov: ortho ? null : cam.fov,
      orthoHeight: ortho ? Math.abs(cam.top - cam.bottom) / Math.max(cam.zoom, 1e-6) : null,
    };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/framework/annotate/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/annotate/annotate-mode.js test/framework/annotate/annotate-mode.test.js
git commit -m "feat(annotate): payload v2 carries the projection

A user can switch to orthographic and then open Sketch, so the camera
block gains projection/orthoHeight and fov becomes nullable. Version
bumped rather than added to: an fov-shaped hole fails silently."
```

---

### Task 10: `viewcube-mode.js` — the orchestrator

**Files:**
- Create: `src/framework/viewcube/viewcube-mode.js`
- Test: `test/framework/viewcube/viewcube-mode.test.js` (create)

**Interfaces:**
- Consumes: `projectCube`, `hitRegion` (Task 2); `createCubeCanvas` (Task 3); `viewer.onFrame`, `viewer.onThemeChange`, `viewer.getTheme`, `viewer.tweenCameraTo`, `viewer.orbitBy` (Task 5), `viewer.camera`.
- Produces: `createViewcubeMode(viewer, { host, createCanvas?, dragThreshold? }) => { element, setHidden(flag), isHidden(), detach() }`.

- [ ] **Step 1: Write the failing test**

Create `test/framework/viewcube/viewcube-mode.test.js`:

```js
// @vitest-environment happy-dom
// The orchestrator: the only viewcube file touching both the viewer and the
// DOM. The two behaviours worth defending are the idle-cost guarantee (an
// unchanged camera must draw NOTHING) and the drag/click split.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createViewcubeMode } from "../../../src/framework/viewcube/viewcube-mode.js";

function stubViewer() {
  const frame = new Set();
  const theme = new Set();
  const quat = { x: 0, y: 0, z: 0, w: 1 };
  return {
    camera: { quaternion: quat, isOrthographicCamera: false, zoom: 1 },
    quat,
    tick: (dt = 0.016) => frame.forEach((cb) => cb(dt)),
    setTheme: (m) => theme.forEach((cb) => cb(m)),
    onFrame: (cb) => { frame.add(cb); return () => frame.delete(cb); },
    onThemeChange: (cb) => { theme.add(cb); return () => theme.delete(cb); },
    getTheme: () => "dark",
    tweenCameraTo: vi.fn(),
    orbitBy: vi.fn(),
    frameCount: () => frame.size,
    themeCount: () => theme.size,
  };
}

let host, viewer, mode, draws, surface;
// The fake MUST append its element to the host: the mode attaches its pointer
// listeners to canvas.element, and the tests dispatch there. Dispatching on the
// wrapper instead would never reach them — events bubble child-to-parent.
function fakeCanvasFactory() {
  draws = [];
  return (wrap) => {
    surface = document.createElement("canvas");
    surface.className = "pf-viewcube-canvas";
    wrap.appendChild(surface);
    // happy-dom returns a zero rect and has no pointer capture; the mode reads
    // one and calls the other.
    surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 90, height: 90 });
    surface.setPointerCapture = () => {};
    surface.releasePointerCapture = () => {};
    return {
      element: surface,
      draw: (projected, opts) => draws.push({ projected, ...opts }),
      setTheme: vi.fn(),
      size: 90,
      dispose: vi.fn(),
    };
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  viewer = stubViewer();
  mode = createViewcubeMode(viewer, { host, createCanvas: fakeCanvasFactory() });
});
afterEach(() => mode?.detach());

const pointer = (type, x, y) => {
  const e = new Event(type, { bubbles: true });
  Object.assign(e, { clientX: x, clientY: y, pointerId: 1, isPrimary: true });
  surface.dispatchEvent(e);
};

describe("idle cost", () => {
  it("draws once on attach so the widget is never blank", () => {
    expect(draws.length).toBe(1);
  });

  it("draws nothing on a frame where the camera did not move", () => {
    draws.length = 0;
    viewer.tick();
    viewer.tick();
    viewer.tick();
    expect(draws.length).toBe(0);
  });

  it("draws again once the camera quaternion changes", () => {
    draws.length = 0;
    viewer.quat.y = 0.3;
    viewer.tick();
    expect(draws.length).toBe(1);
  });

  it("draws again when only the ortho zoom changes", () => {
    viewer.camera.isOrthographicCamera = true;
    draws.length = 0;
    viewer.camera.zoom = 2;
    viewer.tick();
    expect(draws.length).toBe(1);
  });
});

describe("click versus drag", () => {
  it("tweens on a release inside the threshold", () => {
    pointer("pointerdown", 45, 45);
    pointer("pointermove", 47, 46);
    pointer("pointerup", 47, 46);
    expect(viewer.tweenCameraTo).toHaveBeenCalledTimes(1);
    expect(viewer.orbitBy).not.toHaveBeenCalled();
  });

  it("orbits and cancels the click past the threshold", () => {
    pointer("pointerdown", 45, 45);
    pointer("pointermove", 60, 45);
    pointer("pointerup", 60, 45);
    expect(viewer.orbitBy).toHaveBeenCalled();
    expect(viewer.tweenCameraTo).not.toHaveBeenCalled();
  });

  it("does not tween when the release lands outside the cube", () => {
    pointer("pointerdown", 1, 1);
    pointer("pointerup", 1, 1);
    expect(viewer.tweenCameraTo).not.toHaveBeenCalled();
  });
});

describe("hover", () => {
  it("passes a hovered region id to the renderer", () => {
    draws.length = 0;
    pointer("pointermove", 45, 45);
    expect(draws.at(-1).hover).toBe("front");
  });

  it("clears the hover on leave", () => {
    pointer("pointermove", 45, 45);
    draws.length = 0;
    pointer("pointerleave", 45, 45);
    expect(draws.at(-1).hover).toBeNull();
  });
});

describe("hiding", () => {
  it("hides and restores the element", () => {
    mode.setHidden(true);
    expect(mode.element.hidden).toBe(true);
    expect(mode.isHidden()).toBe(true);
    mode.setHidden(false);
    expect(mode.element.hidden).toBe(false);
  });

  it("draws nothing at all while hidden, even as the camera moves", () => {
    mode.setHidden(true);
    draws.length = 0;
    viewer.quat.y = 0.5;
    viewer.tick();
    expect(draws.length).toBe(0);
  });
});

describe("detach", () => {
  it("unsubscribes from the viewer and removes its DOM", () => {
    mode.detach();
    expect(viewer.frameCount()).toBe(0);
    expect(viewer.themeCount()).toBe(0);
    expect(host.querySelector(".pf-viewcube")).toBeNull();
  });

  it("is idempotent", () => {
    mode.detach();
    expect(() => mode.detach()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/framework/viewcube/viewcube-mode.test.js`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the orchestrator**

Create `src/framework/viewcube/viewcube-mode.js`:

```js
// The view cube's orchestrator — the only viewcube file that touches both the
// viewer and the DOM (the annotate-mode.js / measure-mode.js stance). Owns the
// frame subscription, the dirty check that keeps idle frames free, pointer
// input, and the drag/click split.
import { projectCube, hitRegion } from "./cube-geom.js";
import { createCubeCanvas } from "./cube-canvas.js";
import { runCleanupSteps } from "../teardown.js";

// Past this many px of travel a press is an orbit, not a click. 4px is the
// usual "did they mean to drag" threshold and comfortably above the jitter a
// trackpad tap produces.
const DRAG_THRESHOLD_PX = 4;

export function createViewcubeMode(viewer, {
  host,
  createCanvas = createCubeCanvas,
  dragThreshold = DRAG_THRESHOLD_PX,
} = {}) {
  const wrap = document.createElement("div");
  wrap.className = "pf-viewcube";
  host.appendChild(wrap);

  const canvas = createCanvas(wrap, {});
  canvas.setTheme?.(viewer.getTheme?.() ?? "dark");

  let hidden = false;
  let hover = null;
  let projected = null;
  // The dirty check. An unchanged camera must cost nothing — no clear, no
  // fills — because this runs inside the viewer's rAF callback alongside the
  // cutaway's outline re-slice and the main render.
  let lastKey = null;

  const cameraKey = () => {
    const cam = viewer.camera;
    const q = cam.quaternion;
    // Zoom is part of the key because an ortho dolly changes camera.zoom
    // without touching the quaternion, and the cube's scale follows neither —
    // but the projection SWAP repaints, and a zoom change is the cheapest
    // signal that one happened.
    return `${q.x.toFixed(6)},${q.y.toFixed(6)},${q.z.toFixed(6)},${q.w.toFixed(6)},${cam.isOrthographicCamera ? cam.zoom : 0}`;
  };

  function redraw() {
    if (hidden) return;
    const cam = viewer.camera;
    const q = cam.quaternion;
    projected = projectCube([q.x, q.y, q.z, q.w], { size: canvas.size });
    canvas.draw(projected, { hover });
  }

  function onFrame() {
    if (hidden) return;
    const key = cameraKey();
    if (key === lastKey) return;
    lastKey = key;
    redraw();
  }

  // --- pointer ---------------------------------------------------------------
  let press = null; // { x, y, dragging, id }

  const localPoint = (event) => {
    const rect = canvas.element.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };

  const onPointerDown = (event) => {
    if (event.isPrimary === false || hidden) return;
    press = { x: event.clientX, y: event.clientY, dragging: false, id: event.pointerId };
    canvas.element.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event) => {
    if (event.isPrimary === false || hidden) return;
    if (press) {
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;
      if (!press.dragging && Math.hypot(dx, dy) < dragThreshold) return;
      press.dragging = true;
      press.x = event.clientX;
      press.y = event.clientY;
      // Hover is meaningless mid-drag and would flicker as the cube spins.
      if (hover !== null) hover = null;
      viewer.orbitBy(dx, dy);
      return;
    }
    const next = hitRegion(...localPoint(event), projected);
    if (next === hover) return;
    hover = next;
    redraw();
  };

  const onPointerUp = (event) => {
    if (!press || event.isPrimary === false) return;
    const wasDrag = press.dragging;
    canvas.element.releasePointerCapture?.(press.id);
    press = null;
    if (wasDrag) return;
    const id = hitRegion(...localPoint(event), projected);
    if (id) viewer.tweenCameraTo(id, { duration: 0.6 });
  };

  const onPointerLeave = () => {
    if (press || hover === null) return;
    hover = null;
    redraw();
  };

  canvas.element.addEventListener("pointerdown", onPointerDown);
  canvas.element.addEventListener("pointermove", onPointerMove);
  canvas.element.addEventListener("pointerup", onPointerUp);
  canvas.element.addEventListener("pointercancel", onPointerUp);
  canvas.element.addEventListener("pointerleave", onPointerLeave);

  const offFrame = viewer.onFrame(onFrame);
  const offTheme = viewer.onThemeChange((mode) => {
    canvas.setTheme(mode);
    redraw();
  });

  lastKey = cameraKey();
  redraw(); // never show a blank box before the first camera movement

  function setHidden(flag) {
    const next = !!flag;
    if (next === hidden) return;
    hidden = next;
    wrap.hidden = hidden;
    if (!hidden) {
      // The camera almost certainly moved while we were away, and the dirty
      // check would otherwise hold the stale drawing until it moves again.
      lastKey = cameraKey();
      redraw();
    }
  }

  let detached = false;
  return {
    element: wrap,
    setHidden,
    isHidden: () => hidden,
    detach() {
      if (detached) return;
      detached = true;
      runCleanupSteps([
        offFrame,
        offTheme,
        () => canvas.element.removeEventListener("pointerdown", onPointerDown),
        () => canvas.element.removeEventListener("pointermove", onPointerMove),
        () => canvas.element.removeEventListener("pointerup", onPointerUp),
        () => canvas.element.removeEventListener("pointercancel", onPointerUp),
        () => canvas.element.removeEventListener("pointerleave", onPointerLeave),
        () => canvas.dispose(),
        () => wrap.remove(),
      ], "viewcube mode cleanup failed");
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/framework/viewcube/viewcube-mode.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/framework/viewcube/viewcube-mode.js test/framework/viewcube/viewcube-mode.test.js
git commit -m "feat(viewcube): orchestrator with a camera dirty check

An unchanged camera draws nothing — asserted, not assumed, because this
runs inside the viewer's rAF callback beside the cutaway's outline
re-slice. A 4px threshold splits an orbit drag from a snap click."
```

---

### Task 11: `viewcube-controls.js` — chrome, the projection button, and CSS

**Files:**
- Create: `src/framework/viewcube/viewcube-controls.js`
- Modify: `src/framework/chrome.css` (placement only)
- Modify: `src/framework/app.css` (appearance only)
- Test: `test/framework/viewcube/viewcube-controls.test.js` (create)

**Interfaces:**
- Consumes: `createViewcubeMode` (Task 10); `viewer.setProjection`/`getProjection`/`onProjectionChange` (Task 7); `viewer.tweenCameraTo`; `attachButtonTooltips` from `../tooltip.js`.
- Produces: `attachViewcubeControls(viewer, { stage }, { tooltip? }) => { element, mode, setHidden(flag), detach() }`.

- [ ] **Step 1: Write the failing test**

Create `test/framework/viewcube/viewcube-controls.test.js`:

```js
// @vitest-environment happy-dom
// The chrome: the stack element, the projection button, and the hidden
// per-view buttons that replace the DOM focus a canvas cannot give us.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachViewcubeControls } from "../../../src/framework/viewcube/viewcube-controls.js";

function stubViewer() {
  const frame = new Set(), theme = new Set(), projection = new Set();
  let mode = "perspective";
  return {
    camera: { quaternion: { x: 0, y: 0, z: 0, w: 1 }, isOrthographicCamera: false, zoom: 1 },
    onFrame: (cb) => { frame.add(cb); return () => frame.delete(cb); },
    onThemeChange: (cb) => { theme.add(cb); return () => theme.delete(cb); },
    onProjectionChange: (cb) => { projection.add(cb); return () => projection.delete(cb); },
    getTheme: () => "dark",
    getProjection: () => mode,
    setProjection: vi.fn((next) => {
      mode = next;
      projection.forEach((cb) => cb(mode));
      return mode;
    }),
    tweenCameraTo: vi.fn(),
    orbitBy: vi.fn(),
    counts: () => ({ frame: frame.size, theme: theme.size, projection: projection.size }),
  };
}

let stage, viewer, handle;
beforeEach(() => {
  document.body.innerHTML = "";
  stage = document.createElement("div");
  stage.className = "pf-stage";
  const viewbar = document.createElement("div");
  viewbar.id = "viewbar";
  stage.append(viewbar);
  document.body.append(stage);
  viewer = stubViewer();
  handle = attachViewcubeControls(viewer, { stage }, {});
});
afterEach(() => handle?.detach());

const projectionButton = () => stage.querySelector("#projection");

describe("structure", () => {
  it("builds the stack inside the stage, not on document.body", () => {
    const stack = stage.querySelector(".pf-viewcube-stack");
    expect(stack).not.toBeNull();
    expect(stack.parentElement).toBe(stage);
  });

  it("puts the cube above the projection button in the stack", () => {
    const children = [...stage.querySelector(".pf-viewcube-stack").children];
    expect(children[0].className).toContain("pf-viewcube");
    expect(children[1].contains(projectionButton())).toBe(true);
  });

  it("gives the projection button a type, label and title", () => {
    const button = projectionButton();
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-label")).toMatch(/orthographic/i);
  });
});

describe("projection button", () => {
  it("switches to orthographic on click and reflects it", () => {
    projectionButton().click();
    expect(viewer.setProjection).toHaveBeenCalledWith("orthographic");
    expect(projectionButton().classList.contains("on")).toBe(true);
    expect(projectionButton().getAttribute("aria-pressed")).toBe("true");
    expect(projectionButton().getAttribute("aria-label")).toMatch(/perspective/i);
  });

  it("switches back on a second click", () => {
    projectionButton().click();
    projectionButton().click();
    expect(viewer.setProjection).toHaveBeenLastCalledWith("perspective");
    expect(projectionButton().classList.contains("on")).toBe(false);
  });

  it("follows a projection change it did not initiate", () => {
    viewer.setProjection("orthographic");
    expect(projectionButton().classList.contains("on")).toBe(true);
  });
});

describe("keyboard access", () => {
  it("offers one hidden button per canonical view", () => {
    const buttons = [...stage.querySelectorAll(".pf-viewcube-key button")];
    expect(buttons.map((b) => b.dataset.view).sort())
      .toEqual(["back", "bottom", "front", "left", "right", "top"]);
    for (const b of buttons) expect(b.getAttribute("aria-label")).toBeTruthy();
  });

  it("tweens to the named view when one is activated", () => {
    stage.querySelector('.pf-viewcube-key button[data-view="top"]').click();
    expect(viewer.tweenCameraTo).toHaveBeenCalledWith("top", { duration: 0.6 });
  });
});

describe("hiding", () => {
  it("hides the whole stack, projection button included", () => {
    handle.setHidden(true);
    expect(stage.querySelector(".pf-viewcube-stack").hidden).toBe(true);
    handle.setHidden(false);
    expect(stage.querySelector(".pf-viewcube-stack").hidden).toBe(false);
  });
});

describe("detach", () => {
  it("unsubscribes everything and removes the stack", () => {
    handle.detach();
    expect(viewer.counts()).toEqual({ frame: 0, theme: 0, projection: 0 });
    expect(stage.querySelector(".pf-viewcube-stack")).toBeNull();
  });

  it("is idempotent", () => {
    handle.detach();
    expect(() => handle.detach()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/framework/viewcube/viewcube-controls.test.js`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the chrome**

Create `src/framework/viewcube/viewcube-controls.js`:

```js
// The view cube's chrome: the bottom-right stack (cube over projection button),
// and the visually-hidden per-view buttons that stand in for the DOM focus a
// canvas cannot give us. Generated, not declared — no part's HTML carries this,
// and partforge-cloud's scaffold does not either (the mobile-tabs.js and
// animation-controls.js precedent).
//
// The projection button deliberately lives OUTSIDE #viewbar: partforge-cloud's
// sandbox-scaffold test enumerates #viewbar's buttons against what it renders,
// and this one is the framework's own.
import { attachButtonTooltips } from "../tooltip.js";
import { runCleanupSteps } from "../teardown.js";
import { createViewcubeMode } from "./viewcube-mode.js";

const PERSPECTIVE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4l18 3v10l-18 3z"/><path d="M3 4v16"/></svg>`;
const ORTHOGRAPHIC_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="14" height="12" rx="1"/><path d="M7 6V3h14v12h-4"/></svg>`;

// One hidden button per canonical FACE view. Edges and corners are reachable by
// pointer only — six targets is a usable keyboard surface; twenty-six is a
// tab-stop thicket.
const KEY_VIEWS = [
  ["front", "View from the front"],
  ["back", "View from the back"],
  ["left", "View from the left"],
  ["right", "View from the right"],
  ["top", "View from the top"],
  ["bottom", "View from the bottom"],
];

export function attachViewcubeControls(viewer, { stage } = {}, { tooltip } = {}) {
  const stack = document.createElement("div");
  stack.className = "pf-viewcube-stack";
  stage.appendChild(stack);

  const mode = createViewcubeMode(viewer, { host: stack });

  const pill = document.createElement("div");
  pill.className = "pf-viewcube-pill";
  const button = document.createElement("button");
  button.type = "button";
  button.id = "projection";
  pill.appendChild(button);
  stack.appendChild(pill);

  const keys = document.createElement("div");
  keys.className = "pf-viewcube-key";
  const keyButtons = KEY_VIEWS.map(([view, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.view = view;
    b.textContent = label;
    b.setAttribute("aria-label", label);
    keys.appendChild(b);
    return b;
  });
  stack.appendChild(keys);

  const tooltipBinding = tooltip
    ? attachButtonTooltips(tooltip, [{ element: button }])
    : null;

  function sync() {
    const ortho = viewer.getProjection() === "orthographic";
    button.innerHTML = ortho ? ORTHOGRAPHIC_ICON : PERSPECTIVE_ICON;
    button.classList.toggle("on", ortho);
    button.setAttribute("aria-pressed", String(ortho));
    const label = ortho ? "Switch to perspective view" : "Switch to orthographic view";
    button.setAttribute("aria-label", label);
    if (!tooltip) button.title = label;
    tooltipBinding?.sync();
  }

  const onToggle = () => {
    viewer.setProjection(viewer.getProjection() === "orthographic" ? "perspective" : "orthographic");
    sync();
  };
  button.addEventListener("click", onToggle);

  const keyHandlers = keyButtons.map((b) => {
    const handler = () => viewer.tweenCameraTo(b.dataset.view, { duration: 0.6 });
    b.addEventListener("click", handler);
    return handler;
  });

  // A host or another mode can flip projection without going through this
  // button; the chrome follows rather than drifting out of sync.
  const offProjection = viewer.onProjectionChange(sync);
  sync();

  function setHidden(flag) {
    const next = !!flag;
    stack.hidden = next;
    // Stand the frame subscription's work down too, not just the pixels.
    mode.setHidden(next);
  }

  let detached = false;
  return {
    element: stack,
    mode,
    setHidden,
    detach() {
      if (detached) return;
      detached = true;
      runCleanupSteps([
        offProjection,
        () => button.removeEventListener("click", onToggle),
        ...keyButtons.map((b, i) => () => b.removeEventListener("click", keyHandlers[i])),
        () => tooltipBinding?.detach(),
        () => mode.detach(),
        () => stack.remove(),
      ], "viewcube control cleanup failed");
    },
  };
}
```

- [ ] **Step 4: Add the placement rules to `chrome.css`**

Append to `src/framework/chrome.css`, directly after the `.pf-float-viewbar` rule:

```css
/* ---- view cube stack: PLACEMENT ONLY (see the rule above) ----------------
   Bottom-right, stacked above #viewbar. The offset is measured, not
   hardcoded: viewcube-controls.js's host publishes --pf-viewbar-clear on the
   stage (the viewbar's own vertical claim), mirroring --pf-anim-clear. The
   56px fallback is the standard viewbar's 12px bottom + 44px height, so the
   stack still sits right if the observer never fires. */
.pf-viewcube-stack {
  position: absolute;
  right: 12px;
  bottom: calc(var(--pf-viewbar-clear, 56px) + 8px);
  z-index: 15;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.pf-viewcube-stack[hidden] { display: none; }

/* The keyboard surface. Visually hidden rather than display:none — the latter
   takes the buttons out of the tab order, which is the whole point of them. */
.pf-viewcube-key {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
.pf-viewcube-key button:focus-visible {
  position: fixed;
  width: auto; height: auto;
  clip-path: none;
}
```

- [ ] **Step 5: Add the appearance rules to `app.css`**

Append to `src/framework/app.css`, directly after the `#viewbar button.on` rule:

```css
/* ---- view cube ------------------------------------------------------------
   APPEARANCE only (placement lives in chrome.css, per the split at the top of
   this file). The pill deliberately reuses #viewbar's chrome so the projection
   toggle reads as one of the viewer controls rather than a second language. */
.pf-viewcube-canvas {
  display: block;
  cursor: grab;
  touch-action: none;
}
.pf-viewcube-canvas:active { cursor: grabbing; }
.pf-viewcube-pill {
  display: flex; gap: 4px; padding: 4px;
  background: var(--pf-surface); border: 1px solid var(--pf-border);
  border-radius: var(--pf-radius-pill);
  box-shadow: var(--pf-shadow-float);
}
.pf-viewcube-pill button {
  width: 34px; height: 34px; border: 0; border-radius: var(--pf-radius-control);
  background: transparent; color: var(--pf-muted-2); cursor: pointer;
  font-size: 15px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
}
.pf-viewcube-pill button:hover { color: var(--pf-text); background: var(--pf-surface-2); }
.pf-viewcube-pill button.on { background: var(--pf-accent); color: var(--pf-on-accent); }
.pf-viewcube-pill button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--pf-accent) 35%, transparent);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/framework/viewcube/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/framework/viewcube/viewcube-controls.js src/framework/chrome.css src/framework/app.css test/framework/viewcube/viewcube-controls.test.js
git commit -m "feat(viewcube): stack chrome, projection button, keyboard surface

Generated DOM, so no part markup and no partforge-cloud scaffold change.
The projection button lives outside #viewbar on purpose — cloud's
scaffold test enumerates that bar's buttons. Six visually-hidden view
buttons replace the DOM focus a canvas cannot provide."
```

---

### Task 12: Mount wiring, persistence, and `runtime.projection`

**Files:**
- Modify: `src/framework/mount.js`
- Modify: `src/framework/view-state.js`
- Test: `test/framework/viewcube/mount-wiring.test.js` (create)
- Test: `test/framework/view-state.test.js` (create if absent, else extend)

**Interfaces:**
- Consumes: `attachViewcubeControls` (Task 11); `viewer.setProjection`/`getProjection`/`onProjectionChange` (Task 7); `annotateMode.onModeChange`.
- Produces:
  - `loadProjection() => "perspective" | "orthographic"` and `saveProjection(mode)` from `view-state.js`.
  - `runtime.projection = { get(), set(mode), onChange(cb) }` on the mount handle.
  - `--pf-viewbar-clear` published on the stage element.

- [ ] **Step 1: Write the failing tests**

Create `test/framework/view-state.test.js` (or append these cases if the file already exists):

```js
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { loadProjection, saveProjection } from "../../src/framework/view-state.js";

beforeEach(() => localStorage.clear());

describe("projection persistence", () => {
  it("defaults to perspective, matching the viewer's own default", () => {
    expect(loadProjection()).toBe("perspective");
  });

  it("round-trips orthographic", () => {
    saveProjection("orthographic");
    expect(loadProjection()).toBe("orthographic");
  });

  it("ignores a value that is neither", () => {
    saveProjection("isometric");
    expect(loadProjection()).toBe("perspective");
  });
});
```

Create `test/framework/viewcube/mount-wiring.test.js`. This mirrors `test/framework/annotate/mount-wiring.test.js` exactly: `makeHandle` is the unit seam — no WASM, no DOM.

```js
// The handle's projection surface: constant shape, NOOP default — the
// NOOP_MEASURE / NOOP_ANNOTATE contract, extended once more. makeHandle is the
// unit seam (the mount.test.js stance); the DOM wiring is asserted in
// mount.test.js against its mocked viewer.
import { expect, test } from "vitest";
import { makeHandle } from "../../../src/framework/mount.js";

const stubViewer = {
  captureCanonicalViews: () => [],
  captureCurrent: () => null,
  setActive: () => {},
  onContextLost: () => () => {},
};

function handle(over = {}) {
  return makeHandle({
    ready: Promise.resolve(),
    dispose: () => {},
    viewer: stubViewer,
    setParams: () => {},
    listExportableParts: () => [],
    exportParts: () => {},
    getView: () => "main",
    setView: () => false,
    captureView: () => null,
    ...over,
  });
}

test("projection defaults to an inert perspective no-op with the full surface", () => {
  const rt = handle();
  expect(rt.projection.get()).toBe("perspective");
  expect(() => rt.projection.set("orthographic")).not.toThrow();
  expect(typeof rt.projection.onChange(() => {})).toBe("function");
  // The default must not lie about having taken effect.
  expect(rt.projection.get()).toBe("perspective");
});

test("a wired projection surface is passed through as-is", () => {
  const projection = { get: () => "orthographic", set: () => {}, onChange: () => () => {} };
  expect(handle({ projection }).projection).toBe(projection);
});
```

Then append to `test/framework/mount.test.js`, which owns the full-mount harness:

```js
test("mounts the view cube stack inside the stage", () => {
  const els = makeElements();
  const { workers, createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els });
  finishFirstBuild(workers);
  expect(els.viewer.querySelector(".pf-viewcube-stack")).not.toBeNull();
  expect(els.viewer.querySelector("#projection")).not.toBeNull();
  runtime.dispose();
  expect(els.viewer.querySelector(".pf-viewcube-stack")).toBeNull();
});

test("exposes projection on the runtime and drives the viewer with it", () => {
  const els = makeElements();
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els });
  const viewer = fakeViewers.at(-1);
  expect(runtime.projection.get()).toBe("perspective");
  runtime.projection.set("orthographic");
  expect(viewer.setProjection).toHaveBeenCalledWith("orthographic");
  expect(runtime.projection.get()).toBe("orthographic");
  runtime.dispose();
});

test("hides the whole cube stack while Sketch is on", () => {
  const els = makeElements();
  const { createWorker } = makeWorkers();
  // Sketch only appears when the host wires a send callback.
  const runtime = mount(makePart(), {
    createWorker, elements: els, onAnnotationSend: () => {},
  });
  const stack = els.viewer.querySelector(".pf-viewcube-stack");
  expect(stack.hidden).toBe(false);
  els.chrome.annotate.click();
  // Ink is pose-locked: an orbit OR a projection swap invalidates it, so the
  // projection button goes away with the cube, not just the cube.
  expect(stack.hidden).toBe(true);
  els.chrome.annotate.click();
  expect(stack.hidden).toBe(false);
  runtime.dispose();
});

test("restores a persisted orthographic projection before any framing", () => {
  localStorage.setItem("partforge:projection", "orthographic");
  const els = makeElements();
  const { createWorker } = makeWorkers();
  const runtime = mount(makePart(), { createWorker, elements: els });
  const viewer = fakeViewers.at(-1);
  // Before the first build settles, so the first frameTo already knows.
  expect(viewer.setProjection).toHaveBeenCalledWith("orthographic");
  expect(viewer.setProjection.mock.invocationCallOrder[0])
    .toBeLessThan(viewer.frame.mock.invocationCallOrder[0] ?? Infinity);
  localStorage.clear();
  runtime.dispose();
});
```

> `mount.test.js` clears `document.body` between tests; if it does not also clear `localStorage`, add `localStorage.clear()` to its existing `beforeEach` rather than leaving the persisted key to leak into neighbouring tests.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/framework/view-state.test.js`
Expected: FAIL — `loadProjection` is not exported.

- [ ] **Step 2b: Teach `mount.test.js`'s mocked viewer the new surface**

**Do this before wiring `mount.js`, or every test in `mount.test.js` starts throwing.** That file mocks `createViewer` wholesale, and its fake currently has no `onThemeChange`, `getTheme`, `getProjection`, `setProjection`, `onProjectionChange`, or `orbitBy`, and its `camera` is a bare `{}` with no `quaternion`. `attachViewcubeControls` calls every one of those during mount.

In `test/framework/mount.test.js`, inside the `vi.mock("../../src/framework/viewer.js", ...)` factory, add alongside the existing `frameCbs` / `orbitCbs` sets:

```js
    const themeCbs = new Set();
    const projectionCbs = new Set();
    let projection = "perspective";
```

and add these entries to the returned fake viewer object `v`:

```js
      // The view cube subscribes to all three and reads the camera's
      // quaternion every frame through its dirty check.
      camera: { quaternion: { x: 0, y: 0, z: 0, w: 1 }, isOrthographicCamera: false, zoom: 1 },
      onThemeChange: (cb) => { themeCbs.add(cb); return () => themeCbs.delete(cb); },
      getTheme: () => "dark",
      getProjection: () => projection,
      setProjection: vi.fn((mode) => {
        projection = mode === "orthographic" ? "orthographic" : "perspective";
        for (const cb of [...projectionCbs]) cb(projection);
        return projection;
      }),
      onProjectionChange: (cb) => { projectionCbs.add(cb); return () => projectionCbs.delete(cb); },
      orbitBy: vi.fn(),
```

The existing bare `camera: {}` entry is replaced by the one above — do not leave both.

- [ ] **Step 3: Add projection persistence to `view-state.js`**

Add `projection: "partforge:projection",` to the `KEY` object, then append:

```js
export function loadProjection() {
  return read(KEY.projection) === "orthographic" ? "orthographic" : "perspective";
}

export function saveProjection(mode) {
  if (mode === "perspective" || mode === "orthographic") write(KEY.projection, mode);
}
```

- [ ] **Step 4: Wire the cube into `mount.js`**

**4a.** Add to the imports:

```js
import { attachViewcubeControls } from "./viewcube/viewcube-controls.js";
import { loadProjection, saveProjection } from "./view-state.js";
```

> If `mount.js` already imports from `./view-state.js`, extend that existing import instead of adding a second one.

**4b.** Immediately after the `annotateChrome` block (`cleanup.defer(() => annotateChrome.detach());`), insert:

```js
    // Orientation cube + projection toggle. Generated chrome — no host markup
    // declares it, so an embedder gets it for free. Restored BEFORE any framing
    // happens so a reload into ortho frames once instead of framing in
    // perspective and then visibly re-framing.
    viewer.setProjection(loadProjection());
    const viewcube = attachViewcubeControls(viewer, { stage: els.viewer }, { tooltip });
    cleanup.defer(() => viewcube.detach());
    cleanup.defer(viewer.onProjectionChange((mode) => saveProjection(mode)));
    // Sketch freezes the view on purpose: ink is stored in screen space and is
    // meaningful only against the pose it was drawn over. A live camera control
    // on top of that — orbit OR a projection swap — invalidates the drawing.
    if (annotateMode) {
      cleanup.defer(annotateMode.onModeChange(() => {
        viewcube.setHidden(annotateMode.isEnabled());
      }));
    }
    // Publish the viewbar's vertical claim so chrome.css can stack the cube on
    // top of it without hardcoding a height that cutaway/measure/annotate
    // action rows can change.
    const viewbarEl = els.viewer.querySelector("#viewbar");
    if (viewbarEl && typeof ResizeObserver === "function") {
      const publishViewbarClear = () => {
        const stageRect = els.viewer.getBoundingClientRect();
        const barRect = viewbarEl.getBoundingClientRect();
        els.viewer.style.setProperty(
          "--pf-viewbar-clear",
          `${Math.max(0, Math.round(stageRect.bottom - barRect.top))}px`,
        );
      };
      const viewbarObserver = new ResizeObserver(publishViewbarClear);
      viewbarObserver.observe(viewbarEl);
      viewbarObserver.observe(els.viewer);
      publishViewbarClear();
      cleanup.defer(() => {
        viewbarObserver.disconnect();
        els.viewer.style.removeProperty("--pf-viewbar-clear");
      });
    }
```

**4c.** Surface it on the runtime. In `makeHandle`'s parameter list add `projection`, and in the returned object add:

```js
    // Projection is a viewer-wide display mode, not a part property — same
    // shape as `measure` and `annotate` so a host reads one convention.
    projection: projection ?? {
      get: () => "perspective",
      set: () => {},
      onChange: () => () => {},
    },
```

Then at the `makeHandle({ ... })` call site, pass:

```js
      projection: {
        get: () => viewer.getProjection(),
        set: (mode) => viewer.setProjection(mode),
        onChange: (cb) => viewer.onProjectionChange(cb),
      },
```

**4d.** Update `mount.js`'s runtime documentation comment block (near the existing `runtime.annotate:` line) with:

```js
//   runtime.projection: { get, set, onChange }
//                                         // "perspective" | "orthographic". Drives the LIVE view
//                                         // and captureCurrent only — captureCanonicalViews,
//                                         // renderMeshPayloads and the CLI stay perspective.
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/framework/view-state.test.js test/framework/viewcube/ test/framework/mount.test.js test/framework/annotate/ test/framework/mount-capture-view.test.js`
Expected: PASS.

If `mount.test.js` fails with "is not a function" on a viewer method, Step 2b's mock is incomplete — add the missing method rather than making the wiring defensive. The framework's own viewer really does have all of them, so a guard in `mount.js` would only hide the gap.

- [ ] **Step 6: Commit**

```bash
git add src/framework/mount.js src/framework/view-state.js test/framework/view-state.test.js test/framework/viewcube/mount-wiring.test.js test/framework/mount.test.js
git commit -m "feat(mount): wire the view cube, persist projection, expose it

Projection restores before the first framing so a reload into ortho
frames once. Sketch hides the whole stack — a projection swap
invalidates pose-locked ink exactly as an orbit does."
```

---

### Task 13: Keep the animation transport bar clear of the taller cluster

The transport bar clamps itself against `#viewbar`'s rect. The bottom-right cluster is now taller, so on a narrow stage the bar would slide underneath the cube. `planAnimBarPlacement` is already pure and stays untouched — only what gets measured changes.

**Files:**
- Modify: `src/framework/animation-controls.js`
- Test: `test/framework/animation-controls.test.js` (extend)

**Interfaces:**
- Consumes: `.pf-viewcube-stack` from Task 11.
- Produces: no new exports. `planAnimBarPlacement`'s signature is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `test/framework/animation-controls.test.js`:

```js
describe("bottom-right cluster measurement", () => {
  // planAnimBarPlacement is pure and already covered; what this defends is that
  // the CALLER measures the union of the viewbar and the view cube stacked
  // above it. Measuring only #viewbar lets the bar slide under the cube.
  it("clamps against the union's left edge, not just the viewbar's", () => {
    const union = unionRect(
      { left: 300, right: 400, top: 560, bottom: 604 }, // #viewbar
      { left: 320, right: 400, top: 470, bottom: 552 }, // .pf-viewcube-stack
    );
    expect(union.left).toBe(300);
    expect(union.right).toBe(400);
    expect(union.top).toBe(470);
    expect(union.bottom).toBe(604);
  });

  it("returns the one rect it is given when the other is missing", () => {
    const only = { left: 300, right: 400, top: 560, bottom: 604 };
    expect(unionRect(only, null)).toEqual(only);
    expect(unionRect(null, only)).toEqual(only);
    expect(unionRect(null, null)).toBeNull();
  });

  it("intersects a bar whose band overlaps the cube but not the viewbar", () => {
    // The regression the cube introduces: at bottom:14px a transport bar clears
    // #viewbar's band on a wide stage but not the cube's.
    const union = unionRect(
      { left: 300, right: 400, top: 560, bottom: 604 },
      { left: 320, right: 400, top: 470, bottom: 552 },
    );
    const bar = { top: 500, bottom: 540 };
    expect(bar.top < union.bottom && bar.bottom > union.top).toBe(true);
  });
});
```

Add `unionRect` to that file's import from `../../src/framework/animation-controls.js`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/framework/animation-controls.test.js`
Expected: FAIL — `unionRect` is not exported.

- [ ] **Step 3: Export `unionRect` and use it**

In `src/framework/animation-controls.js`, add next to `planAnimBarPlacement`:

```js
// The bottom-right chrome cluster is two elements now — #viewbar with the view
// cube stacked above it — so the transport bar has to clamp against their union
// or it slides under the cube on a narrow stage. Null-tolerant because either
// element can be absent (a host that drops the viewbar; a mount before the cube
// attaches).
export function unionRect(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return {
    left: Math.min(a.left, b.left),
    right: Math.max(a.right, b.right),
    top: Math.min(a.top, b.top),
    bottom: Math.max(a.bottom, b.bottom),
  };
}
```

Then, in `applyPlacement`, replace:

```js
    const vb = viewbarEl?.getBoundingClientRect();
    if (!vb || barRect.top >= vb.bottom || barRect.bottom <= vb.top) return;
    const plan = planAnimBarPlacement({
      stageWidth: stageRect.width,
      barWidth: barRect.width,
      viewbarLeft: vb.left - stageRect.left,
    });
```

with:

```js
    const vb = unionRect(
      viewbarEl?.getBoundingClientRect() ?? null,
      cubeEl?.getBoundingClientRect() ?? null,
    );
    if (!vb || barRect.top >= vb.bottom || barRect.bottom <= vb.top) return;
    const plan = planAnimBarPlacement({
      stageWidth: stageRect.width,
      barWidth: barRect.width,
      viewbarLeft: vb.left - stageRect.left,
    });
```

Beside the existing `const viewbarEl = container.querySelector("#viewbar");`, add:

```js
  // Looked up lazily on every pass rather than captured once: the cube stack is
  // generated by viewcube-controls.js, which may attach after this bar does.
  const cubeSelector = ".pf-viewcube-stack";
```

and inside `applyPlacement`, before the `const vb = ...` line:

```js
    const cubeEl = container.querySelector(cubeSelector);
```

Finally, extend the observer set so a cube resize re-runs placement. After `if (viewbarEl) placementObserver.observe(viewbarEl);` add:

```js
    const cubeAtSetup = container.querySelector(cubeSelector);
    if (cubeAtSetup) placementObserver.observe(cubeAtSetup);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/framework/animation-controls.test.js test/framework/animation-transport-idempotent-ui.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/framework/animation-controls.js test/framework/animation-controls.test.js
git commit -m "fix(animation): clamp the transport bar against the whole cluster

The bottom-right chrome is two elements now. Measuring only #viewbar
lets the bar slide under the view cube on a narrow stage.
planAnimBarPlacement itself is untouched — only what is measured."
```

---

### Task 14: Docs, smoke check, and the version bump

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/AUTHORING-PARTS.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new in code.

- [ ] **Step 1: Add `viewcube/` to the architecture map**

In `AGENTS.md`, inside the `src/framework/` bullet, insert after the `annotate/` clause (which ends `...annotate-controls.js is the viewbar chrome)`):

```
  `viewcube/` (the orientation cube: a ghost cube whose 26 regions — 6 faces,
  12 edges, 8 corners — tween the camera to canonical angles, with model-frame
  X/Y/Z arrows drawn in front of it and a perspective/orthographic toggle
  beneath — `cube-geom.js` is the pure projection/hit leaf, `cube-canvas.js`
  the 2D renderer, `viewcube-mode.js` the orchestrator, `viewcube-controls.js`
  the stack chrome),
```

In the same bullet, after the `camera-tween.js` mention (or alongside the other root-level leaves), note:

```
  `camera-orbit.js` and `projection.js` are pure leaves the viewer imports —
  spherical orbit math for external drag sources, and the
  perspective/orthographic framing pair.
```

- [ ] **Step 2: Document the runtime surface and the payload change**

In `docs/AUTHORING-PARTS.md`, in the section that documents the runtime handle beside `runtime.measure` / `runtime.annotate`, add:

```markdown
### `runtime.projection`

`{ get(), set(mode), onChange(cb) }` where `mode` is `"perspective"` or
`"orthographic"`. Drives the **live view** and `captureCurrent` only —
`captureCanonicalViews`, `renderMeshPayloads`, and the CLI's `partforge render`
stay perspective unconditionally, so agent-facing output does not depend on a UI
toggle. The choice persists across reloads under `partforge:projection` and is
restored before the first framing.
```

And where the annotation payload is specified, record:

```markdown
`ANNOTATION_VERSION` is **2**. The camera block carries
`projection: "perspective" | "orthographic"`; under an orthographic camera
`fov` is `null` and `orthoHeight` gives the frustum's world height instead.
(v1 had `fov` only, and predates the projection toggle.)
```

- [ ] **Step 3: Bump the version**

In `package.json`, change `"version": "0.68.0"` to `"version": "0.69.0"`.

This is not optional and not a follow-up. Per `AGENTS.md`, releasing is automatic on merge and the gate is "is this version already published on npm?" — forget the bump and the merge lands, the workflow correctly no-ops, and the work never ships.

- [ ] **Step 4: Run the whole suite**

Run: `nvm use && npm test`
Expected: PASS, whole suite. Investigate any failure before continuing — a failure here is a real interaction with something this plan touched, not noise.

- [ ] **Step 5: Run the headless smoke check**

Run: `npm run check`
Expected: all four apps boot in real Chromium. If Playwright's Chromium is missing: `npm i -D playwright && npx playwright install chromium`.

Then open the dev server and confirm by hand, because none of the above renders a pixel:

```bash
npm run dev
```

Open `/demo.html` and verify: the cube sits above the viewbar and spins with the camera; hovering highlights a region; clicking a face, an edge and a corner each tween somewhere sensible; dragging the cube orbits; the projection button swaps without the part changing size; the reframe button still frames correctly in ortho; entering Sketch hides the whole stack and leaving restores it; the theme toggle repaints the cube.

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md docs/AUTHORING-PARTS.md package.json
git commit -m "docs+release: view cube in the architecture map, version bump

runtime.projection and the v2 annotation payload documented — the
docs-coherence test exists because undocumented surface is what rots
partforge-cloud's regenerated prompt corpus."
```

---

## Appendix: files at a glance

**Created**
| File | Responsibility |
|---|---|
| `src/framework/viewcube/cube-geom.js` | Pure: 54 cells over 26 ids, projection, painter sort, hit test |
| `src/framework/viewcube/cube-canvas.js` | Renderer: paints the projection to a 2D canvas |
| `src/framework/viewcube/viewcube-mode.js` | Orchestrator: frame dirty-check, pointer, hide rule |
| `src/framework/viewcube/viewcube-controls.js` | Chrome: stack, projection button, keyboard surface |
| `src/framework/camera-orbit.js` | Pure: spherical orbit from a pixel delta |
| `src/framework/projection.js` | Pure: perspective ⇄ orthographic framing pair |

**Modified**
| File | Change |
|---|---|
| `src/framework/view-angles.js` | `ORIENTATIONS` (26) beside `CANONICAL_VIEWS` (still 7) |
| `src/framework/viewer.js` | Second camera, `camera` getter, `setProjection`, `orbitBy`, ortho-aware `resize`/`frameTo`/`captureCurrent`/`renderOffscreen` |
| `src/framework/cutaway.js`, `cutaway-gizmo.js` | `setCamera` so a projection swap re-points them |
| `src/framework/measure/dim3-scene.js` | `orthoWorldPerPx` branch replacing the `fov ?? 45` fallback |
| `src/framework/annotate/annotate-mode.js` | Payload v2: `projection`, `orthoHeight`, nullable `fov` |
| `src/framework/animation-controls.js` | `unionRect`; clamp against viewbar ∪ cube |
| `src/framework/mount.js` | Attach the cube, restore/persist projection, Sketch hide rule, `--pf-viewbar-clear`, `runtime.projection` |
| `src/framework/view-state.js` | `loadProjection` / `saveProjection` |
| `src/framework/chrome.css` | `.pf-viewcube-stack` placement, `.pf-viewcube-key` visually-hidden |
| `src/framework/app.css` | `.pf-viewcube-canvas` / `.pf-viewcube-pill` appearance |
| `AGENTS.md`, `docs/AUTHORING-PARTS.md`, `package.json` | Architecture map, runtime surface, 0.69.0 |
