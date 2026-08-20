// The spherical math behind "drag the view cube to orbit". Pure, so the widget
// never touches three; the sign convention matches OrbitControls (drag right
// decreases theta, drag down decreases phi).
import { describe, expect, it } from "vitest";
import { orbitPose } from "../../src/framework/camera-orbit.js";

const Y_UP = [0, 1, 0];
const base = { position: [0, 0, 10], target: [0, 0, 0], up: Y_UP };
const dist = (p, t) => Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);

describe("orbitPose", () => {
  it("is exactly a no-op for a zero delta", () => {
    const out = orbitPose(base, { dx: 0, dy: 0 });
    expect(out.position[0]).toBeCloseTo(0, 10);
    expect(out.position[1]).toBeCloseTo(0, 10);
    expect(out.position[2]).toBeCloseTo(10, 10);
  });

  it("never changes the orbit radius", () => {
    for (const d of [{ dx: 40, dy: 0 }, { dx: 0, dy: 30 }, { dx: -25, dy: -60 }]) {
      const out = orbitPose(base, d, { radiansPerPx: 0.01 });
      expect(dist(out.position, out.target)).toBeCloseTo(10, 8);
    }
  });

  it("never moves the target", () => {
    const out = orbitPose({ ...base, target: [1, 2, 3] }, { dx: 50, dy: 20 }, { radiansPerPx: 0.01 });
    expect(out.target).toEqual([1, 2, 3]);
  });

  it("swings the camera one way for a rightward drag and back for a leftward one", () => {
    const right = orbitPose(base, { dx: 30, dy: 0 }, { radiansPerPx: 0.01 });
    const left = orbitPose(base, { dx: -30, dy: 0 }, { radiansPerPx: 0.01 });
    expect(Math.sign(right.position[0])).toBe(-Math.sign(left.position[0]));
    expect(right.position[0]).not.toBeCloseTo(0, 3);
  });

  it("round-trips: equal and opposite drags return to the start", () => {
    const there = orbitPose(base, { dx: 33, dy: 17 }, { radiansPerPx: 0.01 });
    const back = orbitPose({ ...there, up: Y_UP }, { dx: -33, dy: -17 }, { radiansPerPx: 0.01 });
    for (let i = 0; i < 3; i++) expect(back.position[i]).toBeCloseTo(base.position[i], 8);
  });

  it("clamps at the top pole rather than flipping over it", () => {
    // OrbitControls' convention: phi -= dy, so a DOWNWARD drag (positive dy)
    // raises the camera. An unbounded drag pins it just short of straight up.
    const out = orbitPose(base, { dx: 0, dy: 100000 }, { radiansPerPx: 0.01 });
    expect(dist(out.position, out.target)).toBeCloseTo(10, 8);
    expect(out.position[1]).toBeGreaterThan(9.9);
  });

  it("clamps at the bottom pole too", () => {
    const out = orbitPose(base, { dx: 0, dy: -100000 }, { radiansPerPx: 0.01 });
    expect(dist(out.position, out.target)).toBeCloseTo(10, 8);
    expect(out.position[1]).toBeLessThan(-9.9);
  });

  it("orbits about a non-Y up vector without changing the radius", () => {
    const topView = { position: [0, 10, 0], target: [0, 0, 0], up: [0, 0, -1] };
    const out = orbitPose(topView, { dx: 20, dy: 10 }, { radiansPerPx: 0.01 });
    expect(dist(out.position, out.target)).toBeCloseTo(10, 8);
  });

  it("returns the pose untouched when the camera sits on the target", () => {
    const degenerate = { position: [5, 5, 5], target: [5, 5, 5], up: Y_UP };
    const out = orbitPose(degenerate, { dx: 10, dy: 10 });
    expect(out.position).toEqual([5, 5, 5]);
  });
});
