// The describe job's injection seam. The semantic mesh oracle lives in a closed
// package this repo never names; jobs.js reaches it only through an injected
// `opts.loadOracle` thunk. Two properties matter and are pinned here: WITHOUT the
// loader the job answers with the structured `oracle-unavailable` report (never a
// stall, never a throw — cloud's tool layer and the CLI both act on the code), and
// WITH one the job runs whatever the loader resolves, contract-shaped — proven with
// a stub oracle, so this suite needs no access to the real package.
import { expect, test, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handle } from "../src/framework/jobs.js";

// The import fixture is a watertight tetrahedron built inline as ASCII STL — the
// real mesh fixtures moved out with the oracle, and this seam needs only "a valid
// import exists", not any particular geometry.
const V = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]];
const F = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
const stl = `solid seam\n${F.map((f) =>
  `facet normal 0 0 0\nouter loop\n${f.map((i) => `vertex ${V[i].join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid seam\n`;
const part = {
  name: "seam",
  imports: { scan: () => new TextEncoder().encode(stl) },
  parts: { body: { build: (k) => k.import("scan") } },
  views: { default: { parts: ["body"] } },
  params: {},
};

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(part); });

const run = (msg, opts) => new Promise((resolve) => handle(kernel, part, msg, resolve, opts));

test("a describe job without an injected oracle answers oracle-unavailable", async () => {
  const out = await run({ type: "describe", importName: "scan" });
  expect(out.type).toBe("describe-report");
  expect(out.report.error).toBe("oracle-unavailable");
  // The structured triple every error in this repo carries — an agent acts on
  // the correctiveAction, not a stack trace.
  expect(out.report.diagnostic.correctiveAction).toMatch(/loadOracle/);
  expect(out.report.source.name).toBe("scan");
});

test("an injected loader is what the describe job runs", async () => {
  const seen = {};
  const stub = {
    describe: (k, solid, opts) => {
      seen.digest = opts.digest;
      seen.memo = opts.memo;
      return { stub: true, source: { name: opts.name } };
    },
    describeMemo: () => new Map(),
    compactDescribe: (full) => ({ ...full, compacted: true }),
  };
  const out = await run(
    { type: "describe", importName: "scan", compact: true },
    { loadOracle: async () => stub },
  );
  expect(out.report.stub).toBe(true);
  expect(out.report.compacted).toBe(true);
  // The job threads the kernel's own content digest and a worker-lifetime memo
  // into the oracle — the memoization contract the closed package depends on.
  expect(typeof seen.digest).toBe("string");
  expect(seen.memo).toBeInstanceOf(Map);
});
