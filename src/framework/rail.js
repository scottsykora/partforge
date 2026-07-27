import {
  RAIL_DEFAULT_WIDTH, RAIL_MIN_WIDTH, RAIL_NARROW_BREAKPOINT,
  clampRailWidth, railMaxWidth, readRailPref, resolveRailDrag, writeRailPref,
} from "./rail-state.js";

const KEY_STEP = 16;
const KEY_STEP_SHIFT = 64;
// A held arrow-key repeat must not animate either, so the suppression flag
// covers the whole repeat window rather than just the instant of a keydown.
const KEY_SETTLE_MS = 200;

// Make the controls rail resizable and collapsible, with partforge-cloud's seam
// affordance: a 12px hit target holding a pill that is invisible until hover,
// keyboard focus, or a drag.
//
// The seam is created here, so no host markup declares it. Width is written
// straight onto :root as --pf-rail-w during a drag with no state layer in
// between: every width change resizes the viewer, whose ResizeObserver
// reallocates the WebGL drawing buffer. One reallocation per frame is inherent
// to live resizing; anything on top of it is not.
//
// Everything is optional. With no rail this returns a no-op, so hosts that lay
// the framework out themselves (see embed-test.html) are unaffected.
export function attachRail({ rail, toggle, shell = rail?.parentElement, storage = globalThis.localStorage } = {}) {
  if (!rail || !shell) return { detach: () => {} };

  const root = document.documentElement;
  const shellBox = () => shell.getBoundingClientRect();
  const shellWidth = () => shellBox().width;
  let state = readRailPref(storage, shellWidth());

  const seam = document.createElement("div");
  seam.className = "pf-rail-seam";
  seam.setAttribute("role", "separator");
  seam.setAttribute("aria-orientation", "vertical");
  seam.setAttribute("aria-label", "Resize controls");
  seam.setAttribute("aria-valuemin", "0");
  seam.tabIndex = 0;
  seam.append(document.createElement("span")); // the hover/focus affordance
  rail.before(seam);

  function apply({ persist = false } = {}) {
    const width = state.collapsed ? 0 : clampRailWidth(state.width, shellWidth());
    root.style.setProperty("--pf-rail-w", `${width}px`);
    rail.toggleAttribute("inert", state.collapsed);
    seam.toggleAttribute("data-collapsed", state.collapsed);
    seam.setAttribute("aria-valuenow", String(width));
    seam.setAttribute("aria-valuemax", String(railMaxWidth(shellWidth())));
    if (toggle) {
      toggle.textContent = state.collapsed ? "⇤" : "⇥";
      const label = state.collapsed ? "Show controls" : "Hide controls";
      toggle.setAttribute("aria-expanded", String(!state.collapsed));
      toggle.setAttribute("aria-label", label);
      toggle.title = label;
      toggle.classList.toggle("on", state.collapsed);
    }
    if (persist) writeRailPref(state, storage);
  }

  // --- discrete changes: animate, and commit immediately ---
  let keyTimer = 0;
  function settleKeys() {
    clearTimeout(keyTimer);
    shell.removeAttribute("data-pf-key-resizing");
  }
  function commit(next) {
    settleKeys(); // a discrete change interrupting a key repeat animates normally
    state = next;
    apply({ persist: true });
  }
  const toggleCollapsed = () => commit({ collapsed: !state.collapsed, width: state.width });

  // --- keyboard: move the SEPARATOR (standard role="separator" semantics), so
  // ArrowLeft widens a right-hand rail. Arrows clamp at the minimum and never
  // collapse; Enter/Space is the collapse gesture.
  function onKeyDown(e) {
    const from = state.collapsed ? 0 : state.width;
    const step = e.shiftKey ? KEY_STEP_SHIFT : KEY_STEP;
    let width;
    switch (e.key) {
      case "ArrowLeft": width = from + step; break;
      case "ArrowRight": width = from - step; break;
      case "Home": width = RAIL_MIN_WIDTH; break;
      case "End": width = railMaxWidth(shellWidth()); break;
      case "Enter": case " ": e.preventDefault(); toggleCollapsed(); return;
      default: return;
    }
    e.preventDefault();
    state = { collapsed: false, width: clampRailWidth(width, shellWidth()) };
    shell.toggleAttribute("data-pf-key-resizing", true);
    clearTimeout(keyTimer);
    keyTimer = setTimeout(() => {
      shell.removeAttribute("data-pf-key-resizing");
      writeRailPref(state, storage);
    }, KEY_SETTLE_MS);
    apply();
  }

  const onDoubleClick = () => commit({ collapsed: false, width: RAIL_DEFAULT_WIDTH });
  const onToggleClick = () => toggleCollapsed();

  // --- drag ---
  let grabOffset = 0;
  function onPointerDown(e) {
    if (e.button !== 0) return;
    // Stacked layout: the rail is under the viewer, so there is no vertical seam
    // to drag (chrome.css hides it). The toggle still works.
    if (window.innerWidth < RAIL_NARROW_BREAKPOINT) return;
    e.preventDefault();
    // setPointerCapture is load-bearing: without it the pointer crosses into the
    // viewer (an iframe, in the cloud editor) whose document eats the move
    // events, and the drag dies the moment it reaches the thing being resized.
    seam.setPointerCapture?.(e.pointerId);
    const box = seam.getBoundingClientRect();
    // Where inside the 12px seam the grab landed, so the rail edge doesn't jump.
    grabOffset = e.clientX - (box.left + box.width / 2);
    shell.toggleAttribute("data-pf-dragging", true);
  }
  function onPointerMove(e) {
    if (!shell.hasAttribute("data-pf-dragging")) return;
    const railX = shellBox().right - (e.clientX - grabOffset);
    state = resolveRailDrag(railX, state, shellWidth());
    apply();
  }
  function onPointerUp(e) {
    if (!shell.hasAttribute("data-pf-dragging")) return;
    seam.releasePointerCapture?.(e.pointerId);
    shell.removeAttribute("data-pf-dragging");
    apply({ persist: true });
  }

  seam.addEventListener("pointerdown", onPointerDown);
  seam.addEventListener("pointermove", onPointerMove);
  seam.addEventListener("pointerup", onPointerUp);
  seam.addEventListener("pointercancel", onPointerUp);
  seam.addEventListener("keydown", onKeyDown);
  seam.addEventListener("dblclick", onDoubleClick);
  toggle?.addEventListener("click", onToggleClick);
  // A window resize can invalidate the clamp (max is half the shell).
  const onResize = () => apply();
  window.addEventListener("resize", onResize);

  apply();

  return {
    detach: () => {
      settleKeys();
      seam.removeEventListener("pointerdown", onPointerDown);
      seam.removeEventListener("pointermove", onPointerMove);
      seam.removeEventListener("pointerup", onPointerUp);
      seam.removeEventListener("pointercancel", onPointerUp);
      seam.removeEventListener("keydown", onKeyDown);
      seam.removeEventListener("dblclick", onDoubleClick);
      toggle?.removeEventListener("click", onToggleClick);
      window.removeEventListener("resize", onResize);
      seam.remove();
      shell.removeAttribute("data-pf-dragging");
      rail.removeAttribute("inert");
      root.style.removeProperty("--pf-rail-w");
    },
  };
}
