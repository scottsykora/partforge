// The handle's projection surface: constant shape, NOOP default — the
// NOOP_MEASURE / NOOP_ANNOTATE contract, extended once more. makeHandle is the
// unit seam (the mount.test.js stance); the DOM wiring is asserted in
// mount.test.js against its mocked viewer.
import { expect, test } from "vitest";
import { makeHandle } from "../../../src/framework/mount.js";

const stubViewer = {
  captureCanonicalViews: () => [],
  captureCurrent: () => null,
  setActive: () => {},
  onContextLost: () => () => {},
};

function handle(over = {}) {
  return makeHandle({
    ready: Promise.resolve(),
    dispose: () => {},
    viewer: stubViewer,
    setParams: () => {},
    listExportableParts: () => [],
    exportParts: () => {},
    getView: () => "main",
    setView: () => false,
    captureView: () => null,
    ...over,
  });
}

test("projection defaults to an inert perspective no-op with the full surface", () => {
  const rt = handle();
  expect(rt.projection.get()).toBe("perspective");
  expect(() => rt.projection.set("orthographic")).not.toThrow();
  expect(typeof rt.projection.onChange(() => {})).toBe("function");
  // The default must not lie about having taken effect.
  expect(rt.projection.get()).toBe("perspective");
});

test("a wired projection surface is passed through as-is", () => {
  const projection = { get: () => "orthographic", set: () => {}, onChange: () => () => {} };
  expect(handle({ projection }).projection).toBe(projection);
});
