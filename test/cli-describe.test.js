import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const run = (args) => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

test("describe prints a markdown summary by default", () => {
  const out = run(["describe", "src/parts/import-demo.js#scan"]);
  expect(out).toMatch(/Features/);
  expect(out).toMatch(/explained/i);
});

test("the default summary does not dump the surface list", () => {
  const out = run(["describe", "src/parts/import-demo.js#scan"]);
  expect(out).not.toMatch(/^\s*s0\s+plane/m);
});

test("--surfaces includes the surface table", () => {
  const out = run(["describe", "src/parts/import-demo.js#scan", "--surfaces"]);
  expect(out).toMatch(/s0/);
});

test("--json emits the full report", () => {
  const r = JSON.parse(run(["describe", "src/parts/import-demo.js#scan", "--json"]));
  expect(Array.isArray(r.surfaces)).toBe(true);
  expect(r.frame.up).toBe("+Z");
});

test("low coverage does not make describe exit non-zero", () => {
  // Coverage is a finding, not a failure — an agent must be able to read a poor report
  // rather than only see a non-zero exit.
  expect(() => run(["describe", "src/parts/import-demo.js#scan"])).not.toThrow();
});

test("an unknown import name exits non-zero with a message naming it", () => {
  let err = null;
  try { run(["describe", "src/parts/import-demo.js#missing"]); } catch (e) { err = e; }
  expect(err).not.toBeNull();
  expect(String(err.stderr)).toMatch(/missing/);
});
