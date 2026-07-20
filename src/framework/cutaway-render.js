import * as THREE from "three";

// Stencil/cap passes for every section are kept below all clipped surfaces.
// This leaves a large, deterministic ordering range for assemblies while making
// surface/edge ordering independent of the number of subparts.
const SURFACE_ORDER_BASE = 1_000_000;
const EDGE_ORDER_BASE = 2_000_000;
const SECTION_ORDER_STRIDE = 2;
export const CUTAWAY_OVERLAY_RENDER_ORDER = 3_000_000;

export function createHatchMaterial({ color, opacity, inkColor = 0x1c232d }) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uBase: { value: new THREE.Color(color) },
      uInk: { value: new THREE.Color(inkColor) },
      uOpacity: { value: opacity },
      uScale: { value: 1 },
    },
    vertexShader: `
      varying vec2 vUv;

      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform vec3 uBase;
      uniform vec3 uInk;
      uniform float uOpacity;
      uniform float uScale;

      void main() {
        float coordinate = (vUv.x + vUv.y) * uScale;
        float distanceToLine = abs(fract(coordinate) - 0.5);
        float antialias = max(fwidth(coordinate), 0.001);
        float stripe = 1.0 - smoothstep(
          0.08 - antialias,
          0.08 + antialias,
          distanceToLine
        );
        gl_FragColor = vec4(mix(uBase, uInk, stripe), uOpacity);
        #include <colorspace_fragment>
      }
    `,
    transparent: opacity < 1,
    depthWrite: opacity >= 1,
    forceSinglePass: true,
  });

  material.userData.setHatch = ({ spacing, size }) => {
    material.uniforms.uScale.value = size / spacing * 5;
  };
  material.userData.setInkColor = (color) => {
    material.uniforms.uInk.value.set(color);
  };

  return material;
}

function stencilMaterial(side, operation, plane) {
  const material = new THREE.MeshBasicMaterial({
    side,
    depthWrite: false,
    depthTest: false,
    colorWrite: false,
  });
  material.clippingPlanes = [plane];
  material.stencilWrite = true;
  material.stencilFunc = THREE.AlwaysStencilFunc;
  material.stencilFail = THREE.KeepStencilOp;
  material.stencilZFail = THREE.KeepStencilOp;
  material.stencilZPass = operation;
  return material;
}

function cloneClipped(material, plane, ownedMaterials) {
  if (Array.isArray(material)) {
    return material.map((entry) => cloneClipped(entry, plane, ownedMaterials));
  }
  const clone = material.clone();
  clone.clippingPlanes = [plane];
  clone.needsUpdate = true;
  ownedMaterials.add(clone);
  return clone;
}

function firstMaterial(material) {
  return Array.isArray(material) ? material[0] : material;
}

function makeTransparent(material) {
  if (Array.isArray(material)) {
    for (const entry of material) makeTransparent(entry);
    return;
  }
  material.transparent = true;
  material.needsUpdate = true;
}

function setLineResolution(material, width, height) {
  if (Array.isArray(material)) {
    for (const entry of material) setLineResolution(entry, width, height);
    return;
  }
  if (material?.isLineMaterial) material.resolution.set(width, height);
}

