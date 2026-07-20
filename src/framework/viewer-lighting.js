import * as THREE from "three";

export function addViewerLights(scene) {
  const hemisphere = new THREE.HemisphereLight(0xdce9ff, 0x687586, 1.35);
  const key = new THREE.DirectionalLight(0xffffff, 1.45);
  key.position.set(8, 14, 10);
  const fill = new THREE.DirectionalLight(0xe5efff, 0.65);
  fill.position.set(-10, 6, -8);

  scene.add(hemisphere, key, fill);

  return { hemisphere, key, fill };
}
