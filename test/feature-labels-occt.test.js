// OCCT-side feature labels. OCCT must boot alone (never with Manifold) — this
// file only imports bootOcctKernel.
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing.js";
import filletedBox from "../src/parts/filleted-box.js";
import { resolveParams, buildPosed } from "../src/framework/jobs.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120000);

test("label() attributes a cut tool's surviving surface (OCCT)", () => {
  const s = k.box([0, 0, 0], [10, 10, 10])
    .cut(k.cylinder(2, 2, 12).at([5, 5, -1]).label("Bore"));
  const m = s.toMesh();
  expect(m.features).toEqual(["Bore"]);
  expect(m.featureIds).toBeInstanceOf(Uint16Array);
  expect(m.featureIds.length).toBe(m.triangles);
  // a bore triangle's vertices lie on the r=2 cylinder around (5,5); use indices
  // (OCCT meshes are indexed)
  const t = m.featureIds.indexOf(1);
  expect(t).toBeGreaterThanOrEqual(0);
  for (let v = 0; v < 3; v++) {
    const vi = m.indices[t * 3 + v] * 3;
    const x = m.positions[vi] - 5, y = m.positions[vi + 1] - 5;
    expect(Math.hypot(x, y)).toBeCloseTo(2, 1);
  }
  expect(m.featureIds.some((v) => v === 0)).toBe(true); // box faces unlabeled
});

test("labels survive transforms applied after label() (OCCT)", () => {
  const tool = k.cylinder(2, 2, 12).label("Bore").at([5, 5, -1]);
  const m = k.box([0, 0, 0], [10, 10, 10]).cut(tool).toMesh();
  expect(m.features).toEqual(["Bore"]);
});

test("fillet surfaces stay unlabeled but other labeled faces persist", () => {
  const s = k.box([0, 0, 0], [20, 20, 10]).fillet(2, { dir: "Z" })
    .cut(k.cylinder(3, 3, 12).at([10, 10, -1]).label("Bore"));
  const m = s.toMesh();
  expect(m.features).toEqual(["Bore"]);
});

test("unlabeled OCCT build produces no feature fields", () => {
  const m = k.box([0, 0, 0], [4, 4, 4]).toMesh();
  expect(m.featureIds).toBeUndefined();
});

test("filleted-box labels its bore", () => {
  const { p, d } = resolveParams(filletedBox, {});
  const m = buildPosed(k, filletedBox, "body", { purpose: "display", view: "box", p, d }).toMesh();
  expect(m.features).toEqual(["Bore"]);
});
