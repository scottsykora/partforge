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
function resolveExpect(verify, p, d) {
  if (typeof verify?.expect !== "function") return { expect: verify?.expect, threw: null };
  try { return { expect: verify.expect(p, d), threw: null }; }
  catch (e) { return { expect: null, threw: e?.message || String(e) }; }
}

const isExpectation = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && "expr" in v;
const exprOf = (v) => (isExpectation(v) ? v.expr : v);

export const VERIFY_RULES = [
  {
    id: "verify-expect-throws",
    run: ({ part, p, d }) => {
      const { threw } = resolveExpect(part?.verify, p, d);
      return threw ? [err("verify-expect-throws",
        `\`verify.expect(p, d)\` threw: ${threw}`,
        "The function form of `expect` must return an expectation object for any parameter set. Guard whatever it reads, or switch to the static object form.",
        "verify.expect")] : [];
    },
  },
  {
    id: "verify-unknown-subpart",
    run: ({ part, p, d }) => {
      const { expect } = resolveExpect(part?.verify, p, d);
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
    run: ({ part, p, d }) => {
      const { expect } = resolveExpect(part?.verify, p, d);
      if (!expect || typeof expect !== "object") return [];
      const names = Object.keys(part?.parts ?? {});
      const out = [];
      for (const [target, metrics] of Object.entries(expect)) {
        if (target !== "_view" && !names.includes(target)) continue; // reported by verify-unknown-subpart
        if (!metrics || typeof metrics !== "object") continue;
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
    run: ({ part, p, d }) => {
      const { expect } = resolveExpect(part?.verify, p, d);
      if (!expect || typeof expect !== "object") return [];
      const out = [];
      for (const [target, metrics] of Object.entries(expect)) {
        if (!metrics || typeof metrics !== "object") continue;
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
