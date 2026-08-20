// The view cube's chrome: the bottom-right stack (cube over projection button),
// and the visually-hidden per-view buttons that stand in for the DOM focus a
// canvas cannot give us. Generated, not declared — no part's HTML carries this,
// and partforge-cloud's scaffold does not either (the mobile-tabs.js and
// animation-controls.js precedent).
//
// The projection button deliberately lives OUTSIDE #viewbar: partforge-cloud's
// sandbox-scaffold test enumerates #viewbar's buttons against what it renders,
// and this one is the framework's own.
import { attachButtonTooltips } from "../tooltip.js";
import { runCleanupSteps } from "../teardown.js";
import { createViewcubeMode } from "./viewcube-mode.js";

const PERSPECTIVE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4l18 3v10l-18 3z"/><path d="M3 4v16"/></svg>`;
const ORTHOGRAPHIC_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="14" height="12" rx="1"/><path d="M7 6V3h14v12h-4"/></svg>`;

// One hidden button per canonical FACE view. Edges and corners are reachable by
// pointer only — six targets is a usable keyboard surface; twenty-six is a
// tab-stop thicket.
const KEY_VIEWS = [
  ["front", "View from the front"],
  ["back", "View from the back"],
  ["left", "View from the left"],
  ["right", "View from the right"],
  ["top", "View from the top"],
  ["bottom", "View from the bottom"],
];

export function attachViewcubeControls(viewer, { stage } = {}, { tooltip } = {}) {
  const stack = document.createElement("div");
  stack.className = "pf-viewcube-stack";
  stage.appendChild(stack);

  const mode = createViewcubeMode(viewer, { host: stack });

  const pill = document.createElement("div");
  pill.className = "pf-viewcube-pill";
  const button = document.createElement("button");
  button.type = "button";
  button.id = "projection";
  pill.appendChild(button);
  stack.appendChild(pill);

  const keys = document.createElement("div");
  keys.className = "pf-viewcube-key";
  const keyButtons = KEY_VIEWS.map(([view, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.view = view;
    b.textContent = label;
    b.setAttribute("aria-label", label);
    keys.appendChild(b);
    return b;
  });
  stack.appendChild(keys);

  const tooltipBinding = tooltip
    ? attachButtonTooltips(tooltip, [{ element: button }])
    : null;

  function sync() {
    const ortho = viewer.getProjection() === "orthographic";
    button.innerHTML = ortho ? ORTHOGRAPHIC_ICON : PERSPECTIVE_ICON;
    button.classList.toggle("on", ortho);
    button.setAttribute("aria-pressed", String(ortho));
    const label = ortho ? "Switch to perspective view" : "Switch to orthographic view";
    button.setAttribute("aria-label", label);
    if (!tooltip) button.title = label;
    tooltipBinding?.sync();
  }

  const onToggle = () => {
    viewer.setProjection(viewer.getProjection() === "orthographic" ? "perspective" : "orthographic");
    sync();
  };
  button.addEventListener("click", onToggle);

  const keyHandlers = keyButtons.map((b) => {
    const handler = () => viewer.tweenCameraTo(b.dataset.view, { duration: 0.6 });
    b.addEventListener("click", handler);
    return handler;
  });

  // A host or another mode can flip projection without going through this
  // button; the chrome follows rather than drifting out of sync.
  const offProjection = viewer.onProjectionChange(sync);
  sync();

  function setHidden(flag) {
    const next = !!flag;
    stack.hidden = next;
    // Stand the frame subscription's work down too, not just the pixels.
    mode.setHidden(next);
  }

  let detached = false;
  return {
    element: stack,
    mode,
    setHidden,
    detach() {
      if (detached) return;
      detached = true;
      runCleanupSteps([
        offProjection,
        () => button.removeEventListener("click", onToggle),
        ...keyButtons.map((b, i) => () => b.removeEventListener("click", keyHandlers[i])),
        () => tooltipBinding?.detach(),
        () => mode.detach(),
        () => stack.remove(),
      ], "viewcube control cleanup failed");
    },
  };
}
