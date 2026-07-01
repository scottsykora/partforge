import { expect, test, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";

const run = (args) => execFileSync("node", ["bin/cli.js", ...args], { encoding: "utf8" });

// Render into a per-file output dir, not the shared default `render/`. Two CLI test
// files both rendering to (and rmSync-ing) `render/` race under vitest's parallel
// file execution — one file's afterAll deletes it mid-render in the other.
const OUT = "test/.cli-occt-render";

afterAll(() => {
  rmSync(OUT, { recursive: true, force: true });
});

test("render auto-selects OCCT for a filleted part and writes a PNG", () => {
  const out = run(["render", "src/parts/filleted-box.js", "box", "--views", "iso", "--out", OUT]);
  expect(out).toMatch(/wrote test\/\.cli-occt-render\/filleted-box-box-iso\.png/);
  expect(existsSync(`${OUT}/filleted-box-box-iso.png`)).toBe(true);
});

test("measure runs on the OCCT part and prints n/a topology", () => {
  const out = run(["measure", "src/parts/filleted-box.js"]);
  expect(out).toMatch(/Filleted Box \/ box/);
  expect(out).toMatch(/watertight n\/a/);
  expect(existsSync("measure-filleted-box-box.json")).toBe(false); // only --out writes a file
});
