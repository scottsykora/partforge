import { expect, test, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";

const run = (args) => execFileSync("node", ["bin/cli.js", ...args], { encoding: "utf8" });

afterAll(() => {
  rmSync("render", { recursive: true, force: true });
  rmSync("measure-spacer-spacer.json", { force: true });
});

test("CLI measure prints a report, writes JSON, exits 0 for a sound part", () => {
  const out = run(["measure", "src/parts/demo.js"]);
  expect(out).toMatch(/Spacer \/ spacer/);
  expect(out).toMatch(/watertight ✓/);
  expect(existsSync("measure-spacer-spacer.json")).toBe(true);
});

test("CLI render writes a PNG for the requested angle", () => {
  const out = run(["render", "src/parts/demo.js", "spacer", "--views", "iso"]);
  expect(out).toMatch(/wrote render\/spacer-spacer-iso\.png/);
  expect(existsSync("render/spacer-spacer-iso.png")).toBe(true);
});

test("CLI exits non-zero on a bad part path", () => {
  expect(() => run(["measure", "src/parts/does-not-exist.js"])).toThrow();
});
