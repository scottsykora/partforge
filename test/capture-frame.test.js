import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  makeCaptureCamera, projectedExtent, centeredCropView, cropRenderFrame, recenteredView,
} from "../src/framework/capture-frame.js";

// A camera 10 units down +Z looking at the origin with a 90° fov and a square
// frame: a point (x, y, 0) lands at NDC (x/10, y/10), so image fractions are
// easy to write down by hand.
const POSE = { position: [0, 0, 10], up: [0, 1, 0], target: [0, 0, 0] };
const square = () => makeCaptureCamera(POSE, { aspect: 1, fov: 90 });

function meshOf(points, { position } = {}) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(points.flat(), 3));
  const mesh = new THREE.Mesh(geo);
  if (position) mesh.position.set(...position);
  return mesh;
}

const near = (a, b) => expect(a).toBeCloseTo(b, 5);

describe("makeCaptureCamera", () => {
  it("builds a perspective camera at the pose with the full-frame aspect and ready matrices", () => {
    const cam = makeCaptureCamera(POSE, { aspect: 2, fov: 30 });
    expect(cam.isPerspectiveCamera).toBe(true);
    expect(cam.aspect).toBe(2);
    expect(cam.fov).toBe(30);
    expect(cam.position.toArray()).toEqual([0, 0, 10]);
    // lookAt + updateMatrixWorld: the inverse is what projection reads.
    const p = new THREE.Vector3(0, 0, 0).applyMatrix4(cam.matrixWorldInverse);
    near(p.z, -10);
  });

  it("builds an orthographic frustum from orthoHalfH × aspect", () => {
    const cam = makeCaptureCamera(POSE, { aspect: 2, projection: "orthographic", orthoHalfH: 5 });
    expect(cam.isOrthographicCamera).toBe(true);
    expect([cam.left, cam.right, cam.top, cam.bottom]).toEqual([-10, 10, 5, -5]);
  });
});

describe("projectedExtent", () => {
  it("is the exact image-fraction box of the projected vertices, top-left origin", () => {
    const ext = projectedExtent(square(), [meshOf([[-2, -1, 0], [2, -1, 0], [2, 1, 0], [-2, 1, 0]])]);
    near(ext.left, 0.4); near(ext.right, 0.6); near(ext.top, 0.45); near(ext.bottom, 0.55);
  });

  it("applies each mesh's world matrix (a posed sub-part moves in the frame)", () => {
    const ext = projectedExtent(square(), [meshOf([[-2, 0, 0], [2, 0, 0]], { position: [3, 0, 0] })]);
    near(ext.left, 0.55); near(ext.right, 0.75);
  });

  it("unions across meshes and skips ones without a position attribute", () => {
    const bare = new THREE.Mesh(new THREE.BufferGeometry());
    const ext = projectedExtent(square(), [meshOf([[-4, 0, 0]]), bare, meshOf([[0, 3, 0]])]);
    near(ext.left, 0.3); near(ext.right, 0.5); near(ext.top, 0.35); near(ext.bottom, 0.5);
  });

  it("uses perspective (a nearer vertex projects larger)", () => {
    // At z=5 the camera is 5 away: x=2 → NDC 0.4 → fraction 0.7.
    const ext = projectedExtent(square(), [meshOf([[2, 0, 5]])]);
    near(ext.right, 0.7);
  });

  it("follows the frame aspect", () => {
    const wide = makeCaptureCamera(POSE, { aspect: 2, fov: 90 });
    const ext = projectedExtent(wide, [meshOf([[2, 1, 0]])]);
    near(ext.left, 0.55); near(ext.top, 0.45);
  });

  it("projects orthographically when asked", () => {
    const ortho = makeCaptureCamera(POSE, { aspect: 1, projection: "orthographic", orthoHalfH: 5 });
    // Depth must not matter under ortho.
    const ext = projectedExtent(ortho, [meshOf([[2, 1, 0], [2, 1, 7]])]);
    near(ext.left, 0.7); near(ext.right, 0.7); near(ext.top, 0.4); near(ext.bottom, 0.4);
  });

  it("is null when a vertex would be clipped: behind the camera, inside the near plane, or past far", () => {
    expect(projectedExtent(square(), [meshOf([[0, 0, 0], [0, 0, 20]])])).toBeNull();
    expect(projectedExtent(square(), [meshOf([[0, 0, 0], [0, 0, 9.95]])])).toBeNull();
    expect(projectedExtent(square(), [meshOf([[0, 0, 0], [0, 0, -2000]])])).toBeNull();
  });

  it("is null with nothing to project", () => {
    expect(projectedExtent(square(), [])).toBeNull();
    expect(projectedExtent(square(), [new THREE.Mesh(new THREE.BufferGeometry())])).toBeNull();
  });
});

