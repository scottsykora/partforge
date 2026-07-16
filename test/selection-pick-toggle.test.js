// @vitest-environment happy-dom
// The ?pick clipboard toggle: detach() must remove its DOM and click listener.
import { afterEach, expect, test, vi } from "vitest";
import { attachPickToggle } from "../src/framework/selection/pick-toggle.js";

afterEach(() => { document.body.innerHTML = ""; });

function fakeViewer() {
  const domElement = document.createElement("div");
  document.body.append(domElement);
  return { domElement, camera: {}, _subMeshes: {}, flashPoint: vi.fn() };
}

test("detach() removes the button, toast, and click listener", () => {
  const viewer = fakeViewer();
  const toggle = attachPickToggle(viewer, { part: { parts: {} }, getContext: () => ({}) });
  expect(document.getElementById("pf-pick")).not.toBeNull();
  expect(document.getElementById("pf-pick-toast")).not.toBeNull();
  toggle.detach();
  expect(document.getElementById("pf-pick")).toBeNull();
  expect(document.getElementById("pf-pick-toast")).toBeNull();
  // an armed-then-detached picker must not react to clicks (no raycast → no throw)
  expect(() => viewer.domElement.click()).not.toThrow();
});
