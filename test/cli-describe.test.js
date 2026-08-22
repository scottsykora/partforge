import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const run = (args) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

test("describe prints a markdown summary by default", () => {
  const out = run(["describe", "src/parts/import-demo.js#scan"]);
  expect(out).toMatch(/Features/);
  expect(out).toMatch(/explained/i);
});

test("the default summary does not dump the surface list", () => {
  const out = run(["describe", "src/parts/import-demo.js#scan"]);
  expect(out).not.toMatch(/^\s*s0\s+plane/m);
});

test("--surfaces includes the surface table", () => {
  const out = run(["describe", "src/parts/import-demo.js#scan", "--surfaces"]);
  expect(out).toMatch(/s0/);
});

// Fix round 2, IMPORTANT 2: `share NN%` on a feature line had no inline explanation
// that volumeShare measures SIZE, not certainty — score.note (report.js's SCORE_NOTE)
// makes that distinction and was already in the JSON, just never printed. Surfaced
// verbatim, not paraphrased down to something shorter that loses the distinction.
test("the default summary prints score.note, not just the two coverage numbers", () => {
  const out = run(["describe", "src/parts/import-demo.js#scan"]);
  expect(out).toMatch(/not certainty/i);
});

test("--json emits the full report", () => {
  const r = JSON.parse(run(["describe", "src/parts/import-demo.js#scan", "--json"]));
  expect(Array.isArray(r.surfaces)).toBe(true);
  expect(r.frame.up).toBe("+Z");
});

test("low coverage does not make describe exit non-zero", () => {
  // Coverage is a finding, not a failure — an agent must be able to read a poor report
  // rather than only see a non-zero exit.
  expect(() => run(["describe", "src/parts/import-demo.js#scan"])).not.toThrow();
});

test("an unknown import name exits non-zero with a message naming it", () => {
  let err = null;
  try { run(["describe", "src/parts/import-demo.js#missing"]); } catch (e) { err = e; }
  expect(err).not.toBeNull();
  expect(String(err.stderr)).toMatch(/missing/);
});

// --- fix round 2, IMPORTANT 1: budget-exceeded was invisible in the default view ---
//
// compactDescribe() only ever set its `warning` field from the LOW_COVERAGE check and
// never read `full.warning` (where describe.js puts "budget-exceeded"), so the plain-
// text printer — which reads only the compact shape, same as an agent's `--json`
// consumer — showed nothing even when `--json` on the exact same run carried
// `"warning": "budget-exceeded"` at top level. `test/fixtures/describe-washer-part.js`
// (928-triangle washer, 3 candidate-eligible features) with a deliberately starved
// `--budget 1` reliably exhausts the acceptance loop's attempts before the residual
// converges — reproduced directly against this fixture at every budget from 1 to 2;
// budget 3 already covers all three candidates and stops exceeding it.
test("a starved --budget makes the budget-exceeded warning appear in the default text output", () => {
  const out = run(["describe", "test/fixtures/describe-washer-part.js#scan", "--budget", "1"]);
  expect(out).toMatch(/BUDGET EXCEEDED/);
});

test("--json on the same starved run carries the same warning code the text banner reports", () => {
  const r = JSON.parse(run(["describe", "test/fixtures/describe-washer-part.js#scan", "--budget", "1", "--json"]));
  expect(r.warning).toBe("budget-exceeded");
});
