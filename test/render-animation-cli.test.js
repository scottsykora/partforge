// CLI animation stills: --params passthrough, --animation/--at frame naming,
// --step targeting, and cue-derived default views.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const cli = (args) => execFileSync("node", ["bin/cli.js", ...args], { encoding: "utf8" });
const out = () => mkdtempSync(join(tmpdir(), "pf-anim-render-"));

test("--params renders at the given params", () => {
  const dir = out();
  cli(["render", "src/parts/hinged-box.js", "--views", "iso", "--out", dir, "--params", '{"lidAngle":90}']);
  expect(readdirSync(dir)).toEqual(["hinged-box-box-iso.png"]);
});

test("--animation --at writes tagged frames, defaulting views to the governing cue", () => {
  const dir = out();
  cli(["render", "src/parts/hinged-box.js", "--out", dir, "--animation", "open", "--at", "0,0.5,1"]);
  // open's cue is "front" at t=0 → governs every t
  expect(readdirSync(dir).sort()).toEqual([
    "hinged-box-box-front-open-t000.png",
    "hinged-box-box-front-open-t050.png",
    "hinged-box-box-front-open-t100.png",
  ]);
});

test("--step renders the end of the named step at its cue view", () => {
  const dir = out();
  cli(["render", "src/parts/hinged-box.js", "--out", dir, "--animation", "assemble", "--step", "Lower the lid"]);
  expect(readdirSync(dir)).toEqual(["hinged-box-box-left-assemble-step1.png"]);
});

test("--at without --animation fails loudly", () => {
  expect(() => cli(["render", "src/parts/hinged-box.js", "--at", "0.5"])).toThrow();
});
