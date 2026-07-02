// @vitest-environment happy-dom
import { afterEach, expect, test } from "vitest";
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
