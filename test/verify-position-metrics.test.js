import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { measure } from "../src/testing/measure.js";
import { evaluateCase } from "../src/testing/verify.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const boxPart = {   // [0,0,0]..[10,20,5]; com [5,10,2.5]
  meta: { title: "Box", units: "mm" }, defaults: {},
  parts: { block: { views: ["v"], build: (kk) => kk.box({ min: [0, 0, 0], max: [10, 20, 5] }) } },
  views: { v: { label: "V" } },
};
const run = (expect_) => evaluateCase(measure(k, boxPart, "v"), { expect: expect_, subPartNames: ["block"] });
const find = (checks, metric) => checks.find((c) => c.metric === metric);

test("centerOfMass vector assertion passes and fails componentwise", () => {
  expect(find(run({ block: { centerOfMass: "<=[*,*,3]" } }), "centerOfMass").status).toBe("pass");   // 2.5 <= 3
  expect(find(run({ block: { centerOfMass: "<=[*,*,2]" } }), "centerOfMass").status).toBe("fail");   // 2.5 > 2
});

test("boundsMin / boundsMax vector assertions", () => {
  expect(find(run({ block: { boundsMin: ">=[0,0,0]" } }), "boundsMin").status).toBe("pass");
  expect(find(run({ block: { boundsMax: "<=[10,20,5]" } }), "boundsMax").status).toBe("pass");
  expect(find(run({ block: { boundsMax: "<=[9,*,*]" } }), "boundsMax").status).toBe("fail");          // max x is 10
});

test("view (aggregate) centerOfMass metric works", () => {
  expect(find(run({ _view: { centerOfMass: "<=[*,*,3]" } }), "centerOfMass").status).toBe("pass");
});

test("a null centerOfMass skips rather than fails", () => {
  const facts = { subparts: [{ name: "block", centerOfMass: null, bounds: { min: [0, 0, 0], max: [1, 1, 1] } }],
    aggregate: { centerOfMass: null, bounds: { min: [0, 0, 0], max: [1, 1, 1] } }, overlaps: [], gaps: [], nearMisses: [] };
  const checks = evaluateCase(facts, { expect: { block: { centerOfMass: "<=[*,*,3]" } }, subPartNames: ["block"] });
  expect(find(checks, "centerOfMass").status).toBe("skip");
});
