import { expect, test, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handle } from "../src/framework/jobs.js";

// A thunk, not a bare `new URL(...)`: jobs.js's `handle()` re-registers a part's
// imports on every job via ensureImports -> resolveImports, which resolves a URL
// source with the platform `fetch` — and Node's fetch cannot read file: URLs. A
// thunk returning bytes sidesteps that entirely (asset-resolve.js's grammar) and
// is exactly the pattern test/import-jobs.test.js already uses for the same
// reason. bootManifoldKernel's own Node boot path routes a bare URL through
// nodeAssetSources first, which is why the same declaration would have worked in
// beforeAll alone but not once handle() re-resolved it per job.
const fixturePath = fileURLToPath(new URL("./fixtures/describe-washer.stl", import.meta.url));
const part = {
  name: "washer",
  imports: { scan: () => readFileSync(fixturePath) },
  parts: { body: { build: (k) => k.import("scan") } },
  views: { default: { parts: ["body"] } },
  params: {},
};

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(part); });

const run = (msg) => new Promise((resolve) => handle(kernel, part, msg, resolve));

test("a describe job answers with a describe-report", async () => {
  const out = await run({ type: "describe", importName: "scan" });
  expect(out.type).toBe("describe-report");
  expect(out.report.source.name).toBe("scan");
});

test("the report carries the import digest so the caller can key its own cache", async () => {
  const out = await run({ type: "describe", importName: "scan" });
  expect(typeof out.report.source.digest).toBe("string");
  expect(out.report.source.digest.length).toBeGreaterThan(0);
});

test("compact:true returns the compact shape with surfaces elided", async () => {
  const out = await run({ type: "describe", importName: "scan", compact: true });
  expect(out.report.surfaces).toBeUndefined();
  expect(out.report.counts.surfaces).toBeGreaterThan(0);
});

test("a second describe of the same import is served from the memo", async () => {
  const a = await run({ type: "describe", importName: "scan" });
  const b = await run({ type: "describe", importName: "scan" });
  expect(b.report).toBe(a.report);
});

test("an unknown import name is an error, not a crash", async () => {
  const out = await run({ type: "describe", importName: "nope" });
  expect(out.type).toBe("error");
  expect(out.message).toMatch(/nope/);
});
