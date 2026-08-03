// The animation reference part: builds clean, poses are rigid and
// view-independent, and the animations block round-trips the timeline model.
import { beforeAll, expect, test } from "vitest";
import part from "../src/parts/hinged-box.js";
import { bootManifoldKernel, measure } from "../src/testing.js";
import { normalizeAnimations, evaluate } from "../src/framework/animation.js";

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(); });

test("builds and measures clean at defaults", () => {
  const r = measure(kernel, part, "box");
  expect(r.ok).toBe(true);
  expect(r.subparts.map((s) => s.name).sort()).toEqual(["base", "lid"]);
  expect(r.overlaps).toEqual([]);
});

test("lidAngle/lidLift are pose-only: same volume at any pose", () => {
  const closed = measure(kernel, part, "box");
  const open = measure(kernel, part, "box", { lidAngle: 90, lidLift: 20 }); // params is the 4th positional
  const vol = (r, n) => r.subparts.find((s) => s.name === n).volume;
  expect(vol(open, "lid")).toBeCloseTo(vol(closed, "lid"), 3);
  expect(vol(open, "base")).toBeCloseTo(vol(closed, "base"), 3);
});

test("animations normalize: open has an intro cue, assemble has step cues", () => {
  const [open, cycle, assemble] = normalizeAnimations(part);
  expect(open.cues).toEqual([{ t: 0, view: "front" }]);
  expect(open.description).toMatch(/lid/i);
  expect(cycle.loop).toBe(true);
  expect(assemble.steps.map((s) => s.label)).toEqual(["Lower the lid", "Open to check clearance"]);
  expect(assemble.cues.map((c) => c.view)).toEqual(["left", "iso"]);
  expect(evaluate(open, 1).values.lidAngle).toBe(110);
});
