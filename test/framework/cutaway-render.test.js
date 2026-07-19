import { describe, expect, test, vi } from "vitest";
import * as THREE from "three";

import {
  createHatchMaterial,
  createSectionRenderSet,
} from "../../src/framework/cutaway-render.js";

function createFixture({ order = 0 } = {}) {
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
  const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x111111 });
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
  test("creates a UV-based antialiased 45-degree hatch shader", () => {
    const material = createHatchMaterial({
      color: 0x336699,
      opacity: 0.65,
      theme: "dark",
    });

    expect(material).toBeInstanceOf(THREE.ShaderMaterial);
    expect(material.uniforms.uBase.value.getHex()).toBe(0x336699);
    expect(material.uniforms.uOpacity.value).toBe(0.65);
    expect(material.uniforms.uScale.value).toBe(1);
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.vertexShader).toContain("vUv = uv");
    expect(material.fragmentShader).toContain("(vUv.x + vUv.y) * uScale");
    expect(material.fragmentShader).toContain("fwidth(coordinate)");
    expect(material.fragmentShader).toContain("mix(uBase, uInk, stripe)");
  });

  test("updates hatch scale and theme without replacing uniform colors", () => {
    const material = createHatchMaterial({ color: 0xabcdef, opacity: 1, theme: "dark" });
    const ink = material.uniforms.uInk.value;
    const darkInk = ink.getHex();

    material.userData.setHatch({ spacing: 2.5, size: 40 });
    material.userData.setTheme("light");

    expect(material.uniforms.uScale.value).toBe(16);
    expect(material.uniforms.uInk.value).toBe(ink);
    expect(material.uniforms.uInk.value.getHex()).not.toBe(darkInk);
    expect(material.transparent).toBe(false);
    expect(material.depthWrite).toBe(true);
  });
});

describe("createSectionRenderSet", () => {
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
    expect(renderSet.cap.material.uniforms.uScale.value).toBe(16);
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

  test("updates cap theme in place", () => {
    const { renderSet } = createFixture();
    const ink = renderSet.cap.material.uniforms.uInk.value;
    const before = ink.getHex();

    renderSet.setTheme("light");

    expect(renderSet.cap.material.uniforms.uInk.value).toBe(ink);
    expect(ink.getHex()).not.toBe(before);
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
