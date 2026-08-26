// Framing math for the showcase capture (viewer.js captureCurrentFromScene):
// where the visible geometry lands in the rendered frame, and the centred
// sub-window that puts it in the middle. Pure three.js math, no GL — the
// renderer builds its camera through makeCaptureCamera too, so what this
// module projects through is exactly what renderOffscreen draws with.
//
// Why vertices and not bounding boxes: the projection of a triangle mesh is a
// union of projected triangles, and a triangle's projected extremes are its
// corners — so the min/max over projected VERTICES is the exact 2-D extent of
// the rendered silhouette at any angle, where a projected 3-D bounding box
// over-reports by up to the box's slack at diagonal views.
//
// Why a view offset and not a pixel crop: three's setViewOffset renders a
// sub-window of a larger virtual frame with the same projection, so the
// recentred image is a pixel-exact crop of what the user framed — at the full
// requested resolution and with no second JPEG encode.
import * as THREE from "three";

const NEAR = 0.1;
const FAR = 1000;

// The temp camera an offscreen capture renders with. `aspect` is the FULL
// frame's aspect; a recentred sub-window is applied afterwards by the caller
// via setViewOffset, which (for a PerspectiveCamera) keeps this aspect as the
// virtual full frame's. Matrices are updated so a caller can project through
// matrixWorldInverse without a render having happened first.
export function makeCaptureCamera(
  { position, up, target },
  { aspect = 1, fov = 45, projection = "perspective", orthoHalfH = 1 } = {},
) {
  const cam = projection === "orthographic"
    ? new THREE.OrthographicCamera(-orthoHalfH * aspect, orthoHalfH * aspect, orthoHalfH, -orthoHalfH, NEAR, FAR)
    : new THREE.PerspectiveCamera(fov, aspect, NEAR, FAR);
  cam.position.set(position[0], position[1], position[2]);
  cam.up.set(up[0], up[1], up[2]);
  cam.lookAt(target[0], target[1], target[2]);
  cam.updateMatrixWorld(true);
  return cam;
}

// Exact 2-D extent of the meshes' projected vertices, as fractions of the
// frame with a top-left origin ({ left, top, right, bottom }; values outside
// [0, 1] mean the geometry runs past that edge). Null when there is nothing
// to project, or when ANY vertex would be clipped by the frustum's near/far
// planes or sits behind the camera — such a vertex is not in the picture, so
// no honest extent exists and the caller should leave the framing alone.
export function projectedExtent(camera, meshes) {
  const toClip = new THREE.Matrix4();
  const v = new THREE.Vector4();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let any = false;
  for (const mesh of meshes ?? []) {
    const pos = mesh?.geometry?.attributes?.position;
    if (!pos || !pos.count) continue;
    mesh.updateWorldMatrix(true, false);
    toClip.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(mesh.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i), 1).applyMatrix4(toClip);
      const w = v.w;
      if (!(w > 0) || v.z < -w || v.z > w) return null;
      const x = v.x / w, y = v.y / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      any = true;
    }
  }
  if (!any) return null;
  return { left: (minX + 1) / 2, right: (maxX + 1) / 2, top: (1 - maxY) / 2, bottom: (1 - minY) / 2 };
}

// The largest sub-window centred on the extent's centre that still fits the
// frame, as { x, y, width, height } fractions. Centring on the extent with
// maximal half-extents min(c, 1 - c) gives equal margins on both sides of each
// axis and is guaranteed to contain the extent (which always lies within
// [0, 2c] and [2c - 1, 1]). Null — leave the framing alone — when the extent
// runs past any edge (the user zoomed in on purpose), when it already fills the
// frame symmetrically (nothing to do), or when there is no usable extent.
// `eps` forgives the ~1 px feature-edge line that can overhang a vertex.
export function centeredCropView(extent, { eps = 0.002 } = {}) {
  if (!extent) return null;
  const { left, top, right, bottom } = extent;
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  if (left < -eps || top < -eps || right > 1 + eps || bottom > 1 + eps) return null;
  if (!(right > left) || !(bottom > top)) return null;
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  const hw = Math.min(cx, 1 - cx), hh = Math.min(cy, 1 - cy);
  if (hw >= 0.5 - eps && hh >= 0.5 - eps) return null;
  return { x: Math.max(0, cx - hw), y: Math.max(0, cy - hh), width: 2 * hw, height: 2 * hh };
}

// Turn a fractional crop of a frame with the given aspect into what
// renderOffscreen needs: the output size (crop rendered at `long` px on its
// long edge, so recentring costs no resolution) and the setViewOffset
// arguments describing it as a sub-window of a larger virtual frame.
export function cropRenderFrame(crop, { aspect, long }) {
  const cropAspect = (crop.width * aspect) / crop.height;
  const width = cropAspect >= 1 ? long : Math.max(1, Math.round(long * cropAspect));
  const height = cropAspect >= 1 ? Math.max(1, Math.round(long / cropAspect)) : long;
  const fullWidth = width / crop.width;
  const fullHeight = height / crop.height;
  return {
    width, height,
    viewOffset: { fullWidth, fullHeight, x: crop.x * fullWidth, y: crop.y * fullHeight },
  };
}

// The whole pipeline for captureCurrentFromScene: the render frame that puts
// the visible geometry in the middle, or null when the current framing should
// be kept as-is (part cropped by the viewport, already centred, or nothing to
// measure). `meshes` are the visible sub-part meshes; the camera parameters
// must be the same ones the render will use.
export function recenteredView(pose, { aspect, fov, projection, orthoHalfH, meshes, long }) {
  const camera = makeCaptureCamera(pose, { aspect, fov, projection, orthoHalfH });
  const crop = centeredCropView(projectedExtent(camera, meshes));
  return crop ? cropRenderFrame(crop, { aspect, long }) : null;
}
