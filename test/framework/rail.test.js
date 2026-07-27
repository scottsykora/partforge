// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from "vitest";
import { attachRail } from "../../src/framework/rail.js";
import { RAIL_DEFAULT_WIDTH, RAIL_MIN_WIDTH } from "../../src/framework/rail-state.js";

function fakeStorage() {
  let value = null;
  return { getItem: () => value, setItem: (_k, v) => { value = v; }, read: () => value };
}

// happy-dom gives every element a zero-size box, so the shell width the state
// machine clamps against has to be stubbed.
function setup({ withToggle = false, shellWidth = 1600 } = {}) {
  document.body.innerHTML = `
    <div class="pf-shell">
      <div class="pf-stage"></div>
      <div class="pf-rail"></div>
    </div>`;
  const shell = document.querySelector(".pf-shell");
  const rail = document.querySelector(".pf-rail");
  shell.getBoundingClientRect = () => ({ left: 0, right: shellWidth, width: shellWidth, top: 0, bottom: 720, height: 720 });
  const toggle = withToggle ? document.createElement("button") : undefined;
  if (toggle) document.body.append(toggle);
  const storage = fakeStorage();
  const handle = attachRail({ rail, shell, toggle, storage });
  return { shell, rail, toggle, storage, handle, seam: shell.querySelector(".pf-rail-seam") };
}

const railWidth = () => document.documentElement.style.getPropertyValue("--pf-rail-w");
const key = (seam, k, init = {}) => seam.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));

beforeEach(() => {
  document.documentElement.style.removeProperty("--pf-rail-w");
  document.body.innerHTML = "";
  vi.useRealTimers();
});

test("creates the seam with separator semantics and the live width", () => {
  const { seam } = setup();
  expect(seam).not.toBeNull();
  expect(seam.getAttribute("role")).toBe("separator");
  expect(seam.getAttribute("aria-orientation")).toBe("vertical");
  expect(seam.getAttribute("aria-label")).toBe("Resize controls");
  expect(seam.tabIndex).toBe(0);
  expect(seam.getAttribute("aria-valuenow")).toBe(String(RAIL_DEFAULT_WIDTH));
  expect(seam.getAttribute("aria-valuemin")).toBe("0");
  // The affordance pill is a child, not a background on the seam itself.
  expect(seam.querySelector("span")).not.toBeNull();
  expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH}px`);
});

test("is a no-op without a rail, so embed hosts are unaffected", () => {
  expect(() => attachRail({}).detach()).not.toThrow();
  expect(document.querySelector(".pf-rail-seam")).toBeNull();
});

test("ArrowLeft widens the rail and ArrowRight narrows it", () => {
  const { seam } = setup();
  key(seam, "ArrowLeft");
  expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH + 16}px`);
  key(seam, "ArrowRight");
  expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH}px`);
});

test("Shift multiplies the keyboard step", () => {
  const { seam } = setup();
  key(seam, "ArrowLeft", { shiftKey: true });
  expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH + 64}px`);
});

test("Home and End jump to the clamped min and max", () => {
  const { seam } = setup({ shellWidth: 900 });
  key(seam, "Home");
  expect(railWidth()).toBe(`${RAIL_MIN_WIDTH}px`);
  key(seam, "End");
  expect(railWidth()).toBe("450px"); // half of a 900px shell
});

test("arrow keys never collapse — they clamp at the minimum", () => {
  const { seam, rail } = setup();
  for (let i = 0; i < 40; i++) key(seam, "ArrowRight");
  expect(railWidth()).toBe(`${RAIL_MIN_WIDTH}px`);
  expect(rail.hasAttribute("inert")).toBe(false);
});

test("Enter collapses: width 0, rail inert, seam still mounted and re-cursored", () => {
  const { seam, rail, shell } = setup();
  key(seam, "Enter");
  expect(railWidth()).toBe("0px");
  expect(rail.hasAttribute("inert")).toBe(true);
  expect(seam.hasAttribute("data-collapsed")).toBe(true);
  expect(seam.getAttribute("aria-valuenow")).toBe("0");
  // Recovery depends on the seam surviving collapse.
  expect(shell.contains(seam)).toBe(true);
});

test("Space toggles back open at the remembered width", () => {
  const { seam } = setup();
  key(seam, "ArrowLeft");
  const widened = railWidth();
  key(seam, " ");
  expect(railWidth()).toBe("0px");
  key(seam, " ");
  expect(railWidth()).toBe(widened);
});

test("double-click resets to the default width", () => {
  const { seam } = setup();
  key(seam, "ArrowLeft");
  seam.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH}px`);
});

test("a drag writes the width live and persists once on pointerup", () => {
  const { seam, shell, storage } = setup();
  seam.getBoundingClientRect = () => ({ left: 1600 - RAIL_DEFAULT_WIDTH - 6, right: 1600 - RAIL_DEFAULT_WIDTH + 6, width: 12 });
  seam.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 1600 - RAIL_DEFAULT_WIDTH }));
  expect(shell.hasAttribute("data-pf-dragging")).toBe(true);
  expect(storage.read()).toBeNull(); // nothing persisted mid-drag
  seam.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 1200 }));
  expect(railWidth()).toBe("400px");
  seam.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 1200 }));
  expect(shell.hasAttribute("data-pf-dragging")).toBe(false);
  expect(JSON.parse(storage.read())).toEqual({ width: 400, collapsed: false });
});

test("a stored preference is restored on attach", () => {
  document.body.innerHTML = `<div class="pf-shell"><div class="pf-stage"></div><div class="pf-rail"></div></div>`;
  const shell = document.querySelector(".pf-shell");
  shell.getBoundingClientRect = () => ({ left: 0, right: 1600, width: 1600 });
  const storage = fakeStorage();
  storage.setItem("partforge:rail", JSON.stringify({ width: 420, collapsed: false }));
  attachRail({ rail: document.querySelector(".pf-rail"), shell, storage });
  expect(railWidth()).toBe("420px");
});

test("an optional toggle button collapses and restores, tracking state in its label", () => {
  const { toggle, rail } = setup({ withToggle: true });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.getAttribute("aria-label")).toBe("Hide controls");
  expect(toggle.textContent).toBe("⇥");

  toggle.click();
  expect(rail.hasAttribute("inert")).toBe(true);
  expect(railWidth()).toBe("0px");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.getAttribute("aria-label")).toBe("Show controls");
  expect(toggle.textContent).toBe("⇤");
  expect(toggle.classList.contains("on")).toBe(true);

  toggle.click();
  expect(rail.hasAttribute("inert")).toBe(false);
  expect(railWidth()).toBe(`${RAIL_DEFAULT_WIDTH}px`);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
});

test("the toggle still works when the seam refuses to drag (stacked layout)", () => {
  const { toggle, seam } = setup({ withToggle: true });
  // chrome.css hides the seam below 720px and onPointerDown bails there, so the
  // toggle is the only affordance left. It must not depend on drag state.
  seam.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 10 }));
  toggle.click();
  expect(railWidth()).toBe("0px");
});

test("detach removes the seam and stops responding", () => {
  const { seam, shell, handle } = setup();
  handle.detach();
  expect(shell.querySelector(".pf-rail-seam")).toBeNull();
  key(seam, "ArrowLeft");
  expect(railWidth()).toBe(""); // property cleaned up, listener gone
});
