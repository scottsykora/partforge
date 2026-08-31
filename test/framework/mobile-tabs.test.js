// @vitest-environment happy-dom
// The narrow-layout pane tab bar. Everything here is width-independent on
// purpose: which pane is VISIBLE is chrome.css's job (keyed on data-pf-pane),
// and whether the bar SHOWS at all is a media query — neither is reachable
// from a happy-dom test, so what is asserted is the attribute contract those
// rules key off, plus the host-override behaviour.
import { afterEach, describe, expect, it } from "vitest";
import { attachMobileTabs } from "../../src/framework/mobile-tabs.js";

let live = [];
function build(options = {}) {
  document.body.innerHTML = "";
  const shell = document.createElement("div");
  shell.className = "pf-shell";
  const stage = document.createElement("div");
  stage.className = "pf-stage";
  const rail = document.createElement("div");
  rail.className = "pf-rail";
  shell.append(stage, rail);
  document.body.append(shell);
  const handle = attachMobileTabs({ shell, stage, rail, ...options });
  live.push(handle);
  return { shell, stage, rail, handle };
}
const bar = () => document.querySelector(".pf-tabbar");
const tab = (pane) => document.querySelector(`[data-pf-pane-tab="${pane}"]`);

afterEach(() => {
  live.forEach((h) => h.detach());
  live = [];
});

describe("attachMobileTabs", () => {
  it("starts on the stage and marks that tab pressed", () => {
    const { shell } = build();
    expect(shell.dataset.pfPane).toBe("stage");
    expect(tab("stage").getAttribute("aria-pressed")).toBe("true");
    expect(tab("rail").getAttribute("aria-pressed")).toBe("false");
  });

  it("renders two labelled buttons with decorative icons", () => {
    build();
    expect(bar().getAttribute("role")).toBe("group");
    expect(tab("stage").textContent).toContain("3D");
    expect(tab("rail").textContent).toContain("Controls");
    // The icon must never be announced — the visible label already says it.
    expect(tab("stage").querySelector("svg").getAttribute("aria-hidden")).toBe("true");
    for (const pane of ["stage", "rail"]) {
      expect(tab(pane).type).toBe("button"); // never a form submit
    }
  });

  it("switches the pane on click", () => {
    const { shell } = build();
    tab("rail").click();
    expect(shell.dataset.pfPane).toBe("rail");
    expect(tab("rail").getAttribute("aria-pressed")).toBe("true");
    tab("stage").click();
    expect(shell.dataset.pfPane).toBe("stage");
  });

  it("hands pane selection to a host, hiding its own bar", () => {
    const { shell, handle } = build();
    handle.setHostPane("rail");
    expect(shell.dataset.pfPane).toBe("rail");
    expect(bar().hidden).toBe(true);
  });

  it("lets the host override win over the last clicked tab", () => {
    const { shell, handle } = build();
    tab("rail").click();
    handle.setHostPane("stage");
    expect(shell.dataset.pfPane).toBe("stage");
  });

  it("restores standalone behaviour when the host releases control", () => {
    const { shell, handle } = build();
    tab("rail").click();
    handle.setHostPane("stage");
    handle.setHostPane(null);
    expect(bar().hidden).toBe(false);
    // The user's own last choice comes back — the host override was a lease,
    // not a mutation of the standalone selection.
    expect(shell.dataset.pfPane).toBe("rail");
  });

  it("treats an unknown host pane as releasing control", () => {
    const { shell, handle } = build();
    handle.setHostPane("nonsense");
    expect(bar().hidden).toBe(false);
    expect(shell.dataset.pfPane).toBe("stage");
  });

  it("no-ops without a resolvable shell", () => {
    document.body.innerHTML = "";
    const handle = attachMobileTabs({});
    expect(() => handle.setHostPane("rail")).not.toThrow();
    expect(() => handle.detach()).not.toThrow();
    expect(bar()).toBeNull();
  });

  it("leaves no trace after detach", () => {
    const { shell, handle } = build();
    handle.detach();
    live = live.filter((h) => h !== handle);
    expect(bar()).toBeNull();
    expect(shell.dataset.pfPane).toBeUndefined();
  });
});

