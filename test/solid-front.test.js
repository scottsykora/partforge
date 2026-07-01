// The backend-shared solid front (solid-sugar.js) against a fake raw solid — no
// WASM. Pins the responsibilities the front takes over from the backends: scale
// validation, boundingBox center/size derivation, and capability stubs for
// OCCT-only ops the backend doesn't implement.
import { expect, test, vi } from "vitest";
import { addSugar } from "../src/framework/geometry/solid-sugar.js";
import { KernelCapabilityError } from "../src/framework/geometry/errors.js";

const rawSolid = () => ({
  rotate: vi.fn(() => "rotated"),
  translate: vi.fn(() => "translated"),
  scale: vi.fn(() => "scaled"),
  boundingBox: () => ({ min: [0, 2, 4], max: [10, 22, 34] }),
});

test("scale is validated once, in the front, for every backend", () => {
  const s = addSugar(rawSolid());
  expect(() => s.scale(0)).toThrow(/factor must be > 0/);
  expect(() => s.scale(-2)).toThrow(/factor must be > 0/);
  expect(s.scale(2)).toBe("scaled");
});

test("scale defaults its center to the origin before reaching the backend", () => {
  const raw = rawSolid();
  const backendScale = raw.scale; // addSugar wraps in place — grab the spy first
  addSugar(raw).scale(2);
  expect(backendScale).toHaveBeenCalledWith(2, [0, 0, 0]);
});

test("boundingBox center/size are derived from the backend's min/max", () => {
  const s = addSugar(rawSolid());
  expect(s.boundingBox()).toEqual({
    min: [0, 2, 4], max: [10, 22, 34],
    center: [5, 12, 19], size: [10, 20, 30],
  });
});

test("OCCT-only ops the backend lacks throw KernelCapabilityError", () => {
  const s = addSugar(rawSolid());
  for (const op of ["fillet", "chamfer", "shell"]) {
    expect(() => s[op](1), op).toThrow(KernelCapabilityError);
  }
});

test("a backend's own OCCT-only ops are kept, not stubbed over", () => {
  const s = addSugar({ ...rawSolid(), fillet: () => "native fillet" });
  expect(s.fillet(1)).toBe("native fillet");
});
