// The kernel contract, enforced: the Manifold backend must expose exactly the ops
// kernel.js documents (required + optional, nothing undocumented). The OCCT twin of
// this test lives in occt-backend.test.js — the two backends must never boot in one
// process, so the shared contract lists are the only place they can meet.
import { readFileSync } from "node:fs";
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import { CONTRACT_VERSION, KERNEL_OPS, KERNEL_OPTIONAL_OPS, OCCT_ONLY_OPS, SOLID_OPS, SOLID_OPTIONAL_OPS } from "../src/framework/geometry/kernel.js";
import * as polygon from "../src/framework/geometry/polygon.js";

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
  const keys = publicKeys(k.box({ min: [0, 0, 0], max: [1, 1, 1] }));
  for (const op of SOLID_OPS) expect(keys, `solid is missing ${op}`).toContain(op);
});

test("Manifold solid exposes no op the contract doesn't document", () => {
  const documented = new Set([...SOLID_OPS, ...SOLID_OPTIONAL_OPS]);
  expect(publicKeys(k.box({ min: [0, 0, 0], max: [1, 1, 1] })).filter((key) => !documented.has(key))).toEqual([]);
});

// The prose half of the contract (docs/KERNEL-CONTRACT.md) must not drift from the
// machine-checked half: its version header mirrors CONTRACT_VERSION, and every op and
// 2-D helper the code exports must at least be named in the doc.
const doc = readFileSync(new URL("../docs/KERNEL-CONTRACT.md", import.meta.url), "utf8");

test("KERNEL-CONTRACT.md's version header matches CONTRACT_VERSION", () => {
  expect(doc.match(/^\*\*Contract version: (\d+)\*\*/m)?.[1]).toBe(String(CONTRACT_VERSION));
});

test("KERNEL-CONTRACT.md names every contract op", () => {
  const ops = [...KERNEL_OPS, ...KERNEL_OPTIONAL_OPS, ...SOLID_OPS, ...SOLID_OPTIONAL_OPS, ...OCCT_ONLY_OPS];
  expect(ops.filter((op) => !new RegExp(`\\b${op}\\b`).test(doc))).toEqual([]);
});

test("KERNEL-CONTRACT.md names every partforge/geometry helper", () => {
  expect(Object.keys(polygon).filter((name) => !doc.includes(`\`${name}\``))).toEqual([]);
});
