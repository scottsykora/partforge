import { expect, test } from "vitest";
import { evaluateCase } from "../src/testing/verify.js";
import { resolveProfile } from "../src/testing/dfm-profiles.js";

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

test("min-wall is a warn (pending SDF), never a fail", () => {
  const checks = evaluateCase(facts, { profile: resolveProfile("fdm-pla"), expect: {} });
  const w = byKey(checks, "subpart", "minWall");
  expect(w.kind).toBe("warn");
  expect(w.status).toBe("warn");
  expect(w.message).toMatch(/pending SDF/);
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
