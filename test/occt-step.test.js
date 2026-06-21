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

test("OCCT toSTEP exports the full 'both' assembly incl. tensioner block", async () => {
  // Regression: seatBlock() consumes its input shape on the OCCT backend (replicad
  // transforms delete their operand), so reusing the block for both the export
  // shape and a seated display left the exported shape pointing at a freed object —
  // STEP write then threw "This object has been deleted".
  // Reduced params keep the (groove-independent) block bug in play while cutting
  // the two helical groove fields down so the build stays fast + reliable.
  const fewGrooves = { ratio: 6, output_range_deg: 90, contact_wraps: 2, small_match_big_h: false };
  const parts = buildParts(k, "both", fewGrooves);
  expect(parts.map((p) => p.name)).toContain("tensioner_block");
  const named = parts.map((p) => ({ name: p.name, solid: p.shape }));
  const buf = await k.toSTEP(named);
  expect(buf.byteLength).toBeGreaterThan(0);
});

test("OCCT toSTL produces a non-empty STL buffer", async () => {
  const parts = buildParts(k, "small", {});
  const buf = await parts[0].shape.toSTL({ quality: "print" });
  expect(buf.byteLength).toBeGreaterThan(0);
});
