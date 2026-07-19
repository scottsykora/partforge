// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import * as THREE from "three";
import { attachHoverLabels } from "../src/framework/selection/hover.js";

const part = { parts: { one: { label: "Planter", views: ["v"] } }, views: { v: {} } };
const sync = (cb) => cb(); // run raycasts synchronously in tests

function makeViewer({ featured = true } = {}) {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const geo = new THREE.BoxGeometry(4, 4, 4).toNonIndexed();
  if (featured) {
    const nTri = geo.getAttribute("position").count / 3;
    geo.userData.featureIds = new Uint16Array(nTri).fill(1);
    geo.userData.features = ["Drainage hole"];
  }
  const mesh = new THREE.Mesh(geo);
  mesh.name = "one";
  mesh.visible = true;
  const group = new THREE.Group();
  group.add(mesh);
  group.updateMatrixWorld(true);
  const domElement = document.createElement("div");
  domElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  document.body.appendChild(domElement);
  return { camera, domElement, _subMeshes: { one: mesh }, _group: group };
}

const move = (el, x, y) => el.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));

afterEach(() => { document.body.innerHTML = ""; });

test("hovering a labeled feature shows 'feature · sub-part' and a highlight overlay", () => {
  const viewer = makeViewer();
  const h = attachHoverLabels(viewer, { part, schedule: sync });
  move(viewer.domElement, 100, 100);
  const tip = document.getElementById("pf-hover-tip");
  expect(tip.classList.contains("show")).toBe(true);
  expect(tip.querySelector("b").textContent).toBe("Drainage hole");
  expect(tip.querySelector(".pf-hover-sub").textContent).toBe("Planter");
  // overlay mesh added beside the sub-mesh
  const overlay = viewer._subMeshes.one.parent.children.find((c) => c !== viewer._subMeshes.one);
  expect(overlay).toBeDefined();
  expect(overlay.visible).toBe(true);
  h.detach();
});

test("hovering unlabeled geometry shows only the sub-part label, no overlay", () => {
  const viewer = makeViewer({ featured: false });
  const h = attachHoverLabels(viewer, { part, schedule: sync });
  move(viewer.domElement, 100, 100);
  const tip = document.getElementById("pf-hover-tip");
  expect(tip.classList.contains("show")).toBe(true);
  expect(tip.querySelector("b").textContent).toBe("Planter");
  const overlay = viewer._subMeshes.one.parent.children.find((c) => c !== viewer._subMeshes.one && c.visible);
  expect(overlay).toBeUndefined();
  h.detach();
});

test("a miss hides the tooltip and overlay", () => {
  const viewer = makeViewer();
  const h = attachHoverLabels(viewer, { part, schedule: sync });
  move(viewer.domElement, 100, 100);
  move(viewer.domElement, 1, 1); // corner → miss
  expect(document.getElementById("pf-hover-tip").classList.contains("show")).toBe(false);
  h.detach();
});

test("pointerdown (orbiting) suppresses the tooltip until the next move", () => {
  const viewer = makeViewer();
  const h = attachHoverLabels(viewer, { part, schedule: sync });
  move(viewer.domElement, 100, 100);
  viewer.domElement.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  expect(document.getElementById("pf-hover-tip").classList.contains("show")).toBe(false);
  h.detach();
});

test("detach removes the tooltip element and listeners", () => {
  const viewer = makeViewer();
  const h = attachHoverLabels(viewer, { part, schedule: sync });
  h.detach();
  expect(document.getElementById("pf-hover-tip")).toBeNull();
});

test("hover overlay material follows cutaway clipping until detach", () => {
  const viewer = makeViewer();
  const unregister = vi.fn();
  viewer.registerCutawayMaterial = vi.fn(() => unregister);

  const hover = attachHoverLabels(viewer, { part, schedule: sync });

  expect(viewer.registerCutawayMaterial).toHaveBeenCalledTimes(1);
  const material = viewer.registerCutawayMaterial.mock.calls[0][0];
  expect(material).toBeInstanceOf(THREE.MeshBasicMaterial);

  move(viewer.domElement, 100, 100);
  const overlay = viewer._group.children.find(
    (child) => child !== viewer._subMeshes.one,
  );
  expect(overlay.material).toBe(material);
  // Cutaway feature lines start at render order 2,000,000; the translucent
  // highlight must render after them so it remains legible on retained faces.
  expect(overlay.renderOrder).toBeGreaterThan(2_000_000);

  hover.detach();
  expect(unregister).toHaveBeenCalledTimes(1);
});
