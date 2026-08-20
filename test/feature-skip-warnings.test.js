// Feature-skip warnings: a fillet/chamfer the geometry (or its own arguments)
// defeats no longer fails the whole build on the Manifold backend — it returns
// its INPUT solid unchanged and records a warning the caller can drain
// (kernel.takeBuildWarnings) and jobs.js ships on the meshes message. This is
// the OCCT backend's long-standing safeOp policy (occt-repair.js) adopted by
// the mesh backend, plus the channel that makes either backend's skip VISIBLE
// to the caller instead of only to the console — in the cloud app, that caller
// is the LLM agent, which must be told the fillet didn't land while the part
// still renders without it (feedback 746c4ac2).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handle } from "../src/framework/jobs.js";
import { KernelCapabilityError } from "../src/framework/geometry/errors.js";
import { createOcctRepair } from "../src/framework/geometry/occt-repair.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

describe("Manifold fillet/chamfer feature-skip", () => {
  it("a defeated fillet returns the input solid and records one warning", () => {
    k.takeBuildWarnings();
    const box = k.box({ size: [10, 10, 5] });
    // an unknown inPlane axis throws inside the mesh-fillet machinery — the
    // deterministic stand-in for a geometry-defeated fillet
    const out = box.fillet({ r: 1, edges: { inPlane: "XQ", at: 5 } });
    expect(out.volume()).toBeCloseTo(box.volume(), 6);
    const warnings = k.takeBuildWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/fillet 1 failed/);
    expect(warnings[0]).toMatch(/feature skipped/);
    expect(k.takeBuildWarnings()).toEqual([]); // drained
  });

  it("a repeated skipped op re-warns without failing (the no-op re-apply case)", () => {
    k.takeBuildWarnings();
    const box = k.box({ size: [10, 10, 5] });
    box.fillet({ r: 1, edges: { inPlane: "XQ", at: 5 } });
    k.takeBuildWarnings();
    const again = box.fillet({ r: 1, edges: { inPlane: "XQ", at: 5 } });
    expect(again.volume()).toBeCloseTo(box.volume(), 6);
    expect(k.takeBuildWarnings()).toHaveLength(1);
  });

  it("a defeated chamfer skips the same way", () => {
    k.takeBuildWarnings();
    const box = k.box({ size: [10, 10, 5] });
    const out = box.chamfer({ d: 1, edges: { inPlane: "XQ", at: 5 } });
    expect(out.volume()).toBeCloseTo(box.volume(), 6);
    expect(k.takeBuildWarnings()[0]).toMatch(/chamfer 1 failed/);
  });

  it("NEEDS_OCCT capability errors still propagate — they are the reroute signal", () => {
    const box = k.box({ size: [10, 10, 5] });
    expect(() => box.fillet(1, (e) => e)).toThrow(KernelCapabilityError);
    expect(k.takeBuildWarnings()).toEqual([]); // a reroute is not a skip
  });

  it("a working fillet records nothing", () => {
    k.takeBuildWarnings();
    const box = k.box({ size: [10, 10, 5] });
    const out = box.fillet({ r: 1, edges: { inPlane: "XY", at: 5 } });
    expect(out.volume()).toBeLessThan(box.volume());
    expect(k.takeBuildWarnings()).toEqual([]);
  });

  // The seam this feature can silently break. roundAll's prism fast path fillets
  // internally and answers a FAILED fillet by returning null, which hands the job
  // to the reference Minkowski path. If that internal call degraded like the
  // public op, the fast path would receive an un-rounded prism, believe it
  // succeeded, and emit it — a silently wrong roundAll instead of a correct slow
  // one. So the internal primitive must keep throwing.
  it("the internal fillet primitive throws rather than skipping", () => {
    k.takeBuildWarnings();
    const box = k.box({ size: [10, 10, 5] });
    expect(() => box._filletRaw(1, { inPlane: "XQ", at: 5 })).toThrow();
    expect(k.takeBuildWarnings()).toEqual([]); // nothing recorded — it did not skip
  });

  it("roundAll still rounds every edge (it never rides the degrading fillet)", () => {
    k.takeBuildWarnings();
    const box = k.box({ size: [10, 10, 5] });
    const out = box.roundAll({ r: 0.4 });
    expect(out.volume()).toBeLessThan(box.volume()); // material actually came off
    expect(k.takeBuildWarnings()).toEqual([]);
  });
});

