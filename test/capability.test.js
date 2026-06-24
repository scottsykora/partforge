import { beforeAll, expect, test, vi } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { KernelCapabilityError } from "../src/framework/geometry/errors.js";
import { handle } from "../src/framework/jobs.js";

let k;
beforeAll(async () => { const w = await Module(); w.setup(); k = createManifoldKernel(w, { quality: "preview" }); });

test("Manifold fillet/chamfer throw KernelCapabilityError with code NEEDS_OCCT", () => {
  expect(() => k.box([0, 0, 0], [1, 1, 1]).fillet(0.1)).toThrow(KernelCapabilityError);
  try { k.box([0, 0, 0], [1, 1, 1]).chamfer(0.1); } catch (e) { expect(e.code).toBe("NEEDS_OCCT"); }
});

test("handle() posts needs-occt when a build uses an OCCT-only op on Manifold", async () => {
  const part = {
    defaults: {}, views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (kk) => kk.box([0, 0, 0], [2, 2, 2]).fillet(0.5) } },
  };
  const post = vi.fn();
  await handle(k, part, { type: "generate", subparts: ["a"], view: "v", params: {} }, post);
  expect(post).toHaveBeenCalledWith({ type: "needs-occt" });
});

test("Manifold shell throws KernelCapabilityError with code NEEDS_OCCT", () => {
  try { k.box([0, 0, 0], [10, 10, 10]).shell(1, { dir: "Z" }); }
  catch (e) { expect(e).toBeInstanceOf(KernelCapabilityError); expect(e.code).toBe("NEEDS_OCCT"); }
});
