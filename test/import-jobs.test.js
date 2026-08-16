// Import registration in the job loop, and the STEP-on-Manifold crossover error
// path (needs-import-mesh). Manifold-booting only — OCCT must never boot in the
// same process, so this file stays Manifold-only by construction (own file).
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handle } from "../src/framework/jobs.js";
import { meshToStl } from "../src/framework/geometry/mesh-stl.js";
import { resolveImports } from "../src/framework/imports.js";
import { cubeSoup } from "./helpers/cube-soup.js";

const stlBytes = () => { const c = cubeSoup(10); return meshToStl(c.positions, c.indices); };

const importingPart = {
  meta: { title: "t" },
  imports: { cube: () => stlBytes() },
  defaults: {},
  views: { main: {} },
  parts: {
    body: { views: ["main"], build: (k) => k.import("cube") },
  },
};

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(); });

const run = async (part, msg, opts) => {
  const posts = [];
  await handle(kernel, part, msg, (m) => posts.push(m), opts);
  return posts;
};

describe("jobs import wiring", () => {
  it("generate on an importing part produces meshes", async () => {
    const posts = await run(importingPart, { type: "generate", subparts: ["body"], view: "main", params: {} });
    const meshes = posts.find((p) => p.type === "meshes");
    expect(meshes.meshes[0].triangles).toBeGreaterThan(0);
  });

  it("a STEP import with no primed mesh posts needs-import-mesh", async () => {
    const part = { ...importingPart, imports: { cube: () => new TextEncoder().encode("ISO-10303-21;\nHEADER;\nENDSEC;") } };
    const posts = await run(part, { type: "generate", subparts: ["body"], view: "main", params: {}, jobId: 7 });
    expect(posts.some((p) => p.type === "needs-import-mesh" && p.jobId === 7)).toBe(true);
  });

  it("a primed STEP import builds", async () => {
    const part = { ...importingPart, imports: { cube: () => new TextEncoder().encode("ISO-10303-21;\nHEADER;\nENDSEC;") } };
    const soup = cubeSoup(10);
    // digest must match what resolveImports computes for those bytes — compute it via
    // resolveImports (memoized by thunk identity, so this reuses the same cache entry
    // ensureImports will hit inside handle()).
    const digest = (await resolveImports(part.imports)).get("cube").digest;
    const primed = new Map([["cube", { digest, positions: soup.positions, indices: soup.indices }]]);
    const posts = await run(part, { type: "generate", subparts: ["body"], view: "main", params: {} }, { importMeshes: primed });
    expect(posts.some((p) => p.type === "meshes")).toBe(true);
  });

  it("a generate that never calls the STEP import triggers no crossover", async () => {
    // Lazy errors: the unusable/unprimed entry registers inertly; only a build
    // that actually calls k.import on it throws. body only imports "cube".
    const part = {
      ...importingPart,
      imports: { cube: () => stlBytes(), scan: () => new TextEncoder().encode("ISO-10303-21;\nHEADER;\nENDSEC;") },
    };
    const posts = await run(part, { type: "generate", subparts: ["body"], view: "main", params: {} });
    expect(posts.some((p) => p.type === "needs-import-mesh")).toBe(false);
    expect(posts.some((p) => p.type === "meshes")).toBe(true);
  });
});
