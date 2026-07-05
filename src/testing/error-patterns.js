// Shared parser + matcher for docs/ERROR-PATTERNS.md — the symptom-indexed
// error→pattern library (issue #28). The parser here is the single source of
// truth: the format lint (test/error-patterns.test.js) and the CLI crash-path
// matcher (issue #27) both import it. Contract: partforge code that throws must
// throw strings appearing verbatim, in a backtick literal AT THE START of some
// entry's Symptom line — only a leading literal participates in matching, so
// backticks used for prose mid-sentence never mis-attribute an unrelated crash.
import { readFileSync } from "node:fs";

// Single-pass, fence-aware parse: a heading inside a ``` / ~~~ fence is quoted
// content, not structure. Each `## <id>` entry records the `# <section>` it sits
// under; its body runs to the next h1/h2 heading. (Moved verbatim from the lint
// test, then enriched with symptom/cause/fix extraction.)
export function parsePatterns(md) {
  const entries = [];
  let section = null;
  let entry = null;
  let inFence = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      if (entry) entry.body += line + "\n";
      continue;
    }
    if (!inFence) {
      const h1 = line.match(/^# (.+)$/);
      const h2 = line.match(/^## (.+)$/);
      if (h1) { section = h1[1]; entry = null; continue; }
      if (h2) { entry = { id: h2[1], section, body: "" }; entries.push(entry); continue; }
    }
    if (entry) entry.body += line + "\n";
  }
  const field = (body, label) => {
    const i = body.indexOf(`- **${label}:**`);
    return i < 0 ? null : body.slice(i).split("\n")[0].replace(`- **${label}:**`, "").trim();
  };
  return entries.map((e) => {
    const symptom = field(e.body, "Symptom");
    // Leading-literal convention: only a backtick literal at the very START of the
    // Symptom text is a match literal (kept as a ≤1-element array for compatibility
    // — tests and the matcher read symptomStrings). Mid-line backticks are prose.
    const leading = symptom?.match(/^`([^`]+)`/);
    return {
      ...e,
      symptom,
      cause: field(e.body, "Cause"),
      fix: field(e.body, "Fix"),
      symptomStrings: leading ? [leading[1]] : [],
    };
  });
}

// Cached read of the live doc, resolved relative to this module so it works from
// a consuming app's node_modules too. Any read/parse error → null (callers treat
// that as "no patterns available", never an error).
let cached;
export function loadPatterns() {
  if (cached !== undefined) return cached;
  try {
    cached = parsePatterns(readFileSync(new URL("../../docs/ERROR-PATTERNS.md", import.meta.url), "utf8"));
  } catch {
    cached = null;
  }
  return cached;
}

// Leading symptom literals ≥ 6 chars, longest match wins. Never throws.
export function matchPattern(message, patterns = loadPatterns()) {
  if (!patterns || typeof message !== "string") return null;
  let best = null;
  let bestLen = 5;
  for (const p of patterns) {
    for (const s of p.symptomStrings) {
      if (s.length > bestLen && message.includes(s)) { best = p; bestLen = s.length; }
    }
  }
  return best ? { id: best.id, fix: best.fix } : null;
}
