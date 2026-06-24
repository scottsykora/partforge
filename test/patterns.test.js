import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { linearPattern, circularPattern } from "../src/framework/geometry/polygon.js";
import { bboxSize } from "../src/testing/mesh.js";

let k;
beforeAll(async () => { const w = await Module(); w.setup(); k = createManifoldKernel(w, { quality: "preview" }); });

test("linearPattern makes `count` copies the union of which spans the run", () => {
  const unit = k.box([-1, -1, -1], [1, 1, 1]);          // 2mm cube at origin
  const copies = linearPattern(unit, 4, [10, 0, 0]);
  expect(copies.length).toBe(4);
  const [w] = bboxSize(k.union(copies).toMesh().positions);
  expect(w).toBeCloseTo(32, 1);                          // 0..30 plus the 2mm cube width
});

test("circularPattern makes `count` copies arranged around the axis", () => {
  const tool = k.box([18, -1, -1], [22, 1, 1]);          // a tab out at radius ~20 on +X
  const copies = circularPattern(tool, 4, { axis: "Z" });
  expect(copies.length).toBe(4);
  const u = k.union(copies).toMesh().positions;
  const [w, h] = bboxSize(u);
  expect(w).toBeCloseTo(44, 0);                          // tabs reach ±22 on X and Y
  expect(h).toBeCloseTo(44, 0);
});

test("rotateCopies:false keeps each copy axis-aligned", () => {
  const tool = k.box([18, -1, -2], [22, 1, 2]);          // longer in Z
  const rotated = circularPattern(tool, 4, { axis: "Z", rotateCopies: true });
  const fixed = circularPattern(tool, 4, { axis: "Z", rotateCopies: false });
  // every fixed copy keeps the original Z-extent of 4; bbox Z stays 4
  expect(bboxSize(k.union(fixed).toMesh().positions)[2]).toBeCloseTo(4, 1);
  expect(rotated.length).toBe(4);
});