export function createSectionRenderSet({
  scene,
  mesh,
  edgeLines,
  plane,
  capGeometry,
  order,
}) {
  let originalMeshMaterial = mesh.material;
  let originalEdgeMaterial = edgeLines?.material;
  const originalMeshOrder = mesh.renderOrder;
  const originalEdgeOrder = edgeLines?.renderOrder;
  const ownedMaterials = new Set();
  let viewportSize = null;

  let clippedMeshMaterial = cloneClipped(originalMeshMaterial, plane, ownedMaterials);
  let clippedEdgeMaterial = edgeLines
    ? cloneClipped(originalEdgeMaterial, plane, ownedMaterials)
    : null;

  const backMaterial = stencilMaterial(
    THREE.BackSide,
    THREE.IncrementWrapStencilOp,
    plane,
  );
  const frontMaterial = stencilMaterial(
    THREE.FrontSide,
    THREE.DecrementWrapStencilOp,
    plane,
  );
  ownedMaterials.add(backMaterial);
  ownedMaterials.add(frontMaterial);

  const sourceMaterial = firstMaterial(originalMeshMaterial);
  const capMaterial = createHatchMaterial({
    color: sourceMaterial?.color ?? 0x9fb4cc,
    opacity: sourceMaterial?.opacity ?? 1,
  });
  capMaterial.side = THREE.DoubleSide;
  capMaterial.stencilWrite = true;
  capMaterial.stencilFunc = THREE.NotEqualStencilFunc;
  capMaterial.stencilRef = 0;
  capMaterial.stencilFail = THREE.ReplaceStencilOp;
  capMaterial.stencilZFail = THREE.ReplaceStencilOp;
  capMaterial.stencilZPass = THREE.ReplaceStencilOp;
  ownedMaterials.add(capMaterial);

  // three.js sorts opaque and transparent draws in separate lists. Keeping a
  // translucent section's stencil, cap, surface, and edges in the transparent
  // list preserves the renderOrder-based isolation between subparts.
  if (capMaterial.transparent) {
    backMaterial.transparent = true;
    frontMaterial.transparent = true;
    if (clippedEdgeMaterial) makeTransparent(clippedEdgeMaterial);
  }

  // Parenting the stencil meshes to the source mesh makes their local identity
  // transform follow every current and future source transform exactly.
  const back = new THREE.Mesh(mesh.geometry, backMaterial);
  const front = new THREE.Mesh(mesh.geometry, frontMaterial);
  mesh.add(back, front);

  const cap = new THREE.Mesh(capGeometry, capMaterial);
  cap.onAfterRender = (renderer) => renderer.clearStencil();
  scene.add(cap);

  const stencilOrder = order * SECTION_ORDER_STRIDE;
  back.renderOrder = stencilOrder;
  front.renderOrder = stencilOrder;
  cap.renderOrder = stencilOrder + 1;

  let enabled = false;
  let visible = mesh.visible;
  let disposed = false;

  function updateHelperVisibility() {
    const on = enabled && visible && !disposed;
    back.visible = on;
    front.visible = on;
    cap.visible = on;
  }

  back.visible = false;
  front.visible = false;
  cap.visible = false;

  function setEnabled(on) {
    if (disposed) return;
    enabled = Boolean(on);
    if (enabled) {
      mesh.material = clippedMeshMaterial;
      mesh.renderOrder = SURFACE_ORDER_BASE + order * SECTION_ORDER_STRIDE;
      if (edgeLines) {
        edgeLines.material = clippedEdgeMaterial;
        edgeLines.renderOrder = EDGE_ORDER_BASE + order;
      }
    } else {
      mesh.material = originalMeshMaterial;
      mesh.renderOrder = originalMeshOrder;
      if (edgeLines) {
        edgeLines.material = originalEdgeMaterial;
        edgeLines.renderOrder = originalEdgeOrder;
      }
    }
    updateHelperVisibility();
  }

  function setVisible(on) {
    if (disposed) return;
    visible = Boolean(on);
    updateHelperVisibility();
  }

  function setGeometry(geometry) {
    if (disposed) return;
    back.geometry = geometry;
    front.geometry = geometry;
  }

  function setCapPose({ position, quaternion, size, spacing }) {
    if (disposed) return;
    cap.position.copy(position);
    cap.quaternion.copy(quaternion);
    cap.scale.setScalar(size);
    capMaterial.userData.setHatch({ spacing, size });
  }

  function setHatchInk(color) {
    if (disposed) return;
    capMaterial.userData.setInkColor(color);
  }

  function setViewportSize(width, height) {
    if (disposed) return;
    viewportSize = { width, height };
    setLineResolution(clippedEdgeMaterial, width, height);
  }

  function disposeClipped(material) {
    if (Array.isArray(material)) {
      for (const entry of material) disposeClipped(entry);
      return;
    }
    if (!material) return;
    ownedMaterials.delete(material);
    material.dispose();
  }

  function refreshSourceMaterial(
    meshMaterial = originalMeshMaterial,
    lineMaterial = originalEdgeMaterial,
  ) {
    if (disposed) return false;

    const nextMeshMaterial = meshMaterial === clippedMeshMaterial
      ? originalMeshMaterial
      : meshMaterial;
    const nextLineMaterial = lineMaterial === clippedEdgeMaterial
      ? originalEdgeMaterial
      : lineMaterial;
    disposeClipped(clippedMeshMaterial);
    disposeClipped(clippedEdgeMaterial);
    originalMeshMaterial = nextMeshMaterial;
    originalEdgeMaterial = nextLineMaterial;
    clippedMeshMaterial = cloneClipped(nextMeshMaterial, plane, ownedMaterials);
    clippedEdgeMaterial = edgeLines
      ? cloneClipped(nextLineMaterial, plane, ownedMaterials)
      : null;
    if (viewportSize) {
      setLineResolution(
        clippedEdgeMaterial,
        viewportSize.width,
        viewportSize.height,
      );
    }

    const source = firstMaterial(nextMeshMaterial);
    capMaterial.uniforms.uBase.value.copy(source?.color ?? new THREE.Color(0x9fb4cc));
    capMaterial.uniforms.uOpacity.value = source?.opacity ?? 1;
    capMaterial.opacity = source?.opacity ?? 1;
    capMaterial.transparent = source?.transparent ?? capMaterial.opacity < 1;
    capMaterial.depthWrite = source?.depthWrite ?? !capMaterial.transparent;
    capMaterial.needsUpdate = true;
    backMaterial.transparent = capMaterial.transparent;
    frontMaterial.transparent = capMaterial.transparent;
    if (clippedEdgeMaterial && capMaterial.transparent) makeTransparent(clippedEdgeMaterial);

    if (enabled) {
      mesh.material = clippedMeshMaterial;
      if (edgeLines) edgeLines.material = clippedEdgeMaterial;
    } else {
      mesh.material = originalMeshMaterial;
      if (edgeLines) edgeLines.material = originalEdgeMaterial;
    }
    return true;
  }

  function dispose() {
    if (disposed) return;
    setEnabled(false);
    disposed = true;
    mesh.remove(back, front);
    scene.remove(cap);
    for (const material of ownedMaterials) material.dispose();
  }

  return {
    back,
    front,
    cap,
    setEnabled,
    setVisible,
    setGeometry,
    setCapPose,
    setHatchInk,
    setViewportSize,
    refreshSourceMaterial,
    dispose,
  };
}
