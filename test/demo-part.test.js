import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import part from "../src/parts/demo.js";

let k;
beforeAll(async () => { const w = await Module(); w.setup(); k = createManifoldKernel(w, { quality: "preview" }); });

const buildSpacer = (overrides = {}) => {
  const p = { ...part.defaults, ...overrides };
  const d = part.derive ? part.derive(p) : {};
  return part.parts.spacer.build(k, p, d);
};

test("demo derive feeds build: spacer meshes and has exactly one through-bore", () => {
  const s = buildSpacer();
  expect(s.toMesh().triangles).toBeGreaterThan(0);
  expect(s.genus()).toBe(1);                 // the bore
  expect(s.volume()).toBeGreaterThan(0);
});

test("flange_h is a defaulted param the build consumes when the flange is on", () => {
  expect(part.defaults.flange_h).toBeGreaterThan(0);   // present in defaults (hidden control)
  const s = buildSpacer({ flange_d: 16 });
  expect(s.volume()).toBeGreaterThan(buildSpacer({ flange_d: 0 }).volume()); // flange adds material
});

test("derive applies a print clearance: bore hole is wider than the nominal bore", () => {
  const p = { ...part.defaults };
  const d = part.derive(p);
  expect(d.boreR).toBeCloseTo((p.bore + 0.2) / 2, 6);  // nominal + 0.2mm clearance, as radius
  expect(d.cutH).toBe(p.h + 4);
});
