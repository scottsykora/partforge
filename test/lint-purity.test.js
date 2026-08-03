// partforge/lint must load in a browser sandbox iframe and in Deno, so its transitive
// import closure may never reach a WASM geometry kernel or the DOM viewer. This is the
// property that silently regresses the first time someone adds a convenient import —
// e.g. pulling SUBPART_METRICS from src/framework/oracle/verify.js, which imports
// measure.js and the part model. Walk the graph and prove it.
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { walk as walkGraph } from "./helpers/import-graph.js";

const BANNED = ["three", "manifold-3d", "replicad", "replicad-opencascadejs"];
const ENTRY = fileURLToPath(new URL("../src/lint.js", import.meta.url));

const walk = (entry) => walkGraph(entry, "lint-purity walk");

test("the lint import closure reaches no geometry kernel or renderer", () => {
  const { bare } = walk(ENTRY);
  for (const banned of BANNED) {
    expect([...bare], `partforge/lint must not import ${banned}`).not.toContain(banned);
  }
});

test("the lint import closure does not reach the kernel-importing modules", () => {
  const { files } = walk(ENTRY);
  const forbidden = ["src/framework/oracle/verify.js", "src/framework/oracle/measure.js", "src/framework/jobs.js", "src/index.js"];
  for (const f of forbidden) {
    expect([...files].some((p) => p.endsWith(f)), `partforge/lint must not reach ${f}`).toBe(false);
  }
});

test("the lint closure has no bare dependencies at all", () => {
  // Zero runtime dependencies is the strongest form of the browser guarantee, and
  // the spec requires it. Loosen this only with a deliberate decision.
  expect([...walk(ENTRY).bare]).toEqual([]);
});
