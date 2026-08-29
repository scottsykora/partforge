// The k.svg2d reference part. Manifold-booting only; never boot OCCT in this
// file (AGENTS.md — the two WASM kernels must not share a process).
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import part from "../src/parts/emblem.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel({ svgs: part.svgs }); });

const build = (over = {}) => {
  const p = { ...part.defaults, ...over };
  return part.parts.plate.build(k, p, part.derive ? part.derive(p) : {});
};

test("the part declares its ingested artwork under svgs", () => {
  expect(Object.keys(part.svgs)).toEqual(["emblem"]);
});

test("the plate builds, is solid, and carries the emboss", () => {
  const s = build();
  expect(s.toMesh().triangles).toBeGreaterThan(0);
  expect(s.volume()).toBeGreaterThan(
    k.box({ min: [-20, -16, 0], max: [20, 16, 3] }).volume());
});

test("the artwork's aspect is 40:30 — fill unioned with stroke, not the viewBox", () => {
  const { min, max } = k.svg2d("emblem", { width: 40 }).extrude({ h: 1 }).boundingBox();
  expect(max[0] - min[0]).toBeCloseTo(40, 1);
  expect(max[1] - min[1]).toBeCloseTo(30, 1);
});

test("the circle survived ingest as symbolic arcs", () => {
  const all = k._svgs.get("emblem").flatMap((r) => r.outer.segments);
  expect(all.some((s) => s.via)).toBe(true);
});

test("emblem_w drives the emboss size", () => {
  expect(build({ emblem_w: 30 }).volume()).toBeGreaterThan(build({ emblem_w: 15 }).volume());
});
