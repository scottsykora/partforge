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

// --- the flags fail loudly rather than rendering something unasked-for --------
// bin/cli.js's header promises a typo'd flag "fails loudly instead of being
// silently ignored"; these are the cases where it previously didn't.

// Returns { code, stderr } instead of throwing, so a rejection can be asserted on.
const cliFails = (args) => {
  try {
    execFileSync("node", ["bin/cli.js", ...args], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, stderr: "" };
  } catch (e) {
    return { code: e.status, stderr: String(e.stderr ?? "") };
  }
};

test("an empty --animation is rejected, not treated as absent", () => {
  const dir = out();
  // `--animation ""` is the shape an unset shell variable produces. Falsiness made
  // it indistinguishable from omitting the flag, so it rendered a plain still.
  const r = cliFails(["render", "src/parts/hinged-box.js", "--views", "iso", "--out", dir, "--animation", ""]);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/--animation needs an animation name/);
  expect(readdirSync(dir)).toEqual([]);
});

test("--at rejects an empty entry instead of rendering it as t=0", () => {
  const dir = out();
  const r = cliFails(["render", "src/parts/hinged-box.js", "--out", dir, "--animation", "open", "--at", "0.2,,0.8"]);
  expect(r.code).toBe(1); // Number("") is 0, which passed the 0..1 range check
  expect(r.stderr).toMatch(/--at takes comma-separated positions/);
  expect(readdirSync(dir)).toEqual([]);
});

test("--at and --step together is a conflict, not a silent preference", () => {
  const dir = out();
  const r = cliFails(["render", "src/parts/hinged-box.js", "--out", dir,
    "--animation", "assemble", "--at", "0.5", "--step", "1"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/--at and --step are alternatives/);
});

test("--at positions that collide in the filename are rejected", () => {
  const dir = out();
  // Tags carry two decimals, so 0.001 and 0.004 both render "…-t000.png" and the
  // second silently overwrote the first — one file for two requested frames.
  const r = cliFails(["render", "src/parts/hinged-box.js", "--out", dir,
    "--animation", "open", "--at", "0.001,0.004"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/both render to/);
  expect(readdirSync(dir)).toEqual([]);
});

test("--params must be a JSON object", () => {
  const dir = out();
  for (const bad of ["[1,2]", "42", '"hi"', "null"]) {
    const r = cliFails(["render", "src/parts/hinged-box.js", "--views", "iso", "--out", dir, "--params", bad]);
    expect(r.code, `--params ${bad}`).toBe(1);
    expect(r.stderr).toMatch(/--params takes a JSON object/);
  }
});

test("an unknown positional view is rejected, not rendered blank", () => {
  const dir = out();
  // viewSubParts returns nothing for an unknown view, so this used to write
  // background-only PNGs with the bogus name baked in, and exit 0.
  const r = cliFails(["render", "src/parts/hinged-box.js", "notaview", "--views", "iso", "--out", dir]);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/unknown view "notaview"/);
  expect(readdirSync(dir)).toEqual([]);
});
