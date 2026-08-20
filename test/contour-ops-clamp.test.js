// Profile fillet/chamfer CLAMP to the largest magnitude that fits, instead of
// throwing. These ops used to fail loudly with a computed `max ≈`, which reads in
// a parametric app as "the part builds at r=3.0 and dies at r=3.1" — the harshest
// failure class in this engine, and the same cliff the offset fallback ladder
// exists to remove. Every failure mode here already knew its own ceiling (a
// closed-form per-corner cap for line-line corners, a bisected one for
// curve-adjacent corners, the segment length for a shared-edge overlap), so the
// remedy is to use it and report the clamp rather than to refuse.
import { describe, test, expect, vi } from "vitest";
import { filletProfile, chamferProfile } from "../src/framework/geometry/contour-ops.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
const arcs = (c) => c.segments.filter((s) => s.via).length;

describe("per-corner clamp (line-line corners)", () => {
  test("an over-large radius rounds at the max that fits instead of throwing", () => {
    const record = vi.fn();
    const out = filletProfile(sq, 6, undefined, record);      // max is 5 on a 10x10 square
    expect(arcs(out)).toBe(4);
    // r=5 on every corner of a 10x10 square is the inscribed circle
    expect(ringArea(tessellateContour(out, 512))).toBeCloseTo(Math.PI * 25, 1);
    expect(record).toHaveBeenCalled();
    expect(record.mock.calls[0][0]).toMatch(/filletProfile.*r=6.*clamped to 5/);
  });

  test("a radius that already fits is untouched and records nothing", () => {
    const record = vi.fn();
    const out = filletProfile(sq, 2, undefined, record);
    expect(ringArea(tessellateContour(out, 256))).toBeCloseTo(100 - 4 * (4 - Math.PI), 2);
    expect(record).not.toHaveBeenCalled();
  });

  test("clamping is PER CORNER — a corner that fits keeps its full radius", () => {
    // A 10x3 plate: every corner is bounded by its 3-long edge, so the ceiling is
    // r=3. Corners 0 and 2 are DIAGONAL, so they share no segment and the overlap
    // path can't fire — this isolates the per-corner clamp. r=2 fits; r=4 doesn't.
    const plate = [[0, 0], [10, 0], [10, 3], [0, 3]];
    const record = vi.fn();
    const out = filletProfile(plate, [2, 4], { corners: { indices: [0, 2] } }, record);
    expect(arcs(out)).toBe(2);
    expect(record).toHaveBeenCalledTimes(1);          // only the over-large one
    expect(record.mock.calls[0][0]).toMatch(/corner 2.*r=4.*clamped to 3/);
  });

  test("chamfer clamps the same way", () => {
    const record = vi.fn();
    const out = chamferProfile(sq, 9, undefined, record);
    expect(out.segments.filter((s) => s.via || s.c1).length).toBe(0);
    expect(record.mock.calls[0][0]).toMatch(/chamferProfile.*dist=9.*clamped to 5/);
  });
});

describe("shared-edge overlap clamp", () => {
  test("two fillets claiming one short edge both shrink to fit it", () => {
    // 3 wide, 20 tall: r=2 at all four corners overruns the 3-wide edges
    const thin = [[0, 0], [3, 0], [3, 20], [0, 20]];
    const record = vi.fn();
    const out = filletProfile(thin, 2, undefined, record);
    expect(arcs(out)).toBe(4);
    // area must stay sane: below the raw rectangle, above the r=2 ideal it couldn't have
    const area = ringArea(tessellateContour(out, 512));
    expect(area).toBeLessThan(60);
    expect(area).toBeGreaterThan(50);
    expect(record).toHaveBeenCalled();
  });

  test("the clamped profile is still a valid closed ring", () => {
    const thin = [[0, 0], [3, 0], [3, 20], [0, 20]];
    const out = filletProfile(thin, 2);
    const pts = tessellateContour(out, 256);
    // closed: last point returns to the first
    expect(Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]))
      .toBeLessThan(1e-6);
    expect(Math.abs(ringArea(pts))).toBeGreaterThan(0);
  });
});

describe("what still throws", () => {
  test("a selector matching no corner is still an error, not a clamp", () => {
    expect(() => filletProfile(sq, 1, { corners: "concave" })).toThrow(/no corner matched/);
  });

  test("a per-corner array without an indices selector is still an error", () => {
    expect(() => filletProfile(sq, [3, 1.5])).toThrow();
  });
});

describe("reporting", () => {
  test("with no recorder supplied the clamp still happens (and does not throw)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => filletProfile(sq, 6)).not.toThrow();
    warn.mockRestore();
  });
});
