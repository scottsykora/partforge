import { expect, test } from "vitest";
import { evaluateCase } from "../src/testing/verify.js";
import { resolveProfile } from "../src/testing/dfm-profiles.js";
import { measure as measureReal } from "../src/testing/measure.js";
import { verify as verifyFromEntry } from "../src/testing.js";
import demo from "../src/parts/demo.js";

test("verify is exported from the partforge/testing entry", () => {
  expect(typeof verifyFromEntry).toBe("function");
});

const facts = {
  subparts: [{ name: "spacer", holes: 1, volume: 500, surfaceArea: 300, triangleCount: 200, bbox: [8, 8, 10], watertight: true, minWall: null }],
  aggregate: { bbox: [8, 8, 10], volume: 500 },
  overlaps: [],
};
const byKey = (checks, scope, metric) => checks.find((c) => c.scope === scope && c.metric === metric);

test("passes exact gates from profile + expect", () => {
  const checks = evaluateCase(facts, { profile: resolveProfile("fdm-pla"), expect: { spacer: { holes: 1, volume: "0.4..0.6cm3" }, _view: { overlaps: 0 } } });
  expect(byKey(checks, "subpart", "holes").status).toBe("pass");
  expect(byKey(checks, "subpart", "volume").status).toBe("pass");
  expect(byKey(checks, "view", "overlaps").status).toBe("pass");
  expect(byKey(checks, "view", "bbox").status).toBe("pass");       // from profile.bed
});

test("min-wall with no reading is a warn (unavailable), never a fail", () => {
  const checks = evaluateCase(facts, { profile: resolveProfile("fdm-pla"), expect: {} });
  const w = byKey(checks, "subpart", "minWall");
  expect(w.kind).toBe("warn");
  expect(w.status).toBe("warn");
  expect(w.message).toMatch(/unavailable/);
});

test("a violated exact gate is a fail", () => {
  const checks = evaluateCase(facts, { profile: null, expect: { spacer: { holes: 2 } } });
  expect(byKey(checks, "subpart", "holes").status).toBe("fail");
});

test("Manifold-only facts skip on OCCT (null actual)", () => {
  const occt = { subparts: [{ name: "spacer", holes: null, watertight: null, volume: 500, surfaceArea: 1, triangleCount: 1, bbox: [8, 8, 10], minWall: null }], aggregate: { bbox: [8, 8, 10], volume: 500 }, overlaps: [] };
  const checks = evaluateCase(occt, { profile: null, expect: { spacer: { watertight: true } } });
  expect(byKey(checks, "subpart", "watertight").status).toBe("skip");
});

test("throws on an unknown metric", () => {
  expect(() => evaluateCase(facts, { profile: null, expect: { spacer: { wormholes: 1 } } })).toThrow();
});

import { beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { verify } from "../src/testing/verify.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const tube = (od, h) => ({
  meta: { title: "Tube", units: "mm" },
  defaults: { od, h, label: "a" },
  parameters: [{ id: "b", presets: { Big: { od: 20, h: 30 }, Relabel: { label: "z" } } }],
  parts: { tube: { views: ["v"], build: (kk, p) => kk.cylinder(p.od / 2, p.od / 2, p.h).cut(kk.cylinder(2, 2, p.h + 4).translate([0, 0, -2])) } },
  views: { v: { label: "V" } },
});

test("verify passes a sound part and reports a real min-wall measurement", () => {
  const part = { ...tube(12, 10), verify: { process: "fdm-pla", expect: { tube: { holes: 1 }, _view: { overlaps: 0 } } } };
  const v = verify(k, part);
  expect(v.ok).toBe(true);
  const mw = v.cases[0].checks.find((c) => c.metric === "minWall");
  expect(mw.actual).toBeGreaterThan(1.2);   // healthy wall (~4 mm)
  expect(mw.status).toBe("pass");
});

test("verify fails a violated gate", () => {
  const part = { ...tube(12, 10), verify: { expect: { tube: { holes: 2 } } } };
  const v = verify(k, part);
  expect(v.ok).toBe(false);
  expect(v.failures).toHaveLength(3);   // defaults + 2 presets
});

test("dedup: cases with the same param-deps signature reuse one measure call", () => {
  // "Relabel" preset changes only `label`, which the build never reads → same
  // signature as defaults; "Big" changes od/h → distinct. 3 cases, 2 measures.
  const part = { ...tube(12, 10), verify: { process: "fdm-pla", cases: ["defaults", "Relabel", "Big"] } };
  let calls = 0;
  const measureFn = (...args) => { calls++; return measureReal(...args); };
  const v = verify(k, part, { measureFn });
  expect(v.cases).toHaveLength(3);
  expect(calls).toBe(2);
});

test("the demo part ships a passing verify block", () => {
  const v = verify(k, demo);
  expect(v.ok).toBe(true);
  expect(v.cases.map((c) => c.name)).toEqual(["defaults", "M3", "M5"]);
  const mw = v.cases[0].checks.find((c) => c.metric === "minWall");
  expect(mw.actual).toBeGreaterThan(1.2);   // spacer wall ~2.2 mm
  expect(mw.status).toBe("pass");
});
