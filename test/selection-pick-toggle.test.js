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
  const added = vi.spyOn(viewer.domElement, "addEventListener");
  const removed = vi.spyOn(viewer.domElement, "removeEventListener");
  const toggle = attachPickToggle(viewer, { part: { parts: {} }, getContext: () => ({}) });
  expect(document.getElementById("pf-pick")).not.toBeNull();
  expect(document.getElementById("pf-pick-toast")).not.toBeNull();
  toggle.detach();
  expect(document.getElementById("pf-pick")).toBeNull();
  expect(document.getElementById("pf-pick-toast")).toBeNull();
  // the exact click handler the picker registered must be the one removed
  const clickHandler = added.mock.calls.find(([type]) => type === "click")[1];
  expect(removed).toHaveBeenCalledWith("click", clickHandler);
});
