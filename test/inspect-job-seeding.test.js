// The inspect job runs measure() and then verify(), and verify always expands a
// "defaults" case whose params are the part defaults — so on an unparameterized
// inspect it used to re-measure exactly what the job had just measured: a full
// geometry rebuild, min-wall pass and gap pass, duplicated. On a single-case part
// that was half the oracle. jobs.js now seeds verify with the measurement it
// already has; this counts the measure() calls so a refactor cannot quietly
// re-introduce the duplicate.
//
// Kept in its own file: the mock only reaches jobs.js's import of measure.js when
// the test file does not also import measure.js directly.
import { beforeAll, expect, test, vi } from "vitest";

let measures = 0;
vi.mock("../src/testing/measure.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, measure: (...args) => { measures++; return real.measure(...args); } };
});

const { bootManifoldKernel } = await import("../src/testing/manifold.js");
const { handle } = await import("../src/framework/jobs.js");
const planter = (await import("../src/parts/planter.js")).default;

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const inspect = async (part, view, params = {}) => {
  const posts = [];
  await handle(k, part, { type: "inspect", view, params }, (m) => posts.push(m));
  return posts.find((m) => m.type === "report");
};

const tube = {
  meta: { title: "Tube", units: "mm" },
  defaults: { od: 12, h: 10 },
  parameters: [{ id: "b", presets: { Big: { od: 20 } } }],
  parts: { tube: { views: ["v"], build: (kk, p) => kk.cylinder({ r: p.od / 2, h: p.h })
    .cut(kk.cylinder({ r: 2, h: p.h + 4 }).translate([0, 0, -2])) } },
  views: { v: { label: "V" } },
  verify: { process: "fdm-pla", cases: ["defaults", "Big"] },
};

test("a two-case inspect measures twice, not three times", async () => {
  measures = 0;
  const report = await inspect(tube, "v");
  expect(report.verify.cases).toHaveLength(2);
  expect(report.verify.ok).toBe(true);
  // 1 for the report's own measure (which IS the "defaults" case) + 1 for "Big".
  expect(measures).toBe(2);
  const mw = report.verify.cases[0].checks.find((c) => c.metric === "minWall");
  expect(mw.status).toBe("pass");
  expect(mw.actual).toBeGreaterThan(1.2);          // the seeded min-wall reading survived
});

test("a single-case inspect measures exactly once", async () => {
  measures = 0;
  const report = await inspect({ ...tube, verify: { process: "fdm-pla", cases: ["defaults"] } }, "v");
  expect(report.verify.ok).toBe(true);
  expect(measures).toBe(1);
});

test("inspecting with non-default params does not let the seed answer the defaults case", async () => {
  measures = 0;
  const report = await inspect(tube, "v", { od: 30 });
  expect(report.measure.subparts[0].bbox[0]).toBeCloseTo(30, 0);   // the report is the caller's params
  expect(report.verify.cases).toHaveLength(2);
  expect(measures).toBe(3);                                        // report + defaults + Big
  expect(report.verify.ok).toBe(true);
});

test("the shipped planter inspect still reports a passing verify over all four cases", async () => {
  measures = 0;
  const report = await inspect(planter, "planter");
  expect(report.verify.cases.map((c) => c.name)).toEqual(["defaults", "Pen cup", "Planter", "Vase"]);
  expect(report.verify.ok).toBe(true);
  expect(measures).toBe(4);                                        // was 5 — the defaults case is seeded
});
