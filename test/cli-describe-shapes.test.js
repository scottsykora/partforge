// Which report shape `describe` emits under which flags — brief by default. Runs the
// real CLI against a stub oracle (test/fixtures/stub-oracle.js) so the test is about
// the plumbing, not the segmentation: the compact report over --json, the full one
// under --verbose, the region view under --region, and --out writing what was shown.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const PART = "test/fixtures/import-tetra-part.js#scan";
const env = { ...process.env, PARTFORGE_ORACLE: "./test/fixtures/stub-oracle.js" };
const run = (args) => execFileSync("node", ["bin/cli.js", "describe", PART, ...args], { encoding: "utf8", env });
const runFail = (args) => {
  try { run(args); } catch (e) { return { status: e.status, stderr: String(e.stderr) }; }
  throw new Error("expected the CLI to exit non-zero");
};

test("--json emits the compact report by default", () => {
  const r = JSON.parse(run(["--json"]));
  expect(r.compacted).toBe(true);
  expect(r.surfaces).toBeUndefined();
  expect(r.features[0].id).toBe("f0");
});

test("--verbose restores the full report", () => {
  const r = JSON.parse(run(["--json", "--verbose"]));
  expect(r.compacted).toBeUndefined();
  expect(r.surfaces).toHaveLength(1);
});

test("--region asks the oracle about one box and is structured even without --json", () => {
  const r = JSON.parse(run(["--region", "0,0,0,5,5,5"]));
  expect(r.region).toEqual({ min: [0, 0, 0], max: [5, 5, 5] });
  expect(r.surfaces).toHaveLength(1);
});

test("a malformed --region fails fast, before any describe runs", () => {
  const { status, stderr } = runFail(["--region", "1,0,0,0,0,0"]);
  expect(status).not.toBe(0);
  expect(stderr).toMatch(/six numbers/);
  expect(runFail(["--region", "1,2,3"]).stderr).toMatch(/six numbers/);
});

test("--out writes the same shape that was emitted", () => {
  const dir = mkdtempSync(join(tmpdir(), "pf-describe-"));
  const out = join(dir, "r.json");
  run(["--json", "--out", out]);
  expect(JSON.parse(readFileSync(out, "utf8")).compacted).toBe(true);
  run(["--json", "--verbose", "--out", out]);
  expect(JSON.parse(readFileSync(out, "utf8")).surfaces).toHaveLength(1);
});
