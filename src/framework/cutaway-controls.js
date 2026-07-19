const UNSUPPORTED_TITLE = "Cutaway requires a stencil-capable WebGL context";

const noop = () => {};

function actionButton(label, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  return button;
}

// Wire the optional cutaway button to the viewer and create its contextual
// actions. Hosts that omit the primary button opt out of all DOM behavior.
export function attachCutawayControls(viewer, { cutaway: button } = {}) {
  if (!button) return { reset: noop, detach: noop };

  const canvas = viewer.domElement;
  const addedCanvasTabIndex = !canvas.hasAttribute("tabindex");
  if (addedCanvasTabIndex) canvas.tabIndex = 0;

  button.type = "button";
  button.setAttribute("aria-pressed", "false");
  if (!button.hasAttribute("title")) button.title = "Toggle cutaway view";

  const supported = viewer.cutawaySupported();
  if (!supported) {
    button.disabled = true;
    button.title = UNSUPPORTED_TITLE;
  }

  const actions = document.createElement("span");
  actions.className = "pf-cutaway-actions";
  const flipButton = actionButton("Flip", "Flip cutaway direction");
  const resetButton = actionButton("Reset", "Reset cutaway plane");
  actions.append(flipButton, resetButton);
  button.after(actions);

  function sync() {
    const enabled = supported && viewer.cutawayEnabled();
    button.setAttribute("aria-pressed", String(enabled));
    button.classList.toggle("on", enabled);
    actions.hidden = !enabled;
  }

  function disable() {
    viewer.setCutawayEnabled(false);
    sync();
  }

  const onToggle = () => {
    viewer.setCutawayEnabled(!viewer.cutawayEnabled());
    sync();
  };
  const onFlip = () => viewer.flipCutaway();
  const onReset = () => {
    viewer.resetCutaway();
    sync();
  };
  const onEscape = (event) => {
    if (event.key !== "Escape" || !viewer.cutawayEnabled()) return;
    event.preventDefault();
    disable();
  };
  const onCanvasPointerDown = () => canvas.focus({ preventScroll: true });

  button.addEventListener("click", onToggle);
  flipButton.addEventListener("click", onFlip);
  resetButton.addEventListener("click", onReset);
  for (const element of [canvas, button, flipButton, resetButton]) {
    element.addEventListener("keydown", onEscape);
  }
  canvas.addEventListener("pointerdown", onCanvasPointerDown);
  sync();

  let detached = false;
  return {
    reset: disable,
    detach() {
      if (detached) return;
      detached = true;
      button.removeEventListener("click", onToggle);
      flipButton.removeEventListener("click", onFlip);
      resetButton.removeEventListener("click", onReset);
      for (const element of [canvas, button, flipButton, resetButton]) {
        element.removeEventListener("keydown", onEscape);
      }
      canvas.removeEventListener("pointerdown", onCanvasPointerDown);
      if (addedCanvasTabIndex) canvas.removeAttribute("tabindex");
      actions.remove();
    },
  };
}
