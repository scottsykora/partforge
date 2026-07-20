import { describe, expect, test, vi } from "vitest";
import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

import {
  HATCH_LINE_CSS_PX,
  HATCH_PERIOD_CSS_PX,
  createHatchMaterial,
  createSectionRenderSet,
} from "../../src/framework/cutaway-render.js";

function createFixture({
  order = 0,
  inkColor = 0x2468ac,
  edgeMaterial: providedEdgeMaterial,
} = {}) {
  const scene = new THREE.Scene();
  const parent = new THREE.Group();
  parent.position.set(4, 5, 6);
  parent.rotation.set(0.1, 0.2, 0.3);
  scene.add(parent);

  const geometry = new THREE.BoxGeometry(2, 3, 4);
  const material = new THREE.MeshStandardMaterial({
    color: 0x336699,
    opacity: 0.65,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(1, 2, 3);
  mesh.rotation.set(0.4, 0.5, 0.6);
  mesh.scale.set(1.2, 0.8, 1.5);
  mesh.renderOrder = 17;
  parent.add(mesh);

  const edgeGeometry = new THREE.EdgesGeometry(geometry);
  const edgeMaterial = providedEdgeMaterial
    ?? new THREE.LineBasicMaterial({ color: 0x111111 });
  const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  edgeLines.renderOrder = 23;
  parent.add(edgeLines);

  const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
  const capGeometry = new THREE.PlaneGeometry(1, 1);
  const renderSet = createSectionRenderSet({
    scene,
    mesh,
    edgeLines,
    plane,
    capGeometry,
    order,
    inkColor,
  });

  return {
    scene,
    geometry,
    material,
    mesh,
    edgeGeometry,
    edgeMaterial,
    edgeLines,
    plane,
    capGeometry,
    renderSet,
  };
}

describe("createHatchMaterial", () => {
  test("creates a screen-space antialiased 45-degree hatch shader", () => {
    const material = createHatchMaterial({
      color: 0x336699,
      opacity: 0.65,
      inkColor: 0x1c232d,
    });

    expect(material).toBeInstanceOf(THREE.ShaderMaterial);
    expect(material.uniforms.uBase.value.getHex()).toBe(0x336699);
    expect(material.uniforms.uOpacity.value).toBe(0.65);
    expect(material.uniforms.uScale.value).toBe(1);
    expect(material.uniforms.uPixelRatio.value).toBe(1);
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.vertexShader).not.toContain("vUv");
    expect(material.fragmentShader).not.toContain("vUv");
    expect(material.fragmentShader).toContain("uniform float uPixelRatio");
    expect(material.fragmentShader).toContain(
      "gl_FragCoord.xy / uPixelRatio",
    );
    expect(material.fragmentShader).toContain("normalize(vec2(1.0, 1.0))");
    expect(material.fragmentShader).toContain("fwidth(axisPixel)");
    expect(material.fragmentShader).toContain(
      "mod(axisPixel, HATCH_PERIOD_CSS_PX)",
    );
    expect(material.fragmentShader).toContain(
      "min(wrapped, HATCH_PERIOD_CSS_PX - wrapped)",
    );
    expect(material.fragmentShader).toContain("HATCH_LINE_CSS_PX * 0.5");
    expect(material.fragmentShader).toMatch(
      /float stripe = 1\.0 - smoothstep\(\s*halfLine - antialias,\s*halfLine \+ antialias,\s*distanceToLine\s*\);/,
    );
    expect(material.fragmentShader).toContain("mix(uBase, uInk, stripe)");
    expect(material.fragmentShader).toMatch(
      /gl_FragColor\s*=.*;[\s\S]*#include <colorspace_fragment>/,
    );
  });

  test("defines exact CSS-pixel hatch dimensions from exported constants", () => {
    const material = createHatchMaterial({
      color: 0x336699,
      opacity: 1,
      inkColor: 0x1c232d,
    });

    expect(HATCH_PERIOD_CSS_PX).toBe(10);
    expect(HATCH_LINE_CSS_PX).toBe(2);
    expect(material.fragmentShader).toContain(
      `const float HATCH_PERIOD_CSS_PX = ${HATCH_PERIOD_CSS_PX.toFixed(1)};`,
    );
    expect(material.fragmentShader).toContain(
      `const float HATCH_LINE_CSS_PX = ${HATCH_LINE_CSS_PX.toFixed(1)};`,
    );
  });

  test.each([
    [2, 2],
    [0.5, 0.5],
    [0, 1],
    [-1, 1],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
    [undefined, 1],
  ])("sanitizes screen scale %s to %s", (pixelRatio, expected) => {
    const material = createHatchMaterial({
      color: 0x336699,
      opacity: 1,
      inkColor: 0x1c232d,
    });

    material.userData.setScreenScale(pixelRatio);

    expect(material.uniforms.uPixelRatio.value).toBe(expected);
  });

  test("renders a double-sided transparent hatch in one draw", () => {
    const material = createHatchMaterial({
      color: 0x336699,
      opacity: 0.65,
      inkColor: 0x1c232d,
    });

    expect(material.forceSinglePass).toBe(true);
  });

  test("updates hatch scale and ink color without replacing uniform colors", () => {
    const material = createHatchMaterial({
      color: 0xabcdef,
      opacity: 1,
      inkColor: 0x1c232d,
    });
    const ink = material.uniforms.uInk.value;

    expect(ink.getHex()).toBe(0x1c232d);

    material.userData.setHatch({ spacing: 2.5, size: 40 });
    material.userData.setInkColor(0x33414f);

    expect(material.uniforms.uScale.value).toBe(160);
    expect(material.uniforms.uInk.value).toBe(ink);
    expect(ink.getHex()).toBe(0x33414f);
    expect(material.transparent).toBe(false);
    expect(material.depthWrite).toBe(true);
  });
});

describe("createSectionRenderSet", () => {
  test("initializes the cap with its explicitly injected ink color", () => {
    const { renderSet } = createFixture({ inkColor: 0x2468ac });

    expect(renderSet.cap.material.uniforms.uInk.value.getHex()).toBe(0x2468ac);
  });

  test("configures isolated increment, decrement, and cap stencil passes", () => {
    const { renderSet } = createFixture();

    for (const pass of [renderSet.back, renderSet.front]) {
      expect(pass.material.depthWrite).toBe(false);
      expect(pass.material.depthTest).toBe(false);
      expect(pass.material.colorWrite).toBe(false);
      expect(pass.material.stencilWrite).toBe(true);
      expect(pass.material.stencilFunc).toBe(THREE.AlwaysStencilFunc);
      expect(pass.material.stencilFail).toBe(THREE.KeepStencilOp);
      expect(pass.material.stencilZFail).toBe(THREE.KeepStencilOp);
    }
    expect(renderSet.back.material.side).toBe(THREE.BackSide);
    expect(renderSet.back.material.stencilZPass).toBe(THREE.IncrementWrapStencilOp);
    expect(renderSet.front.material.side).toBe(THREE.FrontSide);
    expect(renderSet.front.material.stencilZPass).toBe(THREE.DecrementWrapStencilOp);
    expect(renderSet.back.material.transparent).toBe(renderSet.cap.material.transparent);
    expect(renderSet.front.material.transparent).toBe(renderSet.cap.material.transparent);

    expect(renderSet.cap.material.stencilWrite).toBe(true);
    expect(renderSet.cap.material.stencilFunc).toBe(THREE.NotEqualStencilFunc);
    expect(renderSet.cap.material.stencilRef).toBe(0);
    expect(renderSet.cap.material.stencilFail).toBe(THREE.ReplaceStencilOp);
    expect(renderSet.cap.material.stencilZFail).toBe(THREE.ReplaceStencilOp);
    expect(renderSet.cap.material.stencilZPass).toBe(THREE.ReplaceStencilOp);

    const renderer = { clearStencil: vi.fn() };
    renderSet.cap.onAfterRender(renderer);
    expect(renderer.clearStencil).toHaveBeenCalledOnce();
  });

  test("enables clipped clones with one stable plane and restores exact originals", () => {
    const { material, mesh, edgeMaterial, edgeLines, plane, renderSet } = createFixture();

    expect(renderSet.back.visible).toBe(false);
    expect(renderSet.front.visible).toBe(false);
    expect(renderSet.cap.visible).toBe(false);

    renderSet.setEnabled(true);

    expect(mesh.material).not.toBe(material);
    expect(mesh.material.clippingPlanes).toEqual([plane]);
    expect(mesh.material.clippingPlanes[0]).toBe(plane);
    expect(edgeLines.material).not.toBe(edgeMaterial);
    expect(edgeLines.material.clippingPlanes[0]).toBe(plane);
    expect(edgeLines.material.transparent).toBe(true);
    expect(renderSet.back.material.clippingPlanes[0]).toBe(plane);
    expect(renderSet.front.material.clippingPlanes[0]).toBe(plane);
    expect(renderSet.back.visible).toBe(true);
    expect(renderSet.front.visible).toBe(true);
    expect(renderSet.cap.visible).toBe(true);

    renderSet.setVisible(false);
    expect(renderSet.back.visible).toBe(false);
    expect(renderSet.front.visible).toBe(false);
    expect(renderSet.cap.visible).toBe(false);

    renderSet.setVisible(true);
    renderSet.setEnabled(false);
    expect(mesh.material).toBe(material);
    expect(edgeLines.material).toBe(edgeMaterial);
    expect(mesh.renderOrder).toBe(17);
    expect(edgeLines.renderOrder).toBe(23);
    expect(renderSet.back.visible).toBe(false);
    expect(renderSet.front.visible).toBe(false);
    expect(renderSet.cap.visible).toBe(false);
  });

  test("shares source geometry and follows the mesh world transform", () => {
    const { mesh, geometry, renderSet } = createFixture();
    const replacement = new THREE.SphereGeometry(2);

    expect(renderSet.back.geometry).toBe(geometry);
    expect(renderSet.front.geometry).toBe(geometry);
    expect(renderSet.back.parent).toBe(mesh);
    expect(renderSet.front.parent).toBe(mesh);

    mesh.updateWorldMatrix(true, true);
    expect(renderSet.back.matrixWorld.equals(mesh.matrixWorld)).toBe(true);
    expect(renderSet.front.matrixWorld.equals(mesh.matrixWorld)).toBe(true);

    renderSet.setGeometry(replacement);
    expect(renderSet.back.geometry).toBe(replacement);
    expect(renderSet.front.geometry).toBe(replacement);
  });

  test("copies the cap pose, scales it, and updates hatch density", () => {
    const { scene, capGeometry, renderSet } = createFixture();
    const position = new THREE.Vector3(7, 8, 9);
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.6, 0.2));

    renderSet.setCapPose({ position, quaternion, size: 48, spacing: 3 });

    expect(renderSet.cap.parent).toBe(scene);
    expect(renderSet.cap.geometry).toBe(capGeometry);
    expect(renderSet.cap.position.equals(position)).toBe(true);
    expect(renderSet.cap.position).not.toBe(position);
    expect(renderSet.cap.quaternion.equals(quaternion)).toBe(true);
    expect(renderSet.cap.quaternion).not.toBe(quaternion);
    expect(renderSet.cap.scale.toArray()).toEqual([48, 48, 48]);
    expect(renderSet.cap.material.uniforms.uScale.value).toBe(160);
  });

  test("keeps every cap isolated before all clipped surfaces and edge lines", () => {
    const first = createFixture({ order: 2 });
    const second = createFixture({ order: 7 });

    first.renderSet.setEnabled(true);
    second.renderSet.setEnabled(true);

    expect(first.renderSet.back.renderOrder).toBe(first.renderSet.front.renderOrder);
    expect(first.renderSet.back.renderOrder).toBeLessThan(first.renderSet.cap.renderOrder);
    expect(first.renderSet.cap.renderOrder).toBeLessThan(second.renderSet.back.renderOrder);
    expect(second.renderSet.back.renderOrder).toBeLessThan(second.renderSet.cap.renderOrder);
    expect(second.renderSet.cap.renderOrder).toBeLessThan(first.mesh.renderOrder);
    expect(second.renderSet.cap.renderOrder).toBeLessThan(second.mesh.renderOrder);
    expect(first.mesh.renderOrder).toBeLessThan(first.edgeLines.renderOrder);
    expect(second.mesh.renderOrder).toBeLessThan(second.edgeLines.renderOrder);
    expect(second.mesh.renderOrder).toBeLessThan(first.edgeLines.renderOrder);
    expect(first.mesh.renderOrder).toBeLessThan(second.edgeLines.renderOrder);
  });

  test("updates cap hatch ink in place", () => {
    const { renderSet } = createFixture();
    const ink = renderSet.cap.material.uniforms.uInk.value;

    renderSet.setHatchInk(0x33414f);

    expect(renderSet.cap.material.uniforms.uInk.value).toBe(ink);
    expect(ink.getHex()).toBe(0x33414f);
  });

  test("updates and retains viewport resolution and screen scale across material refresh", () => {
    const edgeMaterial = new LineMaterial({ color: 0x111111, linewidth: 1 });
    const { edgeLines, renderSet } = createFixture({ edgeMaterial });
    renderSet.setEnabled(true);

    renderSet.setViewportSize(640, 480, 2);

    expect(edgeLines.material.resolution.toArray()).toEqual([640, 480]);
    expect(renderSet.cap.material.uniforms.uPixelRatio.value).toBe(2);

    renderSet.setViewportSize(900, 700, 1.5);
    expect(edgeLines.material.resolution.toArray()).toEqual([900, 700]);
    expect(renderSet.cap.material.uniforms.uPixelRatio.value).toBe(1.5);

    const replacement = new LineMaterial({ color: 0x222222, linewidth: 2 });
    renderSet.refreshSourceMaterial(undefined, replacement);

    expect(edgeLines.material.resolution.toArray()).toEqual([900, 700]);
    expect(renderSet.cap.material.uniforms.uPixelRatio.value).toBe(1.5);

    renderSet.setViewportSize(320, 240, 0);
    expect(edgeLines.material.resolution.toArray()).toEqual([320, 240]);
    expect(renderSet.cap.material.uniforms.uPixelRatio.value).toBe(1);
  });

  test("refreshes source color and opacity while preserving exact restoration ownership", () => {
    const { mesh, edgeLines, renderSet, geometry, edgeGeometry } = createFixture();
    const firstClippedMesh = (() => {
      renderSet.setEnabled(true);
      const clipped = mesh.material;
      renderSet.setEnabled(false);
      return clipped;
    })();
    const firstClippedDispose = vi.spyOn(firstClippedMesh, "dispose");
    const replacementMeshMaterial = new THREE.MeshStandardMaterial({
      color: 0xe87922,
      opacity: 0.35,
      transparent: true,
      depthWrite: false,
    });
    const replacementLineMaterial = new THREE.LineBasicMaterial({ color: 0xfafafa });
    const replacementDispose = vi.spyOn(replacementMeshMaterial, "dispose");
    const replacementLineDispose = vi.spyOn(replacementLineMaterial, "dispose");
    const geometryDispose = vi.spyOn(geometry, "dispose");
    const edgeGeometryDispose = vi.spyOn(edgeGeometry, "dispose");
    mesh.material = replacementMeshMaterial;
    edgeLines.material = replacementLineMaterial;

    renderSet.refreshSourceMaterial(replacementMeshMaterial, replacementLineMaterial);

    expect(firstClippedDispose).toHaveBeenCalledOnce();
    expect(renderSet.cap.material.uniforms.uBase.value.getHex()).toBe(0xe87922);
    expect(renderSet.cap.material.uniforms.uOpacity.value).toBe(0.35);
    expect(renderSet.cap.material.transparent).toBe(true);
    expect(renderSet.cap.material.depthWrite).toBe(false);
    renderSet.setEnabled(true);
    expect(mesh.material).not.toBe(replacementMeshMaterial);
    expect(mesh.material.clippingPlanes).toEqual([renderSet.back.material.clippingPlanes[0]]);
    renderSet.setEnabled(false);
    expect(mesh.material).toBe(replacementMeshMaterial);
    expect(edgeLines.material).toBe(replacementLineMaterial);

    renderSet.dispose();
    expect(replacementDispose).not.toHaveBeenCalled();
    expect(replacementLineDispose).not.toHaveBeenCalled();
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(edgeGeometryDispose).not.toHaveBeenCalled();
  });

  test("refreshes cap transparency and depth-write flags from the source material exactly", () => {
    const { mesh, edgeLines, renderSet } = createFixture();
    const replacement = new THREE.MeshStandardMaterial({
      color: 0xabcdef,
      opacity: 1,
      transparent: true,
      depthWrite: false,
    });
    mesh.material = replacement;

    renderSet.refreshSourceMaterial(replacement, edgeLines.material);

    expect(renderSet.cap.material.transparent).toBe(true);
    expect(renderSet.cap.material.depthWrite).toBe(false);
  });

  test("refreshes active clipped clones from tracked originals and restores exact sources", () => {
    const { material, mesh, edgeMaterial, edgeLines, plane, renderSet } = createFixture();
    renderSet.setEnabled(true);
    const oldClippedMesh = mesh.material;
    const oldClippedEdge = edgeLines.material;
    const oldMeshDispose = vi.spyOn(oldClippedMesh, "dispose");
    const oldEdgeDispose = vi.spyOn(oldClippedEdge, "dispose");
    const meshOrder = mesh.renderOrder;
    const edgeOrder = edgeLines.renderOrder;
    material.color.set(0x22c55e);
    edgeMaterial.color.set(0xf97316);

    expect(renderSet.refreshSourceMaterial()).toBe(true);

    expect(oldMeshDispose).toHaveBeenCalledOnce();
    expect(oldEdgeDispose).toHaveBeenCalledOnce();
    expect(mesh.material).not.toBe(oldClippedMesh);
    expect(mesh.material.color.getHex()).toBe(0x22c55e);
    expect(mesh.material.clippingPlanes).toEqual([plane]);
    expect(edgeLines.material).not.toBe(oldClippedEdge);
    expect(edgeLines.material.color.getHex()).toBe(0xf97316);
    expect(edgeLines.material.clippingPlanes).toEqual([plane]);
    expect(mesh.renderOrder).toBe(meshOrder);
    expect(edgeLines.renderOrder).toBe(edgeOrder);
    expect(renderSet.back.visible).toBe(true);
    expect(renderSet.front.visible).toBe(true);
    expect(renderSet.cap.visible).toBe(true);

    renderSet.setEnabled(false);
    expect(mesh.material).toBe(material);
    expect(edgeLines.material).toBe(edgeMaterial);
  });

  test("never adopts its active owned clones as source originals", () => {
    const { material, mesh, edgeMaterial, edgeLines, renderSet } = createFixture();
    renderSet.setEnabled(true);
    const ownedMeshClone = mesh.material;
    const ownedEdgeClone = edgeLines.material;
    material.color.set(0x84cc16);
    edgeMaterial.color.set(0x0ea5e9);

    renderSet.refreshSourceMaterial(mesh.material, edgeLines.material);
    renderSet.setEnabled(false);

    expect(mesh.material).toBe(material);
    expect(edgeLines.material).toBe(edgeMaterial);
    expect(mesh.material).not.toBe(ownedMeshClone);
    expect(edgeLines.material).not.toBe(ownedEdgeClone);
    expect(material.color.getHex()).toBe(0x84cc16);
    expect(edgeMaterial.color.getHex()).toBe(0x0ea5e9);
  });

  test("removes helpers and disposes only owned materials, idempotently", () => {
    const fixture = createFixture();
    const {
      geometry,
      edgeGeometry,
      capGeometry,
      material,
      edgeMaterial,
      mesh,
      edgeLines,
      renderSet,
    } = fixture;
    const geometryDispose = vi.spyOn(geometry, "dispose");
    const edgeGeometryDispose = vi.spyOn(edgeGeometry, "dispose");
    const capGeometryDispose = vi.spyOn(capGeometry, "dispose");
    const materialDispose = vi.spyOn(material, "dispose");
    const edgeMaterialDispose = vi.spyOn(edgeMaterial, "dispose");
    const ownedMaterials = [
      renderSet.back.material,
      renderSet.front.material,
      renderSet.cap.material,
    ];
    renderSet.setEnabled(true);
    ownedMaterials.push(mesh.material, edgeLines.material);
    const ownedDisposals = ownedMaterials.map((owned) => vi.spyOn(owned, "dispose"));

    renderSet.dispose();
    renderSet.dispose();

    expect(renderSet.back.parent).toBeNull();
    expect(renderSet.front.parent).toBeNull();
    expect(renderSet.cap.parent).toBeNull();
    expect(mesh.material).toBe(material);
    expect(edgeLines.material).toBe(edgeMaterial);
    for (const dispose of ownedDisposals) expect(dispose).toHaveBeenCalledOnce();
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(edgeGeometryDispose).not.toHaveBeenCalled();
    expect(capGeometryDispose).not.toHaveBeenCalled();
    expect(materialDispose).not.toHaveBeenCalled();
    expect(edgeMaterialDispose).not.toHaveBeenCalled();
  });
});
