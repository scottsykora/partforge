// The worker's job-extension seam. A host can register its own job types —
// `runWorker(part, { jobs: { <type>: handler } })`, threaded to `handle` as
// `opts.jobs` — and the loop hands each one the live kernel, the current part, the
// message and the poster. This is how a host adds a capability the open framework
// does not ship (the closed semantic-mesh-oracle's describe job, for one) without
// the framework naming it: partforge knows there are host jobs, never what they are.
import { expect, test, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handle } from "../src/framework/jobs.js";

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

const run = (msg, opts) => new Promise((resolve) => {
  const posted = [];
  handle(kernel, part, msg, (m) => posted.push(m), opts).then(() => resolve(posted));
});

test("a registered host job runs with the kernel, the part, the message and the poster", async () => {
  const seen = {};
  const jobs = {
    "count-imports": async (k, p, msg, post) => {
      seen.hasKernel = typeof k.import === "function";
      seen.part = p.name;
      seen.importName = msg.importName;
      const solid = k.import(msg.importName);
      post({ type: "counted", triangles: solid.toMesh().positions.length / 9 });
    },
  };
  const posted = await run({ type: "count-imports", importName: "scan" }, { jobs });
  expect(seen).toEqual({ hasKernel: true, part: "seam", importName: "scan" });
  expect(posted).toEqual([{ type: "counted", triangles: 4 }]);
});

test("a host job that throws is reported the way any failed job is", async () => {
  const jobs = { boom: () => { throw new Error("no such thing"); } };
  const posted = await run({ type: "boom", jobId: 7 }, { jobs });
  expect(posted).toEqual([{ type: "error", message: "no such thing", jobId: 7 }]);
});

test("an unknown job type with no handler registered is ignored, not an error", async () => {
  const posted = await run({ type: "describe", importName: "scan" }, {});
  expect(posted).toEqual([]);
});

test("built-in job types are not overridable by a host job", async () => {
  let called = false;
  const jobs = { generate: () => { called = true; } };
  // A generate with no sub-parts still runs the built-in path (it answers on the
  // meshes channel), and the host's same-named handler is never consulted.
  const posted = await run({ type: "generate", subparts: [], view: "default", params: {} }, { jobs });
  expect(called).toBe(false);
  expect(posted.some((m) => m.type === "meshes" || m.type === "superseded")).toBe(true);
});
