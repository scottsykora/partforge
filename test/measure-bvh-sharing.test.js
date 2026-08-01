// measure() used to index every sub-part mesh into a BVH TWICE: once inside
// minWall (inward rays per triangle) and again inside meshGaps (pair distances),
// from the same mesh objects. At ~77 bytes/triangle that is a whole second index
// per sub-part, built and thrown away. This is the counting test that keeps the
// duplicate gone — it asserts how many indexes get built, which is the thing a
// future refactor can silently undo without any output changing.
//
// Counting is done by wrapping bvh.js: buildBVH counts a direct build, and
// cachedBVH counts a cache MISS (which is exactly when it builds) while still
// delegating to the real implementation, so the test never re-implements the
// behaviour it is checking.
import { beforeAll, expect, test, vi } from "vitest";

let builds = 0;
vi.mock("../src/testing/bvh.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    buildBVH: (mesh) => { builds++; return real.buildBVH(mesh); },
    cachedBVH: (mesh, cache) => {
      if (!cache?.has(mesh)) builds++;
      return real.cachedBVH(mesh, cache);
    },
  };
});

const { bootManifoldKernel } = await import("../src/testing/manifold.js");
const { measure } = await import("../src/testing/measure.js");

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const tube = (kk, ro, ri, h) => kk.cylinder({ r: ro, h }).cut(kk.cylinder({ r: ri, h: h + 4 }).translate([0, 0, -2]));
const threeTubes = {
  meta: { title: "Three tubes", units: "mm" },
  defaults: { ro: 8, ri: 6, h: 10, gap: 2 },
  parts: {
    a: { views: ["v"], build: (kk, p) => tube(kk, p.ro, p.ri, p.h) },
    b: { views: ["v"], build: (kk, p) => tube(kk, p.ro, p.ri, p.h),
      place: (s, { p }) => s.translate([p.ro * 2 + p.gap, 0, 0]) },
    c: { views: ["v"], build: (kk, p) => tube(kk, p.ro, p.ri, p.h),
      place: (s, { p }) => s.translate([0, p.ro * 2 + p.gap, 0]) },
  },
  views: { v: { label: "V" } },
};

test("measure indexes each sub-part mesh ONCE — min-wall and meshGaps share the BVH", () => {
  builds = 0;
  const r = measure(k, threeTubes, "v", {}, { minWall: true });
  expect(r.subparts).toHaveLength(3);
  expect(r.gaps).toHaveLength(3);                                    // pair distances really ran
  expect(r.subparts.every((s) => typeof s.minWall === "number")).toBe(true);  // and so did min-wall
  expect(builds).toBe(3);                                            // one index per sub-part, not two
});

test("without min-wall only meshGaps indexes, and still just once per sub-part", () => {
  builds = 0;
  const r = measure(k, threeTubes, "v");
  expect(r.gaps).toHaveLength(3);
  expect(builds).toBe(3);
});

test("a single-sub-part measure skips meshGaps entirely — one index, min-wall's", () => {
  builds = 0;
  const one = { ...threeTubes, parts: { a: threeTubes.parts.a } };
  const r = measure(k, one, "v", {}, { minWall: true });
  expect(r.gaps).toEqual([]);
  expect(builds).toBe(1);
});
