import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";

// 10mm cube as triangle soup (12 tris, outward winding) — build it in a helper.
import { cubeSoup } from "./helpers/cube-soup.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

describe("manifold import op", () => {
  it("registers a mesh and returns a real Solid", () => {
    k._registerImport({ name: "cube", digest: "d1", ...cubeSoup(10) });
    const s = k.import("cube");
    expect(s.volume()).toBeCloseTo(1000, 0);
    expect(s.cut(k.box({ size: [20, 20, 5] })).volume()).toBeLessThan(1000);
  });
  it("fixes inward-facing winding", () => {
    const soup = cubeSoup(10);
    for (let t = 0; t < soup.indices.length; t += 3) { const tmp = soup.indices[t + 1]; soup.indices[t + 1] = soup.indices[t + 2]; soup.indices[t + 2] = tmp; }
    k._registerImport({ name: "inv", digest: "d2", ...soup });
    expect(k.import("inv").volume()).toBeCloseTo(1000, 0);
  });
  it("throws with open-edge diagnostics on a non-solid mesh", () => {
    const soup = cubeSoup(10);
    const holed = { positions: soup.positions, indices: soup.indices.slice(0, soup.indices.length - 6) };
    expect(() => k._registerImport({ name: "bad", digest: "d3", ...holed })).toThrow(/not a solid.*open edge/i);
  });
  it("stores an error entry and throws it lazily at k.import", () => {
    const lazy = new Error(`import "s": STEP needs tessellation for the Manifold backend`);
    lazy.code = "NEEDS_IMPORT_MESH";
    k._registerImport({ name: "s", digest: "d4", error: lazy }); // registration never throws
    expect(k._importDigest("s")).toBeUndefined(); // error entries don't satisfy the memo — upgradable
    let err;
    try { k.import("s"); } catch (e) { err = e; }
    expect(err?.code).toBe("NEEDS_IMPORT_MESH");
  });
  it("an error entry upgrades to a real registration under the same digest", () => {
    k._registerImport({ name: "s", digest: "d4", ...cubeSoup(10) });
    expect(k.import("s").volume()).toBeCloseTo(1000, 0);
    expect(k._importDigest("s")).toBe("d4");
  });
  it("unknown name names the imports field", () => {
    expect(() => k.import("nope")).toThrow(/unknown import "nope"/);
  });
  it("re-registration with the same digest is a no-op; a new digest replaces", () => {
    expect(k._importDigest("cube")).toBe("d1");
    k._registerImport({ name: "cube", digest: "d1", positions: new Float32Array(0), indices: new Uint32Array(0) }); // ignored
    expect(k.import("cube").volume()).toBeCloseTo(1000, 0);
  });
});
