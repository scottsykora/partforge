// This package ships PLAIN ESM SOURCE — the published files are the artifact, and
// every tool a reader reaches for treats them as text. A single stray control
// character breaks that quietly and completely: git marks the file binary and
// prints "Binary files … differ" instead of a diff (so the module is invisible in
// every review, local and on GitHub), `grep` skips it, and `file` reports `data`.
//
// That is not hypothetical. src/framework/lint/rules-vector.js shipped two raw NUL
// bytes as a dedup-key separator, and the whole module went unreviewed on its
// branch because no diff ever rendered it. Nothing in the suite noticed, because
// the RUNTIME behaviour was fine. So assert the property that actually matters:
// the source is text.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

// The published trees. `types/` is declarations, `bin/` is the CLI entry.
const TREES = ["src", "bin", "types"];
const EXTENSIONS = /\.(js|mjs|cjs|ts|css)$/;

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) { yield* sources(full); continue; }
    if (entry.isFile() && EXTENSIONS.test(entry.name)) yield full;
  }
}

// Tab, newline and carriage return are the only control characters a text file has
// any business containing. Everything else in C0 (plus DEL) is what makes git call
// the file binary.
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

test("no shipped source file contains a control character", () => {
  const bad = [];
  for (const tree of TREES) {
    const dir = `${ROOT}/${tree}`;
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const file of sources(dir)) {
      const m = FORBIDDEN.exec(readFileSync(file, "utf8"));
      if (m) {
        bad.push(`${file.slice(ROOT.length + 1)} (U+${m[0].codePointAt(0).toString(16).padStart(4, "0").toUpperCase()} at offset ${m.index})`);
      }
    }
  }
  expect(bad, [
    "These shipped source files contain a control character, so git treats them as",
    "binary and they will not render in any diff. Write the byte as an escape, or",
    "pick a printable separator (JSON.stringify of a tuple is one honest option):",
    ...bad.map((b) => `  ${b}`),
  ].join("\n")).toEqual([]);
});
