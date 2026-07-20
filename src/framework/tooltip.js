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

  function setContent(content) {
    title.textContent = content.title;
    subtitle.textContent = content.subtitle ?? "";
  }

  return {
    showPointer(content, x, y) {
      if (disposed) return;
      setContent(content);
      element.style.left = `${x + 14}px`;
      element.style.top = `${y + 14}px`;
      element.classList.remove("pf-tooltip-anchored");
      element.classList.add("show");
    },
    showAnchor(content, anchor) {
      if (disposed) return;
      setContent(content);
      const rect = anchor.getBoundingClientRect();
      element.style.left = `${(rect.left + rect.right) / 2}px`;
      element.style.top = `${rect.bottom + 8}px`;
      element.classList.add("pf-tooltip-anchored", "show");
    },
    hide() {
      if (disposed) return;
      element.classList.remove("show");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
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

    const show = () => {
      const label = entry.getLabel?.()
        ?? element.getAttribute("aria-label")
        ?? originalTitle.value
        ?? "";
      tooltip.showAnchor({ title: label }, element);
    };
    const onPointerEnter = (event) => {
      if (event.pointerType === "touch") return;
      show();
    };
    const hide = () => tooltip.hide();
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
  return {
    detach() {
      if (detached) return;
      detached = true;
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
