// The kernel contract, enforced: the Manifold backend must expose exactly the ops
// kernel.js documents (required + optional, nothing undocumented). The OCCT twin of
// this test lives in occt-backend.test.js — the two backends must never boot in one
// process, so the shared contract lists are the only place they can meet.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { KERNEL_OPS, KERNEL_OPTIONAL_OPS, SOLID_OPS, SOLID_OPTIONAL_OPS } from "../src/framework/geometry/kernel.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// `_`-prefixed keys are backend internals (matches the probe kernel's convention).
const publicKeys = (obj) => Object.keys(obj).filter((key) => !key.startsWith("_"));

test("Manifold kernel implements every required op", () => {
  const keys = publicKeys(k);
  for (const op of KERNEL_OPS) expect(keys, `kernel is missing ${op}`).toContain(op);
});

test("Manifold kernel exposes no op the contract doesn't document", () => {
  const documented = new Set([...KERNEL_OPS, ...KERNEL_OPTIONAL_OPS]);
  expect(publicKeys(k).filter((key) => !documented.has(key))).toEqual([]);
});

test("Manifold solid implements every required op", () => {
  const keys = publicKeys(k.box([0, 0, 0], [1, 1, 1]));
  for (const op of SOLID_OPS) expect(keys, `solid is missing ${op}`).toContain(op);
});

test("Manifold solid exposes no op the contract doesn't document", () => {
  const documented = new Set([...SOLID_OPS, ...SOLID_OPTIONAL_OPS]);
  expect(publicKeys(k.box([0, 0, 0], [1, 1, 1])).filter((key) => !documented.has(key))).toEqual([]);
});
