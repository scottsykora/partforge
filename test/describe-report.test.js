import { expect, test } from "vitest";
import { DESCRIBE_LIMITS } from "../src/framework/oracle/describe/limits.js";
import { buildReport, compactDescribe, LOW_COVERAGE } from "../src/framework/oracle/describe/report.js";
import { buildHints } from "../src/framework/oracle/describe/hints.js";

const base = {
  source: { name: "scan", digest: "abc123", triangles: 24310, watertight: true },
  bounds: { min: [0,0,0], max: [60,40,12] },
  surfaces: [{ id: "s0", type: "plane", fit: { normal: [0,0,1], offset: 12, rms: 4e-4 }, area: 2100, faces: [1,2] }],
  arcs: [{ between: ["s0","s7"], convexity: "concave", kind: "circle", radius: 2.65, length: 16.6 }],
  features: [{ id: "f0", type: "throughHole", diameter: 5.3, depth: 12, confidence: 0.99,
               snapped: { diameter: { raw: 5.2996, to: 5.3, note: "M5 clearance (close fit)" } } }],
  patterns: [], symmetry: [],
  residual: { areaFraction: 0.012, regions: [] },
  score: { explainedArea: 0.988, explainedVolumeFraction: 0.99, xorFraction: 0.0019 },
  suggestion: { disclaimer: "x", params: [], steps: [] },
};

test("the full report states its coordinate frame explicitly", () => {
  expect(buildReport(base).frame.up).toBe("+Z");
});

test("raw and snapped values are both retained", () => {
  const f = buildReport(base).features[0];
  expect(f.snapped.diameter.raw).toBe(5.2996);
  expect(f.snapped.diameter.to).toBe(5.3);
});

test("arrays are capped and the report says so", () => {
  const many = { ...base, surfaces: Array.from({ length: 500 }, (_, i) => ({ ...base.surfaces[0], id: `s${i}` })) };
  const r = buildReport(many);
  expect(r.surfaces.length).toBe(DESCRIBE_LIMITS.MAX_SURFACES);
  expect(r.truncated.surfaces).toBe(true);
});

test("an uncapped report reports truncated:false for every array", () => {
  const r = buildReport(base);
  expect(Object.values(r.truncated).every((v) => v === false)).toBe(true);
});

test("the compact report elides surfaces and edges to counts", () => {
  const c = compactDescribe(buildReport(base));
  expect(c.surfaces).toBeUndefined();
  expect(c.counts.surfaces).toBe(1);
  expect(c.counts.edges).toBe(1);
});

test("the compact report keeps features, patterns, score and residual", () => {
  const c = compactDescribe(buildReport(base));
  expect(c.features.length).toBe(1);
  expect(c.score.explainedArea).toBe(0.988);
  expect(c.residual.areaFraction).toBe(0.012);
});

test("low coverage raises a loud banner at the top of the compact report", () => {
  const poor = { ...base, score: { explainedArea: 0.61, explainedVolumeFraction: 0.5, xorFraction: 0.4 } };
  const c = compactDescribe(buildReport(poor));
  expect(c.warning).toMatch(/LOW COVERAGE/);
  expect(c.warning).toMatch(/incomplete/i);
});

test("good coverage carries no banner", () => {
  expect(compactDescribe(buildReport(base)).warning).toBeUndefined();
});

test("LOW_COVERAGE is the documented threshold", () => {
  expect(LOW_COVERAGE).toBe(0.85);
});

// --- fix round 1 regressions -------------------------------------------------------

test("the banner gates on the WORSE of area and volume coverage (hemisphere case): a " +
     "surface that segments cleanly but reconstructs to nothing still fires it", () => {
  // A 2304-triangle hemisphere against the real pipeline: one sphere surface plus one
  // flat base segments with explainedArea 1.0 (zero unassigned triangles) but sphere
  // is not a candidate-eligible type for any of the four feature detectors, so
  // accept.js is handed zero candidates and explainedVolumeFraction is 0.0. Gating on
  // explainedArea alone let this present as a clean report.
  const hemisphere = {
    ...base,
    features: [],
    score: { explainedArea: 1.0, explainedVolumeFraction: 0.0, xorFraction: 1.0 },
  };
  const c = compactDescribe(buildReport(hemisphere));
  expect(c.warning).toMatch(/LOW COVERAGE/);
});

test("the banner serializes FIRST: it precedes every other key in both Object.keys " +
     "and round-tripped JSON", () => {
  const poor = { ...base, score: { explainedArea: 0.5, explainedVolumeFraction: 0.4, xorFraction: 0.5 } };
  const c = compactDescribe(buildReport(poor));
  expect(Object.keys(c)[0]).toBe("warning");
  expect(Object.keys(JSON.parse(JSON.stringify(c)))[0]).toBe("warning");
});

// --- fix round 2, IMPORTANT 1: budget-exceeded was silently dropped ----------------
//
// describe.js sets `report.warning = "budget-exceeded"` directly on the object
// buildReport() returns (not through an input field — buildReport's own shape has no
// `warning` key), so these tests reproduce that by mutating the built report the same
// way, rather than adding a `warning` field to `base`/`buildReport`'s input contract.