describe("jobs.js ships feature-skip warnings on the meshes message", () => {
  const flaky = {
    defaults: { bad: true },
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (kk, p) =>
      kk.box({ size: [10, 10, 5] }).fillet({ r: 1, edges: { inPlane: p.bad ? "XQ" : "XY", at: 5 } }) } },
  };
  const run = async (params) => {
    const post = vi.fn();
    await handle(k, flaky, { type: "generate", subparts: ["a"], view: "v", params }, post);
    return post.mock.calls.map(([m]) => m).find((m) => m.type === "meshes");
  };

  it("a skipped fillet arrives as {part, message} beside real meshes", async () => {
    const msg = await run({ bad: true });
    expect(msg.meshes[0].triangles).toBeGreaterThan(0); // the part still built
    expect(msg.warnings).toHaveLength(1);
    expect(msg.warnings[0].part).toBe("a");
    expect(msg.warnings[0].message).toMatch(/fillet 1 failed .*feature skipped/);
  });

  it("a clean build carries no warnings key at all", async () => {
    const msg = await run({ bad: false });
    expect(msg.warnings).toBeUndefined();
  });
});

// The three degrades that already skipped or clamped but only reached the
// console. Each is reported through the SHARED `kernel._recordWarning`, so a
// build that quietly lost a feature is now as visible as one that skipped a
// fillet — that invisibility was the actual bug behind feedback 746c4ac2.
describe("shared degrades reach the same channel", () => {
  it("an extrude bevel too big for its profile is reported, not just consoled", () => {
    k.takeBuildWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // a 2mm bevel on a 3mm-wide profile cannot be offset — rim left square
    k.extrude({ profile: [[0, 0], [3, 0], [3, 40], [0, 40]], h: 10, bevel: 2 });
    warn.mockRestore();
    const warnings = k.takeBuildWarnings();
    expect(warnings.some((w) => /extrude bevel 2/.test(w))).toBe(true);
  });

  it("roundedBox's rim clamp is reported", () => {
    k.takeBuildWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    k.roundedBox({ size: [20, 20, 10], round: { side: 1, top: 3 } }); // top clamps to side
    warn.mockRestore();
    const warnings = k.takeBuildWarnings();
    expect(warnings.some((w) => /roundedBox: round\.top .* clamped to round\.side/.test(w))).toBe(true);
  });

  it("a Shape2D corner-op clamp is reported", () => {
    k.takeBuildWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    k.shape2d([[0, 0], [10, 0], [10, 10], [0, 10]]).fillet(6); // max is 5
    warn.mockRestore();
    const warnings = k.takeBuildWarnings();
    expect(warnings.some((w) => /filletProfile.*clamped to 5/.test(w))).toBe(true);
  });

  it("a build that degrades nothing records nothing", () => {
    k.takeBuildWarnings();
    k.roundedBox({ size: [20, 20, 10], round: { side: 1, top: 1 } });
    k.shape2d([[0, 0], [10, 0], [10, 10], [0, 10]]).fillet(2);
    expect(k.takeBuildWarnings()).toEqual([]);
  });
});

describe("occt-repair records through the injected warn", () => {
  it("safeOp reports a throwing op and returns the backup", () => {
    const warnings = [];
    const { safeOp } = createOcctRepair(() => 1, (m) => warnings.push(m));
    const backup = { deleted: false, delete() { this.deleted = true; } };
    const shape = { clone: () => backup };
    const out = safeOp(shape, () => { throw new Error("boom"); }, "fillet(2)");
    expect(out).toBe(backup);
    expect(warnings).toEqual(["fillet(2) failed (boom) — feature skipped"]);
  });
});
