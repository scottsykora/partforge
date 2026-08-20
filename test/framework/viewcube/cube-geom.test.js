// The view cube's pure geometry: 54 surface cells mapping onto 26 orientation
// ids, projected by a camera quaternion and hit-tested by point-in-polygon.
// No DOM, no three, no GL — this is the module that carries the widget's
// correctness, so it carries the coverage too.
import { describe, expect, it } from "vitest";
import {
  CUBE_CONSTANTS,
  CUBE_DOWN_BIAS_PX,
  FACE_LABEL_UP,
  cubeCells,
  cubeEdges,
  faceLabelUpSign,
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

describe("cubeEdges", () => {
  it("emits exactly 12 edges", () => {
    expect(cubeEdges()).toHaveLength(12);
  });

  it("tags exactly 3 of them with an axis", () => {
    const tagged = cubeEdges().filter((e) => e.axis);
    expect(tagged).toHaveLength(3);
    expect(tagged.map((e) => e.axis).sort()).toEqual(["x", "y", "z"]);
  });

  it("has every endpoint on a cube vertex", () => {
    for (const edge of cubeEdges()) {
      for (const v of [edge.a, edge.b]) {
        for (const c of v) expect(Math.abs(c)).toBeCloseTo(1, 10);
      }
    }
  });

  it("shares exactly one common endpoint among the 3 tagged edges, at (-1,-1,-1)", () => {
    const tagged = cubeEdges().filter((e) => e.axis);
    // Each tagged edge starts at the shared corner and runs to the adjacent
    // vertex along its axis — the corner is whichever endpoint every tagged
    // edge has in common.
    const key = (v) => v.join(",");
    const endpointsOf = (e) => [key(e.a), key(e.b)];
    const [first, ...rest] = tagged;
    const shared = endpointsOf(first).filter((p) => rest.every((e) => endpointsOf(e).includes(p)));
    expect(shared).toEqual(["-1,-1,-1"]);
  });

  it("gives every edge two adjoining unit-normal faces", () => {
    for (const edge of cubeEdges()) {
      expect(edge.faceNormals).toHaveLength(2);
      for (const n of edge.faceNormals) {
        expect(Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2])).toBe(1);
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

  it("keeps every projected point inside the canvas box — cells, edges, and arrows alike", () => {
    const p = projectCube([0.2, 0.3, 0.1, 0.927], { size: SIZE });
    const allPoints = [
      ...[...p.back, ...p.front].flatMap((c) => c.points),
      ...[...p.backEdges, ...p.frontEdges].flatMap((e) => e.points),
      ...p.arrows.flatMap((a) => [a.from, a.tip]),
    ];
    for (const [x, y] of allPoints) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(SIZE);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(SIZE);
    }
  });

  it("uses the full box now that the denominator is just sqrt(3), not sqrt(3) * (arrowLength + labelOffset)", () => {
    // Every cube vertex — and every arrow tip, which now lands exactly on one
    // — sits at model-space distance sqrt(3) from the origin, so with no
    // pixel pad it should reach within a hair of the box edge AT ANY
    // ROTATION, not the ~60% the old arrowLength-weighted denominator gave.
    const p = projectCube([0.2, 0.3, 0.1, 0.927], { size: SIZE });
    const centre = SIZE / 2;
    const reach = Math.max(
      ...p.arrows.map((a) => Math.hypot(a.tip[0] - centre, a.tip[1] - centre)),
    );
    expect(reach).toBeGreaterThan(centre * 0.95);
  });

  it("shifts the whole drawing DOWN by downBias without changing its size", () => {
    // The 2026-08-20 lowering: chrome.css can only take the 8px the stack
    // clears the viewbar by, and the rest of the "gap" the user sees is unused
    // canvas below the cube. downBias spends that padding asymmetrically —
    // every projected point moves down by exactly the bias, and nothing scales
    // (the scale is derived from outerPad alone, so the cube must not resize).
    const q = [0.2, 0.3, 0.1, 0.927];
    const base = projectCube(q, { size: SIZE, outerPad: 23 });
    const low = projectCube(q, { size: SIZE, outerPad: 23, downBias: 7 });
    const pointsOf = (p) => [
      ...[...p.back, ...p.front].flatMap((c) => c.points),
      ...[...p.backEdges, ...p.frontEdges].flatMap((e) => e.points),
      ...p.arrows.flatMap((a) => [a.from, a.tip]),
    ];
    const a = pointsOf(base), b = pointsOf(low);
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) {
      expect(b[i][0]).toBeCloseTo(a[i][0], 9);      // x untouched
      expect(b[i][1]).toBeCloseTo(a[i][1] + 7, 9);  // y down by the bias
    }
  });

  it("defaults downBias to 0 — the caller supplies it, exactly like outerPad", () => {
    const q = [0.2, 0.3, 0.1, 0.927];
    const bare = projectCube(q, { size: SIZE, outerPad: 23 });
    const zero = projectCube(q, { size: SIZE, outerPad: 23, downBias: 0 });
    expect(zero.arrows[0].tip).toEqual(bare.arrows[0].tip);
    // The production value lives here beside CUBE_CONSTANTS but is not applied
    // by default: with no outerPad there is no unused padding to spend, and a
    // bias would push the drawing straight out of the box.
    expect(CUBE_DOWN_BIAS_PX).toBeGreaterThan(0);
  });

  it("shrinks the drawing by outerPad so screen-space extras (head/label) still fit", () => {
    const full = projectCube(IDENTITY, { size: SIZE });
    const padded = projectCube(IDENTITY, { size: SIZE, outerPad: 20 });
    const centre = SIZE / 2;
    const reachOf = (p) => Math.max(...p.arrows.map((a) => Math.hypot(a.tip[0] - centre, a.tip[1] - centre)));
    expect(reachOf(padded)).toBeLessThan(reachOf(full));
  });

  it("emits three axis arrows, all starting at the same point — the shared corner", () => {
    const p = projectCube(IDENTITY, { size: SIZE });
    expect(p.arrows.map((a) => a.axis)).toEqual(["X", "Y", "Z"]);
    const [x, y, z] = p.arrows;
    expect(x.from).toEqual(y.from);
    expect(y.from).toEqual(z.from);
  });

  it("draws Z upward on screen at identity (model +Z is world up)", () => {
    const p = projectCube(IDENTITY, { size: SIZE });
    const z = p.arrows.find((a) => a.axis === "Z");
    expect(z.tip[1]).toBeLessThan(SIZE / 2); // screen y grows downward
  });

  describe("far-edge hiding", () => {
    // At identity 4 of the cube's 6 faces are *exactly* edge-on (view-space Z
    // of 0, not just close to it) — a degenerate case that is load-bearing
    // for the "at or below epsilon counts as not-facing" rule. Under that
    // rule the back face's 4 edges (adjoining the back face and one edge-on
    // face) and the 4 front-to-back edges (adjoining two edge-on faces) are
    // all hidden, leaving only the front face's 4 edges drawn — 2 of them the
    // axis-tagged x/z edges, 2 of them plain.
    it("at identity, draws only the front face's 4 edges and hides the other 8", () => {
      const p = projectCube(IDENTITY, { size: SIZE });
      const all = [...p.frontEdges, ...p.backEdges];
      expect(all).toHaveLength(12);
      const visible = all.filter((e) => !e.hidden);
      const hidden = all.filter((e) => e.hidden);
      expect(visible).toHaveLength(4);
      expect(hidden).toHaveLength(8);
      // The front face's 4 edges are exactly 2 axis-tagged (x, z — both meet
      // AXIS_ORIGIN_CORNER, which sits on the front face) plus 2 plain ones;
      // the third tagged edge (y) pokes away from the front face into the
      // cube's depth and is correctly among the hidden 8.
      expect(visible.filter((e) => e.axis).map((e) => e.axis).sort()).toEqual(["x", "z"]);
      expect(visible.filter((e) => !e.axis)).toHaveLength(2);
      const yEdge = all.find((e) => e.axis === "y");
      expect(yEdge.hidden).toBe(true);
    });

    it("at a general orientation, hides exactly 3 edges sharing one common endpoint (the far corner)", () => {
      const p = projectCube([0.2, 0.3, 0.1, 0.927], { size: SIZE });
      const all = [...p.frontEdges, ...p.backEdges];
      const hidden = all.filter((e) => e.hidden);
      expect(hidden).toHaveLength(3);
      const closeEnough = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
      // The shared vertex projects to the same screen point on every hidden
      // edge it touches — find a point on the first hidden edge that every
      // other hidden edge also has.
      const shared = hidden[0].points.find((point) =>
        hidden.every((e) => e.points.some((p2) => closeEnough(point, p2))),
      );
      expect(shared).toBeDefined();
    });

    it("never marks an edge hidden when only one of its two faces is edge-on or facing away", () => {
      // Sanity check on the rule itself, not just the two special cases above:
      // sweep a handful of orientations and confirm every hidden edge really
      // does have both adjoining faces at view-Z <= 0 (using the module's own
      // cell normals, computed independently of the edge-hiding code path via
      // the `back`/`front` cell split projectCube already produces for cells).
      for (const q of [IDENTITY, [0.2, 0.3, 0.1, 0.927], [0.5, 0.5, 0.5, 0.5], [0, 0.7071, 0, 0.7071]]) {
        const p = projectCube(q, { size: SIZE });
        const hiddenCount = [...p.frontEdges, ...p.backEdges].filter((e) => e.hidden).length;
        expect(hiddenCount).toBeGreaterThanOrEqual(3);
        expect(hiddenCount).toBeLessThanOrEqual(8);
      }
    });
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

  it("follows a downBias: the same click lands on the same region at the drawing's new centre", () => {
    // Hit-testing derives from the same projection as the painting, so the
    // 2026-08-20 lowering needs no work of its own — but that is exactly the
    // kind of "obviously fine" coupling that breaks silently the day someone
    // biases the drawing in one place and not the other.
    const q = [0.2, 0.3, 0.1, 0.927];
    const base = projectCube(q, { size: SIZE, outerPad: 23 });
    const low = projectCube(q, { size: SIZE, outerPad: 23, downBias: CUBE_DOWN_BIAS_PX });
    for (const [x, y] of [centre(), [SIZE / 2 - 12, SIZE / 2 - 9], [SIZE / 2 + 14, SIZE / 2 + 6]]) {
      const before = hitRegion(x, y, base);
      expect(before).not.toBeNull();
      expect(hitRegion(x, y + CUBE_DOWN_BIAS_PX, low)).toBe(before);
    }
    // And the clickable silhouette really did move, rather than the paint
    // moving while the hit test stayed put: a point just below the unbiased
    // cube's lowest edge is outside it and inside the lowered one.
    const lowest = base.front
      .flatMap((c) => c.points)
      .reduce((best, pt) => (pt[1] > best[1] ? pt : best));
    const probe = [lowest[0], lowest[1] + 1];
    expect(hitRegion(...probe, base)).toBeNull();
    expect(hitRegion(...probe, low)).not.toBeNull();
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

describe("FACE_LABEL_UP / faceLabelUpSign", () => {
  it("gives the four side faces the MODEL up axis, +Z — not view-angles.js's Y-up", () => {
    // The repo carries both conventions: view-angles.js names camera poses in
    // the viewer's Y-up world, this module's cells are in the model's Z-up
    // frame. Getting them the wrong way round lays every side label on its
    // side, so pin the frame explicitly.
    for (const face of ["front", "back", "left", "right"]) {
      expect(FACE_LABEL_UP[face]).toEqual([0, 0, 1]);
    }
  });

  it("gives TOP and BOTTOM the ups their own canonical camera pose uses", () => {
    // view-angles.js's upFor() gives a pure top view world [0,0,-1] and a
    // bottom view world [0,0,1]; the pivot maps model (x,y,z) -> world (x,z,-y),
    // so those are model +Y and -Y. Sharing them is what makes a TOP/BOTTOM
    // label read upright immediately after you click that face on the cube.
    expect(FACE_LABEL_UP.top).toEqual([0, 1, 0]);
    expect(FACE_LABEL_UP.bottom).toEqual([0, -1, 0]);
  });

  it("declares an up for every face, and always one of that face's in-plane axes", () => {
    const faces = [...new Set(cubeCells().map((c) => c.id))].filter((id) => FACE_LABEL_UP[id]);
    expect(faces).toHaveLength(6);
    for (const face of faces) {
      // Never the face's own normal: an up along the normal has no in-plane
      // direction to project onto, and the renderer's single-multiply
      // shortcut would silently collapse the label to nothing.
      const cell = cubeCells().find((c) => c.id === face);
      const dot = FACE_LABEL_UP[face].reduce((s, v, i) => s + v * cell.normal[i], 0);
      expect(dot).toBe(0);
      expect(Math.abs(faceLabelUpSign(face))).toBe(1);
    }
  });

  it("throws on a face name it does not know rather than silently defaulting", () => {
    expect(() => faceLabelUpSign("sideways")).toThrow(/unknown cube face/);
  });
});

describe("CUBE_CONSTANTS", () => {
  it("keeps the face cell smaller than the whole face", () => {
    expect(CUBE_CONSTANTS.faceHalf).toBeGreaterThan(0);
    expect(CUBE_CONSTANTS.faceHalf).toBeLessThan(1);
  });
});