test("a budget-exceeded report raises its own banner even when coverage is good", () => {
  const r = buildReport(base); // `base`'s score is 0.988/0.99 — well above LOW_COVERAGE
  r.warning = "budget-exceeded";
  const c = compactDescribe(r);
  expect(c.warning).toMatch(/BUDGET EXCEEDED/);
  expect(c.warning).not.toMatch(/LOW COVERAGE/);
});

test("low coverage and budget-exceeded are independent and both show when both fire " +
     "— neither is allowed to mask the other", () => {
  const poor = { ...base, score: { explainedArea: 0.61, explainedVolumeFraction: 0.5, xorFraction: 0.4 } };
  const r = buildReport(poor);
  r.warning = "budget-exceeded";
  const c = compactDescribe(r);
  expect(c.warning).toMatch(/LOW COVERAGE/);
  expect(c.warning).toMatch(/BUDGET EXCEEDED/);
});

test("no budget-exceeded warning on a report that never set one", () => {
  const r = buildReport(base);
  expect(r.warning).toBeUndefined();
  expect(compactDescribe(r).warning).toBeUndefined();
});

test("counts report pre-cap magnitudes, not the length of the capped array", () => {
  const many = { ...base, surfaces: Array.from({ length: 500 }, (_, i) => ({ ...base.surfaces[0], id: `s${i}` })) };
  const c = compactDescribe(buildReport(many));
  expect(c.counts.surfaces).toBe(500);
});

test("truncated carries every flag, false, even when there is no suggestion yet", () => {
  const noSuggestion = { ...base, suggestion: null };
  const r = buildReport(noSuggestion);
  expect(r.truncated).toEqual({
    surfaces: false, edges: false, features: false, patterns: false,
    residualRegions: false, suggestionSteps: false,
  });
});

test("score is self-describing: a note distinguishes area coverage from volume coverage", () => {
  const r = buildReport(base);
  expect(r.score.note).toMatch(/explainedArea/);
  expect(r.score.note).toMatch(/explainedVolumeFraction/);
});

// --- hints layer -----------------------------------------------------------
const accepted = [
  { candidate: { key: "extrusion:5:s0", featureKey: "extrusion:5:s0", op: "union", hintOp: "box",
                 explains: ["f0"], hintArgs: { shape: "polygon" } }, gain: 0.94, order: 0 },
  { candidate: { key: "hole:5.3:a", featureKey: "hole:5.3:a", op: "cut", explains: ["f1"],
                 dimension: 5.3, paramName: "holeDia", hintArgs: {} }, gain: 0.02, order: 1 },
  { candidate: { key: "hole:5.3:b", featureKey: "hole:5.3:b", op: "cut", explains: ["f2"],
                 dimension: 5.3, paramName: "holeDia", hintArgs: {} }, gain: 0.02, order: 2 },
];
const patterns = [{ id: "p0", type: "grid", members: ["hole:5.3:a", "hole:5.3:b"], counts: [2, 1], pitch: [50] }];

test("hint steps come out in acceptance order", () => {
  const h = buildHints(accepted, [], base.bounds);
  expect(h.steps.map((s) => s.op)).toEqual(["box", "cut", "cut"]);
});

test("a pattern's members collapse into a single hint step", () => {
  const h = buildHints(accepted, patterns, base.bounds);
  expect(h.steps.length).toBe(2);
  expect(h.steps[1].pattern).toBe("p0");
});

test("the hints layer labels itself as an interpretation, not a measurement", () => {
  expect(buildHints(accepted, patterns, base.bounds).disclaimer).toMatch(/not measurement/i);
});

test("hint params are derived from bounds and carry their provenance", () => {
  const h = buildHints(accepted, patterns, base.bounds);
  const width = h.params.find((p) => p.name === "width");
  expect(width.value).toBe(60);
  expect(width.from).toBe("bounds.size[0]");
});

test("hint step scores are the acceptance gains", () => {
  const h = buildHints(accepted, [], base.bounds);
  expect(h.steps[0].score).toBe(0.94);
});

test("two distinct-valued candidates sharing a fallback param name both survive, suffixed", () => {
  // Neither candidate sets `paramName`, so both fall back to `c.key.split(":")[0]`,
  // which is "hole" for both — but they carry different diameters and are not covered
  // by a pattern. The second must not be silently dropped (fix round 1, MINOR).
  const collision = [
    { candidate: { key: "hole:4:a", featureKey: "hole:4:a", op: "cut", explains: ["f1"], dimension: 4, hintArgs: {} }, gain: 0.5, order: 0 },
    { candidate: { key: "hole:6:b", featureKey: "hole:6:b", op: "cut", explains: ["f2"], dimension: 6, hintArgs: {} }, gain: 0.3, order: 1 },
  ];
  const h = buildHints(collision, [], base.bounds);
  const holeParams = h.params.filter((p) => p.name === "hole" || p.name === "hole_2");
  expect(holeParams.length).toBe(2);
  expect(holeParams.map((p) => p.value).sort((a, b) => a - b)).toEqual([4, 6]);
});
