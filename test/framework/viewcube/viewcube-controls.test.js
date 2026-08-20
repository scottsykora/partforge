// @vitest-environment happy-dom
// The chrome: the stack element, the projection button, and the hidden
// per-view buttons that replace the DOM focus a canvas cannot give us.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachViewcubeControls } from "../../../src/framework/viewcube/viewcube-controls.js";

function stubViewer() {
  const frame = new Set(), theme = new Set(), projection = new Set();
  let mode = "perspective";
  return {
    camera: { quaternion: { x: 0, y: 0, z: 0, w: 1 }, isOrthographicCamera: false, zoom: 1 },
    onFrame: (cb) => { frame.add(cb); return () => frame.delete(cb); },
    onThemeChange: (cb) => { theme.add(cb); return () => theme.delete(cb); },
    onProjectionChange: (cb) => { projection.add(cb); return () => projection.delete(cb); },
    getTheme: () => "dark",
    getProjection: () => mode,
    setProjection: vi.fn((next) => {
      mode = next;
      projection.forEach((cb) => cb(mode));
      return mode;
    }),
    tweenCameraTo: vi.fn(),
    orbitBy: vi.fn(),
    counts: () => ({ frame: frame.size, theme: theme.size, projection: projection.size }),
  };
}

let stage, viewer, handle;
beforeEach(() => {
  document.body.innerHTML = "";
  stage = document.createElement("div");
  stage.className = "pf-stage";
  const viewbar = document.createElement("div");
  viewbar.id = "viewbar";
  stage.append(viewbar);
  document.body.append(stage);
  viewer = stubViewer();
  handle = attachViewcubeControls(viewer, { stage }, {});
});
afterEach(() => handle?.detach());

const projectionButton = () => stage.querySelector("#projection");

describe("structure", () => {
  it("builds the stack inside the stage, not on document.body", () => {
    const stack = stage.querySelector(".pf-viewcube-stack");
    expect(stack).not.toBeNull();
    expect(stack.parentElement).toBe(stage);
  });

  it("appends the cube before the projection button (CSS row-reverse puts the button on screen-left)", () => {
    // DOM order stays cube-then-button — chrome.css's `.pf-viewcube-stack`
    // is `flex-direction: row-reverse`, which is what actually places the
    // button to the cube's left without reordering the DOM (see its comment).
    const children = [...stage.querySelector(".pf-viewcube-stack").children];
    expect(children[0].className).toContain("pf-viewcube");
    expect(children[1]).toBe(projectionButton());
  });

  it("gives the projection button its own toggle class, no wrapping pill", () => {
    // The button used to sit inside a `.pf-viewcube-pill` card; the
    // 2026-08-20 revision made it a bare circle and dropped the wrapper.
    expect(projectionButton().className).toBe("pf-viewcube-toggle");
    expect(stage.querySelector(".pf-viewcube-pill")).toBeNull();
  });

  it("gives the projection button a type, label and title", () => {
    const button = projectionButton();
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-label")).toMatch(/orthographic/i);
  });
});

describe("projection button", () => {
  it("switches to orthographic on click and reflects it", () => {
    projectionButton().click();
    expect(viewer.setProjection).toHaveBeenCalledWith("orthographic");
    expect(projectionButton().classList.contains("on")).toBe(true);
    expect(projectionButton().getAttribute("aria-pressed")).toBe("true");
    expect(projectionButton().getAttribute("aria-label")).toMatch(/perspective/i);
  });

  it("switches back on a second click", () => {
    projectionButton().click();
    projectionButton().click();
    expect(viewer.setProjection).toHaveBeenLastCalledWith("perspective");
    expect(projectionButton().classList.contains("on")).toBe(false);
  });

  it("follows a projection change it did not initiate", () => {
    viewer.setProjection("orthographic");
    expect(projectionButton().classList.contains("on")).toBe(true);
  });
});

describe("keyboard access", () => {
  it("offers one hidden button per canonical view", () => {
    const buttons = [...stage.querySelectorAll(".pf-viewcube-key button")];
    expect(buttons.map((b) => b.dataset.view).sort())
      .toEqual(["back", "bottom", "front", "left", "right", "top"]);
    for (const b of buttons) expect(b.getAttribute("aria-label")).toBeTruthy();
  });

  it("tweens to the named view when one is activated", () => {
    stage.querySelector('.pf-viewcube-key button[data-view="top"]').click();
    expect(viewer.tweenCameraTo).toHaveBeenCalledWith("top", { duration: 0.6 });
  });
});

describe("hiding", () => {
  it("hides the whole stack, projection button included", () => {
    handle.setHidden(true);
    expect(stage.querySelector(".pf-viewcube-stack").hidden).toBe(true);
    handle.setHidden(false);
    expect(stage.querySelector(".pf-viewcube-stack").hidden).toBe(false);
  });
});

describe("detach", () => {
  it("unsubscribes everything and removes the stack", () => {
    handle.detach();
    expect(viewer.counts()).toEqual({ frame: 0, theme: 0, projection: 0 });
    expect(stage.querySelector(".pf-viewcube-stack")).toBeNull();
  });

  it("is idempotent", () => {
    handle.detach();
    expect(() => handle.detach()).not.toThrow();
  });
});
