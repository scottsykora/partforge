const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;

export function createTooltipPresenter({ id = "pf-hover-tip" } = {}) {
  const element = document.createElement("div");
  if (id != null && id !== "") element.id = id;
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

    let hovered = false;
    let focused = false;
    let touchActivation = false;
    let dismissed = false;
    let presentationToken;
    let hasPresented = false;
    const showIfNeeded = () => {
      if (hasPresented || dismissed || touchActivation || (!hovered && !focused)) return;
      const label = entry.getLabel?.()
        ?? element.getAttribute("aria-label")
        ?? originalTitle.value
        ?? "";
      presentationToken = tooltip.showAnchor({ title: label }, element);
      hasPresented = true;
    };
    const onPointerEnter = (event) => {
      if (event.pointerType === "touch") return;
      hovered = true;
      dismissed = false;
      showIfNeeded();
    };
    const hidePresentation = () => {
      if (!hasPresented) return;
      hasPresented = false;
      tooltip.hide(presentationToken);
      presentationToken = undefined;
    };
    const syncVisibility = () => {
      if (dismissed || (!hovered && !focused)) hidePresentation();
      else showIfNeeded();
    };
    const onPointerLeave = (event) => {
      if (event.pointerType === "touch") return;
      hovered = false;
      syncVisibility();
    };
    const onPointerDown = (event) => {
      if (event.pointerType !== "touch") return;
      touchActivation = true;
      dismissed = true;
      hidePresentation();
    };
    const onPointerCancel = (event) => {
      if (event.pointerType !== "touch") return;
      touchActivation = false;
      dismissed = true;
      hidePresentation();
    };
    const onFocus = () => {
      focused = true;
      if (touchActivation) return;
      dismissed = false;
      showIfNeeded();
    };
    const onBlur = () => {
      focused = false;
      touchActivation = false;
      syncVisibility();
    };
    const dismiss = () => {
      dismissed = true;
      touchActivation = false;
      hidePresentation();
    };
    element.addEventListener("pointerenter", onPointerEnter);
    element.addEventListener("pointerleave", onPointerLeave);
    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointercancel", onPointerCancel);
    element.addEventListener("focus", onFocus);
    element.addEventListener("blur", onBlur);
    element.addEventListener("click", dismiss);
    attached.push({
      element,
      originalTitle,
      originalAriaLabel,
      onPointerEnter,
      onPointerLeave,
      onPointerDown,
      onPointerCancel,
      onFocus,
      onBlur,
      dismiss,
    });
  }

  let detached = false;
  const hide = () => {
    for (const binding of attached) binding.dismiss();
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
          onPointerLeave,
          onPointerDown,
          onPointerCancel,
          onFocus,
          onBlur,
          dismiss,
        } = binding;
        element.removeEventListener("pointerenter", onPointerEnter);
        element.removeEventListener("pointerleave", onPointerLeave);
        element.removeEventListener("pointerdown", onPointerDown);
        element.removeEventListener("pointercancel", onPointerCancel);
        element.removeEventListener("focus", onFocus);
        element.removeEventListener("blur", onBlur);
        element.removeEventListener("click", dismiss);
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
