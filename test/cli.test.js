import { expect, test, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { rmSync, existsSync, readFileSync } from "node:fs";

const run = (args) => execFileSync("node", ["bin/cli.js", ...args], { encoding: "utf8" });

// Render into a per-file output dir, not the shared default `render/`. Two CLI test
// files both rendering to (and rmSync-ing) `render/` race under vitest's parallel
// file execution — one file's afterAll deletes it mid-render in the other.
const OUT = "test/.cli-render";

afterAll(() => {
  rmSync(OUT, { recursive: true, force: true });
});

test("CLI measure prints a report and exits 0 — no file unless --out asks for one", () => {
  const out = run(["measure", "src/parts/demo.js"]);
  expect(out).toMatch(/Spacer \/ spacer/);
  expect(out).toMatch(/watertight ✓/);
  expect(existsSync("measure-spacer-spacer.json")).toBe(false); // no droppings in the consumer's cwd
});

test("CLI measure --out writes the JSON report where asked", () => {
  const out = run(["measure", "src/parts/demo.js", "--out", `${OUT}/report.json`]);
  expect(out).toMatch(/wrote test\/\.cli-render\/report\.json/);
  const report = JSON.parse(readFileSync(`${OUT}/report.json`, "utf8"));
  expect(report.ok).toBe(true);
  expect(report.subparts[0].name).toBe("spacer");
});

test("an unknown flag fails loudly instead of being silently ignored", () => {
  let err;
  try { run(["render", "src/parts/demo.js", "spacer", "--viwes", "iso"]); } catch (e) { err = e; }
  expect(err).toBeTruthy();
  expect(`${err.stderr}`).toMatch(/viwes/); // the typo is named, with usage
  expect(`${err.stderr}`).toMatch(/usage: partforge render/);
});

test("--process without a value fails loudly instead of dropping the profile", () => {
  let err;
  try { run(["measure", "src/parts/demo.js", "--process"]); } catch (e) { err = e; }
  expect(err).toBeTruthy();
  expect(`${err.stderr}`).toMatch(/process/);
});

test("CLI render writes a PNG for the requested angle", () => {
  const out = run(["render", "src/parts/demo.js", "spacer", "--views", "iso", "--out", OUT]);
  expect(out).toMatch(/wrote test\/\.cli-render\/spacer-spacer-iso\.png/);
  expect(existsSync(`${OUT}/spacer-spacer-iso.png`)).toBe(true);
});

test("CLI exits non-zero on a bad part path", () => {
  expect(() => run(["measure", "src/parts/does-not-exist.js"])).toThrow();
});
