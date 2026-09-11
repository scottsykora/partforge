import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  depthRangeFor, DEFAULT_NEAR, DEFAULT_FAR, SCENE_MARGIN,
} from "../src/framework/depth-range.js";
import { makeCaptureCamera, projectedExtent, captureDepthRange } from "../src/framework/capture-frame.js";
import { cameraPoseForView } from "../src/framework/view-angles.js";

// The two framing distances in the codebase, both `2.6r + 6` but over
// different radii: frameTo (and tweenCameraTo, and the view cube) uses the max
// EXTENT, the canonical captures use half of it.
const framingDistance = (r) => r * 2.6 + 6;

// A cube centred on the origin, as a mesh and as the sphere enclosing it.
function cube(mm) {
  const geo = new THREE.BoxGeometry(mm, mm, mm);
  geo.computeBoundingBox();
  return {
    mesh: new THREE.Mesh(geo),
    sceneBounds: { center: [0, 0, 0], radius: (mm * Math.sqrt(3)) / 2 },
  };
}

describe("depthRangeFor", () => {
  it("clears the far side of the scene from any distance", () => {
    for (const radius of [0.5, 6, 12, 130, 259.8, 2000]) {
      for (const distance of [0, radius / 2, radius * 2.6, radius * 40, 12000]) {
        const { near, far } = depthRangeFor({ distance, radius });
        expect(far).toBeGreaterThanOrEqual(distance + radius);
        expect(near).toBeGreaterThan(0);
        expect(near).toBeLessThan(far);
      }
    }
  });

  it("keeps the near plane in front of the nearest visible point", () => {
    for (const radius of [1, 12, 259.8, 2000]) {
      for (const distance of [radius * 1.5, radius * 2.6, radius * 10]) {
        const { near } = depthRangeFor({ distance, radius });
        expect(near).toBeLessThanOrEqual(distance - radius);
      }
    }
  });

  it("holds far/near inside what a 24-bit depth buffer resolves", () => {
    for (const radius of [0.5, 12, 259.8, 2000]) {
      for (const distance of [0, radius, radius * 2.6, radius * 100]) {
        const { near, far } = depthRangeFor({ distance, radius });
        expect(far / near).toBeLessThanOrEqual(1e5 + 1);
      }
    }
  });

  it("quantizes, so a small camera move leaves the projection alone", () => {
    const a = depthRangeFor({ distance: 786, radius: 259.8 });
    const b = depthRangeFor({ distance: 790, radius: 259.8 });
    expect(b).toEqual(a);
    // …and still moves once the step is crossed.
    const far = depthRangeFor({ distance: 1600, radius: 259.8 });
    expect(far.far).toBeGreaterThan(a.far);
  });

  it("grows monotonically with distance, so a dolly never tightens the range", () => {
    let previous = 0;
    for (let distance = 0; distance < 5000; distance += 37) {
      const { far } = depthRangeFor({ distance, radius: 259.8 });
      expect(far).toBeGreaterThanOrEqual(previous);
      previous = far;
    }
  });

  it("lets an orthographic near plane go negative, where three allows it", () => {
    // The camera inside the sphere: under ortho the half "behind" it is still
    // in the picture, so clamping near to a positive number would slice it off.
    const { near, far } = depthRangeFor({ distance: 10, radius: 260, projection: "orthographic" });
    expect(near).toBeLessThan(0);
    expect(-near).toBeGreaterThanOrEqual(260 * SCENE_MARGIN - 10);
    expect(far).toBeGreaterThanOrEqual(270);
  });

  it("falls back to the historical fixed pair on an empty or broken scene", () => {
    for (const input of [{ distance: 5, radius: 0 }, { distance: NaN, radius: 10 }, {}]) {
      expect(depthRangeFor(input)).toEqual({ near: DEFAULT_NEAR, far: DEFAULT_FAR });
    }
  });
});

// The regression this all exists for. Before it, near/far were fixed at
// 0.1/1000: a 300 mm box framed at 786 mm had its far corner at 1046 mm and
// the back of it was simply not drawn.
describe("a part is never clipped by its own framing", () => {
  for (const mm of [12, 100, 287, 300, 500, 1200]) {
    it(`holds a ${mm} mm cube at the distance the viewer frames it from`, () => {
      const { mesh, sceneBounds } = cube(mm);
      const pose = cameraPoseForView("iso", { center: [0, 0, 0], radius: mm });
      const cam = makeCaptureCamera(pose, {
        aspect: 1, fov: 45, ...captureDepthRange(pose, { sceneBounds }),
      });
      // projectedExtent returns null the moment ANY vertex falls outside the
      // frustum, which is exactly the failure being guarded against.
      expect(projectedExtent(cam, [mesh])).not.toBeNull();
      expect(framingDistance(mm)).toBeCloseTo(Math.hypot(...pose.position), 6);
    });
  }

  it("holds the part after zooming a long way out", () => {
    const { mesh, sceneBounds } = cube(300);
    for (const distance of [900, 2200, 9000]) {
      const pose = { position: [0, 0, distance], up: [0, 1, 0], target: [0, 0, 0] };
      const cam = makeCaptureCamera(pose, {
        aspect: 1, fov: 45, ...captureDepthRange(pose, { sceneBounds }),
      });
      expect(projectedExtent(cam, [mesh])).not.toBeNull();
    }
  });

  it("still clipped a 300 mm cube under the old fixed planes", () => {
    // Pins the bug itself, so the fix cannot be quietly reverted: the same
    // camera built WITHOUT bounds keeps 0.1/1000 and loses the far corner.
    const { mesh } = cube(300);
    const pose = cameraPoseForView("iso", { center: [0, 0, 0], radius: 300 });
    const cam = makeCaptureCamera(pose, { aspect: 1, fov: 45 });
    expect(cam.far).toBe(DEFAULT_FAR);
    expect(projectedExtent(cam, [mesh])).toBeNull();
  });
});
