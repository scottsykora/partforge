// The k.vector2d reference part. Manifold-booting only; never boot OCCT in this
// file (AGENTS.md — the two WASM kernels must not share a process).
import { beforeAll, expect, it, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import part from "../src/parts/emblem.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel({ vectors: part.vectors }); });

const build = (over = {}) => {
  const p = { ...part.defaults, ...over };
  return part.parts.plate.build(k, p, part.derive ? part.derive(p) : {});
};

test("the part declares both the ingested artwork and the authored plate under vectors", () => {
  expect(Object.keys(part.vectors)).toEqual(["emblem", "plate"]);
});

test("the plate builds, is solid, and carries the emboss", () => {
  const s = build();
  expect(s.toMesh().triangles).toBeGreaterThan(0);
  // The plate outline is now drawn (40 x 24 mm, plate.vector.json), not
  // parameterized — the box bound below matches that fixed footprint.
  expect(s.volume()).toBeGreaterThan(
    k.box({ min: [-20, -12, 0], max: [20, 12, 3] }).volume());
});

test("the artwork's aspect is 40:30 — fill unioned with stroke, not the viewBox", () => {
  const { min, max } = k.vector2d("emblem", { width: 40 }).extrude({ h: 1 }).boundingBox();
  expect(max[0] - min[0]).toBeCloseTo(40, 1);
  expect(max[1] - min[1]).toBeCloseTo(30, 1);
});

test("the circle survived ingest as symbolic arcs", () => {
  // emblem.vector.json's outer contours are 5 arcs and 2 lines, 0 cubics (see
  // docs/VECTOR-FORMAT.md §2) — `some((s) => s.via)` would pass just as
  // happily on one arc buried in a pile of cubics, which is exactly the
  // regression this test exists to catch (arc recovery falling back to a
  // Bézier approximation instead of a true circular arc). Assert what the
  // fixture actually guarantees: NO cubic survived, not just that one arc did.
  const doc = k._vectors.get("emblem");
  const all = [...doc.shapes.values()].flatMap((e) => e.regions).flatMap((r) => r.outer.segments);
  expect(all.some((s) => s.via)).toBe(true);
  expect(all.every((s) => !s.c1)).toBe(true);
});

test("emblem_w drives the emboss size", () => {
  expect(build({ emblem_w: 30 }).volume()).toBeGreaterThan(build({ emblem_w: 15 }).volume());
});

it("cuts the authored plate's holes and keyway, in the drawing's own frame", async () => {
  const k = await bootManifoldKernel({ vectors: part.vectors });
  const body = k.vector2d("plate", { shape: "body" });
  const cut = body.cut(k.vector2d("plate", { shape: "holes" })).cut(k.vector2d("plate", { shape: "keyway" }));
  // 40x24 with four r=4 corners, minus two r=1.7 discs and a 6x4 triangle.
  const bodyArea = 40 * 24 - 4 * 16 + Math.PI * 16;
  expect(body.area()).toBeCloseTo(bodyArea, 1);
  expect(cut.area()).toBeCloseTo(bodyArea - 2 * Math.PI * 1.7 ** 2 - 12, 1);
  // The whole point of roles: the file composes itself, and the result is
  // identical to doing it by hand shape by shape.
  expect(k.vector2d("plate").area()).toBeCloseTo(cut.area(), 6);
});
