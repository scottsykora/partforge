import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { captureViewsFromScene } from "../src/framework/viewer.js";
import { CANONICAL_VIEWS } from "../src/framework/view-angles.js";

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

  it("renders the full canonical set (7 views), not just the first 6", () => {
    const liveCamera = new THREE.PerspectiveCamera();
    liveCamera.position.set(18, 12, 18);

    const fakeRenderer = {
      renderOffscreen: vi.fn(() => "data:image/jpeg;base64,AAAA"),
    };
    const grid = { visible: true };
    const out = captureViewsFromScene(CANONICAL_VIEWS, {
      renderer: fakeRenderer,
      liveCamera,
      grid,
      bounds: { center: [0, 0, 0], radius: 10 },
    });

    expect(out.map((o) => o.view)).toEqual(CANONICAL_VIEWS);
    expect(fakeRenderer.renderOffscreen).toHaveBeenCalledTimes(CANONICAL_VIEWS.length);
  });
});
