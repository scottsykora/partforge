// The ⓘ glyph and its per-panel popover. Shared by the control panel and the
// animation transport bar (animation-controls.js), which is why it is its own
// module rather than living inside the panel renderer.
import { renderMarkdown } from "../markdown.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Popover top edge: below the glyph when it fits, flipped above when the
// viewport bottom would clip it (e.g. the animation transport bar's ⓘ, which
// sits at the bottom of the stage). Pure, for direct unit testing — happy-dom
// reports zero layout metrics, so the flip can't be exercised via the DOM.
export function popoverTop({ glyphTop, glyphBottom, popHeight, viewportHeight }) {
  const below = glyphBottom + 6;
  if (below + popHeight <= viewportHeight - 8) return below;
  return Math.max(8, glyphTop - 6 - popHeight);
}

// One popover element per panel, shared by all its glyphs (only one open at a
// time). Document-level dismiss listeners are registered per panel and removed
// by panel.dispose().
export function createInfoPopover() {
  const pop = el("div", "popover");
  pop.hidden = true;
  document.body.append(pop);
  let owner = null; // the glyph whose description is showing

  function close() {
    if (pop.hidden) return;
    pop.hidden = true;
    if (owner) { owner.setAttribute("aria-expanded", "false"); owner = null; }
  }
  const onDocClick = (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest?.(".info")) close();
  };
  const onDocKeydown = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onDocKeydown);

  return {
    toggle(glyph, description) {
      if (owner === glyph) { close(); return; } // toggle off
      close();
      pop.innerHTML = renderMarkdown(description);
      pop.hidden = false;
      owner = glyph;
      glyph.setAttribute("aria-expanded", "true");
      const r = glyph.getBoundingClientRect();
      pop.style.top = `${popoverTop({ glyphTop: r.top, glyphBottom: r.bottom, popHeight: pop.offsetHeight, viewportHeight: window.innerHeight })}px`;
      pop.style.left = `${Math.max(8, r.left - 8)}px`;
    },
    dispose() {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onDocKeydown);
      pop.remove();
    },
  };
}

// Append a focusable ⓘ glyph to `container` that toggles the panel's shared
// popover with `description` (Markdown). No-op when description is empty.
export function attachInfo(container, description, info) {
  if (typeof description !== "string" || !description.trim()) return;
  const glyph = document.createElement("button");
  glyph.type = "button";
  glyph.className = "info";
  glyph.textContent = "ⓘ";
  glyph.setAttribute("aria-label", "More info");
  glyph.setAttribute("aria-expanded", "false");
  glyph.addEventListener("click", (e) => { e.stopPropagation(); info.toggle(glyph, description); });
  container.append(glyph);
}
