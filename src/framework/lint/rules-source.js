// Group 9 — source-text rules. These run only when the caller hands lintPart
// the part's SOURCE alongside the evaluated definition, because they exist
// precisely for the defects evaluation erases: `13 / 3` evaluates to a plain
// number, so the evaluated-object rules cannot see it, yet a host that
// persists panel settings by rewriting the defaults literal cannot write that
// value back — the control moves, the build is green, and the user's edit is
// silently gone on reload. Findings here carry `file` and `line` on top of
// the standard shape.
import { err, warn } from "./finding.js";
import { controlBoundKeys } from "./rules-schema.js";
import { pickDefaultsFile, stripNonCode, lineOf } from "./source-scan.js";

const MAX_SOURCE_CHARS = 48;
// The quoted source is LLM- or user-authored text on its way into a JSON
// diagnostics channel, so control characters come out along with the whitespace
// collapse — a raw C0 byte in a finding message is an escaping hazard for every
// consumer downstream, and it renders as nothing useful anyway.
const describeSource = (raw) => {
  const flat = String(raw ?? "").replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return flat.length > MAX_SOURCE_CHARS ? `${flat.slice(0, MAX_SOURCE_CHARS - 1)}…` : flat;
};

// Impurity tokens a source scan can see that the behavioral probe (which runs
// build() twice and diffs the recorded calls) can miss when the impure value
// is stable within one probe pass. `new Date()` matches only the ARGLESS
// form: `new Date(0)` is deterministic and legal.
//
// Scope limit (documented in AUTHORING-PARTS.md → Rule catalog → Source rules):
// stripNonCode blanks whole template interiors, so a token inside a `${…}`
// interpolation is not seen by this rule.
const IMPURE_TOKENS = [
  { re: /\bMath\s*\.\s*random\b/g, token: "Math.random" },
  { re: /\bDate\s*\.\s*now\b/g, token: "Date.now" },
  { re: /\bperformance\s*\.\s*now\b/g, token: "performance.now" },
  { re: /\bnew\s+Date\s*\(\s*\)/g, token: "new Date()" },
];

export const SOURCE_RULES = [
  {
    id: "control-default-not-literal",
    run: ({ part, sources }) => {
      if (!sources) return [];
      const picked = pickDefaultsFile(sources.files, sources.entrypoint);
      if (!picked) return [];
      // `excludeHidden` because a STATICALLY hidden control renders no widget,
      // so a panel save can never lose an edit to it — and `hidden: true` is
      // the documented idiom for an internal constant, exactly the place an
      // author legitimately writes an expression. A `when`-conditioned control
      // stays in: it can appear, so its default must be writable.
      const bound = controlBoundKeys(part, { excludeHidden: true });
      return picked.entries
        .filter((e) => e.key !== null && bound.has(e.key) && !e.readable)
        .map((e) => ({
          ...err("control-default-not-literal",
            `control "${e.key}" has a default written as \`${describeSource(e.raw)}\`, which a panel-settings save cannot write back`,
            `Write the computed value as a plain decimal number, quoted string or boolean literal (e.g. \`4.333\` instead of \`13 / 3\`), or move the computation into \`derive()\`. Hosts persist panel edits by rewriting this value in the source, so a spelling the rewriter cannot read silently loses the user's changes when the part is reopened.`,
            `defaults.${e.key}`,
            "control-default-not-literal"),
          file: picked.path,
          line: lineOf(picked.source, e.index),
        }));
    },
  },
  {
    id: "impure-source-token",
    run: ({ sources }) => {
      if (!sources?.files) return [];
      const out = [];
      for (const [path, source] of Object.entries(sources.files)) {
        if (typeof source !== "string") continue;
        // Code files only. A part tree can carry prose and data (a README, a
        // profile JSON), and `Date.now()` written in a sentence is not an
        // impure build — the scanner's comment/string blanking has no purchase
        // on a file that is not JS at all.
        if (!/\.m?js$/.test(path)) continue;
        const code = stripNonCode(source);
        for (const { re, token } of IMPURE_TOKENS) {
          // ONE finding per (file, token), carrying the occurrence count and
          // the first occurrence's line. Per-occurrence findings are unbounded:
          // a part looping `Math.random()` a few thousand times produced ~1.4 MB
          // of identical findings on a channel an LLM reads. The count is the
          // information; the rest was repetition.
          re.lastIndex = 0;
          let count = 0;
          let firstIndex = 0;
          for (let m; (m = re.exec(code)); ) {
            if (count === 0) firstIndex = m.index;
            count++;
          }
          if (count === 0) continue;
          out.push({
            ...warn("impure-source-token",
              `\`${token}\`${count > 1 ? ` ×${count}` : ""} in ${path} — an impure build silently returns stale geometry`,
              "A build must be a pure function of (k, p, d): the preview kernel memoizes geometry by content hash, so a value that changes between calls silently serves stale geometry instead of rebuilding. Replace the impure value with a parameter or a derive() output.",
              "",
              "impure-source-token"),
            file: path,
            line: lineOf(code, firstIndex),
          });
        }
      }
      // Deterministic order for stable reports: by file, then line.
      return out.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
    },
  },
];

export const SOURCE_RULE_IDS = new Set(SOURCE_RULES.map((r) => r.id));
