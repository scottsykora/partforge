// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import {
  createDimScene, DIM_THEME, RENDER_ORDER_DIMS, RENDER_ORDER_LABELS,
  labelWorldHeight, LABEL_SCREEN_PX, ARROW_SCREEN_PX, OVERSHOOT_SCREEN_PX,
} from "../../../src/framework/measure/dim3-scene.js";

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
  arrows: [{ tip: [0, 0, 0], inward: [1, 0, 0], perp: [0, 1, 0] }],
  tails: [{ origin: [10, 0, 0], dir: [1, 0, 0] }],
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
    expect(kids.length).toBe(4); // lines + 1 arrow + 1 tail + 1 label
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
    expect(scene.group.children.length).toBe(4);
    scene.clear();
    expect(scene.group.children.length).toBe(0);
  });

  it("tick sizes arrowheads and overshoot tails screen-constant", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    viewer.__parts.updateMatrixWorld(true);
    scene.tick();
    const dist = viewer.camera.position.length();
    const worldPerPx = labelWorldHeight(dist, viewer.camera.fov, 600) / LABEL_SCREEN_PX;
    const arrow = scene.group.children.find((k) => k.isMesh && !k.userData.pfDimItemId && k.geometry.type === "BufferGeometry");
    // both the segments run and the tail are LineSegments2 — the tail is the
    // one positioned at its dim-line end, the segments run stays at the origin
    const tail = scene.group.children.find((k) => k.isLineSegments2 && k.position.x === 10);
    expect(arrow.scale.x).toBeCloseTo(ARROW_SCREEN_PX * worldPerPx, 6);
    expect(tail.scale.x).toBeCloseTo(OVERSHOOT_SCREEN_PX * worldPerPx, 6);
    // the arrow's origin stays glued to its tip; scaling grows it away from it
    expect(arrow.position.toArray()).toEqual([0, 0, 0]);
    expect(tail.position.toArray()).toEqual([10, 0, 0]);
    // zoom in: decorations shrink in world units in lockstep
    viewer.camera.position.set(0, 0, dist / 2);
    viewer.camera.updateMatrixWorld();
    scene.tick();
    expect(arrow.scale.x).toBeCloseTo((ARROW_SCREEN_PX * worldPerPx) / 2, 6);
  });

  it("tick sizes labels screen-constant: one shared world height, tracking zoom", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    const second = {
      ...DRAWING, itemId: "pin:x", tier: "pinned",
      labels: [{ text: "5.00 mm", param: null, center: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], h: 8 }],
    };
    scene.update([DRAWING, second]);
    viewer.__parts.updateMatrixWorld(true);
    scene.tick();
    const [a, b] = scene.group.children.filter((k) => k.userData.pfDimItemId);
    const dist = viewer.camera.position.length(); // dim group sits at the world origin
    const hStar = labelWorldHeight(dist, viewer.camera.fov, 600);
    expect(hStar).toBeCloseTo((LABEL_SCREEN_PX * 2 * dist * Math.tan((viewer.camera.fov * Math.PI) / 360)) / 600, 9);
    // both labels display at the SAME world height despite different base h
    expect(a.scale.x * 4).toBeCloseTo(hStar, 6);
    expect(b.scale.x * 8).toBeCloseTo(hStar, 6);
    // zoom to half the distance: world height halves, so screen size holds
    viewer.camera.position.set(0, 0, dist / 2);
    viewer.camera.updateMatrixWorld();
    scene.tick();
    expect(a.scale.x * 4).toBeCloseTo(hStar / 2, 6);
  });

  it("tick keeps a resized label 0.85·displayHeight outside its dim line", () => {
    const viewer = fakeViewer();
    const scene = createDimScene(viewer, { paintLabel: fakePaint });
    scene.update([DRAWING]);
    viewer.__parts.updateMatrixWorld(true);
    scene.tick();
    const label = scene.group.children.find((k) => k.userData.pfDimItemId);
    const hStar = labelWorldHeight(viewer.camera.position.length(), viewer.camera.fov, 600);
    // placement: center [5,-2,0], y [0,1,0], h 4 → on-line anchor [5, 1.4, 0];
    // display position slides along -y by 0.85·hStar from that anchor
    expect(label.position.x).toBeCloseTo(5, 6);
    expect(label.position.z).toBeCloseTo(0, 6);
    expect(label.position.y).toBeCloseTo(1.4 - 0.85 * hStar, 6);
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

  it("bounds the label texture cache to live labels (mark-and-sweep on update)", () => {
    const viewer = fakeViewer();
    const paint = vi.fn(fakePaint);
    const scene = createDimScene(viewer, { paintLabel: paint });

    const mkDrawing = (itemId, texts) => ({
      itemId, tier: "static", pinned: false,
      segments: [0, 0, 0, 10, 0, 0],
      triangles: [],
      labels: texts.map((text, i) => ({
        text, param: null, center: [i, 0, 0], x: [1, 0, 0], y: [0, 1, 0], h: 4,
      })),
    });

    // Update 1: "A" and "C" (twice). A repeated text within one update should
    // hit the cache after the first paint, not repaint.
    scene.update([mkDrawing("item1", ["A", "C", "C"])]);
    expect(paint.mock.calls.length).toBe(2); // one paint for "A", one for "C"

    // Update 2: only "B" is live now. "A" and "C" are no longer referenced by
    // any label, so the sweep at the end of update() should drop them.
    scene.update([mkDrawing("item2", ["B"])]);
    expect(paint.mock.calls.length).toBe(3); // +1 for "B"; no repaint of A/C

    // Update 3: "A" again. Since it was swept out in update 2, this must be a
    // fresh cache miss (a repaint), proving growth is bounded rather than the
    // old "A" texture having lingered unbounded in the cache.
    scene.update([mkDrawing("item3", ["A"])]);
    expect(paint.mock.calls.length).toBe(4); // +1 for "A" repainted from scratch

    // The label currently on screen still renders correctly post-sweep.
    const label = scene.group.children.find((k) => k.userData.pfDimItemId === "item3");
    expect(label.material.map).toBeTruthy();
  });
});
