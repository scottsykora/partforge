// @vitest-environment happy-dom
// The narrow-layout pane tab bar. Everything here is width-independent on
// purpose: which pane is VISIBLE is chrome.css's job (keyed on data-pf-pane),
// and whether the bar SHOWS at all is a media query — neither is reachable
// from a happy-dom test, so what is asserted is the attribute contract those
// rules key off, plus the host-override behaviour.
import { afterEach, describe, expect, it } from "vitest";
import { attachMobileTabs } from "../../src/framework/mobile-tabs.js";

let live = [];
function build() {
  document.body.innerHTML = "";
  const shell = document.createElement("div");
  shell.className = "pf-shell";
  const stage = document.createElement("div");
  stage.className = "pf-stage";
  const rail = document.createElement("div");
  rail.className = "pf-rail";
  shell.append(stage, rail);
  document.body.append(shell);
  const handle = attachMobileTabs({ shell, stage, rail });
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
