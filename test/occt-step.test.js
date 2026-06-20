import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "./occt-kernel.js";
import { buildParts } from "../src/drum.js";

// Covers the OCCT backend's export path — its whole reason for existing.
// toSTEP / toSTL are async (Promise<ArrayBuffer>); a real export must produce bytes.
let k;
beforeAll(async () => { k = await bootOcctKernel(); });

test("OCCT toSTEP produces a non-empty STEP buffer for a built part", async () => {
  const parts = buildParts(k, "small", {}); // [{ name, shape }]
  const named = parts.map((p) => ({ name: p.name, solid: p.shape }));
  const buf = await k.toSTEP(named);
  expect(buf.byteLength).toBeGreaterThan(0);
});

test("OCCT toSTL produces a non-empty STL buffer", async () => {
  const parts = buildParts(k, "small", {});
  const buf = await parts[0].shape.toSTL({ quality: "print" });
  expect(buf.byteLength).toBeGreaterThan(0);
});
