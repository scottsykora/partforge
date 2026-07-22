import { describe, it, expect, vi } from "vitest";

// mount() needs a DOM + workers; assert the handle SHAPE by checking the exported
// factory wires captureViews to viewer.captureCanonicalViews. We test the small
// delegation via a helper export to avoid booting WASM here.
import { makeHandle } from "../src/framework/mount.js";

describe("mount handle captureViews", () => {
  it("delegates to viewer.captureCanonicalViews", () => {
    const viewer = { captureCanonicalViews: vi.fn(() => [{ view: "iso", dataUrl: "d" }]) };
    const handle = makeHandle({ ready: Promise.resolve(), dispose: () => {}, viewer });
    const out = handle.captureViews(["iso"]);
    expect(viewer.captureCanonicalViews).toHaveBeenCalledWith(["iso"]);
    expect(out).toEqual([{ view: "iso", dataUrl: "d" }]);
  });
});
