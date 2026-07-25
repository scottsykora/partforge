// Group 4 — the verify block's own well-formedness. Each condition here currently
// throws from verify() mid-run, AFTER measure has printed and the kernel has booted,
// which is also the documented reason CLI stdout isn't pure JSON in that case.
// Catching them statically removes both the wasted boot and the stdout caveat.
import { err } from "./finding.js";
import { SUBPART_METRICS, VIEW_METRICS } from "../verify-metrics.js";
import { PROFILES } from "../../testing/dfm-profiles.js";
import { parseAssertion } from "../../testing/assert-dsl.js";
import { suggest } from "../geometry/op-options.js";

// Resolve `expect` to a plain object. The function form (p, d) => ({…}) is invoked
// once with the probe's params so per-preset topology can be linted like any other.
// Returns { expect, threw }.
//
// Exported so `lintContext` (index.js) can memoize a single call per lint pass and
// share it across every Group 4 rule below — `expect` is user-supplied code, and
// without memoization a function-form `expect` that throws only on its first call
// would fire both `verify-expect-throws` (first call) and whatever rule calls it
// next (second call succeeds), a cascading double-report.
export function resolveExpect(verify, p, d) {
  if (typeof verify?.expect !== "function") return { expect: verify?.expect, threw: null };
  try { return { expect: verify.expect(p, d), threw: null }; }
  catch (e) { return { expect: null, threw: e?.message || String(e) }; }
}

const isExpectation = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && "expr" in v;
const exprOf = (v) => (isExpectation(v) ? v.expr : v);

// `contacts` (must-touch pairs) and `clearance` (free-fit gaps) live under
// `verify.expect._view` but are pair-wise checks, not scalar VIEW_METRICS — mirror
// verify.js's own peel (verify.js:143) so they never hit the scalar-metric /
// assertion-expression checks below. Validated for real by `verify-bad-pair-check`.
const peelPairKeys = (metrics) => {
  const { contacts, clearance, ...rest } = metrics;
  return rest;
};

// `JSON.stringify` can itself throw (BigInt, circular refs) — lintPart must never
// throw, so fall back to `String` for anything that won't serialize.
const describe = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

// `suggest` calls `.toLowerCase()` on the key; guard against non-string pair names
// (a runtime `contacts`/`clearance` entry can contain anything).
const safeSuggest = (key, valid) => (typeof key === "string" ? suggest(key, valid) : null);

// Both `contacts` pairs and `clearance` keys ultimately name two sub-parts; a name
// absent from `part.parts` is what the runtime `requirePair` throws for.
function checkPairNames(a, b, names, path) {
  const out = [];
  for (const n of [a, b]) {
    if (names.includes(n)) continue;
    const hint = safeSuggest(n, names);
    out.push(err("verify-unknown-subpart",
      `\`${path}\` references "${n}", which is not a sub-part`,
      `Use one of the sub-part names (${names.join(", ")})${hint ? ` — did you mean "${hint}"?` : "."}`,
      path));
  }
  return out;
}

// Static analogue of verify.js's `pairGapChecks` contacts handling (verify.js:61-66).
function checkContacts(contacts, names, path) {
  if (contacts === undefined || contacts === null) return [];
  if (!Array.isArray(contacts)) {
    return [err("verify-bad-pair-check",
      `\`${path}\` must be an array of ["a", "b"] pairs, got ${describe(contacts)}`,
      `Set \`contacts\` to an array of two-element sub-part name pairs, e.g. \`contacts: [["lid", "body"]]\`.`,
      path)];
  }
  const out = [];
  contacts.forEach((pair, i) => {
    const pairPath = `${path}[${i}]`;
    if (!Array.isArray(pair) || pair.length !== 2) {
      out.push(err("verify-bad-pair-check",
        `\`${pairPath}\` must be an ["a", "b"] pair, got ${describe(pair)}`,
        `Each \`contacts\` entry must be a two-element array naming the two sub-parts that should touch, e.g. \`["lid", "body"]\`.`,
        pairPath));
      return;
    }
    out.push(...checkPairNames(pair[0], pair[1], names, pairPath));
  });
  return out;
}

// Static analogue of verify.js's `pairGapChecks` clearance handling (verify.js:85-87).
// Note the separator is the multiplication sign "×" (U+00D7), not the letter x.
function checkClearance(clearance, names, path) {
  if (clearance === undefined || clearance === null || typeof clearance !== "object") return [];
  const out = [];
  for (const key of Object.keys(clearance)) {
    const pairPath = `${path}[${JSON.stringify(key)}]`;
    const pair = key.split("×").map((s) => s.trim());
    if (pair.length !== 2 || !pair[0] || !pair[1]) {
      out.push(err("verify-bad-pair-check",
        `\`${pairPath}\` key must be "a×b" (sub-part names joined by the multiplication sign ×), got ${JSON.stringify(key)}`,
        `Rename the key to \`"a×b"\` using the two sub-part names that should have a declared clearance, e.g. \`"lid×body"\`. The separator is U+00D7 (×), not the letter x.`,
        pairPath));
      continue;
    }
    out.push(...checkPairNames(pair[0], pair[1], names, pairPath));
  }
  return out;
}

