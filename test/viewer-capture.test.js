import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { captureViewsFromScene } from "../src/framework/viewer.js";

// captureViewsFromScene is the pure-ish core extracted so it can run without a
// live GL context: it takes an injected renderer with render()/readPixels()/
// encode() and asserts it never touches the passed live camera.
describe("captureViewsFromScene", () => {
  it("does not mutate the live camera position", () => {
    const liveCamera = new THREE.PerspectiveCamera();
    liveCamera.position.set(18, 12, 18);
    const before = liveCamera.position.toArray();

    const fakeRenderer = {
      renderOffscreen: vi.fn(() => "data:image/jpeg;base64,AAAA"),
    };
    const grid = { visible: true };
    const out = captureViewsFromScene(["front", "top"], {
      renderer: fakeRenderer,
      liveCamera,
      grid,
      bounds: { center: [0, 0, 0], radius: 10 },
    });

    expect(liveCamera.position.toArray()).toEqual(before); // untouched
    expect(grid.visible).toBe(true);                        // restored
    expect(out.map((o) => o.view)).toEqual(["front", "top"]);
    expect(out[0].dataUrl).toMatch(/^data:image\/jpeg/);
    expect(fakeRenderer.renderOffscreen).toHaveBeenCalledTimes(2);
  });
});
