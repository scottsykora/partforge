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
const describeSource = (raw) => {
  const flat = String(raw ?? "").replace(/\s+/g, " ").trim();
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
      const bound = controlBoundKeys(part);
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
        const code = stripNonCode(source);
        for (const { re, token } of IMPURE_TOKENS) {
          re.lastIndex = 0;
          for (let m; (m = re.exec(code)); ) {
            out.push({
              ...warn("impure-source-token",
                `\`${token}\` in ${path} — an impure build silently returns stale geometry`,
                "A build must be a pure function of (k, p, d): the preview kernel memoizes geometry by content hash, so a value that changes between calls silently serves stale geometry instead of rebuilding. Replace the impure value with a parameter or a derive() output.",
                "",
                "impure-build-stale-preview"),
              file: path,
              line: lineOf(code, m.index),
            });
          }
        }
      }
      // Deterministic order for stable reports: by file, then line.
      return out.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
    },
  },
];

export const SOURCE_RULE_IDS = new Set(SOURCE_RULES.map((r) => r.id));
