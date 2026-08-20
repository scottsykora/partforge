// The perspective <-> orthographic framing pair. Pure, so the swap's only
// interesting property — that the part does not change size the instant the
// user hits the toggle — is unit-testable without a renderer.
//
// Perspective frames by DISTANCE; orthographic frames by a frustum height plus
// a zoom (OrbitControls dollies an ortho camera by changing camera.zoom, not by
// moving it). These two functions convert between the two descriptions.

const halfHeightAt = (fovDeg, distance) => distance * Math.tan((fovDeg * Math.PI) / 360);

export function orthoFrustum({ fovDeg, distance, aspect = 1 }) {
  const halfH = halfHeightAt(fovDeg, distance);
  const halfW = halfH * aspect;
  return { halfW, halfH, left: -halfW, right: halfW, top: halfH, bottom: -halfH };
}

export function perspectiveDistance({ halfH, zoom = 1, fovDeg }) {
  return halfH / (zoom * Math.tan((fovDeg * Math.PI) / 360));
}