describe("centeredCropView", () => {
  it("is the largest sub-window centred on the extent that fits the frame, with equal margins", () => {
    const crop = centeredCropView({ left: 0.3, right: 0.5, top: 0.4, bottom: 0.6 });
    near(crop.x, 0); near(crop.width, 0.8); near(crop.y, 0); near(crop.height, 1);
    // Equal margins on the axis that moved: 0.3 on the left, 0.8 - 0.5 = 0.3 on the right.
    near(0.3 - crop.x, crop.x + crop.width - 0.5);
  });

  it("crops both axes when the extent is off-centre both ways", () => {
    const crop = centeredCropView({ left: 0.5, right: 0.7, top: 0.1, bottom: 0.3 });
    near(crop.x, 0.2); near(crop.width, 0.8); near(crop.y, 0); near(crop.height, 0.4);
  });

  it("is null when the extent leaves the frame on any side — the user cropped on purpose", () => {
    expect(centeredCropView({ left: -0.01, right: 0.5, top: 0.4, bottom: 0.6 })).toBeNull();
    expect(centeredCropView({ left: 0.3, right: 0.5, top: 0.4, bottom: 1.01 })).toBeNull();
    expect(centeredCropView({ left: 0.3, right: 1.2, top: 0.4, bottom: 0.6 })).toBeNull();
    expect(centeredCropView({ left: 0.3, right: 0.5, top: -0.2, bottom: 0.6 })).toBeNull();
  });

  it("tolerates edge-line width: a hair outside the frame still counts as inside", () => {
    expect(centeredCropView({ left: -0.001, right: 0.5, top: 0.4, bottom: 0.6 })).not.toBeNull();
  });

  it("is null when already centred (nothing to do) or when there is no extent", () => {
    expect(centeredCropView({ left: 0.2, right: 0.8, top: 0.3, bottom: 0.7 })).toBeNull();
    expect(centeredCropView(null)).toBeNull();
  });

  it("is null for a degenerate extent", () => {
    expect(centeredCropView({ left: 0.3, right: 0.3, top: 0.3, bottom: 0.3 })).toBeNull();
  });
});

describe("cropRenderFrame", () => {
  it("renders the crop at the full long edge and expresses it as a view offset of a larger virtual frame", () => {
    const f = cropRenderFrame({ x: 0, y: 0, width: 0.8, height: 1 }, { aspect: 2, long: 2048 });
    // 0.8 of a 2:1 frame is 1.6:1 → long edge on width.
    expect(f.width).toBe(2048); expect(f.height).toBe(1280);
    near(f.viewOffset.fullWidth, 2560); near(f.viewOffset.fullHeight, 1280);
    near(f.viewOffset.x, 0); near(f.viewOffset.y, 0);
  });

  it("offsets into the virtual frame and puts the long edge on height for a tall crop", () => {
    const f = cropRenderFrame({ x: 0.1, y: 0.25, width: 0.25, height: 0.5 }, { aspect: 1, long: 1000 });
    expect(f.width).toBe(500); expect(f.height).toBe(1000);
    near(f.viewOffset.fullWidth, 2000); near(f.viewOffset.fullHeight, 2000);
    near(f.viewOffset.x, 200); near(f.viewOffset.y, 500);
  });
});

describe("recenteredView", () => {
  const deps = { aspect: 1, fov: 90, long: 1000 };
  it("returns a render frame when the whole part is in view", () => {
    const meshes = [meshOf([[-2, -1, 0], [2, -1, 0], [2, 1, 0], [-2, 1, 0]], { position: [3, 0, 0] })];
    const f = recenteredView(POSE, { ...deps, meshes });
    // Extent 0.55..0.75 → centre 0.65 → half-width 0.35 → crop x 0.3, width 0.7; y untouched.
    expect(f.width).toBe(700); expect(f.height).toBe(1000);
    near(f.viewOffset.fullWidth, 1000); near(f.viewOffset.x, 300); near(f.viewOffset.y, 0);
  });

  it("is null when the part runs off the frame or is already centred", () => {
    expect(recenteredView(POSE, { ...deps, meshes: [meshOf([[-12, 0, 0], [2, 0, 0]])] })).toBeNull();
    expect(recenteredView(POSE, { ...deps, meshes: [meshOf([[-2, -2, 0], [2, 2, 0]])] })).toBeNull();
    expect(recenteredView(POSE, { ...deps, meshes: [] })).toBeNull();
  });

  it("honours the orthographic projection", () => {
    // The z=7 vertex would project elsewhere under perspective; under ortho it
    // coincides with (2, 1, 0) and the extent is exactly the x/y spread.
    const meshes = [meshOf([[2, 1, 0], [2, 1, 7], [4, -1, 0]])];
    const f = recenteredView(POSE, { ...deps, projection: "orthographic", orthoHalfH: 5, meshes });
    // x: 0.7..0.9 → centre 0.8 → half 0.2 → crop 0.6..1.0; y: 0.4..0.6 → centred already → full height.
    near(f.viewOffset.x / f.viewOffset.fullWidth, 0.6);
    near(f.viewOffset.y / f.viewOffset.fullHeight, 0);
    near(f.width / f.viewOffset.fullWidth, 0.4);
    near(f.height / f.viewOffset.fullHeight, 1);
  });
});
