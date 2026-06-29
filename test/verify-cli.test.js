import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { afterAll } from "vitest";

const run = (args) => execFileSync("node", ["bin/cli.js", ...args], { encoding: "utf8" });
afterAll(() => {
  rmSync("measure-spacer-spacer.json", { force: true });
  rmSync("measure-bad-v.json", { force: true });
});

test("measure --process runs verify, prints checks, exits 0 for a sound part", () => {
  const out = run(["measure", "src/parts/demo.js", "--process", "fdm-pla"]);
  expect(out).toMatch(/verify/);
  expect(out).toMatch(/⚠/);            // min-wall warning
  expect(out).toMatch(/all gates passed/);
});

test("measure exits 1 when a verify gate fails", () => {
  try {
    run(["measure", "test/fixtures/bad-verify-part.js"]);
    throw new Error("expected non-zero exit");
  } catch (e) {
    expect(e.status).toBe(1);
    expect(String(e.stdout)).toMatch(/✗/);
  }
});
