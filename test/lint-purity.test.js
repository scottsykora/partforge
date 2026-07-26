// partforge/lint must load in a browser sandbox iframe and in Deno, so its transitive
// import closure may never reach a WASM geometry kernel or the DOM viewer. This is the
// property that silently regresses the first time someone adds a convenient import —
// e.g. pulling SUBPART_METRICS from src/testing/verify.js, which imports measure.js
// and jobs.js. Walk the graph and prove it.
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const BANNED = ["three", "manifold-3d", "replicad", "replicad-opencascadejs"];
const ENTRY = fileURLToPath(new URL("../src/lint.js", import.meta.url));

// Collect every static import specifier in a module.
const importsOf = (src) =>
  [...src.matchAll(/^\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1])
    .concat([...src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]));

function walk(entry) {
  const seen = new Set();
  const bare = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const spec of importsOf(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) {
        const next = resolve(dirname(file), spec);
        queue.push(next);
      } else {
        bare.add(spec);
      }
    }
  }
  return { files: seen, bare };
}

test("the lint import closure reaches no geometry kernel or renderer", () => {
  const { bare } = walk(ENTRY);
  for (const banned of BANNED) {
    expect([...bare], `partforge/lint must not import ${banned}`).not.toContain(banned);
  }
});

test("the lint import closure does not reach the kernel-importing modules", () => {
  const { files } = walk(ENTRY);
  const forbidden = ["src/testing/verify.js", "src/testing/measure.js", "src/framework/jobs.js", "src/index.js"];
  for (const f of forbidden) {
    expect([...files].some((p) => p.endsWith(f)), `partforge/lint must not reach ${f}`).toBe(false);
  }
});

test("the lint closure has no bare dependencies at all", () => {
  // Zero runtime dependencies is the strongest form of the browser guarantee, and
  // the spec requires it. Loosen this only with a deliberate decision.
  expect([...walk(ENTRY).bare]).toEqual([]);
});
