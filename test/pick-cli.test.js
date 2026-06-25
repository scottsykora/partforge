// test/pick-cli.test.js
import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";

const run = (args) => execFileSync("node", ["bin/cli.js", ...args], { encoding: "utf8" });

test("`pick` with no prompts prints usage and exits non-zero", () => {
  let err;
  try { run(["pick"]); } catch (e) { err = e; }
  expect(err).toBeTruthy();
  expect(`${err.stderr}`).toMatch(/usage: partforge pick/);
});

test("an unknown command still prints usage (dispatch intact)", () => {
  let err;
  try { run(["bogus"]); } catch (e) { err = e; }
  expect(err).toBeTruthy();
  expect(`${err.stderr}`).toMatch(/usage: partforge/);
});
