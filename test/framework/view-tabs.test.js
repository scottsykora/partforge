// @vitest-environment happy-dom
// The view-tab segmented control, extracted from mount.js: buttons generated from
// part.views, saved-view restore, click switching + persistence.
import { beforeEach, expect, test, vi } from "vitest";
import { createViewTabs } from "../../src/framework/view-tabs.js";

const part = {
  views: {
    assembly: { label: "Assembly" },
    drum: { label: "Drum" },
    bare: {}, // no label → key is the label
  },
};

let el;
beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div class="seg" id="part"></div>';
  el = document.getElementById("part");
});

test("generates one button per view; the first is active; labels fall back to the key", () => {
  createViewTabs(el, part, { onChange: () => {} });
  const btns = [...el.querySelectorAll("button[data-part]")];
  expect(btns.map((b) => b.dataset.part)).toEqual(["assembly", "drum", "bare"]);
  expect(btns.map((b) => b.textContent)).toEqual(["Assembly", "Drum", "bare"]);
  expect(btns[0].classList.contains("on")).toBe(true);
  expect(btns[1].classList.contains("on")).toBe(false);
});

test("current() is the first view by default", () => {
  const tabs = createViewTabs(el, part, { onChange: () => {} });
  expect(tabs.current()).toBe("assembly");
});

test("a saved view is restored and its tab marked active", () => {
  localStorage.setItem("partforge:view", "drum");
  const tabs = createViewTabs(el, part, { onChange: () => {} });
  expect(tabs.current()).toBe("drum");
  expect(el.querySelector("button.on").dataset.part).toBe("drum");
});

test("a saved view that matches no tab is ignored", () => {
  localStorage.setItem("partforge:view", "retired-view");
  const tabs = createViewTabs(el, part, { onChange: () => {} });
  expect(tabs.current()).toBe("assembly");
});

test("clicking a tab switches, persists, and notifies", () => {
  const onChange = vi.fn();
  const tabs = createViewTabs(el, part, { onChange });
  el.querySelector('button[data-part="drum"]').click();
  expect(tabs.current()).toBe("drum");
  expect(onChange).toHaveBeenCalledWith("drum");
  expect(localStorage.getItem("partforge:view")).toBe("drum");
  expect(el.querySelector("button.on").dataset.part).toBe("drum");
  expect(el.querySelectorAll("button.on")).toHaveLength(1);
});

test("clicks outside the buttons are ignored", () => {
  const onChange = vi.fn();
  createViewTabs(el, part, { onChange });
  el.click();
  expect(onChange).not.toHaveBeenCalled();
});

test("a part without views keeps hand-written buttons and reads the active one", () => {
  el.innerHTML = '<button data-part="x">X</button><button data-part="y" class="on">Y</button>';
  const tabs = createViewTabs(el, { views: undefined }, { onChange: () => {} });
  expect(tabs.current()).toBe("y");
  expect(el.querySelectorAll("button")).toHaveLength(2); // markup untouched
});

test("detach() stops click handling and empties generated buttons", () => {
  const onChange = vi.fn();
  const tabs = createViewTabs(el, part, { onChange });
  tabs.detach();
  expect(el.children.length).toBe(0);
  el.innerHTML = '<button data-part="drum"></button>'; // even a re-added button is inert
  el.querySelector("button").click();
  expect(onChange).not.toHaveBeenCalled();
});

test("detach() leaves hand-written buttons in place for a part without views", () => {
  el.innerHTML = '<button data-part="only" class="on">Only</button>';
  const tabs = createViewTabs(el, { views: undefined }, { onChange: () => {} });
  tabs.detach();
  expect(el.querySelector("button")).not.toBeNull();
});
