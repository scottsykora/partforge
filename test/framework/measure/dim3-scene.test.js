// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { createDimScene, DIM_THEME, RENDER_ORDER_DIMS, RENDER_ORDER_LABELS }
  from "../../../src/framework/measure/dim3-scene.js";

function fakeViewer() {
  const parts = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BufferGeometry());
  parts.add(mesh);
  const scene = new THREE.Scene();
  scene.add(parts);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 100);
  camera.updateMatrixWorld();
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 800 });
  Object.defineProperty(canvas, "clientHeight", { value: 600 });
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  return {
    _subMeshes: { body: mesh },
    camera,
    domElement: canvas,
    getTheme: () => "dark",
    registerCanonicalCaptureHidden: vi.fn(() => vi.fn()),
    __parts: parts,
  };
}

// fake painter: never touches a 2d context
const fakePaint = ({ text }) => {
  const c = document.createElement("canvas");
  c.width = 40 * text.length;
  c.height = 128;
  return c;
};

const DRAWING = {
  itemId: "overall", tier: "static", pinned: false,
  segments: [0, 0, 0, 10, 0, 0],
  triangles: [0, 0, 0, 1, 0.5, 0, 1, -0.5, 0],
  labels: [{ text: "10.00 mm", param: null, center: [5, -2, 0], x: [1, 0, 0], y: [0, 1, 0], h: 4 }],
};

describe("createDimScene", () => {
  it("parents a group under the parts group and registers capture hiding", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    expect(viewer.__parts.children).toContain(scene.group);
    expect(viewer.registerCanonicalCaptureHidden).toHaveBeenCalledWith(scene.group);
  });

  it("builds lines, arrow fills and a label with the right render flags", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    const kids = scene.group.children;
    expect(kids.length).toBe(3); // lines + triangles + 1 label
    for (const k of kids) {
      expect(k.material.depthTest).toBe(false);
      expect(k.renderOrder === RENDER_ORDER_DIMS || k.renderOrder === RENDER_ORDER_LABELS).toBe(true);
    }
    const label = kids.find((k) => k.userData.pfDimItemId);
    expect(label.userData.pfDimItemId).toBe("overall");
  });

  it("update replaces previous drawings; clear empties", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    scene.update([DRAWING]);
    expect(scene.group.children.length).toBe(3);
    scene.clear();
    expect(scene.group.children.length).toBe(0);
  });

  it("tick mirrors a label viewed from behind (and holds within the deadband)", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    viewer.__parts.updateMatrixWorld(true);
    scene.tick(); // facing camera (+Z toward camera at z=100): no flip
    const label = scene.group.children.find((k) => k.userData.pfDimItemId);
    const q0 = label.quaternion.clone();
    viewer.camera.position.set(0, 0, -100);
    viewer.camera.updateMatrixWorld();
    scene.tick(); // viewed from behind: mirrored
    expect(label.quaternion.equals(q0)).toBe(false);
  });

  it("pickLabel finds the label under the pointer, null elsewhere", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    viewer.__parts.updateMatrixWorld(true);
    viewer.camera.lookAt(5, -2, 0);
    viewer.camera.updateMatrixWorld();
    // center of the viewport now aims at the label center
    expect(scene.pickLabel(400, 300)).toBe("overall");
    expect(scene.pickLabel(5, 5)).toBe(null);
  });

  it("setTheme recolors materials and repaints labels", () => {
    const viewer = fakeViewer();
    const paint = vi.fn(fakePaint);
    const scene = createDimScene(viewer, { paintLabel: paint });
    scene.update([DRAWING]);
    const before = paint.mock.calls.length;
    scene.setTheme("light");
    expect(paint.mock.calls.length).toBeGreaterThan(before);
    const lines = scene.group.children.find((k) => k.isLineSegments2 || k.type === "LineSegments2" || k.material.isLineMaterial);
    expect(lines.material.color.getHex()).toBe(DIM_THEME.light.static);
  });

  it("dispose detaches, unregisters and disposes", () => {
    const viewer = fakeViewer();
    const unregister = vi.fn();
    viewer.registerCanonicalCaptureHidden = vi.fn(() => unregister);
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    scene.dispose();
    expect(viewer.__parts.children).not.toContain(scene.group);
    expect(unregister).toHaveBeenCalled();
  });
});
