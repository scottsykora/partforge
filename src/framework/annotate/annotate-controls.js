// Viewbar chrome for annotation mode: the pencil toggle + contextual actions
// (Undo / Clear / Send) shown while the mode is on. A direct sibling of
// measure-controls.js — same no-op-without-button contract, same attribute
// restore discipline on detach. The mode object (annotate-mode.js) owns all
// behavior; this file only puts it on screen. One extra contract: a host whose
// markup HAS the button but whose mount passed no onAnnotationSend gets the
// button hidden entirely (spec: no dead Send) — mount passes mode = null.
import { attachButtonTooltips } from "../tooltip.js";
import { runCleanupSteps, captureAttributes, restoreAttributes } from "../teardown.js";

const BUTTON_ATTRIBUTES = ["type", "aria-pressed", "aria-label", "title", "disabled", "hidden"];
const PENCIL_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>`;

const noop = () => {};

export function attachAnnotateControls(viewer, mode, { annotate: button } = {}, { tooltip, escapeScope } = {}) {
  if (!button) return { detach: noop };

  const hostAttributes = captureAttributes(button, BUTTON_ATTRIBUTES);
  if (!mode) {
    button.hidden = true;
    let restored = false;
    return {
      detach() {
        if (restored) return;
        restored = true;
        restoreAttributes(button, hostAttributes);
      },
    };
  }
  const hostHtml = button.innerHTML;
  const hostOn = button.classList.contains("on");

  button.type = "button";
  button.innerHTML = PENCIL_ICON;
  button.setAttribute("aria-pressed", "false");
  if (!tooltip && !button.hasAttribute("title")) button.title = "Annotate the view";

  const actions = document.createElement("span");
  actions.className = "pf-annotate-actions";
  const undoButton = document.createElement("button");
  undoButton.type = "button";
  undoButton.textContent = "Undo";
  undoButton.title = "Remove the last stroke";
  undoButton.setAttribute("aria-label", "Remove the last stroke");
  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.textContent = "Clear";
  clearButton.title = "Remove all strokes";
  clearButton.setAttribute("aria-label", "Remove all strokes");
  const sendButton = document.createElement("button");
  sendButton.type = "button";
  sendButton.className = "pf-annotate-send";
  sendButton.textContent = "Send";
  sendButton.title = "Send the annotation";
  sendButton.setAttribute("aria-label", "Send the annotation");
  actions.append(undoButton, clearButton, sendButton);
  button.after(actions);

  const tooltipBinding = tooltip
    ? attachButtonTooltips(tooltip, [button, undoButton, clearButton, sendButton].map((element) => ({ element })))
    : null;

  function sync() {
    const on = mode.isEnabled();
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("aria-label", on ? "Stop annotating" : "Annotate the view");
    button.classList.toggle("on", on);
    actions.hidden = !on;
    const empty = mode.strokeCount() === 0;
    undoButton.disabled = empty;
    clearButton.disabled = empty;
    sendButton.disabled = empty;
    tooltipBinding?.sync();
  }

  const onToggle = () => { mode.setEnabled(!mode.isEnabled()); sync(); };
  const onUndo = () => { mode.undo(); sync(); };
  const onClear = () => { mode.clear(); sync(); };
  const onSendClick = () => { mode.send(); sync(); };
  const onEscape = (event) => {
    if (event.key !== "Escape" || !mode.isEnabled()) return;
    event.preventDefault();
    // Consume the keystroke — same order-independence contract as
    // measure-controls.js vs cutaway (which covers itself with escapeGuard;
    // mount extends that guard to include annotate).
    event.stopImmediatePropagation();
    mode.setEnabled(false);
    sync();
    tooltipBinding?.hide();
  };
  const offInk = mode.onInkChange(sync);
  const offMode = mode.onModeChange(sync);

  button.addEventListener("click", onToggle);
  undoButton.addEventListener("click", onUndo);
  clearButton.addEventListener("click", onClear);
  sendButton.addEventListener("click", onSendClick);
  const escapeTargets = [escapeScope ?? viewer.domElement, button, undoButton, clearButton, sendButton];
  for (const element of escapeTargets) element.addEventListener("keydown", onEscape);
  sync();

  let detached = false;
  return {
    detach() {
      if (detached) return;
      detached = true;
      runCleanupSteps([
        offInk,
        offMode,
        () => button.removeEventListener("click", onToggle),
        () => undoButton.removeEventListener("click", onUndo),
        () => clearButton.removeEventListener("click", onClear),
        () => sendButton.removeEventListener("click", onSendClick),
        ...escapeTargets.map((element) => () => element.removeEventListener("keydown", onEscape)),
        () => tooltipBinding?.detach(),
        () => actions.remove(),
        () => restoreAttributes(button, hostAttributes),
        () => { button.innerHTML = hostHtml; },
        () => button.classList.toggle("on", hostOn),
      ], "annotate control cleanup failed");
    },
  };
}
