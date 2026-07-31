import { expect, test, vi } from "vitest";
import { roundedBoxArgs, roundedCylinderArgs, torusArgs, KERNEL_OP_SPECS } from "../src/framework/geometry/op-options.js";

test("KERNEL_OP_SPECS has entries for the three rounded ops", () => {
  for (const op of ["roundedBox", "roundedCylinder", "torus"])
    expect(KERNEL_OP_SPECS[op]?.toArgs).toBeTypeOf("function");
});

test("roundedBox: number round broadcasts to all groups; object form defaults to 0", () => {
  expect(roundedBoxArgs({ size: [20, 12, 8], round: 2 }))
    .toEqual([{ size: [20, 12, 8], center: false, round: { side: 2, top: 2, bottom: 2 } }]);
  expect(roundedBoxArgs({ size: [20, 12, 8], center: true, round: { top: 3 } }))
    .toEqual([{ size: [20, 12, 8], center: true, round: { side: 0, top: 3, bottom: 0 } }]);
});

test("roundedBox: middle regime clamps rims down to side with ONE deduped console.warn", () => {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const [o] = roundedBoxArgs({ size: [20, 20, 10], round: { side: 1, top: 3 } });
  expect(o.round).toEqual({ side: 1, top: 1, bottom: 0 });
  expect(spy).toHaveBeenCalledWith(
    "roundedBox: round.top 3 clamped to round.side 1 (side must be 0 or ≥ rim radii; use side: 0 for a rim-only round-over)");
  const n = spy.mock.calls.length;
  roundedBoxArgs({ size: [20, 20, 10], round: { side: 1, top: 3 } }); // same combo → deduped
  expect(spy.mock.calls.length).toBe(n);
  spy.mockRestore();
});

test("roundedBox: side = 0 with big rims does NOT clamp or warn", () => {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const [o] = roundedBoxArgs({ size: [20, 20, 10], round: { side: 0, top: 4 } });
  expect(o.round).toEqual({ side: 0, top: 4, bottom: 0 });
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test("roundedBox: the h-fit check validates POST-clamp values", () => {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  // raw top+bottom = 4 > h = 3, but both clamp down to side = 1 → valid
  const [o] = roundedBoxArgs({ size: [20, 20, 3], round: { side: 1, top: 2, bottom: 2 } });
  expect(o.round).toEqual({ side: 1, top: 1, bottom: 1 });
  // side = 0 disables the clamp, so an oversized raw sum still throws
  expect(() => roundedBoxArgs({ size: [20, 20, 3], round: { side: 0, top: 2, bottom: 2 } }))
    .toThrow("roundedBox: round.top + round.bottom must be ≤ h");
  spy.mockRestore();
});

test("roundedBox: with round.side > 0, top + bottom must be strictly < h", () => {
  expect(() => roundedBoxArgs({ size: [20, 14, 10], round: { side: 5, top: 5, bottom: 5 } }))
    .toThrow("roundedBox: with round.side > 0, round.top + round.bottom must be < h (the rim fillets would meet tangentially; reduce the rim radii slightly, or use side: 0 for a sharp-sided full-height round-over)");
  expect(() => roundedBoxArgs({ size: [20, 20, 8], round: { side: 0, top: 4, bottom: 4 } }))
    .not.toThrow();
});

test("roundedBox: validation errors", () => {
  expect(() => roundedBoxArgs({ size: [20, 12, 8], round: { side: 11 } }))
    .toThrow("roundedBox: round.side (11) must be ≤ min(w, d)/2");
  expect(() => roundedBoxArgs({ size: [20, 12, 8], round: { top: 5, bottom: 4 } }))
    .toThrow("roundedBox: round.top + round.bottom must be ≤ h");
  expect(() => roundedBoxArgs({ size: [20, 12, 8], round: -1 }))
    .toThrow("roundedBox: round.side must be a finite number ≥ 0");
  expect(() => roundedBoxArgs({ size: [20, 12], round: 1 }))
    .toThrow("roundedBox: size must be [w, d, h] with three positive numbers");
  expect(() => roundedBoxArgs({ size: [20, 12, 8], round: { sied: 1 } }))
    .toThrow(/unknown option "sied"/);
  expect(() => roundedBoxArgs({ size: [20, 12, 8] })).toThrow("roundedBox: round is required");
});

test("roundedCylinder: r/d exclusivity, defaults, validation", () => {
  expect(roundedCylinderArgs({ d: 16, h: 20, round: 3 }))
    .toEqual([{ r: 8, h: 20, center: false, round: { top: 3, bottom: 3 } }]);
  expect(() => roundedCylinderArgs({ r: 8, d: 16, h: 20, round: 1 }))
    .toThrow("roundedCylinder: pass exactly one of r/d");
  expect(() => roundedCylinderArgs({ r: 8, h: 20, round: 9 }))
    .toThrow("roundedCylinder: round.top (9) must be ≤ r");
  expect(() => roundedCylinderArgs({ r: 8, h: 4, round: { top: 3, bottom: 2 } }))
    .toThrow("roundedCylinder: round.top + round.bottom must be ≤ h");
});

test("torus: 0 < rMinor < rMajor enforced", () => {
  expect(torusArgs({ rMajor: 10, rMinor: 3 })).toEqual([{ rMajor: 10, rMinor: 3 }]);
  for (const bad of [{ rMajor: 3, rMinor: 5 }, { rMajor: 3, rMinor: 3 }, { rMajor: 3, rMinor: 0 }])
    expect(() => torusArgs(bad)).toThrow("torus: requires 0 < rMinor < rMajor");
});
