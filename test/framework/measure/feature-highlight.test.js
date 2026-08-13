// @vitest-environment happy-dom
// Shared feature-highlight helper: overlay mesh parenting, subset caching, disposal.
import { expect, test, vi } from "vitest";
import * as THREE from "three";
import { createFeatureHighlight } from "../../../src/framework/selection/feature-highlight.js";

function meshWithFeatures() {
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0,   // tri 0 -> feature 1
    0, 0, 0, 1, 1, 0, 0, 1, 0,   // tri 1 -> feature 2
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.userData.featureIds = new Uint16Array([1, 2]);
  geo.userData.features = ["top", "side"];
  return new THREE.Mesh(geo);
}

const viewer = () => ({ registerCutawayMaterial: vi.fn(() => vi.fn()) });

test("show(feature hit) parents a one-triangle overlay to the hit mesh", () => {
  const mesh = meshWithFeatures();
  const hl = createFeatureHighlight(viewer());
  hl.show({ mesh, subPart: "body", feature: { id: 1, label: "top" } });
  const overlay = mesh.children[0];
  expect(overlay.visible).toBe(true);
  expect(overlay.geometry.getAttribute("position").count).toBe(3);
  hl.clear();
  expect(overlay.visible).toBe(false);
  hl.dispose();
});

test("subset cache reuses geometry per (geometry, featureId)", () => {
  const mesh = meshWithFeatures();
  const hl = createFeatureHighlight(viewer());
  hl.show({ mesh, subPart: "body", feature: { id: 1, label: "top" } });
  const g1 = mesh.children[0].geometry;
  hl.show({ mesh, subPart: "body", feature: { id: 2, label: "side" } });
  hl.show({ mesh, subPart: "body", feature: { id: 1, label: "top" } });
  expect(mesh.children[0].geometry).toBe(g1);
  hl.dispose();
});

test("show without feature highlights the whole mesh geometry", () => {
  const mesh = meshWithFeatures();
  const hl = createFeatureHighlight(viewer());
  hl.show({ mesh, subPart: "body", feature: null });
  expect(mesh.children[0].geometry).toBe(mesh.geometry);
  hl.dispose();
});
