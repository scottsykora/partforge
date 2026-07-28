import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(); });

describe("kernel.sweepCache", () => {
  it("is exposed and drops a partition idle for 3 sweeps (cold rebuild misses)", () => {
    expect(typeof kernel.sweepCache).toBe("function");
    // Build one sub-part bracketed, exactly as jobs.js does for a generate:
    const build = () => {
      kernel.resetCacheStats();
      kernel.beginSubPart("spacer");
      try { kernel.cylinder({ r: 5, h: 10 }).cut(kernel.cylinder({ r: 2, h: 12 }).translate([0, 0, -1])); }
      finally { kernel.endSubPart(); kernel.cleanup?.(); }
      return kernel.cacheStats();
    };
    build();                                 // cold
    expect(build().hits).toBeGreaterThan(0); // warm baseline proven
    kernel.sweepCache(); kernel.sweepCache(); kernel.sweepCache();
    const after = build();
    expect(after.hits).toBe(0);              // partition evicted -> cold again
    expect(after.misses).toBeGreaterThan(0);
  });
});
