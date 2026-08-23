// partforge/oracle — the oracle's own published entry. Downstream (the CLI, a Node
// harness, partforge-cloud's agent tools) imports the oracle through this seam
// rather than through partforge/testing, which also drags the Node-only kernel
// booters and PNG renderer into the graph. The entry is browser-safe by contract:
// everything it re-exports is the same code the geometry worker lazy-loads for the
// `inspect` and `describe` jobs, so its closure must stay as clean as the worker's.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { walk, chainTo } from "./helpers/import-graph.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const ENTRY = `${ROOT}/src/oracle.js`;

test("the entry exports the oracle surface", async () => {
  const oracle = await import("../src/oracle.js");
  for (const name of [
    "measure", "verify", "buildView", "buildBVH", "minWall",
    "assemblyGaps", "meshGaps", "meshVolume", "bboxSize",
    "MATCH_VIEWS", "rasterizeMeshMask", "rasterizeRingsMask", "matchMasks", "matchViews",
    "describe", "describeMemo", "DESCRIBE_ERRORS",
    "compactDescribe", "LOW_COVERAGE", "DESCRIBE_LIMITS",
  ]) expect(oracle[name], name).toBeDefined();
});

test("package.json maps ./oracle with types", () => {
  const exports = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8")).exports;
  expect(exports["./oracle"]).toEqual({
    types: "./types/oracle.d.ts",
    default: "./src/oracle.js",
  });
});

test("partforge/testing re-exports the same oracle surface", async () => {
  // One surface, two doors: a harness already importing from partforge/testing must
  // see the identical bindings, or the two entries drift into subtly different oracles.
  const [oracle, testing] = await Promise.all([import("../src/oracle.js"), import("../src/testing.js")]);
  for (const name of Object.keys(oracle)) expect(testing[name], name).toBe(oracle[name]);
});

test("the entry's import closure is browser-safe (no src/testing/, no Node builtins)", () => {
  const { files, bare, importer } = walk(ENTRY, "oracle entry walk");
  for (const file of files) {
    const inTesting = file.startsWith(`${ROOT}/src/testing/`);
    expect(inTesting, inTesting ? `Node-only harness in the oracle entry:\n  ${chainTo(file, importer, ROOT)}` : "").toBe(false);
  }
  for (const spec of bare) {
    const isNode = spec.startsWith("node:");
    expect(isNode, isNode ? `Node builtin in the oracle entry:\n  ${chainTo(spec, importer, ROOT)}` : "").toBe(false);
  }
});
