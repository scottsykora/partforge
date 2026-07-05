import { parseAssertion, evaluateAssertion } from "./assert-dsl.js";
import { measure as defaultMeasure } from "./measure.js";
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
    hint: "sub-parts interpenetrate at the reported location — adjust placement or add clearance in derive()",
    locate: (r) => r.overlaps[0]?.location ?? null },
};

// An expectation is a bare expression (string/number/boolean) or { expr, hint }.
const normalizeExpectation = (spec) =>
  spec !== null && typeof spec === "object" && !Array.isArray(spec) && "expr" in spec
    ? { expr: spec.expr, hint: spec.hint }
    : { expr: spec, hint: undefined };

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
  const viewExp = {
    ...(profile?.bed ? { bbox: `<=[${profile.bed.join(",")}]` } : {}),
    ...(expect?._view ?? {}),
  };
  for (const [metric, expr] of Object.entries(viewExp)) checks.push(check("view", null, metric, expr, VIEW_METRICS, facts));

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
