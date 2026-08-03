// partforge/lint — static PartDefinition validation.
//
// Zero runtime dependencies: it never imports a geometry kernel or the DOM
// viewer, so it runs unchanged in Node, a Web Worker, a sandboxed iframe, and
// Deno.

import type { Derived, PartDefinition, ResolvedParams } from "./part.js";

/**
 * `error` = the part is provably broken (it cannot behave as authored, whether
 * or not that surfaces as a throw). `warning` = suspicious or lossy, but the
 * part behaves as authored; a warning never blocks anything. `note` = neither
 * broken nor suspicious — informational context for an authoring agent (e.g.
 * "this animated track rebuilds geometry"); notes never gate `measure` or
 * `--strict`.
 */
export type FindingSeverity = "error" | "warning" | "note";

export interface Finding {
  /** The rule id, e.g. `"features-requires-sliders"`. */
  rule: string;
  severity: FindingSeverity;
  message: string;
  /** One self-contained corrective sentence. Always present. */
  hint: string;
  /**
   * A JS accessor path rooted at the PartDefinition —
   * `parameters[1].features[0]`, `defaults.bore`, `parts.spacer.views[0]`.
   * `""` for findings about the definition as a whole. For navigation only.
   */
  path: string;
  /** A stable ERROR-PATTERNS.md entry id, when one applies. */
  pattern?: string;
}

export interface LintReport {
  /** True when there are no `error` findings. Warnings do not affect it. */
  ok: boolean;
  errors: Finding[];
  warnings: Finding[];
  /** Informational findings. Never affect `ok`, `measure`, or `--strict`. */
  notes: Finding[];
}

/**
 * Lint a PartDefinition. NEVER throws — a rule that throws yields an
 * `internal-rule-error` warning and the run continues.
 *
 * @param part - the default-exported PartDefinition (deliberately `unknown`:
 *   lint's whole job is to be handed something that may not be one).
 * @param opts - `params` are layered over `part.defaults` for the probe pass.
 */
export function lintPart(part: unknown, opts?: { params?: ResolvedParams } | null): LintReport;

/** The shared context a rule reads. */
export interface LintContext {
  part: unknown;
  /** `{ ...part.defaults, ...params }`, or `{}` if building it threw. */
  p: ResolvedParams;
  /** `resolveDerived(part, p)`, or `{}` if it threw. */
  d: Derived;
  /** The message from a throwing `defaults`/`params` read, else `null`. */
  pError: string | null;
  /** The message from a throwing `derive()`, else `null`. */
  deriveError: string | null;
  /** A memoized geometry-free probe run of every `build`. */
  probe(): unknown;
  /** A second, un-memoized probe run — for the determinism diff. */
  probeAgain(): unknown;
  /** `verify.expect` resolved once per lint pass. */
  resolveExpectOnce(): unknown;
}

export interface LintRule {
  id: string;
  run(ctx: LintContext): Finding[];
}

/**
 * The rule registry — one rule object per finding id, so it doubles as the
 * documented rule catalog.
 */
export const RULES: LintRule[];

export type { PartDefinition };
