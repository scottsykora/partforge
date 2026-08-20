// The perspective <-> orthographic framing pair. Getting this wrong is visible
// as a jump in part size the instant the user hits the projection toggle, so
// the round trip is asserted in both directions and through a dolly.
import { describe, expect, it } from "vitest";
import { orthoFrustum, perspectiveDistance } from "../../src/framework/projection.js";

const FOV = 45;

describe("orthoFrustum", () => {
  it("matches the perspective frustum's half-height at the target distance", () => {
    const { halfH } = orthoFrustum({ fovDeg: FOV, distance: 100, aspect: 1 });
    expect(halfH).toBeCloseTo(100 * Math.tan((FOV * Math.PI) / 360), 10);
  });

  it("widens with aspect and leaves the height alone", () => {
    const square = orthoFrustum({ fovDeg: FOV, distance: 50, aspect: 1 });
    const wide = orthoFrustum({ fovDeg: FOV, distance: 50, aspect: 2 });
    expect(wide.halfH).toBeCloseTo(square.halfH, 10);
    expect(wide.halfW).toBeCloseTo(square.halfW * 2, 10);
  });

  it("emits a symmetric frustum", () => {
    const f = orthoFrustum({ fovDeg: FOV, distance: 30, aspect: 1.5 });
    expect(f.left).toBeCloseTo(-f.right, 12);
    expect(f.bottom).toBeCloseTo(-f.top, 12);
    expect(f.right).toBeCloseTo(f.halfW, 12);
    expect(f.top).toBeCloseTo(f.halfH, 12);
  });
});

describe("perspectiveDistance", () => {
  it("round-trips an unzoomed frustum back to the original distance", () => {
    const { halfH } = orthoFrustum({ fovDeg: FOV, distance: 137.5, aspect: 1.77 });
    expect(perspectiveDistance({ halfH, zoom: 1, fovDeg: FOV })).toBeCloseTo(137.5, 8);
  });

  it("treats an ortho zoom as a proportionally closer camera", () => {
    const { halfH } = orthoFrustum({ fovDeg: FOV, distance: 100, aspect: 1 });
    expect(perspectiveDistance({ halfH, zoom: 2, fovDeg: FOV })).toBeCloseTo(50, 8);
    expect(perspectiveDistance({ halfH, zoom: 0.5, fovDeg: FOV })).toBeCloseTo(200, 8);
  });

  it("defaults zoom to 1", () => {
    const { halfH } = orthoFrustum({ fovDeg: FOV, distance: 42, aspect: 1 });
    expect(perspectiveDistance({ halfH, fovDeg: FOV })).toBeCloseTo(42, 8);
  });
});
