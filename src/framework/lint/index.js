// partforge/lint — static PartDefinition validation. Pure: no I/O, no async, and
// (load-bearing) an import closure that never reaches three / manifold-3d / replicad,
// so this runs unchanged in Node, a browser sandbox iframe, and Deno. The purity
// guarantee is enforced by test/lint-purity.test.js — read it before adding an import.
//
// A rule is { id, run(ctx) → Finding[] }, one rule object per finding id, so the
// registry doubles as the documented rule catalog. Rules are cheap and parts are
// tiny; clarity beats sharing a walk between rules.
import { resolveDerived } from "../derive.js";
import { warn } from "./finding.js";
import { SHAPE_RULES } from "./rules-shape.js";
import { SCHEMA_RULES } from "./rules-schema.js";
import { runValidatingProbe } from "../geometry/probe.js";
import { BUILD_RULES } from "./rules-build.js";

export const RULES = [...SHAPE_RULES, ...SCHEMA_RULES, ...BUILD_RULES];

// Every rule runs inside a guard. lintPart is called on a user-facing hosted path
// (partforge-cloud's sandbox), and a linter that takes down the preview it exists to
// protect is worse than no linter — so a throwing rule becomes a WARNING, never an
// error, and never blocks a part that would otherwise have built.
export function runRules(rules, ctx) {
  const out = [];
  for (const rule of rules) {
    try {
      const found = rule.run(ctx);
      if (Array.isArray(found)) out.push(...found);
    } catch (e) {
      out.push(warn("internal-rule-error",
        `lint rule "${rule.id}" threw: ${e?.message || String(e)}`,
        "This is a partforge bug rather than a problem with your part; every other rule still ran. Please report it with the part that triggered it."));
    }
  }
  return out;
}

// Build the shared context. A throwing derive() must not abort the lint — the
// `derive-throws` condition is reported by Group 3's build rules, and Groups 1/2/4
// remain useful without derived values.
export function lintContext(part, params) {
  const p = { ...(part?.defaults ?? {}), ...(params ?? {}) };
  let d = {};
  try { d = resolveDerived(part, p) ?? {}; } catch { d = {}; }
  let cached = null;
  const probe = () => (cached ??= runValidatingProbe(part, p, d));
  const probeAgain = () => runValidatingProbe(part, p, d);
  return { part, p, d, probe, probeAgain };
}

/**
 * Lint a PartDefinition. Never throws.
 * @param {object} part   the default-exported PartDefinition
 * @param {{params?: object}} [opts]  params layered over part.defaults for the probe pass
 * @returns {{ok: boolean, errors: object[], warnings: object[]}}
 */
export function lintPart(part, { params } = {}) {
  const findings = runRules(RULES, lintContext(part, params));
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  return { ok: errors.length === 0, errors, warnings };
}
