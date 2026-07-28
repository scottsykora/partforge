import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { handle } from "../src/framework/jobs.js";

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(); });

const part = {
  defaults: {},
  views: { main: { label: "Main" } },
  parts: {
    a: { views: ["main"], build: (k) => k.cylinder({ r: 5, h: 10 }) },
    b: { views: ["main"], build: (k) => k.cylinder({ r: 3, h: 6 }) },
  },
};

describe("generate cancellation", () => {
  it("a build stale at the sub-part boundary posts superseded, not meshes", async () => {
    const posts = [];
    let stale = false;
    const done = handle(kernel, part,
      { type: "generate", subparts: ["a", "b"], view: "main", params: {} },
      (m) => posts.push(m), { isStale: () => stale });
    stale = true; // flips before the post-sub-part macrotask yield runs
    await done;
    const types = posts.map((m) => m.type);
    expect(types).toContain("superseded");
    expect(types).not.toContain("meshes");
  });

  it("a never-stale build posts meshes exactly as before", async () => {
    const posts = [];
    await handle(kernel, part,
      { type: "generate", subparts: ["a", "b"], view: "main", params: {} },
      (m) => posts.push(m)); // no opts at all — backwards compatible
    expect(posts.map((m) => m.type)).toContain("meshes");
    expect(posts.find((m) => m.type === "meshes").meshes).toHaveLength(2);
  });
});
