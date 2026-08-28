// Sketch-mode toolbar: the top-centre pill that OWNS the mode while sketch
// mode is on (annotate-controls.js's viewbar pencil+actions is hidden for the
// duration — mount toggles both). A direct sibling of annotate-controls.js:
// same mode-object-owns-behavior split, same tooltip/cleanup idioms, same
// `send: "host"` contract for a host that draws its own send affordance.
//
// Two DOM nodes are appended to the stage: the toolbar pill itself and a
// `.pf-sketch-hint` sibling (not a child — see the CSS, which positions it
// independently below the pill) carrying a one-line usage hint for the
// active tool.
import { attachButtonTooltips } from "../tooltip.js";
import { runCleanupSteps } from "../teardown.js";
import { INK_COLORS } from "./elements.js";

// pen: the same pencil glyph as annotate-controls.js's toggle button.
const PEN_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>`;
const LINE_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19 19 5"/></svg>`;
const RECT_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="6" width="16" height="12" rx="1"/></svg>`;
const ELLIPSE_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="12" rx="9" ry="6.5"/></svg>`;
// hand: lucide "hand" glyph.
const HAND_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>`;
// eraser: lucide "eraser" glyph.
const ERASER_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>`;
// undo: lucide "undo-2" glyph.
const UNDO_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>`;
// clear: lucide "trash-2" glyph.
const CLEAR_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
// close: lucide "x" glyph. The toolbar's own exit affordance — see its
// wiring below for why the mode needs one now that #viewbar (and the pencil
// toggle that used to sit on it) is hidden for the duration of sketch mode.
const CLOSE_ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

const TOOLS = [
  { tool: "pen", icon: PEN_ICON, label: "Pen", hint: "drag to draw" },
  { tool: "line", icon: LINE_ICON, label: "Line", hint: "drag endpoint to endpoint · snaps to 0/45/90° · shift forces" },
  { tool: "rect", icon: RECT_ICON, label: "Rectangle", hint: "drag corner to corner · snaps to square · shift forces" },
  { tool: "ellipse", icon: ELLIPSE_ICON, label: "Ellipse", hint: "drag corner to corner · snaps to circle · shift forces" },
  { tool: "hand", icon: HAND_ICON, label: "Move", hint: "drag a shape to move it · handles resize · just outside rotates" },
  { tool: "eraser", icon: ERASER_ICON, label: "Eraser", hint: "scrub to erase" },
];

const COLOR_LABELS = { red: "Red ink", blue: "Blue ink", green: "Green ink" };

function makeButton({ className = "", dataset = {}, title, ariaLabel, html }) {
  const button = document.createElement("button");
  button.type = "button";
  if (className) button.className = className;
  for (const [key, value] of Object.entries(dataset)) button.dataset[key] = value;
  if (html !== undefined) button.innerHTML = html;
  if (title) button.title = title;
  button.setAttribute("aria-label", ariaLabel ?? title ?? "");
  return button;
}

function makeSeparator() {
  const sep = document.createElement("span");
  sep.className = "sep";
  sep.setAttribute("aria-hidden", "true");
  return sep;
}

export function attachSketchToolbar(mode, { stage, tooltip, send = "viewbar" } = {}) {
  const element = document.createElement("div");
  element.className = "pf-sketch-toolbar";
  element.setAttribute("role", "toolbar");
  element.hidden = true;

  const hint = document.createElement("div");
  hint.className = "pf-sketch-hint";
  hint.hidden = true;

  const toolButtons = TOOLS.map(({ tool, icon, label }) => makeButton({
    dataset: { tool },
    title: label,
    html: icon,
  }));
  for (const button of toolButtons) button.setAttribute("aria-pressed", "false");
  element.append(...toolButtons, makeSeparator());

  const swatchButtons = Object.keys(INK_COLORS).map((color) => {
    const button = makeButton({
      className: "pf-swatch",
      dataset: { color },
      title: COLOR_LABELS[color] ?? color,
    });
    button.style.setProperty("--sw", INK_COLORS[color]);
    return button;
  });
  element.append(...swatchButtons, makeSeparator());

  const undoButton = makeButton({ dataset: { action: "undo" }, title: "Undo", html: UNDO_ICON });
  const clearButton = makeButton({ dataset: { action: "clear" }, title: "Clear", html: CLEAR_ICON });
  element.append(undoButton, clearButton);

  let sendButton = null;
  if (send !== "host") {
    sendButton = makeButton({ dataset: { action: "send" }, title: "Send" });
    sendButton.textContent = "Send";
    element.append(sendButton);
  }

  // Close: the toolbar's own exit affordance, always the LAST button — it
  // must outlive send's presence/absence so the mode is exitable in-UI
  // regardless of the `send` variant. Never disabled (unlike undo/clear/
  // send, which gate on stroke count): exiting has to work with an empty
  // sketch. annotate-mode.js's document-capture Escape listener covers the
  // keyboard path; this covers pointer/touch, including mobile, which has no
  // Escape key at all.
  const closeButton = makeButton({ dataset: { action: "close" }, title: "Exit sketch", html: CLOSE_ICON });
  element.append(closeButton);

  stage.append(element, hint);

  const allButtons = [...toolButtons, ...swatchButtons, undoButton, clearButton, sendButton, closeButton].filter(Boolean);
  const tooltipBinding = tooltip
    ? attachButtonTooltips(tooltip, allButtons.map((btn) => ({ element: btn })))
    : null;

  function syncTools() {
    const activeTool = mode.tool();
    for (const button of toolButtons) {
      const on = button.dataset.tool === activeTool;
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", String(on));
    }
    const activeColor = mode.color();
    for (const button of swatchButtons) {
      button.classList.toggle("on", button.dataset.color === activeColor);
    }
    const entry = TOOLS.find((t) => t.tool === activeTool);
    hint.textContent = entry?.hint ?? "";
  }

  function syncDisabled() {
    const empty = mode.strokeCount() === 0;
    undoButton.disabled = !mode.canUndo();
    clearButton.disabled = empty;
    if (sendButton) sendButton.disabled = empty;
    tooltipBinding?.sync();
  }

  function syncVisibility() {
    const on = mode.isEnabled();
    element.hidden = !on;
    hint.hidden = !on;
  }

  function sync() {
    syncTools();
    syncDisabled();
    syncVisibility();
  }

  const onUndo = () => mode.undo();
  const onClear = () => mode.clear();
  const onSendClick = () => mode.send();
  const onClose = () => mode.setEnabled(false);

  const toolHandlers = toolButtons.map((button) => {
    const handler = () => mode.setTool(button.dataset.tool);
    button.addEventListener("click", handler);
    return { button, handler };
  });
  const colorHandlers = swatchButtons.map((button) => {
    const handler = () => mode.setColor(button.dataset.color);
    button.addEventListener("click", handler);
    return { button, handler };
  });
  undoButton.addEventListener("click", onUndo);
  clearButton.addEventListener("click", onClear);
  sendButton?.addEventListener("click", onSendClick);
  closeButton.addEventListener("click", onClose);

  const offTool = mode.onToolChange(sync);
  const offInk = mode.onInkChange(sync);
  const offMode = mode.onModeChange(sync);

  sync();

  let detached = false;
  return {
    element,
    detach() {
      if (detached) return;
      detached = true;
      runCleanupSteps([
        offTool,
        offInk,
        offMode,
        ...toolHandlers.map(({ button, handler }) => () => button.removeEventListener("click", handler)),
        ...colorHandlers.map(({ button, handler }) => () => button.removeEventListener("click", handler)),
        () => undoButton.removeEventListener("click", onUndo),
        () => clearButton.removeEventListener("click", onClear),
        () => sendButton?.removeEventListener("click", onSendClick),
        () => closeButton.removeEventListener("click", onClose),
        () => tooltipBinding?.detach(),
        () => element.remove(),
        () => hint.remove(),
      ], "sketch toolbar cleanup failed");
    },
  };
}
