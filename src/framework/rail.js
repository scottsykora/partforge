import {
  RAIL_DEFAULT_WIDTH, RAIL_MIN_WIDTH, RAIL_NARROW_BREAKPOINT,
  clampRailWidth, railMaxWidth, readRailPref, resolveRailDrag, writeRailPref,
} from "./rail-state.js";

const KEY_STEP = 16;
const KEY_STEP_SHIFT = 64;
// A held arrow-key repeat must not animate either, so the suppression flag
// covers the whole repeat window rather than just the instant of a keydown.
const KEY_SETTLE_MS = 200;

// Touching the localStorage PROPERTY can throw (opaque origin, blocked site
// data) — not just its methods. view-state.js guards it the same way; the
// framework runs in an iframe in production, where this is reachable.
function safeStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

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
export function attachRail({ rail, toggle, shell = rail?.parentElement, storage = safeStorage() } = {}) {
  if (!rail || !shell) {
    // No rail to resolve in this document: --pf-rail-w still defaults to 288px
    // from tokens.css, but nothing is reserving that space, so anything that
    // reads the token to centre itself against the rail (app.css's
    // #pf-pick-banner) would otherwise sit 144px off-centre for no reason.
    // Zero is the truth here — a legacy id-only page or a custom host running
    // ?pickserver with no #panel/elements.rail hits this path.
    const root = document.documentElement;
    root.style.setProperty("--pf-rail-w", "0px");
    return { detach: () => root.style.removeProperty("--pf-rail-w") };
  }

  const root = document.documentElement;
  const shellBox = () => shell.getBoundingClientRect();
  const shellWidth = () => shellBox().width;
  let state = readRailPref(storage, shellWidth());
  // Captured before the first apply() mutates the toggle, so detach() can
  // hand back a plain, unwired button rather than a dead "Show controls" one.
  const toggleOriginal = toggle ? { text: toggle.textContent, title: toggle.title } : null;

  const seam = document.createElement("div");
  seam.className = "pf-rail-seam";
  seam.setAttribute("role", "separator");
  seam.setAttribute("aria-orientation", "vertical");
  seam.setAttribute("aria-label", "Resize controls");
  seam.setAttribute("aria-valuemin", "0");
  seam.tabIndex = 0;
  seam.append(document.createElement("span")); // the hover/focus affordance
  rail.before(seam);

  // shellW lets a caller that already measured the shell this frame (the
  // pointermove handler) thread that width through instead of forcing a
  // second synchronous layout here — apply() writes --pf-rail-w onto :root
  // just below, so any un-measured read after that point is a style+layout
  // flush, not a cached value.
  function apply({ persist = false, shellW } = {}) {
    const sw = shellW ?? shellWidth();
    const width = state.collapsed ? 0 : clampRailWidth(state.width, sw);
    // Written on :root, not the rail/shell, so body-appended overlays (the
    // pick banner, the ?debug overlay) inherit it — see spec §4.4. This
    // assumes ONE rail per document: attachRail is written for a single
    // instance, and mounting two on one page would fight over --pf-rail-w
    // (both write :root; whichever's detach() runs last wins, clearing the
    // survivor's width too). README's "multiple mounts" claim is about
    // multiple mount() calls in general (e.g. cross-fade swaps), which is
    // fine as long as at most one has a resolvable rail at a time.
    root.style.setProperty("--pf-rail-w", `${width}px`);
    rail.toggleAttribute("inert", state.collapsed);
    seam.toggleAttribute("data-collapsed", state.collapsed);
    seam.setAttribute("aria-valuenow", String(width));
    seam.setAttribute("aria-valuemax", String(railMaxWidth(sw)));
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
  // The same "transient, debounced" flag suppresses the width transition for
  // both a held arrow-key repeat and a window resize (below) — either can
  // fire several times in a burst, and an animated width would fight the
  // last one before the previous animation finishes.
  let keyTimer = 0;
  function settleKeys() {
    clearTimeout(keyTimer);
    shell.removeAttribute("data-pf-key-resizing");
  }
  function markTransientResize() {
    shell.toggleAttribute("data-pf-key-resizing", true);
    clearTimeout(keyTimer);
    keyTimer = setTimeout(settleKeys, KEY_SETTLE_MS);
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
    // Cmd/Alt/Ctrl+Arrow are browser/OS reserved (back, tab switch, ...); don't
    // eat them just because the seam happens to hold focus.
    if (e.metaKey || e.altKey || e.ctrlKey) return;
    // Enter/Space is the deliberate reopen gesture (below); arrows must not
    // also reopen a collapsed rail — that would clamp it to the 240px minimum
    // and silently discard the remembered width, and "narrower" reopening the
    // rail at all is backwards.
    if (state.collapsed && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;
    const step = e.shiftKey ? KEY_STEP_SHIFT : KEY_STEP;
    // Re-clamp on READ rather than reconciling state.width on resize: a width
    // that no longer fits the current shell is still the user's preference and
    // should come back if the window grows again, so only the transient value
    // used for this keypress is clamped.
    const from = state.collapsed ? 0 : clampRailWidth(state.width, shellWidth());
    let width;
    switch (e.key) {
      case "ArrowLeft": width = from + step; break;
      case "ArrowRight": width = from - step; break;
      case "Home": case "End": {
        e.preventDefault();
        // Route through commit() — the path onDoubleClick uses — so these
        // jumps animate. Only a debounced arrow-key repeat (below) suppresses
        // the width transition.
        commit({
          collapsed: false,
          width: e.key === "Home" ? RAIL_MIN_WIDTH : railMaxWidth(shellWidth()),
        });
        return;
      }
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
    // Safety net: setPointerCapture is load-bearing (see above), but it is
    // still an optional call — if it's unavailable or the browser fails to
    // honour it, the pointerup can land on the canvas instead of the seam,
    // onPointerUp never runs, data-pf-dragging is stuck forever, and
    // chrome.css's [data-pf-dragging] .pf-stage { pointer-events: none } dead-
    // locks the viewer with no recovery. Also listening on window guarantees
    // the drag always terminates regardless of where the pointer ends up.
    // Bound only for the duration of a drag (removed in onPointerUp/detach)
    // so there is never a permanently-bound window listener.
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }
  function onPointerMove(e) {
    if (!shell.hasAttribute("data-pf-dragging")) return;
    // Measure the shell once per move and thread it through resolveRailDrag
    // and apply(), instead of re-measuring after apply() has already mutated
    // :root's style (which would force a synchronous style+layout flush).
    const box = shellBox();
    const railX = box.right - (e.clientX - grabOffset);
    const next = resolveRailDrag(railX, state, box.width);
    if (next === state) return; // unchanged — skip the redundant DOM writes
    state = next;
    apply({ shellW: box.width });
  }
  function onPointerUp(e) {
    // Guards against running end-of-drag logic twice for one gesture: whichever
    // of the seam's own pointerup and the window safety-net fires first clears
    // the attribute, so the second (if it fires at all) is a no-op.
    if (!shell.hasAttribute("data-pf-dragging")) return;
    seam.releasePointerCapture?.(e.pointerId);
    shell.removeAttribute("data-pf-dragging");
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    apply({ persist: true });
  }

  seam.addEventListener("pointerdown", onPointerDown);
  seam.addEventListener("pointermove", onPointerMove);
  seam.addEventListener("pointerup", onPointerUp);
  seam.addEventListener("pointercancel", onPointerUp);
  seam.addEventListener("keydown", onKeyDown);
  seam.addEventListener("dblclick", onDoubleClick);
  toggle?.addEventListener("click", onToggleClick);
  // A window resize can invalidate the clamp (max is half the shell). Narrowing
  // the window with a maxed-out rail can genuinely change --pf-rail-w, and
  // without suppression that change would animate — fighting the resize with
  // a trailing 150ms transition and an extra WebGL buffer reallocation.
  const onResize = () => {
    markTransientResize();
    apply();
  };
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
      // In case detach() happens mid-drag, so the safety net doesn't outlive it.
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      seam.remove();
      shell.removeAttribute("data-pf-dragging");
      rail.removeAttribute("inert");
      root.style.removeProperty("--pf-rail-w");
      if (toggle) {
        toggle.textContent = toggleOriginal.text;
        toggle.title = toggleOriginal.title;
        toggle.removeAttribute("aria-expanded");
        toggle.removeAttribute("aria-label");
        toggle.classList.remove("on");
      }
    },
  };
}
