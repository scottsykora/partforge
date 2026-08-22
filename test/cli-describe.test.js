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

// Fix round 2, IMPORTANT 1 (a self-correction on IMPORTANT 2 from the round before):
// printing the FULL score.note paragraph in the default view measured at 36-43% of a
// typical run's line count — the single largest visual element in every report, bigger
// than the feature list, the banners, and the score line combined, burying findings
// instead of clarifying them. The one thing genuinely missing context was `share`, so
// the fix is a one-line hint at its point of use (the Features header) instead, with
// the long paragraph staying JSON-only — `buildScore` (report.js) attaches score.note
// unconditionally, so nothing is lost there.
test("the default summary hints what `share` means, right at the Features header", () => {
  const out = run(["describe", "src/parts/import-demo.js#scan"]);
  expect(out).toMatch(/Features \(1\):\s+share = fraction of part volume/);
});

test("the default summary does NOT print the full score.note paragraph", () => {
  const out = run(["describe", "src/parts/import-demo.js#scan"]);
  // A substring unique to the long paragraph's OTHER half (the area/volume
  // distinction), not the "not certainty" phrase reused in the short hint above —
  // this is what actually distinguishes "note dropped" from "note shortened".
  expect(out).not.toMatch(/diverge totally/);
});

test("--json still carries the full score.note, unabridged", () => {
  const r = JSON.parse(run(["describe", "src/parts/import-demo.js#scan", "--json"]));
  expect(r.score.note).toMatch(/not certainty/i);
  expect(r.score.note).toMatch(/diverge totally/);
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

// --- fix round 2, IMPORTANT 2: volumeShare:null didn't say WHY --------------------
//
// Three genuinely different situations used to collapse onto the same `share n/a`:
// a feature type never proposed as a candidate at all, one proposed but never reached
// before the search ran out of budget, and one reached, built, and evaluated but never
// winning a round. All three are exercised here through the real CLI against real
// meshes, not asserted in the abstract.
test("`not proposed` and `budget` render distinctly on the washer at a starved budget", () => {
  const out = run(["describe", "test/fixtures/describe-washer-part.js#scan", "--budget", "1"]);
  // f1 throughHole: proposed, but the search (budget 1) never reaches it.
  expect(out).toMatch(/f1\s+throughHole.*share n\/a \(budget\)/);
  // f2 revolve: never proposed as a candidate at all, at ANY budget — toCandidate
  // returns null outright for revolve/fillet/chamfer/shell (describe.js's own comment).
  expect(out).toMatch(/f2\s+revolve.*share n\/a \(not proposed\)/);
});

test("the same washer feature that was `budget`-starved gets a real share once the " +
     "budget is generous enough to reach it — proving `budget` really meant starved, " +
     "not permanently unreconstructable", () => {
  const out = run(["describe", "test/fixtures/describe-washer-part.js#scan", "--budget", "100"]);
  expect(out).toMatch(/f1\s+throughHole.*share \d+\.\d%/);
  // f2 (revolve) is STILL `not proposed` even with budget to spare — confirming that
  // reason is about the feature TYPE, not the search running out of room.
  expect(out).toMatch(/f2\s+revolve.*share n\/a \(not proposed\)/);
});

// `test/fixtures/describe-rejected.stl` (+ its part wrapper): a 300x300x50mm block
// with a 3mm-diameter through-hole whose volume (~353mm3) sits under accept.js's
// MIN_GAIN_FRACTION threshold (1e-4 of the ~4.5M mm3 block) — the search reaches this
// candidate immediately (2 candidates total, default --budget 48), builds and
// evaluates it, and its gain never wins a round. Genuinely different from both
// `budget` (never reached) and `not-proposed` (never a candidate at all).
test("`rejected` renders for a real, proposed, evaluated candidate that never wins a round", () => {
  const out = run(["describe", "test/fixtures/describe-rejected-part.js#scan"]);
  expect(out).toMatch(/f1\s+throughHole.*share n\/a \(rejected\)/);
  // Confirm this is NOT a budget story: plenty of budget was left unused.
  expect(out).not.toMatch(/BUDGET EXCEEDED/);
});
