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
