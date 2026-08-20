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