describe("setRailLayout", () => {
  it("writes the dock attributes and hides the bar", () => {
    const { shell, handle } = build();
    handle.setRailLayout({ mode: "dock", inset: 380, railHeight: 316 });
    expect(shell.dataset.pfRailLayout).toBe("dock");
    expect(shell.style.getPropertyValue("--pf-rail-inset")).toBe("380px");
    expect(shell.style.getPropertyValue("--pf-rail-dock-h")).toBe("316px");
    expect(bar().hidden).toBe(true);
  });

  it("normalizes garbage to null and restores the default layout", () => {
    const { shell, handle } = build();
    handle.setRailLayout({ mode: "dock", inset: 380, railHeight: 316 });
    handle.setRailLayout({ mode: "nope" });
    expect(shell.dataset.pfRailLayout).toBeUndefined();
    expect(shell.style.getPropertyValue("--pf-rail-inset")).toBe("");
    expect(shell.style.getPropertyValue("--pf-rail-dock-h")).toBe("");
    expect(bar().hidden).toBe(false);
  });

  it("clamps railHeight to inset and refuses non-integer insets", () => {
    const { shell, handle } = build();
    handle.setRailLayout({ mode: "dock", inset: 100, railHeight: 400 });
    expect(shell.style.getPropertyValue("--pf-rail-dock-h")).toBe("100px");
    handle.setRailLayout({ mode: "dock", inset: 1.5, railHeight: 0 });
    expect(shell.dataset.pfRailLayout).toBeUndefined();
  });

  it("overlay carries a zero inset, so the stage keeps the full width", () => {
    const { shell, handle } = build();
    handle.setRailLayout({ mode: "overlay" });
    expect(shell.dataset.pfRailLayout).toBe("overlay");
    expect(shell.style.getPropertyValue("--pf-rail-inset")).toBe("0px");
    expect(shell.style.getPropertyValue("--pf-rail-dock-h")).toBe("0px");
  });

  it("overlay: stage pointerdown removes data-pf-rail-open", () => {
    const { shell, stage, handle } = build();
    handle.setRailLayout({ mode: "overlay" });
    shell.setAttribute("data-pf-rail-open", "");
    stage.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(shell.hasAttribute("data-pf-rail-open")).toBe(false);
  });

  it("leaves the drawer alone when a stage pointerdown lands outside overlay mode", () => {
    const { shell, stage, handle } = build();
    handle.setRailLayout({ mode: "dock", inset: 380, railHeight: 316 });
    shell.setAttribute("data-pf-rail-open", "");
    stage.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(shell.hasAttribute("data-pf-rail-open")).toBe(true);
  });

  it("leaving overlay clears data-pf-rail-open", () => {
    const { shell, handle } = build();
    handle.setRailLayout({ mode: "overlay" });
    shell.setAttribute("data-pf-rail-open", "");
    handle.setRailLayout(null);
    expect(shell.hasAttribute("data-pf-rail-open")).toBe(false);
  });

  it("reports the normalized layout through onRailLayout", () => {
    const seen = [];
    const { handle } = build({ onRailLayout: (l) => seen.push(l) });
    handle.setRailLayout({ mode: "overlay" });
    handle.setRailLayout(null);
    expect(seen).toEqual([{ mode: "overlay" }, null]);
  });

  it("keeps the bar hidden while a host pane lease outlives the layout", () => {
    const { handle } = build();
    handle.setHostPane("rail");
    handle.setRailLayout({ mode: "overlay" });
    handle.setRailLayout(null);
    expect(bar().hidden).toBe(true);
  });

  it("no-ops without a resolvable shell", () => {
    document.body.innerHTML = "";
    const handle = attachMobileTabs({});
    expect(() => handle.setRailLayout({ mode: "overlay" })).not.toThrow();
  });

  it("leaves no layout trace after detach", () => {
    const { shell, handle } = build();
    handle.setRailLayout({ mode: "dock", inset: 380, railHeight: 316 });
    shell.setAttribute("data-pf-rail-open", "");
    handle.detach();
    live = live.filter((h) => h !== handle);
    expect(shell.dataset.pfRailLayout).toBeUndefined();
    expect(shell.hasAttribute("data-pf-rail-open")).toBe(false);
    expect(shell.style.getPropertyValue("--pf-rail-inset")).toBe("");
    expect(shell.style.getPropertyValue("--pf-rail-dock-h")).toBe("");
  });
});
