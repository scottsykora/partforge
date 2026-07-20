import { attachButtonTooltips } from "./tooltip.js";

const UNSUPPORTED_TITLE = "Cutaway requires a stencil-capable WebGL context";
const BUTTON_ATTRIBUTES = [
  "type",
  "aria-pressed",
  "aria-label",
  "title",
  "disabled",
  "aria-description",
];

const noop = () => {};

function runCleanupSteps(steps) {
  const errors = [];
  for (const step of steps) {
    try { step(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "cutaway control cleanup failed");
  }
}

function actionButton(label, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  return button;
}

function captureAttributes(element, names) {
  return new Map(names.map((name) => [name, {
    present: element.hasAttribute(name),
    value: element.getAttribute(name),
  }]));
}

function restoreAttributes(element, attributes) {
  for (const [name, { present, value }] of attributes) {
    if (present) element.setAttribute(name, value);
    else element.removeAttribute(name);
  }
}

// Wire the optional cutaway button to the viewer and create its contextual
// actions. Hosts that omit the primary button opt out of all DOM behavior.
export function attachCutawayControls(viewer, { cutaway: button } = {}, { tooltip } = {}) {
  if (!button) return { reset: noop, detach: noop };

  const canvas = viewer.domElement;
  const addedCanvasTabIndex = !canvas.hasAttribute("tabindex");
  const addedCanvasLabel = !canvas.hasAttribute("aria-label");
  if (addedCanvasTabIndex) canvas.tabIndex = 0;
  if (addedCanvasLabel) canvas.setAttribute("aria-label", "3D part viewer");

  const hostButtonAttributes = captureAttributes(button, BUTTON_ATTRIBUTES);
  const hostButtonDisabled = button.disabled;
  const hostButtonOn = button.classList.contains("on");

  const actions = document.createElement("span");
  actions.className = "pf-cutaway-actions";
  const flipButton = actionButton("Flip", "Flip cutaway direction");
  const resetButton = actionButton("Reset", "Reset cutaway plane");
  actions.append(flipButton, resetButton);
  const tooltipBinding = tooltip
    ? attachButtonTooltips(tooltip, [button, flipButton, resetButton].map((element) => ({ element })))
    : null;

  button.type = "button";
  button.setAttribute("aria-pressed", "false");
  if (!tooltip && !button.hasAttribute("title")) button.title = "Toggle cutaway view";

  const supported = viewer.cutawaySupported();
  if (!supported) {
    button.disabled = true;
    if (!tooltip) button.title = UNSUPPORTED_TITLE;
    button.setAttribute("aria-description", UNSUPPORTED_TITLE);
  }

  button.after(actions);

  function sync() {
    const enabled = supported && viewer.cutawayEnabled();
    button.setAttribute("aria-pressed", String(enabled));
    button.setAttribute(
      "aria-label",
      supported ? (enabled ? "Disable cutaway" : "Enable cutaway") : UNSUPPORTED_TITLE,
    );
    button.classList.toggle("on", enabled);
    actions.hidden = !enabled;
    tooltipBinding?.sync();
  }

  let detached = false;
  function disable() {
    if (detached) return;
    const restoreFocus = actions.contains(document.activeElement);
    viewer.setCutawayEnabled(false);
    sync();
    tooltipBinding?.hide();
    if (restoreFocus) button.focus({ preventScroll: true });
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

  return {
    reset: disable,
    detach() {
      if (detached) return;
      detached = true;
      runCleanupSteps([
        () => button.removeEventListener("click", onToggle),
        () => flipButton.removeEventListener("click", onFlip),
        () => resetButton.removeEventListener("click", onReset),
        ...[canvas, button, flipButton, resetButton]
          .map((element) => () => element.removeEventListener("keydown", onEscape)),
        () => canvas.removeEventListener("pointerdown", onCanvasPointerDown),
        () => { if (addedCanvasTabIndex) canvas.removeAttribute("tabindex"); },
        () => { if (addedCanvasLabel) canvas.removeAttribute("aria-label"); },
        () => tooltipBinding?.detach(),
        () => actions.remove(),
        () => restoreAttributes(button, hostButtonAttributes),
        () => { button.disabled = hostButtonDisabled; },
        () => button.classList.toggle("on", hostButtonOn),
      ]);
    },
  };
}
