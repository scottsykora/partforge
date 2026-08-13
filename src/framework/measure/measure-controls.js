// Viewbar chrome for measurement mode: the ruler toggle + contextual actions
// ("Clear" when pins exist, a static "mm" unit tag). A direct sibling of
// cutaway-controls.js — same no-op-without-button contract, same attribute
// restore discipline on detach. The mode object (measure-mode.js) owns all
// behavior; this file only puts it on screen.
import { attachButtonTooltips } from "../tooltip.js";

const BUTTON_ATTRIBUTES = ["type", "aria-pressed", "aria-label", "title", "disabled"];
const RULER_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.3 8.7 8.7 21.3c-.4.4-1 .4-1.4 0l-4.6-4.6c-.4-.4-.4-1 0-1.4L15.3 2.7c.4-.4 1-.4 1.4 0l4.6 4.6c.4.4.4 1 0 1.4Z"/><path d="m7.5 10.5 2 2"/><path d="m10.5 7.5 2 2"/><path d="m13.5 4.5 2 2"/><path d="m4.5 13.5 2 2"/></svg>`;

const noop = () => {};

function runCleanupSteps(steps) {
  const errors = [];
  for (const step of steps) {
    try { step(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "measure control cleanup failed");
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

export function attachMeasureControls(viewer, mode, { measure: button } = {}, { tooltip } = {}) {
  if (!button) return { detach: noop };

  const hostAttributes = captureAttributes(button, BUTTON_ATTRIBUTES);
  const hostHtml = button.innerHTML;
  const hostOn = button.classList.contains("on");

  button.type = "button";
  button.innerHTML = RULER_ICON;
  button.setAttribute("aria-pressed", "false");
  if (!tooltip && !button.hasAttribute("title")) button.title = "Toggle measurements";

  const actions = document.createElement("span");
  actions.className = "pf-measure-actions";
  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.textContent = "Clear";
  clearButton.title = "Remove all pinned measurements";
  clearButton.setAttribute("aria-label", "Remove all pinned measurements");
  const unitTag = document.createElement("span");
  unitTag.className = "pf-measure-unit";
  unitTag.textContent = "mm";
  actions.append(clearButton, unitTag);
  button.after(actions);

  const tooltipBinding = tooltip
    ? attachButtonTooltips(tooltip, [button, clearButton].map((element) => ({ element })))
    : null;

  function sync() {
    const on = mode.isEnabled();
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("aria-label", on ? "Hide measurements" : "Show measurements");
    button.classList.toggle("on", on);
    actions.hidden = !on;
    clearButton.hidden = mode.pinCount() === 0;
    tooltipBinding?.sync();
  }

  const onToggle = () => { mode.setEnabled(!mode.isEnabled()); sync(); };
  const onClear = () => { mode.clearPins(); sync(); };
  const onEscape = (event) => {
    if (event.key !== "Escape" || !mode.isEnabled()) return;
    event.preventDefault();
    // Consume the keystroke: with measure attached first, cutaway's listener
    // on the same element would otherwise read the guard AFTER we've disabled
    // and close too. Order-independent together with cutaway's escapeGuard
    // (which covers the cutaway-attached-first order).
    event.stopImmediatePropagation();
    mode.setEnabled(false);
    sync();
    tooltipBinding?.hide();
  };
  const offPins = mode.onPinsChange(sync);

  button.addEventListener("click", onToggle);
  clearButton.addEventListener("click", onClear);
  const escapeTargets = [viewer.domElement, button, clearButton];
  for (const element of escapeTargets) element.addEventListener("keydown", onEscape);
  sync();

  let detached = false;
  return {
    detach() {
      if (detached) return;
      detached = true;
      runCleanupSteps([
        offPins,
        () => button.removeEventListener("click", onToggle),
        () => clearButton.removeEventListener("click", onClear),
        ...escapeTargets.map((element) => () => element.removeEventListener("keydown", onEscape)),
        () => tooltipBinding?.detach(),
        () => actions.remove(),
        () => restoreAttributes(button, hostAttributes),
        () => { button.innerHTML = hostHtml; },
        () => button.classList.toggle("on", hostOn),
      ]);
    },
  };
}
