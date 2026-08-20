// The inspect job's `checks` knob. "quick" is the agent's fast lap: skip the two
// ray-casting passes (min wall, pair distances) and keep everything derived from the
// build the job already has. The safety half lives in verify — see
// test/oracle-fast-lap.test.js — and is asserted end-to-end here.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { handle } from "../src/framework/jobs.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const part = {
  meta: { title: "Pair", units: "mm" },
  defaults: {},
  parts: {
    left: { views: ["v"], build: (kk) => kk.box({ min: [0, 0, 0], max: [10, 10, 10] }) },
    right: { views: ["v"], build: (kk) => kk.box({ min: [10.2, 0, 0], max: [20, 10, 10] }) },
  },
  views: { v: { label: "V" } },
  verify: { process: "fdm-pla" },
};

const inspect = async (msg) => {
  const posts = [];
  await handle(k, part, { type: "inspect", view: "v", params: {}, ...msg }, (m) => posts.push(m));
  return posts.find((m) => m.type === "report");
};

test("checks: quick skips both ray-casting passes", async () => {
  const r = await inspect({ checks: "quick" });
  expect(r.measure.measuredMinWall).toBe(false);
  expect(r.measure.measuredGaps).toBe(false);
  expect(r.measure.gaps).toBeUndefined();
});

test("checks: quick keeps every fact the build already paid for", async () => {
  const r = await inspect({ checks: "quick" });
  expect(r.measure.subparts).toHaveLength(2);
  expect(r.measure.subparts[0].triangleCount).toBeGreaterThan(0);
  expect(r.measure.subparts[0].volume).toBeCloseTo(1000, 0);
  expect(r.measure.subparts[0].watertight).toBe(true);
  expect(r.measure.aggregate.bbox[0]).toBeCloseTo(20, 1);
  expect(r.measure.overlaps).toEqual([]);           // the cheap assembly check still runs
});

test("checks: quick withholds the verdict — the part gates on min wall", async () => {
  const r = await inspect({ checks: "quick" });
  expect(r.verify.ok).toBeNull();
  expect(r.verify.unevaluated.length).toBeGreaterThan(0);
});

test("the default lap is unchanged", async () => {
  const r = await inspect({});
  expect(r.measure.measuredMinWall).toBe(true);
  expect(r.measure.measuredGaps).toBe(true);
  expect(r.measure.gaps).toHaveLength(1);
  expect(r.verify.ok).toBe(true);
  expect(r.verify.unevaluated).toEqual([]);
});

test("an unrecognized checks value runs the full lap — the safe direction", async () => {
  const r = await inspect({ checks: "quik" });
  expect(r.measure.measuredMinWall).toBe(true);
  expect(r.measure.measuredGaps).toBe(true);
});
