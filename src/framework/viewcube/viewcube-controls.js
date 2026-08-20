// The view cube's chrome: the bottom-right stack (the cube, with the projection
// toggle over its bottom-right corner), and the visually-hidden per-view buttons
// that stand in for the DOM focus a canvas cannot give us. Generated, not
// declared — no part's HTML carries this, and partforge-cloud's scaffold does
// not either (the mobile-tabs.js and animation-controls.js precedent).
//
// The projection button deliberately lives OUTSIDE #viewbar: partforge-cloud's
// sandbox-scaffold test enumerates #viewbar's buttons against what it renders,
// and this one is the framework's own.
//
// The button used to sit in its own `.pf-viewcube-pill` card below the cube,
// borrowing #viewbar's chrome. The 2026-08-20 revision made it a small bare
// circle beside the cube instead (see chrome.css/app.css's viewcube sections),
// so the pill card — which existed only to give a single button somewhere to
// sit — is gone; the button is now a direct child of the stack.
//
// A same-day follow-up took it out of the stack's flex flow entirely and laid
// it OVER the cube's bottom-right corner. The DOM is unchanged (still a direct
// child, still after the cube's wrapper, which is what puts it on top); the
// visible consequence is that the stack is now exactly as wide as the canvas
// rather than `canvas + gap + button`, so the size it publishes below — and
// therefore the crowding decision that reads it — went from 167px to 135
// (101 below the rail's narrow breakpoint).
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

  const button = document.createElement("button");
  button.type = "button";
  button.id = "projection";
  button.className = "pf-viewcube-toggle";
  stack.appendChild(button);

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

  // Publish the stack's size on the element itself, in the data-pf-* convention
  // the shell already uses (data-pf-pane). animation-controls.js reads it to
  // decide whether the transport bar is crowded, and that decision has to come
  // out the same whether or not the stack is on screen — otherwise hiding the
  // cube un-crowds the bar, the bar un-hides the cube, and the two oscillate a
  // frame at a time (see nominalClusterRect for the full argument). A
  // display:none element measures all zeros, so the size cannot be read live;
  // it has to have been written down.
  //
  // Only ever written from a REAL measured size, so the last real values survive
  // a hide. They change only at the rail's narrow breakpoint, which leaves one
  // stale case: a breakpoint change that happens WHILE hidden leaves the
  // full-size value published. That is benign and deliberately not "fixed" — it
  // is the conservative direction (it keeps the cube hidden rather than
  // flickering it back), and the next real measurement corrects it.
  //
  // A dataset write affects no layout, so this observer cannot feed itself.
  const publishSize = () => {
    const { width, height } = stack.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    stack.dataset.pfW = String(Math.round(width));
    stack.dataset.pfH = String(Math.round(height));
  };
  const sizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(publishSize) : null;
  sizeObserver?.observe(stack);
  publishSize(); // the observer's first callback is a frame away; the reader may not be

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
        () => sizeObserver?.disconnect(),
        () => button.removeEventListener("click", onToggle),
        ...keyButtons.map((b, i) => () => b.removeEventListener("click", keyHandlers[i])),
        () => tooltipBinding?.detach(),
        () => mode.detach(),
        () => stack.remove(),
      ], "viewcube control cleanup failed");
    },
  };
}
