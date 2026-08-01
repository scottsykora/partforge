import { parseAssertion, evaluateAssertion } from "./assert-dsl.js";
import { measure as defaultMeasure } from "./measure.js";
import { pairKey, CONTACT_EPS } from "./gaps.js";
import { resolveProfile } from "./dfm-profiles.js";
import { expandCases } from "./cases.js";
import { subPartReadKeys, relevanceHash, RELEVANT_ALL } from "../framework/param-deps.js";
import { resolveParams } from "../framework/jobs.js";
import { SUBPART_METRICS, VIEW_METRICS } from "../framework/verify-metrics.js";

// Re-exported for backwards compatibility: the registries moved to framework/ so
// the linter can read the metric vocabulary without importing a geometry kernel.
export { SUBPART_METRICS, VIEW_METRICS };

// An expectation is a bare expression (string/number/boolean) or { expr, hint }.
const normalizeExpectation = (spec) =>
  spec !== null && typeof spec === "object" && !Array.isArray(spec) && "expr" in spec
    ? { expr: spec.expr, hint: spec.hint }
    : { expr: spec, hint: undefined };

const PAIR_HINTS = {
  contact: "the pair should touch but doesn't — grow the joining feature or move the mating datum so the faces meet",
  clearance: "the pair's free-fit gap is out of the declared range — adjust the mating dimensions or the declared clearance",
  nearMiss: "sub-parts nearly touch here — if they should meet, declare the pair in verify.expect._view.contacts and close the gap; if a free fit is intended, declare it under clearance",
};

// Pair-wise view checks: `contacts` (must touch), `clearance` (assertion DSL vs
// the measured pair distance), and warnings for undeclared near misses. These are
// per-pair, so they live outside the scalar VIEW_METRICS registry but emit the
// same structured check objects.
function pairGapChecks(facts, { contacts, clearance }, subPartNames) {
  const checks = [];
  const declared = new Set();
  const names = new Set(facts.subparts.map((s) => s.name));
  // The part's full sub-part vocabulary (when the caller knows it): a declared
  // name absent from THIS case's facts but present in the part is an
  // enabled()-gated sub-part that is off for this case → skip, don't throw.
  // A name in neither set is a typo → throw. Without the vocabulary (bare
  // evaluateCase callers) the case's own names are the vocabulary.
  const known = subPartNames ? new Set(subPartNames) : names;
  const requirePair = (a, b, what) => {
    if (a === b) throw new Error(`${what}: a pair must name two different sub-parts, got ["${a}", "${b}"]`);
    let absent = false;
    for (const n of [a, b]) {
      if (names.has(n)) continue;
      if (!known.has(n)) throw new Error(`${what}: unknown sub-part "${n}" (view has: ${[...names].join(", ")})`);
      absent = true;
    }
    return absent; // true = valid pair, but a sub-part is disabled in this case
  };
  const gapFor = (a, b) => facts.gaps?.find((g) => pairKey(g.a, g.b) === pairKey(a, b));
  const disabledSkip = (base) => ({ ...base, actual: null, status: "skip", pass: null, message: "sub-part disabled in this case" });
  // No gap table at all = legacy facts → skip. A table that MERELY LACKS the pair
  // = the sub-part built empty (meshGaps skips empty meshes) → a declared gate
  // must fail loudly, not skip, or verify.ok would vouch for an unverified pair.
  const noReading = (base) => (facts.gaps
    ? { ...base, actual: null, status: "fail", pass: false,
        message: "no measured distance for the pair",
        hint: "one sub-part produced no mesh (an empty solid?) — fix the build before trusting this gate" }
    : { ...base, actual: null, status: "skip", pass: null, message: "unavailable" });

  if (contacts != null && !Array.isArray(contacts)) {
    throw new Error(`contacts: must be an array of ["a", "b"] pairs, got ${JSON.stringify(contacts)}`);
  }
  for (const pair of contacts ?? []) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new Error(`contacts: each entry must be an ["a", "b"] pair, got ${JSON.stringify(pair)}`);
    }
    const [a, b] = pair;
    const disabled = requirePair(a, b, "contacts");
    declared.add(pairKey(a, b));
    const base = { scope: "view", subpart: `${a}×${b}`, metric: "contact", kind: "gate", expr: "touching" };
    if (disabled) { checks.push(disabledSkip(base)); continue; }
    const g = gapFor(a, b);
    if (!g) { checks.push(noReading(base)); continue; }
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
    const disabled = requirePair(a, b, "clearance");
    declared.add(pairKey(a, b));
    const { expr, hint: partHint } = normalizeExpectation(spec);
    const base = { scope: "view", subpart: `${a}×${b}`, metric: "clearance", kind: "gate", expr: String(expr) };
    if (disabled) { checks.push(disabledSkip(base)); continue; }
    const g = gapFor(a, b);
    if (!g) { checks.push(noReading(base)); continue; }
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
  // A measurement caveat rides along whatever the verdict — a min-wall reading
  // taken from a sample still passed, but the reader should know it was a sample.
  const note = reg.note?.(factsObj);
  if (note) out.note = note;
  if (!pass) {
    out.hint = partHint ?? reg.hint;
    if (reg.pattern) out.pattern = reg.pattern;
    const loc = reg.locate?.(factsObj);
    if (loc) out.location = loc;
  }
  return out;
}

