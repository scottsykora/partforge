// test/import-occt.test.js — OCCT only; never boot manifold here
import { describe, it, expect, beforeAll } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120000);

describe("occt import op", () => {
  it("round-trips STEP through toSTEP → import", async () => {
    const box = k.box({ size: [10, 10, 10] });
    const stepBytes = await k.toSTEP([{ name: "box", solid: box }]);
    await k._registerImport({ name: "ref", digest: "d1", step: stepBytes });
    const s = k.import("ref");
    expect(s.volume()).toBeCloseTo(1000, 0);
    // consume-safety: a second import call must be unaffected by transforming the first
    s.translate([5, 0, 0]);
    expect(k.import("ref").volume()).toBeCloseTo(1000, 0);
  });
  it("stores a mesh-on-OCCT error entry and throws it at k.import", async () => {
    await k._registerImport({ name: "m", digest: "d2", error: new Error(`import "m": STL/3MF imports need the Manifold backend`) });
    expect(k._importDigest("m")).toBeUndefined(); // error entries don't satisfy the memo
    expect(() => k.import("m")).toThrow(/Manifold backend/);
  });
  it("advertises STEP support", () => {
    expect(k._acceptsStep).toBe(true);
  });
});
