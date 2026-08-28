// Viewbar chrome for annotation mode: just the pencil toggle. A direct
// sibling of measure-controls.js — same no-op-without-button contract, same
// attribute restore discipline on detach. The mode object (annotate-mode.js)
// owns all behavior; this file only puts the toggle on screen. One extra
// contract: a host whose markup HAS the button but whose mount passed no
// onAnnotationSend gets the button hidden entirely (spec: no dead toggle) —
// mount passes mode = null.
//
// The Undo/Clear/Send actions that used to live in a row beside this button
// moved to the sketch toolbar (sketch-toolbar.js, spec 2026-08-27) — the
// toolbar OWNS the top of the stage while sketch mode is on, replacing the
// whole viewbar rather than sharing it. This file no longer knows about
// Undo/Clear/Send at all.
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
  if (!tooltip && !button.hasAttribute("title")) button.title = "Sketch";

  const tooltipBinding = tooltip
    ? attachButtonTooltips(tooltip, [{ element: button }])
    : null;

  function sync() {
    const on = mode.isEnabled();
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("aria-label", on ? "Stop sketching" : "Sketch");
    button.classList.toggle("on", on);
    tooltipBinding?.sync();
  }

  const onToggle = () => { mode.setEnabled(!mode.isEnabled()); sync(); };
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
  const offMode = mode.onModeChange(sync);

  button.addEventListener("click", onToggle);
  const escapeTargets = [escapeScope ?? viewer.domElement, button];
  for (const element of escapeTargets) element.addEventListener("keydown", onEscape);
  sync();

  let detached = false;
  return {
    detach() {
      if (detached) return;
      detached = true;
      runCleanupSteps([
        offMode,
        () => button.removeEventListener("click", onToggle),
        ...escapeTargets.map((element) => () => element.removeEventListener("keydown", onEscape)),
        () => tooltipBinding?.detach(),
        () => restoreAttributes(button, hostAttributes),
        () => { button.innerHTML = hostHtml; },
        () => button.classList.toggle("on", hostOn),
      ], "annotate control cleanup failed");
    },
  };
}
