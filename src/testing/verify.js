import { parseAssertion, evaluateAssertion } from "./assert-dsl.js";
import { measure as defaultMeasure } from "./measure.js";
import { CONTACT_EPS } from "./gaps.js";
import { resolveProfile } from "./dfm-profiles.js";
import { expandCases } from "./cases.js";
import { subPartReadKeys, relevanceHash, RELEVANT_ALL } from "../framework/param-deps.js";

// Metric registry: name → how to pull the value out of facts, whether a failure
// is a hard gate or a warning, and the diagnostics attached to a non-pass check:
// `hint` (required — the report contract promises one on every fail/warn),
// `pattern` (optional stable ERROR-PATTERNS.md#<id>), `locate` (optional
// [x,y,z] source). `manifoldOnly` facts are null on OCCT parts.
export const SUBPART_METRICS = {
  holes: { kind: "gate", manifoldOnly: true, extract: (s) => s.holes,
    hint: "genus is wrong — an unintended tunnel exists or an intended bore is blocked; make cut tools pierce fully (overcut past the faces)" },
  watertight: { kind: "gate", manifoldOnly: true, extract: (s) => s.watertight,
    hint: "a boolean produced an open shell — check for coplanar faces or a cut that exactly grazes a surface",
    pattern: "boolean-not-watertight" },
  volume: { kind: "gate", extract: (s) => s.volume,
    hint: "solid volume is out of range — a feature is missing, doubled, or a governing parameter is mis-scaled" },
  surfaceArea: { kind: "gate", extract: (s) => s.surfaceArea,
    hint: "surface area is out of range — detail features (facets, ribs, textures) are missing or doubled" },
  triangleCount: { kind: "gate", extract: (s) => s.triangleCount,
    hint: "triangle count is out of range — tessellation quality or feature count changed unexpectedly" },
  bbox: { kind: "gate", extract: (s) => s.bbox,
    hint: "bounding box is out of range — check the governing dimensions and the part's orientation" },
  minWall: { kind: "warn", extract: (s) => s.minWall,
    hint: "thinnest wall is at the reported location — increase the governing wall/thickness parameter or reduce the intersecting feature's depth",
    pattern: "minwall-sliver-triangles",
    locate: (s) => s.minWallAt },
};
export const VIEW_METRICS = {
  bbox: { kind: "gate", extract: (r) => r.aggregate.bbox,
    hint: "the assembled view exceeds its size limit — shrink the assembly or pick a process with a larger bed" },
  volume: { kind: "gate", extract: (r) => r.aggregate.volume,
    hint: "total assembly volume is out of range — a sub-part is missing, doubled, or mis-scaled" },
  overlaps: { kind: "gate", extract: (r) => r.overlaps.length,
    hint: "sub-parts interpenetrate near the reported location — adjust placement or add clearance in derive()",
    locate: (r) => r.overlaps[0]?.location ?? null },
};

// An expectation is a bare expression (string/number/boolean) or { expr, hint }.
const normalizeExpectation = (spec) =>
  spec !== null && typeof spec === "object" && !Array.isArray(spec) && "expr" in spec
    ? { expr: spec.expr, hint: spec.hint }
    : { expr: spec, hint: undefined };

const pairKey = (a, b) => [a, b].sort().join("×");

const PAIR_HINTS = {
  contact: "the pair should touch but doesn't — grow the joining feature or move the mating datum so the faces meet",
  clearance: "the pair's free-fit gap is out of the declared range — adjust the mating dimensions or the declared clearance",
  nearMiss: "sub-parts nearly touch here — if they should meet, declare the pair in verify.expect._view.contacts and close the gap; if a free fit is intended, declare it under clearance",
};

// Pair-wise view checks: `contacts` (must touch), `clearance` (assertion DSL vs
// the measured pair distance), and warnings for undeclared near misses. These are
// per-pair, so they live outside the scalar VIEW_METRICS registry but emit the
// same structured check objects.
function pairGapChecks(facts, { contacts, clearance }) {
  const checks = [];
  const declared = new Set();
  const names = new Set(facts.subparts.map((s) => s.name));
  const requireNames = (a, b, what) => {
    for (const n of [a, b]) if (!names.has(n)) throw new Error(`${what}: unknown sub-part "${n}" (view has: ${[...names].join(", ")})`);
  };
  const gapFor = (a, b) => facts.gaps?.find((g) => pairKey(g.a, g.b) === pairKey(a, b));

  for (const [a, b] of contacts ?? []) {
    requireNames(a, b, "contacts");
    declared.add(pairKey(a, b));
    const base = { scope: "view", subpart: `${a}×${b}`, metric: "contact", kind: "gate", expr: "touching" };
    const g = gapFor(a, b);
    if (!g) { checks.push({ ...base, actual: null, status: "skip", pass: null, message: "unavailable" }); continue; }
    const overlapping = (facts.overlaps ?? []).some((o) => pairKey(o.a, o.b) === pairKey(a, b));
    if (overlapping || g.distance <= CONTACT_EPS) {
      checks.push({ ...base, actual: g.distance, status: "pass", pass: true, message: overlapping ? "in contact (overlapping)" : "in contact" });
    } else {
      checks.push({ ...base, actual: g.distance, status: "fail", pass: false,
        message: `${g.distance.toFixed(3)}mm apart, expected touching`,
        hint: PAIR_HINTS.contact, pattern: "near-miss-gap", location: g.at });
    }
  }

  for (const [key, spec] of Object.entries(clearance ?? {})) {
    const pair = key.split("×").map((s) => s.trim());
    if (pair.length !== 2 || !pair[0] || !pair[1]) throw new Error(`clearance: pair key must be "a×b", got "${key}"`);
    const [a, b] = pair;
    requireNames(a, b, "clearance");
    declared.add(pairKey(a, b));
    const { expr, hint: partHint } = normalizeExpectation(spec);
    const base = { scope: "view", subpart: `${a}×${b}`, metric: "clearance", kind: "gate", expr: String(expr) };
    const g = gapFor(a, b);
    if (!g) { checks.push({ ...base, actual: null, status: "skip", pass: null, message: "unavailable" }); continue; }
    const { pass, message } = evaluateAssertion(parseAssertion(expr), g.distance);
    const out = { ...base, actual: g.distance, status: pass ? "pass" : "fail", pass, message };
    if (!pass) { out.hint = partHint ?? PAIR_HINTS.clearance; out.pattern = "near-miss-gap"; out.location = g.at; }
    checks.push(out);
  }

  for (const g of facts.nearMisses ?? []) {
    if (declared.has(pairKey(g.a, g.b))) continue;
    checks.push({ scope: "view", subpart: `${g.a}×${g.b}`, metric: "nearMiss", kind: "warn",
      expr: "intent undeclared", actual: g.distance, status: "warn", pass: false,
      message: `${g.distance.toFixed(3)}mm gap`, hint: PAIR_HINTS.nearMiss,
      pattern: "near-miss-gap", location: g.at });
  }
  return checks;
}

