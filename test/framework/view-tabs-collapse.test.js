// @vitest-environment happy-dom
// The view-tab bar's narrow-stage fallback: when the segmented pill's natural
// width no longer fits the stage's top-centre slot, the buttons give way to a
// dropdown. Split out of view-tabs.test.js, which covers the segmented control
// itself; this file is only about the swap, its measurement, and keeping both
// representations in sync.
import { beforeEach, expect, test, vi } from "vitest";
import { createViewTabs, pickLayout } from "../../src/framework/view-tabs.js";

const part = {
  meta: { title: "Test part" },
  views: {
    assembly: { label: "Assembly" },
    exploded: { label: "Exploded assembly" },
    bare: {}, // no label → key is the label
  },
};

// A measurement source the test drives. `segWidth` is what the pill measures
// RIGHT NOW — which is small once the buttons are hidden, exactly the reading
// the collapse must not be re-derived from.
function stubMeasure(initial) {
  const state = { ...initial };
  const measure = () => ({ segWidth: state.segWidth, available: state.available });
  measure.set = (next) => Object.assign(state, next);
  return measure;
}

const resize = () => window.dispatchEvent(new Event("resize"));

let el;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '<div class="pf-stage"><div id="topbar"><div class="seg" id="part"></div></div></div>';
  el = document.getElementById("part");
});

// ---- pickLayout: the pure rule ------------------------------------------

test("pickLayout collapses to the menu when the pill is wider than the slot", () => {
  expect(pickLayout({ natural: 400, available: 300, collapsed: false })).toBe("menu");
});

test("pickLayout stays segmented while the pill fits", () => {
  expect(pickLayout({ natural: 260, available: 300, collapsed: false })).toBe("segmented");
});

// The deadband is what stops a pill whose natural width lands within a
// subpixel of the slot from flapping between the two layouts on every frame.
test("pickLayout holds the menu until the slot clears the pill by the deadband", () => {
  expect(pickLayout({ natural: 300, available: 300, collapsed: true })).toBe("menu");
  expect(pickLayout({ natural: 300, available: 301, collapsed: true })).toBe("menu");
  expect(pickLayout({ natural: 300, available: 302, collapsed: true })).toBe("segmented");
});

// happy-dom (and any pre-layout first paint) reports zeros for every box. That
// is "no measurement", not "nothing fits" — the segmented control is what the
// bar must fall back to.
test("pickLayout treats unmeasurable boxes as segmented", () => {
  expect(pickLayout({ natural: 0, available: 0, collapsed: false })).toBe("segmented");
  expect(pickLayout({ natural: 0, available: 0, collapsed: true })).toBe("segmented");
  expect(pickLayout({ natural: 400, available: 0, collapsed: false })).toBe("segmented");
});

// ---- the swap ------------------------------------------------------------

test("a slot that fits leaves the segmented buttons showing", () => {
  createViewTabs(el, part, { onChange: () => {}, measure: stubMeasure({ segWidth: 260, available: 300 }) });
  expect(el.dataset.pfTabs).toBe("segmented");
  expect(el.querySelector("select")).not.toBeNull(); // built up front, just not showing
  expect(el.querySelector("select").hidden).toBe(true);
});

test("a slot too narrow for the pill shows the dropdown instead of the buttons", () => {
  createViewTabs(el, part, { onChange: () => {}, measure: stubMeasure({ segWidth: 400, available: 300 }) });

  expect(el.dataset.pfTabs).toBe("menu");
  const select = el.querySelector("select");
  expect(select.hidden).toBe(false);
  expect([...select.options].map((o) => o.value)).toEqual(["assembly", "exploded", "bare"]);
  expect([...select.options].map((o) => o.textContent)).toEqual(["Assembly", "Exploded assembly", "bare"]);
  for (const b of el.querySelectorAll("button[data-part]")) expect(b.hidden).toBe(true);
});

// The fixed point that keeps the swap from oscillating: once collapsed, the
// hidden buttons measure ~nothing, so re-deriving "does it fit?" from the live
// pill would say yes, re-expand, overflow, and collapse again — a flicker loop.
// The natural width is remembered from the last time the buttons were showing.
test("the collapsed bar does not re-expand just because its hidden buttons measure nothing", () => {
  const measure = stubMeasure({ segWidth: 400, available: 300 });
  createViewTabs(el, part, { onChange: () => {}, measure });
  expect(el.dataset.pfTabs).toBe("menu");

  measure.set({ segWidth: 0 }); // what a hidden button row actually reports
  resize();

  expect(el.dataset.pfTabs).toBe("menu");
});

test("widening the stage past the remembered pill width brings the buttons back", () => {
  const measure = stubMeasure({ segWidth: 400, available: 300 });
  createViewTabs(el, part, { onChange: () => {}, measure });
  expect(el.dataset.pfTabs).toBe("menu");

  measure.set({ segWidth: 0, available: 500 });
  resize();

  expect(el.dataset.pfTabs).toBe("segmented");
  expect(el.querySelector("select").hidden).toBe(true);
  for (const b of el.querySelectorAll("button[data-part]")) expect(b.hidden).toBe(false);
});

test("narrowing the stage collapses a bar that started out segmented", () => {
  const measure = stubMeasure({ segWidth: 260, available: 300 });
  createViewTabs(el, part, { onChange: () => {}, measure });
  expect(el.dataset.pfTabs).toBe("segmented");

  measure.set({ available: 200 });
  resize();

  expect(el.dataset.pfTabs).toBe("menu");
});