// Pure policy: profile rules + per-part expect → checks for one case's facts.
export function evaluateCase(facts, { profile, expect, subPartNames }) {
  const checks = [];
  // contacts/clearance are per-pair, not scalar view metrics — peel them off
  // before the registry loop and hand them to pairGapChecks.
  const { contacts, clearance, ...viewScalarExp } = expect?._view ?? {};
  const viewExp = {
    ...(profile?.bed ? { bbox: `<=[${profile.bed.join(",")}]` } : {}),
    ...viewScalarExp,
  };
  for (const [metric, expr] of Object.entries(viewExp)) checks.push(check("view", null, metric, expr, VIEW_METRICS, facts));
  checks.push(...pairGapChecks(facts, { contacts, clearance }, subPartNames));

  for (const s of facts.subparts) {
    const merged = {
      ...(profile?.minWall != null ? { minWall: `>=${profile.minWall}` } : {}),
      ...(expect?.[s.name] ?? {}),
    };
    for (const [metric, expr] of Object.entries(merged)) checks.push(check("subpart", s.name, metric, expr, SUBPART_METRICS, s));
  }
  return checks;
}

// `seed` lets a caller that has ALREADY measured this part hand the result in so
// verify does not recompute it — see the seeding block below for the shape and
// the one correctness rule that governs it.
export function verify(kernel, part, { process, view, measureFn = defaultMeasure, seed } = {}) {
  view = view ?? Object.keys(part.views)[0];
  const profileSpec = process ?? part.verify?.process;
  const profile = profileSpec ? resolveProfile(profileSpec) : null;
  const expectSpec = part.verify?.expect ?? {};

  const cases = expandCases(part);
  // `expect` can be a pure function of the case's resolved params — (p, d) →
  // expect object — so topology that legitimately changes with a preset (an
  // optional drain or bore flipping the genus) can be pinned per case instead
  // of one static number that some presets must violate.
  const resolveExpect = (params) => {
    if (typeof expectSpec !== "function") return expectSpec;
    const { p, d } = resolveParams(part, params);
    return expectSpec(p, d) ?? {};
  };
  const expanded = cases.map((c) => ({ ...c, expect: resolveExpect(c.params) }));
  const expectMentionsMinWall = expanded.some(({ expect }) =>
    Object.values(expect).some((o) => o && typeof o === "object" && "minWall" in o));
  const needMinWall = profile?.minWall != null || expectMentionsMinWall;
  const readKeys = subPartReadKeys(part, view, part.defaults);
  const signature = (params) =>
    readKeys === RELEVANT_ALL
      ? JSON.stringify(params)
      : [...readKeys.entries()].map(([name, keys]) => `${name}:${relevanceHash([...keys], params)}`).join("|");

  const memo = new Map();

  // SEEDING. expandCases always yields a "defaults" case, and the inspect job
  // (framework/jobs.js) measures those exact params immediately before calling
  // verify — so without this the oracle rebuilds the same geometry, casts the
  // same min-wall rays and re-indexes the same meshes a second time. On a
  // single-case part that is half the job.
  //   seed = { params, minWall, result } — the params the result was measured
  //   with, whether that measurement included min-wall, and the measure() output.
  //
  // THE MIN-WALL SUPERSET RULE, which is the trap here. measureCase asks for
  // `{ minWall: needMinWall }`, and needMinWall is false whenever no profile and
  // no expectation mentions min wall. A result measured WITH min wall is a strict
  // superset of one measured without: the extra fields are only ever read by the
  // minWall metric, which by definition this run never checks. Reuse in that
  // direction is free. The reverse is NOT safe — a seed taken without min wall
  // carries `minWall: null` on every sub-part, which the registry reports as
  // "min wall unavailable", silently downgrading a real gate to a warning. So the
  // seed must declare what it included, and it is consulted only when
  // `seed.minWall || !needMinWall`; otherwise it is ignored and the case is
  // measured properly.
  //
  // Keyed through the SAME signature() the memo uses, never a JSON compare of the
  // raw params — a separate compare would miss cases that share a signature (a
  // preset touching only params the build never reads) and, worse, could hit on
  // params that merely look equal. The seed's params are layered over
  // part.defaults first because a caller's `{}` and the defaults case's
  // `{...part.defaults}` build identical geometry but hash differently
  // (JSON.stringify({}) is not JSON.stringify(defaults), and relevanceHash reads
  // params[k] straight through). The view is checked too: measure()'s output is
  // per-view, and a seed from another view would be a silent wrong answer.
  //
  // Non-default measure options (a custom `gapThreshold`) are the caller's
  // responsibility: seed only a measurement taken the way verify would take it.
  if (seed?.result && (seed.minWall || !needMinWall) && seed.result.view === view) {
    memo.set(signature({ ...part.defaults, ...(seed.params ?? {}) }), seed.result);
  }

  const measureCase = (params) => {
    const key = signature(params);
    if (!memo.has(key)) memo.set(key, measureFn(kernel, part, view, params, { minWall: needMinWall }));
    return memo.get(key);
  };

  const subPartNames = Object.keys(part.parts);
  const caseResults = expanded.map(({ name, params, expect }) => ({ name, params, checks: evaluateCase(measureCase(params), { profile, expect, subPartNames }) }));
  const all = caseResults.flatMap((c) => c.checks.map((ch) => ({ case: c.name, ...ch })));
  return {
    ok: !all.some((c) => c.status === "fail"),
    view,
    cases: caseResults,
    failures: all.filter((c) => c.status === "fail"),
    warnings: all.filter((c) => c.status === "warn"),
  };
}