function check(scope, subpart, metric, spec, registry, factsObj) {
  const reg = registry[metric];
  if (!reg) throw new Error(`unknown ${scope} metric "${metric}"${subpart ? ` on sub-part "${subpart}"` : ""}`);
  const { expr, hint: partHint } = normalizeExpectation(spec);
  const actual = reg.extract(factsObj);
  const base = { scope, subpart, metric, kind: reg.kind, expr: String(expr) };
  if (actual === null || actual === undefined) {
    if (reg.manifoldOnly) return { ...base, actual, status: "skip", pass: null, message: "n/a (OCCT backend)" };
    if (metric === "minWall") {
      return { ...base, actual, status: "warn", pass: null, message: "min wall unavailable",
        hint: partHint ?? "no min-wall reading for this mesh — treat thin features as unverified" };
    }
    return { ...base, actual, status: "skip", pass: null, message: "unavailable" };
  }
  const { pass, message } = evaluateAssertion(parseAssertion(expr), actual);
  const status = pass ? "pass" : reg.kind === "warn" ? "warn" : "fail";
  const out = { ...base, actual, status, pass, message };
  if (!pass) {
    out.hint = partHint ?? reg.hint;
    if (reg.pattern) out.pattern = reg.pattern;
    const loc = reg.locate?.(factsObj);
    if (loc) out.location = loc;
  }
  return out;
}

// Pure policy: profile rules + per-part expect → checks for one case's facts.
export function evaluateCase(facts, { profile, expect }) {
  const checks = [];
  // contacts/clearance are per-pair, not scalar view metrics — peel them off
  // before the registry loop and hand them to pairGapChecks.
  const { contacts, clearance, ...viewScalarExp } = expect?._view ?? {};
  const viewExp = {
    ...(profile?.bed ? { bbox: `<=[${profile.bed.join(",")}]` } : {}),
    ...viewScalarExp,
  };
  for (const [metric, expr] of Object.entries(viewExp)) checks.push(check("view", null, metric, expr, VIEW_METRICS, facts));
  checks.push(...pairGapChecks(facts, { contacts, clearance }));

  for (const s of facts.subparts) {
    const merged = {
      ...(profile?.minWall != null ? { minWall: `>=${profile.minWall}` } : {}),
      ...(expect?.[s.name] ?? {}),
    };
    for (const [metric, expr] of Object.entries(merged)) checks.push(check("subpart", s.name, metric, expr, SUBPART_METRICS, s));
  }
  return checks;
}

export function verify(kernel, part, { process, view, measureFn = defaultMeasure } = {}) {
  view = view ?? Object.keys(part.views)[0];
  const profileSpec = process ?? part.verify?.process;
  const profile = profileSpec ? resolveProfile(profileSpec) : null;
  const expect = part.verify?.expect ?? {};
  const expectMentionsMinWall = Object.values(expect).some((o) => o && typeof o === "object" && "minWall" in o);
  const needMinWall = profile?.minWall != null || expectMentionsMinWall;

  const cases = expandCases(part);
  const readKeys = subPartReadKeys(part, view, part.defaults);
  const signature = (params) =>
    readKeys === RELEVANT_ALL
      ? JSON.stringify(params)
      : [...readKeys.entries()].map(([name, keys]) => `${name}:${relevanceHash([...keys], params)}`).join("|");

  const memo = new Map();
  const measureCase = (params) => {
    const key = signature(params);
    if (!memo.has(key)) memo.set(key, measureFn(kernel, part, view, params, { minWall: needMinWall }));
    return memo.get(key);
  };

  const caseResults = cases.map(({ name, params }) => ({ name, params, checks: evaluateCase(measureCase(params), { profile, expect }) }));
  const all = caseResults.flatMap((c) => c.checks.map((ch) => ({ case: c.name, ...ch })));
  return {
    ok: !all.some((c) => c.status === "fail"),
    view,
    cases: caseResults,
    failures: all.filter((c) => c.status === "fail"),
    warnings: all.filter((c) => c.status === "warn"),
  };
}
