// Thin SVG renderer for measurement mode: layout primitives -> a full-viewport
// <svg> above the canvas. All appearance comes from CSS classes (app.css) so
// the theme system applies; only geometry attributes are written here. The
// svg is pointer-transparent except label chips, which are the pin/reveal
// hit targets (role=button, keyboard-activatable).
import { ARROW, LABEL_PAD } from "./dim-layout.js";

const NS = "http://www.w3.org/2000/svg";
const LINE_CLASS = { ext: "pf-dim-ext", dim: "pf-dim-line", leader: "pf-dim-leader" };

function svgEl(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export function createDimOverlay(container, { onChipClick } = {}) {
  const svg = svgEl("svg", { class: "pf-dim-overlay" });
  container.appendChild(svg);

  // One delegated listener pair instead of per-chip listeners (chips are
  // rebuilt every render). onChipClick gets the STRUCTURED item id first
  // (data-item-id), then the primitive's own dim id (data-dim-id) — resolving
  // a click by parsing data-dim-id back into an item id would collide when a
  // Solid.label() string itself contains a colon.
  const chipOf = (ev) => ev.target.closest?.("g.pf-dim-chip");
  const onClick = (ev) => {
    const chip = chipOf(ev);
    if (chip) onChipClick?.(chip.dataset.itemId, chip.dataset.dimId);
  };
  const onKeydown = (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const chip = chipOf(ev);
    if (!chip) return;
    ev.preventDefault();
    onChipClick?.(chip.dataset.itemId, chip.dataset.dimId);
  };
  svg.addEventListener("click", onClick);
  svg.addEventListener("keydown", onKeydown);

  function render({ lines, arrows, labels }, viewport) {
    svg.setAttribute("viewBox", `0 0 ${viewport.width} ${viewport.height}`);
    const next = [];
    for (const l of lines) {
      next.push(svgEl("line", {
        x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2,
        class: `${LINE_CLASS[l.kind]} tier-${l.tier}`,
      }));
    }
    for (const a of arrows) {
      // filled triangle pointing along `angle`
      const s = Math.sin(a.angle), c = Math.cos(a.angle);
      const p = (dx, dy) => `${a.x + dx * c - dy * s},${a.y + dx * s + dy * c}`;
      next.push(svgEl("path", {
        d: `M ${p(0, 0)} L ${p(-ARROW, ARROW / 2.6)} L ${p(-ARROW, -ARROW / 2.6)} Z`,
        class: `pf-dim-arrow tier-${a.tier}`,
      }));
    }
    for (const l of labels) {
      const linked = !!l.paramName;
      const g = svgEl("g", {
        class: `pf-dim-chip tier-${l.tier} kind-${l.kind}`
          + (linked ? " linked" : "") + (l.pinned ? " pinned" : ""),
        "data-dim-id": l.id,
        "data-item-id": l.itemId,
        role: "button", tabindex: "0",
        "aria-label": linked ? `${l.text}, linked to ${l.paramName}` : l.text,
      });
      g.appendChild(svgEl("rect", {
        x: l.x, y: l.y, width: l.w, height: l.h, rx: 4, class: "pf-dim-chip-bg",
      }));
      const text = svgEl("text", {
        x: l.x + LABEL_PAD, y: l.y + l.h / 2, class: "pf-dim-text",
        "dominant-baseline": "central",
      });
      text.textContent = l.text;
      g.appendChild(text);
      if (linked) {
        const param = svgEl("text", {
          x: l.x + l.w - LABEL_PAD, y: l.y + l.h / 2, class: "pf-dim-param",
          "dominant-baseline": "central", "text-anchor": "end",
        });
        param.textContent = l.paramName;
        g.appendChild(param);
      }
      next.push(g);
    }
    svg.replaceChildren(...next);
  }

  return {
    render,
    clear: () => svg.replaceChildren(),
    setVisible: (on) => { if (on) svg.removeAttribute("hidden"); else svg.setAttribute("hidden", ""); },
    element: svg,
    dispose() {
      svg.removeEventListener("click", onClick);
      svg.removeEventListener("keydown", onKeydown);
      svg.remove();
    },
  };
}
