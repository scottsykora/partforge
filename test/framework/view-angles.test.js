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
