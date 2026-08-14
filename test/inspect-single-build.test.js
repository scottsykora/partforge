// The inspect job builds the view ONCE and shares it: the measurement takes it
// through `measure`'s `opts.built`, and silhouette match scoring rasterizes the same
// meshes. Drop `built` from that call and nothing breaks — measure quietly builds the
// part a second time, every test still passes, and an inspect costs two full builds
// (on a heavy part, seconds and hundreds of megabytes). So count the builds, the same
// way test/inspect-job-seeding.test.js counts measure() calls for the sibling
// duplicate it closed.
//
// Kept in its own file for the same reason that one is: the mock only reaches the
// jobs.js/measure.js imports of build.js while this file does not import build.js
// itself. That is also why the ring fixture below is written out by hand rather than
// rasterized off the part.
import { beforeAll, expect, test, vi } from "vitest";

let builds = 0;
vi.mock("../src/framework/oracle/build.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, buildView: (...args) => { builds++; return real.buildView(...args); } };
});

const { bootManifoldKernel } = await import("../src/testing/manifold.js");
const { handle } = await import("../src/framework/jobs.js");

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// One case, so verify's "defaults" case is answered entirely by the seeded
// measurement and adds no build of its own. Any build counted here is the job's.
const tube = {
  meta: { title: "Tube", units: "mm" },
  defaults: { od: 12, h: 10 },
  parts: { tube: { views: ["v"], build: (kk, p) => kk.cylinder({ r: p.od / 2, h: p.h })
    .cut(kk.cylinder({ r: 2, h: p.h + 4 }).translate([0, 0, -2])) } },
  views: { v: { label: "V" } },
  verify: { process: "fdm-pla", cases: ["defaults"] },
};

const circle = (r, n = 96) =>
  Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)]);

const inspect = async (msg) => {
  const posts = [];
  await handle(k, tube, { type: "inspect", view: "v", params: {}, ...msg }, (m) => posts.push(m));
  expect(posts.find((m) => m.type === "error")?.message ?? null).toBe(null);
  return posts.find((m) => m.type === "report");
};

test("a single-case inspect with match targets builds the view exactly once", async () => {
  builds = 0;
  const report = await inspect({ matchTargets: [{ kind: "profile", rings: [circle(6), circle(2)] }] });
  // The scoring really ran off that one build — otherwise "one build" would be
  // satisfied by simply never rasterizing anything.
  expect(report.match).toHaveLength(1);
  expect(report.match[0].best.iou).toBeGreaterThan(0.9);
  expect(report.verify.ok).toBe(true);
  expect(builds).toBe(1);
});

test("match targets cost no extra build: a plain inspect builds once too", async () => {
  builds = 0;
  await inspect({});
  expect(builds).toBe(1);
});

test("every target shares the one build — a second target adds none", async () => {
  builds = 0;
  const report = await inspect({
    matchTargets: [
      { kind: "profile", rings: [circle(6), circle(2)] },
      { kind: "profile", rings: [circle(6)] },
    ],
  });
  expect(report.match).toHaveLength(2);
  expect(builds).toBe(1);
});
