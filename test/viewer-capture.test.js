import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { captureViewsFromScene, srgbEncodeInPlace } from "../src/framework/viewer.js";
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

// Render-target readback is in the linear working space (three only applies
// outputColorSpace on the canvas path), so captures must be encoded before they go into
// a JPEG — skipping this is what made them look dark.
describe("srgbEncodeInPlace", () => {
  it("brightens midtones, pins the endpoints, and leaves alpha alone", () => {
    // one pixel per channel plus a grey, all at alpha 200
    const data = new Uint8ClampedArray([
      0, 0, 0, 200,
      255, 255, 255, 200,
      128, 64, 32, 200,
    ]);

    expect(srgbEncodeInPlace(data)).toBe(data); // in place

    expect([data[0], data[1], data[2]]).toEqual([0, 0, 0]);
    expect([data[4], data[5], data[6]]).toEqual([255, 255, 255]);
    // sRGB transfer of linear 128/255 ≈ 0.7366 → 188
    expect(data[8]).toBe(188);
    expect(data[9]).toBe(137);
    expect(data[10]).toBe(99);
    // every channel got brighter; alpha never touched
    expect(data[8]).toBeGreaterThan(128);
    expect([data[3], data[7], data[11]]).toEqual([200, 200, 200]);
  });

  it("is monotonic across the whole 8-bit range", () => {
    const data = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) data[i * 4] = i;
    srgbEncodeInPlace(data);
    for (let i = 1; i < 256; i++) expect(data[i * 4]).toBeGreaterThanOrEqual(data[(i - 1) * 4]);
  });
});
