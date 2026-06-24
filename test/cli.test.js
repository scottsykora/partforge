import { expect, test, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";

const run = (args) => execFileSync("node", ["bin/cli.js", ...args], { encoding: "utf8" });

// Render into a per-file output dir, not the shared default `render/`. Two CLI test
// files both rendering to (and rmSync-ing) `render/` race under vitest's parallel
// file execution — one file's afterAll deletes it mid-render in the other.
const OUT = "test/.cli-render";

afterAll(() => {
  rmSync(OUT, { recursive: true, force: true });
  rmSync("measure-spacer-spacer.json", { force: true });
});

test("CLI measure prints a report, writes JSON, exits 0 for a sound part", () => {
  const out = run(["measure", "src/parts/demo.js"]);
  expect(out).toMatch(/Spacer \/ spacer/);
  expect(out).toMatch(/watertight ✓/);
  expect(existsSync("measure-spacer-spacer.json")).toBe(true);
});

test("CLI render writes a PNG for the requested angle", () => {
  const out = run(["render", "src/parts/demo.js", "spacer", "--views", "iso", "--out", OUT]);
  expect(out).toMatch(/wrote test\/\.cli-render\/spacer-spacer-iso\.png/);
  expect(existsSync(`${OUT}/spacer-spacer-iso.png`)).toBe(true);
});

test("CLI exits non-zero on a bad part path", () => {
  expect(() => run(["measure", "src/parts/does-not-exist.js"])).toThrow();
});
