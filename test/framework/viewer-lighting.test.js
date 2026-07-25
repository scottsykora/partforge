import { expect, test } from "vitest";
import * as THREE from "three";

import {
  addViewerLights,
  captureLightPoses,
  createCaptureLights,
} from "../../src/framework/viewer-lighting.js";
import { CANONICAL_VIEWS, cameraPoseForView } from "../../src/framework/view-angles.js";

const BOUNDS = { center: [0, 0, 0], radius: 10 };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

test("adds the technical CAD light rig in scene order and returns each light", () => {
  const scene = new THREE.Scene();

  const lights = addViewerLights(scene);
  const { hemisphere, key, fill } = lights;

  expect(lights).toEqual({ hemisphere, key, fill });
  expect(scene.children).toEqual([hemisphere, key, fill]);
  expect(hemisphere).toBeInstanceOf(THREE.HemisphereLight);
  expect(hemisphere.color.getHex()).toBe(0xdce9ff);
  expect(hemisphere.groundColor.getHex()).toBe(0x687586);
  expect(hemisphere.intensity).toBe(1.35);

  expect(key).toBeInstanceOf(THREE.DirectionalLight);
  expect(key.color.getHex()).toBe(0xffffff);
  expect(key.intensity).toBe(1.45);
  expect(key.position.toArray()).toEqual([8, 14, 10]);

  expect(fill).toBeInstanceOf(THREE.DirectionalLight);
  expect(fill.color.getHex()).toBe(0xe5efff);
  expect(fill.intensity).toBe(0.65);
  expect(fill.position.toArray()).toEqual([-10, 6, -8]);

  expect(key.intensity).toBeGreaterThan(fill.intensity);
  expect(key.position.dot(fill.position)).toBeLessThan(0);
  expect([hemisphere, key, fill].every((light) => light.castShadow === false)).toBe(true);
});

test("capture lights match the live key/fill and stay out of the scene", () => {
  const scene = new THREE.Scene();
  const live = addViewerLights(scene);
  const capture = createCaptureLights();

  expect(capture.key.color.getHex()).toBe(live.key.color.getHex());
  expect(capture.key.intensity).toBe(live.key.intensity);
  expect(capture.fill.color.getHex()).toBe(live.fill.color.getHex());
  expect(capture.fill.intensity).toBe(live.fill.intensity);
  // the viewer adds/removes these around a single offscreen render; the factory must not
  expect(scene.children).toEqual([live.hemisphere, live.key, live.fill]);
});

test("every canonical view is front-lit by the capture rig", () => {
  for (const view of CANONICAL_VIEWS) {
    const pose = cameraPoseForView(view, BOUNDS);
    const { key, fill } = captureLightPoses(pose);
    const forward = norm(sub(pose.target, pose.position));

    // Both lights shine mostly along the view axis, so geometry the camera can see is
    // lit from roughly behind it — never a flat, ambient-only silhouette.
    expect(dot(norm(sub(pose.target, key)), forward)).toBeGreaterThan(0.5);
    expect(dot(norm(sub(pose.target, fill)), forward)).toBeGreaterThan(0.5);
    // ...but off-axis, so surfaces facing the camera still get a shading gradient.
    expect(dot(norm(sub(pose.target, key)), forward)).toBeLessThan(0.95);
    expect(key.every(Number.isFinite)).toBe(true);
    expect(fill.every(Number.isFinite)).toBe(true);
  }
});

test("the bottom view is lit from below, where the world-fixed key never reaches", () => {
  const pose = cameraPoseForView("bottom", BOUNDS);
  const { key, fill } = captureLightPoses(pose);

  // The live rig's key sits at y=+14 and contributes nothing to a downward-facing
  // normal — the whole reason an agent's `bottom` capture used to come back flat.
  expect(key[1]).toBeLessThan(0);
  expect(fill[1]).toBeLessThan(0);
  // and the key is offset to one side, not parked on the camera
  expect(Math.abs(key[0])).toBeGreaterThan(0);
});

test("a degenerate up vector still yields finite light positions", () => {
  const { key, fill } = captureLightPoses({
    position: [0, 0, 30],
    up: [0, 0, 1], // parallel to the view axis
    target: [0, 0, 0],
  });

  expect(key.every(Number.isFinite)).toBe(true);
  expect(fill.every(Number.isFinite)).toBe(true);
});
