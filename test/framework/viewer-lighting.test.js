import { expect, test } from "vitest";
import * as THREE from "three";

import { addViewerLights } from "../../src/framework/viewer-lighting.js";

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
