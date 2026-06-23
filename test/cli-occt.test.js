import { expect, test, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";

const run = (args) => execFileSync("node", ["bin/cli.js", ...args], { encoding: "utf8" });

afterAll(() => {
  rmSync("render", { recursive: true, force: true });
  rmSync("measure-filleted-box-box.json", { force: true });
});

test("render auto-selects OCCT for a filleted part and writes a PNG", () => {
  const out = run(["render", "src/parts/filleted-box.js", "box", "--views", "iso"]);
  expect(out).toMatch(/wrote render\/filleted-box-box-iso\.png/);
  expect(existsSync("render/filleted-box-box-iso.png")).toBe(true);
});

test("measure runs on the OCCT part and prints n/a topology", () => {
  const out = run(["measure", "src/parts/filleted-box.js"]);
  expect(out).toMatch(/Filleted Box \/ box/);
  expect(out).toMatch(/watertight n\/a/);
  expect(existsSync("measure-filleted-box-box.json")).toBe(true);
});
