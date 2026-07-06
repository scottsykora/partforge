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

// ── contacts / clearance / near-miss warnings ──────────────────────────────────────────────

const twoBoxFacts = (over = {}) => ({
  subparts: [
    { name: "left", holes: 0, volume: 1000, surfaceArea: 600, triangleCount: 12, bbox: [10, 10, 10], watertight: true, minWall: null },
    { name: "right", holes: 0, volume: 1000, surfaceArea: 600, triangleCount: 12, bbox: [10, 10, 10], watertight: true, minWall: null },
  ],
  aggregate: { bbox: [20.2, 10, 10], volume: 2000 },
  overlaps: [],
  gaps: [{ a: "left", b: "right", distance: 0.2, at: [10.1, 5, 5] }],
  nearMisses: [{ a: "left", b: "right", distance: 0.2, at: [10.1, 5, 5] }],
  ...over,
});
const pairCheck = (checks, metric) => checks.find((c) => c.metric === metric);

test("an undeclared near miss is a warning with location, hint, and pattern", () => {
  const checks = evaluateCase(twoBoxFacts(), { profile: null, expect: {} });
  const w = pairCheck(checks, "nearMiss");
  expect(w.kind).toBe("warn");
  expect(w.status).toBe("warn");
  expect(w.subpart).toBe("left×right");
  expect(w.actual).toBeCloseTo(0.2, 6);
  expect(w.location).toEqual([10.1, 5, 5]);
  expect(w.hint).toMatch(/contacts|clearance/);
  expect(w.pattern).toBe("near-miss-gap");
});

test("declaring the pair in contacts turns the near miss into a gate failure (and silences the warning)", () => {
  const checks = evaluateCase(twoBoxFacts(), { profile: null, expect: { _view: { contacts: [["left", "right"]] } } });
  const c = pairCheck(checks, "contact");
  expect(c.kind).toBe("gate");
  expect(c.status).toBe("fail");
  expect(c.actual).toBeCloseTo(0.2, 6);
  expect(c.location).toEqual([10.1, 5, 5]);
  expect(c.hint).toBeTruthy();
  expect(pairCheck(checks, "nearMiss")).toBeUndefined();
});

test("contacts passes on a touching pair, in either name order", () => {
  const facts = twoBoxFacts({ gaps: [{ a: "left", b: "right", distance: 0, at: [10, 5, 5] }], nearMisses: [] });
  const checks = evaluateCase(facts, { profile: null, expect: { _view: { contacts: [["right", "left"]] } } });
  expect(pairCheck(checks, "contact").status).toBe("pass");
});

test("contacts passes on an overlapping pair (interpenetration is contact)", () => {
  const facts = twoBoxFacts({
    overlaps: [{ a: "left", b: "right", volume: 50, location: [10, 5, 5] }],
    gaps: [{ a: "left", b: "right", distance: 0.4, at: [10, 5, 5] }],  // contained-ish reading
    nearMisses: [],
  });
  const checks = evaluateCase(facts, { profile: null, expect: { _view: { contacts: [["left", "right"]] } } });
  expect(pairCheck(checks, "contact").status).toBe("pass");
});

test("clearance gates the measured pair distance with the assertion DSL", () => {
  const fail = evaluateCase(twoBoxFacts(), { profile: null, expect: { _view: { clearance: { "left×right": ">=0.3" } } } });
  expect(pairCheck(fail, "clearance").status).toBe("fail");
  expect(pairCheck(fail, "clearance").location).toEqual([10.1, 5, 5]);
  expect(pairCheck(fail, "nearMiss")).toBeUndefined();     // declared → no warning
  const ok = evaluateCase(twoBoxFacts({ gaps: [{ a: "left", b: "right", distance: 5, at: [12.5, 5, 5] }], nearMisses: [] }),
    { profile: null, expect: { _view: { clearance: { "left×right": ">=0.3" } } } });
  expect(pairCheck(ok, "clearance").status).toBe("pass");
});

test("clearance accepts { expr, hint } and surfaces the part-authored hint", () => {
  const checks = evaluateCase(twoBoxFacts(), { profile: null,
    expect: { _view: { clearance: { "left×right": { expr: ">=0.3", hint: "grow `gap`" } } } } });
  expect(pairCheck(checks, "clearance").hint).toBe("grow `gap`");
});

test("unknown sub-part names and malformed pair keys throw", () => {
  expect(() => evaluateCase(twoBoxFacts(), { profile: null, expect: { _view: { contacts: [["left", "wing"]] } } })).toThrow(/wing/);
  expect(() => evaluateCase(twoBoxFacts(), { profile: null, expect: { _view: { clearance: { "left+right": ">=0.3" } } } })).toThrow(/a×b/);
});

test("contact/clearance skip when facts carry no gap table (legacy facts)", () => {
  const facts = twoBoxFacts({ gaps: undefined, nearMisses: undefined });
  const checks = evaluateCase(facts, { profile: null,
    expect: { _view: { contacts: [["left", "right"]], clearance: { "left×right": ">=0.3" } } } });
  expect(pairCheck(checks, "contact").status).toBe("skip");
  expect(pairCheck(checks, "clearance").status).toBe("skip");
});

test("a declared pair MISSING from a present gap table fails loudly (empty sub-part mesh)", () => {
  // gaps exists but has no entry for the pair (meshGaps skips empty meshes) —
  // a declared gate must not silently skip, or verify.ok lies.
  const facts = twoBoxFacts({ gaps: [], nearMisses: [] });
  const checks = evaluateCase(facts, { profile: null,
    expect: { _view: { contacts: [["left", "right"]], clearance: { "left×right": ">=0.3" } } } });
  expect(pairCheck(checks, "contact").status).toBe("fail");
  expect(pairCheck(checks, "contact").message).toMatch(/no measured distance/);
  expect(pairCheck(checks, "contact").hint).toBeTruthy();
  expect(pairCheck(checks, "clearance").status).toBe("fail");
});

test("a flat (non-nested) contacts entry throws a clear shape error", () => {
  expect(() => evaluateCase(twoBoxFacts(), { profile: null, expect: { _view: { contacts: ["left", "right"] } } }))
    .toThrow(/\["a", "b"\] pair/);
});

import gapPart from "./fixtures/gap-part.js";

test("end-to-end: contacts gate fails on the real 0.2mm gap part", () => {
  const part = { ...gapPart, verify: { expect: { _view: { contacts: [["left", "right"]] } } } };
  const v = verify(k, part);
  expect(v.ok).toBe(false);
  const c = v.failures.find((f) => f.metric === "contact");
  expect(c.actual).toBeCloseTo(0.2, 4);
  expect(c.location[0]).toBeCloseTo(10.1, 3);
  expect(c.pattern).toBe("near-miss-gap");
});

test("end-to-end: undeclared near miss is a warning; verify still ok", () => {
  const v = verify(k, { ...gapPart, verify: { expect: {} } });
  expect(v.ok).toBe(true);
  expect(v.warnings.some((w) => w.metric === "nearMiss")).toBe(true);
});

test("end-to-end: declared clearance passes a separated pair", () => {
  const part = { ...gapPart, defaults: { gap: 5 }, verify: { expect: { _view: { clearance: { "left×right": ">=0.3" } } } } };
  const v = verify(k, part);
  expect(v.ok).toBe(true);
  expect(v.warnings.filter((w) => w.metric === "nearMiss")).toEqual([]);
});
