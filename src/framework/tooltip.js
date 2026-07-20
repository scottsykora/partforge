const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;

export function createTooltipPresenter() {
  const element = document.createElement("div");
  element.id = "pf-hover-tip";
  element.className = "pf-hover-tip";

  const title = document.createElement("b");
  const subtitle = document.createElement("span");
  subtitle.className = "pf-hover-sub";
  element.append(title, subtitle);
  document.body.appendChild(element);
  let disposed = false;
  let currentToken;

  function setContent(content) {
    title.textContent = content.title;
    subtitle.textContent = content.subtitle ?? "";
  }

  return {
    showPointer(content, x, y) {
      if (disposed) return;
      const token = Symbol("tooltip presentation");
      currentToken = token;
      setContent(content);
      element.style.left = `${x + 14}px`;
      element.style.top = `${y + 14}px`;
      element.classList.remove("pf-tooltip-anchored");
      element.classList.add("show");
      return token;
    },
    showAnchor(content, anchor) {
      if (disposed) return;
      const token = Symbol("tooltip presentation");
      currentToken = token;
      setContent(content);
      element.style.left = `${VIEWPORT_MARGIN}px`;
      element.style.top = `${VIEWPORT_MARGIN}px`;
      element.classList.add("pf-tooltip-anchored", "show");
      const tooltipRect = element.getBoundingClientRect();
      const rect = anchor.getBoundingClientRect();
      const width = Math.max(0, tooltipRect.width || 0);
      const height = Math.max(0, tooltipRect.height || 0);
      const viewportWidth = Math.max(0, globalThis.innerWidth || 0);
      const viewportHeight = Math.max(0, globalThis.innerHeight || 0);
      const centeredLeft = (rect.left + rect.right - width) / 2;
      const maxLeft = Math.max(
        VIEWPORT_MARGIN,
        viewportWidth - VIEWPORT_MARGIN - width,
      );
      const left = Math.min(Math.max(centeredLeft, VIEWPORT_MARGIN), maxLeft);
      const belowTop = rect.bottom + ANCHOR_GAP;
      const fitsBelow = belowTop + height <= viewportHeight - VIEWPORT_MARGIN;
      const top = fitsBelow ? belowTop : rect.top - ANCHOR_GAP - height;
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
      return token;
    },
    hide(token) {
      if (disposed) return;
      if (token !== undefined && token !== currentToken) return;
      currentToken = undefined;
      element.classList.remove("show");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      currentToken = undefined;
      element.remove();
    },
  };
}

export function attachButtonTooltips(tooltip, entries) {
  const attached = [];

  for (const entry of entries ?? []) {
    const element = entry?.element;
    if (!element) continue;

    const originalTitle = {
      present: element.hasAttribute("title"),
      value: element.getAttribute("title"),
    };
    const originalAriaLabel = {
      present: element.hasAttribute("aria-label"),
      value: element.getAttribute("aria-label"),
    };
    if (!originalAriaLabel.present && originalTitle.present) {
      element.setAttribute("aria-label", originalTitle.value);
    }
    element.removeAttribute("title");

    let presentationToken;
    let hasPresented = false;
    const show = () => {
      const label = entry.getLabel?.()
        ?? element.getAttribute("aria-label")
        ?? originalTitle.value
        ?? "";
      presentationToken = tooltip.showAnchor({ title: label }, element);
      hasPresented = true;
    };
    const onPointerEnter = (event) => {
      if (event.pointerType === "touch") return;
      show();
    };
    const hide = () => {
      if (!hasPresented) return;
      hasPresented = false;
      tooltip.hide(presentationToken);
      presentationToken = undefined;
    };
    element.addEventListener("pointerenter", onPointerEnter);
    element.addEventListener("pointerleave", hide);
    element.addEventListener("focus", show);
    element.addEventListener("blur", hide);
    element.addEventListener("click", hide);
    attached.push({
      element,
      originalTitle,
      originalAriaLabel,
      onPointerEnter,
      show,
      hide,
    });
  }

  let detached = false;
  const hide = () => {
    for (const binding of attached) binding.hide();
  };
  return {
    hide,
    detach() {
      if (detached) return;
      detached = true;
      hide();
      for (const binding of attached) {
        const {
          element,
          originalTitle,
          originalAriaLabel,
          onPointerEnter,
          show,
          hide,
        } = binding;
        element.removeEventListener("pointerenter", onPointerEnter);
        element.removeEventListener("pointerleave", hide);
        element.removeEventListener("focus", show);
        element.removeEventListener("blur", hide);
        element.removeEventListener("click", hide);
        if (originalTitle.present) element.setAttribute("title", originalTitle.value);
        else element.removeAttribute("title");
        if (originalAriaLabel.present) {
          element.setAttribute("aria-label", originalAriaLabel.value);
        } else {
          element.removeAttribute("aria-label");
        }
      }
    },
  };
}