export const VERIFY_RULES = [
  {
    id: "verify-expect-throws",
    run: ({ resolveExpectOnce }) => {
      const { threw } = resolveExpectOnce();
      return threw ? [err("verify-expect-throws",
        `\`verify.expect(p, d)\` threw: ${threw}`,
        "The function form of `expect` must return an expectation object for any parameter set. Guard whatever it reads, or switch to the static object form.",
        "verify.expect")] : [];
    },
  },
  {
    id: "verify-unknown-subpart",
    run: ({ part, resolveExpectOnce }) => {
      const { expect } = resolveExpectOnce();
      if (!expect || typeof expect !== "object") return [];
      const names = Object.keys(part?.parts ?? {});
      return Object.keys(expect)
        .filter((key) => key !== "_view" && !names.includes(key))
        .map((key) => {
          const hint = suggest(key, names);
          return err("verify-unknown-subpart",
            `\`verify.expect\` targets "${key}", which is not a sub-part`,
            `Use one of the sub-part names (${names.join(", ")}) or the literal \`_view\` for whole-assembly metrics${hint ? ` — did you mean "${hint}"?` : "."}`,
            `verify.expect.${key}`);
        });
    },
  },
  {
    id: "verify-unknown-metric",
    run: ({ part, resolveExpectOnce }) => {
      const { expect } = resolveExpectOnce();
      if (!expect || typeof expect !== "object") return [];
      const names = Object.keys(part?.parts ?? {});
      const out = [];
      for (const [target, metricsRaw] of Object.entries(expect)) {
        if (target !== "_view" && !names.includes(target)) continue; // reported by verify-unknown-subpart
        if (!metricsRaw || typeof metricsRaw !== "object") continue;
        // contacts/clearance are pair checks, not scalar view metrics — validated
        // separately by verify-bad-pair-check, and excluded here.
        const metrics = target === "_view" ? peelPairKeys(metricsRaw) : metricsRaw;
        const registry = target === "_view" ? VIEW_METRICS : SUBPART_METRICS;
        const valid = Object.keys(registry);
        for (const metric of Object.keys(metrics)) {
          if (valid.includes(metric)) continue;
          const hint = suggest(metric, valid);
          out.push(err("verify-unknown-metric",
            `"${metric}" is not a ${target === "_view" ? "view" : "sub-part"} metric`,
            `Valid ${target === "_view" ? "view" : "sub-part"} metrics are: ${valid.join(", ")}${hint ? ` — did you mean "${hint}"?` : "."}`,
            `verify.expect.${target}.${metric}`));
        }
      }
      return out;
    },
  },
  {
    id: "verify-bad-expr",
    run: ({ resolveExpectOnce }) => {
      const { expect } = resolveExpectOnce();
      if (!expect || typeof expect !== "object") return [];
      const out = [];
      for (const [target, metricsRaw] of Object.entries(expect)) {
        if (!metricsRaw || typeof metricsRaw !== "object") continue;
        // contacts/clearance are pair checks, not scalar assertions — validated
        // separately by verify-bad-pair-check, and excluded here.
        const metrics = target === "_view" ? peelPairKeys(metricsRaw) : metricsRaw;
        for (const [metric, spec] of Object.entries(metrics)) {
          try { parseAssertion(exprOf(spec)); }
          catch (e) {
            out.push(err("verify-bad-expr",
              `the expectation for ${target}.${metric} is not a valid assertion: ${e?.message || String(e)}`,
              "Use the assertion DSL: a bare value for equality, a comparison like `>=3`, a range like `2..5`, or a componentwise vector like `<=[60,60,60]` (with `*` to skip an axis).",
              `verify.expect.${target}.${metric}`));
          }
        }
      }
      return out;
    },
  },
  {
    id: "verify-bad-pair-check",
    run: ({ part, resolveExpectOnce }) => {
      const { expect } = resolveExpectOnce();
      const view = expect?._view;
      if (!view || typeof view !== "object") return [];
      const names = Object.keys(part?.parts ?? {});
      return [
        ...checkContacts(view.contacts, names, "verify.expect._view.contacts"),
        ...checkClearance(view.clearance, names, "verify.expect._view.clearance"),
      ];
    },
  },
  {
    id: "verify-unknown-process",
    run: ({ part }) => {
      const process = part?.verify?.process;
      if (process === undefined || process === null) return [];
      if (typeof process === "object") return []; // an inline { bed, minWall, clearance } profile
      const valid = Object.keys(PROFILES);
      if (valid.includes(process)) return [];
      const hint = suggest(String(process), valid);
      return [err("verify-unknown-process",
        `\`verify.process\` names "${process}", which is not a known DFM profile`,
        `Use one of: ${valid.join(", ")}${hint ? ` — did you mean "${hint}"?` : ""}, or pass an inline profile object such as \`{ bed: [220, 220, 250], minWall: 1.2 }\`.`,
        "verify.process")];
    },
  },
];