// ---- the two representations stay in step --------------------------------

test("choosing from the dropdown switches, persists, and notifies", () => {
  const onChange = vi.fn();
  const ctl = createViewTabs(el, part, { onChange, measure: stubMeasure({ segWidth: 400, available: 300 }) });
  onChange.mockClear();

  const select = el.querySelector("select");
  select.value = "exploded";
  select.dispatchEvent(new Event("change"));

  expect(ctl.current()).toBe("exploded");
  expect(onChange).toHaveBeenCalledWith("exploded");
  expect(sessionStorage.getItem("partforge:view:Test part")).toBe("exploded");
  expect(el.querySelector("button.on").dataset.part).toBe("exploded");
});

test("clicking a button keeps the dropdown's value in step for when it takes over", () => {
  createViewTabs(el, part, { onChange: () => {}, measure: stubMeasure({ segWidth: 260, available: 300 }) });

  el.querySelector('button[data-part="exploded"]').click();

  expect(el.querySelector("select").value).toBe("exploded");
});

test("select(name) drives both representations", () => {
  const ctl = createViewTabs(el, part, { onChange: () => {}, measure: stubMeasure({ segWidth: 400, available: 300 }) });

  expect(ctl.select("bare")).toBe(true);

  expect(el.querySelector("select").value).toBe("bare");
  expect(el.querySelector("button.on").dataset.part).toBe("bare");
});

test("a restored saved view opens selected in the dropdown too", () => {
  sessionStorage.setItem("partforge:view:Test part", "exploded");
  createViewTabs(el, part, { onChange: () => {}, measure: stubMeasure({ segWidth: 400, available: 300 }) });
  expect(el.querySelector("select").value).toBe("exploded");
});

// ---- host-proofing -------------------------------------------------------

// partforge-cloud restyles the pill from scratch (`#viewer #part button`, no
// `.seg`), which silently dropped app.css's `white-space: nowrap` and let
// labels wrap onto a second line. The rule is load-bearing for the collapse —
// a wrapping label narrows the pill instead of widening it, so the measurement
// never trips — so it rides on the element, out of a host's reach.
test("generated buttons carry their own nowrap, not a stylesheet's", () => {
  createViewTabs(el, part, { onChange: () => {} });
  for (const b of el.querySelectorAll("button[data-part]")) {
    expect(b.style.whiteSpace).toBe("nowrap");
  }
});

// partforge-cloud hides the pill with `#viewer #part:empty { display: none }`,
// so a part with nothing to switch between must leave the element empty rather
// than gain a one-option dropdown nobody can use.
test("a single view gets no dropdown at all", () => {
  const solo = { meta: { title: "Solo" }, views: { only: { label: "Only" } } };
  createViewTabs(el, solo, { onChange: () => {}, measure: stubMeasure({ segWidth: 400, available: 300 }) });
  expect(el.querySelector("select")).toBeNull();
  expect(el.dataset.pfTabs).toBe("segmented");
});

test("hand-written buttons get a dropdown built from the markup", () => {
  el.innerHTML = '<button data-part="x">X</button><button data-part="y" class="on">Y</button>';
  const ctl = createViewTabs(el, { views: undefined }, { onChange: () => {}, measure: stubMeasure({ segWidth: 400, available: 300 }) });

  const select = el.querySelector("select");
  expect([...select.options].map((o) => o.value)).toEqual(["x", "y"]);
  expect(select.value).toBe("y");
  expect(ctl.current()).toBe("y");
});

test("detach() removes the dropdown and stops relayout", () => {
  const measure = stubMeasure({ segWidth: 260, available: 300 });
  const ctl = createViewTabs(el, part, { onChange: () => {}, measure });
  ctl.detach();

  expect(el.querySelector("select")).toBeNull();
  measure.set({ available: 100 });
  resize(); // must not throw, and must not resurrect anything
  expect(el.querySelector("select")).toBeNull();
});

test("detach() removes a dropdown it added to hand-written markup", () => {
  el.innerHTML = '<button data-part="x">X</button><button data-part="y" class="on">Y</button>';
  const ctl = createViewTabs(el, { views: undefined }, { onChange: () => {}, measure: stubMeasure({ segWidth: 400, available: 300 }) });
  ctl.detach();

  expect(el.querySelector("select")).toBeNull();
  expect(el.querySelectorAll("button")).toHaveLength(2); // markup untouched
  for (const b of el.querySelectorAll("button")) expect(b.hidden).toBe(false);
});

// A PartDefinition is untrusted data; the dropdown must be as safe as the
// buttons view-tabs.test.js already pins.
test("a malicious label renders as option text, not markup", () => {
  const hostile = {
    views: {
      main: { label: '<img src=x onerror="globalThis.__pwnedSelect = true">' },
      other: { label: "Other" },
    },
  };
  createViewTabs(el, hostile, { onChange: () => {}, measure: stubMeasure({ segWidth: 400, available: 300 }) });

  const select = el.querySelector("select");
  expect(select.querySelector("img")).toBeNull();
  expect(select.options[0].textContent).toBe('<img src=x onerror="globalThis.__pwnedSelect = true">');
  expect(globalThis.__pwnedSelect).toBeUndefined();
});
