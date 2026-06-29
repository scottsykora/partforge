import { parseAssertion, evaluateAssertion } from "./assert-dsl.js";
import { measure as defaultMeasure } from "./measure.js";
import { resolveProfile } from "./dfm-profiles.js";
import { expandCases } from "./cases.js";
import { subPartReadKeys, relevanceHash, RELEVANT_ALL } from "../framework/param-deps.js";

// Metric registry: name → how to pull the value out of facts, and whether a failure
// is a hard gate or a warning. `manifoldOnly` facts are null on OCCT parts.
const SUBPART_METRICS = {
  holes: { kind: "gate", manifoldOnly: true, extract: (s) => s.holes },
  watertight: { kind: "gate", manifoldOnly: true, extract: (s) => s.watertight },
  volume: { kind: "gate", extract: (s) => s.volume },
  surfaceArea: { kind: "gate", extract: (s) => s.surfaceArea },
  triangleCount: { kind: "gate", extract: (s) => s.triangleCount },
  bbox: { kind: "gate", extract: (s) => s.bbox },
  minWall: { kind: "warn", extract: (s) => s.minWall },
};
const VIEW_METRICS = {
  bbox: { kind: "gate", extract: (r) => r.aggregate.bbox },
  volume: { kind: "gate", extract: (r) => r.aggregate.volume },
  overlaps: { kind: "gate", extract: (r) => r.overlaps.length },
};

function check(scope, subpart, metric, expr, registry, factsObj) {
  const reg = registry[metric];
  if (!reg) throw new Error(`unknown ${scope} metric "${metric}"${subpart ? ` on sub-part "${subpart}"` : ""}`);
  const actual = reg.extract(factsObj);
  const base = { scope, subpart, metric, kind: reg.kind, expr: String(expr) };
  if (actual === null || actual === undefined) {
    if (reg.manifoldOnly) return { ...base, actual, status: "skip", pass: null, message: "n/a (OCCT backend)" };
    if (metric === "minWall") return { ...base, actual, status: "warn", pass: null, message: "min wall unavailable" };
    return { ...base, actual, status: "skip", pass: null, message: "unavailable" };
  }
  const { pass, message } = evaluateAssertion(parseAssertion(expr), actual);
  const status = pass ? "pass" : reg.kind === "warn" ? "warn" : "fail";
  return { ...base, actual, status, pass, message };
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
  const needMinWall = profile?.minWall != null || JSON.stringify(expect).includes("minWall");

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
