// @vitest-environment happy-dom
// The view-tab segmented control, extracted from mount.js: buttons generated from
// part.views, saved-view restore, click switching + persistence.
import { beforeEach, expect, test, vi } from "vitest";
import { createViewTabs } from "../../src/framework/view-tabs.js";

const part = {
  meta: { title: "Test part" },
  views: {
    assembly: { label: "Assembly" },
    drum: { label: "Drum" },
    bare: {}, // no label → key is the label
  },
};

let el;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '<div class="seg" id="part"></div>';
  el = document.getElementById("part");
});

test("generates one button per view; the resolved default is active; labels fall back to the key", () => {
  createViewTabs(el, part, { onChange: () => {} });
  const btns = [...el.querySelectorAll("button[data-part]")];
  expect(btns.map((b) => b.dataset.part)).toEqual(["assembly", "drum", "bare"]);
  expect(btns.map((b) => b.textContent)).toEqual(["Assembly", "Drum", "bare"]);
  expect(btns[0].classList.contains("on")).toBe(true);
  expect(btns[1].classList.contains("on")).toBe(false);
});

// A PartDefinition is untrusted data downstream (hosts run LLM-generated and
// user-supplied parts), so a label must never be parsed as markup.
test("a malicious label renders as text, not markup", () => {
  const hostile = {
    views: {
      "main": { label: '<img src=x onerror="globalThis.__pwned = true">' },
      'evil" onclick="globalThis.__pwned = true': { label: "Quoted key" },
    },
  };
  createViewTabs(el, hostile, { onChange: () => {} });
  const btns = [...el.querySelectorAll("button[data-part]")];
  expect(btns).toHaveLength(2);
  expect(el.querySelector("img")).toBeNull();
  expect(btns[0].textContent).toBe('<img src=x onerror="globalThis.__pwned = true">');
  expect(btns[0].children).toHaveLength(0);
  // the quoted key stays one attribute value, and never becomes an onclick
  expect(btns[1].dataset.part).toBe('evil" onclick="globalThis.__pwned = true');
  expect(btns[1].getAttribute("onclick")).toBeNull();
  btns[1].click();
  expect(globalThis.__pwned).toBeUndefined();
});

test("current() falls back to the first view when there's no parts map to count", () => {
  const tabs = createViewTabs(el, part, { onChange: () => {} });
  expect(tabs.current()).toBe("assembly");
});

test("a saved view is restored and its tab marked active", () => {
  sessionStorage.setItem("partforge:view:Test part", "drum");
  const tabs = createViewTabs(el, part, { onChange: () => {} });
  expect(tabs.current()).toBe("drum");
  expect(el.querySelector("button.on").dataset.part).toBe("drum");
});

test("a saved view that matches no tab is ignored", () => {
  sessionStorage.setItem("partforge:view:Test part", "retired-view");
  const tabs = createViewTabs(el, part, { onChange: () => {} });
  expect(tabs.current()).toBe("assembly");
});

test("a view saved under another part's key is ignored", () => {
  sessionStorage.setItem("partforge:view:Other part", "drum");
  const tabs = createViewTabs(el, part, { onChange: () => {} });
  expect(tabs.current()).toBe("assembly");
});

test("clicking a tab switches, persists, and notifies", () => {
  const onChange = vi.fn();
  const tabs = createViewTabs(el, part, { onChange });
  el.querySelector('button[data-part="drum"]').click();
  expect(tabs.current()).toBe("drum");
  expect(onChange).toHaveBeenCalledWith("drum");
  expect(sessionStorage.getItem("partforge:view:Test part")).toBe("drum");
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

test("a part with no meta.title switches tabs but persists nothing", () => {
  const untitled = { views: { a: { label: "A" }, b: { label: "B" } } };
  const tabs = createViewTabs(el, untitled, { onChange: () => {} });
  el.querySelector('button[data-part="b"]').click();
  expect(tabs.current()).toBe("b");
  expect(sessionStorage.length).toBe(0);
});

test("the resolved default view opens, not the first key", () => {
  const multi = {
    meta: { title: "Multi" },
    defaults: {},
    parts: {
      body: { views: ["body", "assembly"] },
      lid: { views: ["assembly"] },
      pin: { views: ["assembly"] },
    },
    views: { body: { label: "Body" }, assembly: { label: "Assembly" } },
  };
  const tabs = createViewTabs(el, multi, { onChange: () => {} });
  expect(tabs.current()).toBe("assembly");
  expect(el.querySelector("button.on").dataset.part).toBe("assembly");
  expect(el.querySelectorAll("button.on")).toHaveLength(1);
});

test("an author's `default: true` view opens even when a bigger view exists", () => {
  const flagged = {
    meta: { title: "Flagged" },
    defaults: {},
    parts: { body: { views: ["assembly", "body"] }, lid: { views: ["assembly"] } },
    views: { assembly: { label: "Assembly" }, body: { label: "Body", default: true } },
  };
  const tabs = createViewTabs(el, flagged, { onChange: () => {} });
  expect(tabs.current()).toBe("body");
  expect(el.querySelector("button.on").dataset.part).toBe("body");
});

test("a saved view still wins over the resolved default", () => {
  const multi = {
    meta: { title: "Multi" },
    defaults: {},
    parts: { body: { views: ["body", "assembly"] }, lid: { views: ["assembly"] } },
    views: { body: { label: "Body" }, assembly: { label: "Assembly" } },
  };
  sessionStorage.setItem("partforge:view:Multi", "body");
  const tabs = createViewTabs(el, multi, { onChange: () => {} });
  expect(tabs.current()).toBe("body");
  expect(el.querySelector("button.on").dataset.part).toBe("body");
});
