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

  it("orbits correctly about an antiparallel up vector (upside-down camera)", () => {
    // up = -Y takes the "parallel or antiparallel to +Y" branch of upFrame down
    // its other fork (a half turn about X, not the identity taken by the +Y
    // case just above it). A round trip (drag then negate the drag) can't tell
    // a correct half turn from a bug that leaves upFrame as the identity: since
    // both are self-inverse, forward-then-backward returns to the start either
    // way — confirmed by patching the branch to identity and rerunning this
    // style of test; it still round-tripped. So this checks an independent
    // invariant instead: orbiting is equivariant under rotating the whole
    // scene. Rotating a +Y-up pose 180° about world X (R below) turns its up
    // vector into exactly -Y, so the -Y orbit of the rotated pose must equal
    // the rotated +Y orbit of the original pose — and a bad antiparallel
    // branch breaks that equality (verified: patching it to identity makes
    // this fail).
    const R = ([x, y, z]) => [x, -y, -z];
    const yUp = { position: [6, 8, 0], target: [0, 0, 0], up: Y_UP };
    const delta = { dx: 33, dy: 17 };
    const opts = { radiansPerPx: 0.01 };

    const outYUp = orbitPose(yUp, delta, opts);
    const negUp = { position: R(yUp.position), target: R(yUp.target), up: R(yUp.up) };
    const outNegUp = orbitPose(negUp, delta, opts);

    const expected = R(outYUp.position);
    for (let i = 0; i < 3; i++) expect(outNegUp.position[i]).toBeCloseTo(expected[i], 8);
    expect(dist(outNegUp.position, outNegUp.target)).toBeCloseTo(10, 8);
  });
});
