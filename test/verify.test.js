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

const factsThin = {
  subparts: [{ name: "ring", holes: 1, volume: 500, surfaceArea: 300, triangleCount: 200,
    bbox: [8, 8, 10], watertight: true, minWall: 0.8, minWallAt: [3.7, 0, 5] }],
  aggregate: { bbox: [8, 8, 10], volume: 500 },
  overlaps: [],
};

test("a failed check carries registry hint, pattern, and location", () => {
  const checks = evaluateCase(factsThin, { profile: resolveProfile("fdm-pla"), expect: {} });
  const w = byKey(checks, "subpart", "minWall");
  expect(w.status).toBe("warn");
  expect(w.hint).toMatch(/wall/);
  expect(w.pattern).toBe("minwall-sliver-triangles");
  expect(w.location).toEqual([3.7, 0, 5]);
});

test("part-authored { expr, hint } wins over the registry hint (pattern still applies)", () => {
  const checks = evaluateCase(factsThin, { profile: null,
    expect: { ring: { minWall: { expr: ">=1.2", hint: "increase `wallThickness` or reduce `twist`" } } } });
  const w = byKey(checks, "subpart", "minWall");
  expect(w.status).toBe("warn");
  expect(w.expr).toBe(">=1.2");
  expect(w.hint).toBe("increase `wallThickness` or reduce `twist`");
  expect(w.pattern).toBe("minwall-sliver-triangles");
});

test("passing checks carry no diagnostic noise", () => {
  const checks = evaluateCase(factsThin, { profile: null, expect: { ring: { holes: 1 } } });
  const c = byKey(checks, "subpart", "holes");
  expect(c.status).toBe("pass");
  expect(c.hint).toBeUndefined();
  expect(c.pattern).toBeUndefined();
  expect(c.location).toBeUndefined();
});

test("a failing view overlaps gate locates the first offending pair", () => {
  const facts2 = { ...factsThin, overlaps: [{ a: "a", b: "b", volume: 200, location: [9, 5, 5] }] };
  const checks = evaluateCase(facts2, { profile: null, expect: { _view: { overlaps: 0 } } });
  const c = byKey(checks, "view", "overlaps");
  expect(c.status).toBe("fail");
  expect(c.hint).toMatch(/clearance|placement/);
  expect(c.location).toEqual([9, 5, 5]);
});

test("min-wall-unavailable warn still carries a hint", () => {
  const noReading = { ...factsThin, subparts: [{ ...factsThin.subparts[0], minWall: null, minWallAt: null }] };
  const checks = evaluateCase(noReading, { profile: resolveProfile("fdm-pla"), expect: {} });
  const w = byKey(checks, "subpart", "minWall");
  expect(w.status).toBe("warn");
  expect(w.message).toMatch(/unavailable/);
  expect(w.hint).toBeTruthy();
});

// ── function-valued expect (per-case expectations) ─────────────────────────────────────────

// A puck with an optional bore: presets legitimately change the topology
// (bore on → genus 1, bore off → genus 0) — the case a static expect can't pin.
const holey = () => ({
  meta: { title: "Holey", units: "mm" },
  defaults: { od: 12, h: 10, bore: 4 },
  parameters: [{ id: "b", presets: { Solid: { bore: 0 }, Wide: { bore: 6 } } }],
  derive: (p) => ({ boreR: p.bore / 2 }),
  parts: {
    puck: { views: ["v"], build: (kk, p, d) => {
      const s = kk.cylinder(p.od / 2, p.od / 2, p.h);
      return p.bore > 0 ? s.cut(kk.cylinder(d.boreR, d.boreR, p.h + 4).translate([0, 0, -2])) : s;
    } },
  },
  views: { v: { label: "V" } },
});

test("a function-valued expect is resolved per case and passes topology-changing presets", () => {
  const part = { ...holey(), verify: { expect: (p) => ({ puck: { holes: p.bore > 0 ? 1 : 0 } }) } };
  const v = verify(k, part);
  expect(v.ok).toBe(true);
  expect(v.cases.map((c) => c.name)).toEqual(["defaults", "Solid", "Wide"]);
});

test("a function-valued expect still fails a genuinely wrong case", () => {
  const part = { ...holey(), verify: { expect: () => ({ puck: { holes: 2 } }) } };
  const v = verify(k, part);
  expect(v.ok).toBe(false);
  expect(v.failures).toHaveLength(3);
});

test("the expect function receives the case's resolved (p, d)", () => {
  const seen = [];
  const part = { ...holey(), verify: { expect: (p, d) => { seen.push([p.bore, d.boreR]); return {}; } } };
  verify(k, part);
  expect(seen).toEqual([[4, 2], [0, 0], [6, 3]]);   // defaults, Solid, Wide
});

test("a function expect mentioning minWall turns the measurement on", () => {
  const part = { ...holey(), verify: { expect: () => ({ puck: { minWall: ">=1" } }) } };
  const v = verify(k, part);
  const mw = v.cases[0].checks.find((c) => c.metric === "minWall");
  expect(typeof mw.actual).toBe("number");          // a real reading, not "unavailable"
});

import planter from "../src/parts/planter.js";

test("the planter's shipped verify block passes every preset (drain on AND off)", () => {
  const v = verify(k, planter);
  expect(v.failures).toEqual([]);
  expect(v.ok).toBe(true);
  expect(v.cases.map((c) => c.name)).toEqual(["defaults", "Pen cup", "Planter", "Vase"]);
});
