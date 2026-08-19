// The handle's annotate surface: constant shape, NOOP default (the
// NOOP_MEASURE contract, extended). makeHandle is the unit seam — no WASM,
// no DOM (mount.test.js stance).
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

test("annotate defaults to an inert no-op with the full surface", () => {
  const rt = handle();
  expect(rt.annotate.isEnabled()).toBe(false);
  expect(rt.annotate.strokeCount()).toBe(0);
  expect(rt.annotate.send()).toBe(false);
  expect(() => rt.annotate.setEnabled(true)).not.toThrow();
  expect(() => rt.annotate.clear()).not.toThrow();
  expect(typeof rt.annotate.onModeChange(() => {})).toBe("function");
});

test("a wired annotate mode is passed through as-is", () => {
  const mode = { isEnabled: () => true };
  expect(handle({ annotate: mode }).annotate).toBe(mode);
});
