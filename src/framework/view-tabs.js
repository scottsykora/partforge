import { loadView, saveView } from "./view-state.js";

// The view-tab segmented control. When the part declares `views`, the buttons are
// generated from it (part.views is the single source of truth — host pages leave
// the #part div empty); a part without `views` keeps whatever buttons the page
// hand-wrote. The active view persists across reloads via view-state.
export function createViewTabs(el, part, { onChange }) {
  const generated = !!(el && part.views);
  if (generated) {
    el.innerHTML = Object.entries(part.views)
      .map(([key, v], i) => `<button data-part="${key}"${i === 0 ? ' class="on"' : ""}>${v?.label ?? key}</button>`)
      .join("");
  }

  const setActive = (btn) => { for (const b of el.children) b.classList.toggle("on", b === btn); };

  // Initial view: the saved one if it still matches a tab, else the active (first) tab.
  const defaultView = el.querySelector("button.on")?.dataset.part ?? el.querySelector("button")?.dataset.part;
  const saved = loadView();
  const savedBtn = saved ? [...el.querySelectorAll("button[data-part]")].find((b) => b.dataset.part === saved) : null;
  let view = savedBtn ? saved : defaultView;
  if (savedBtn) setActive(savedBtn);

  const onClick = (e) => {
    const btn = e.target.closest("button[data-part]");
    if (!btn) return;
    view = btn.dataset.part;
    saveView(view);
    setActive(btn);
    onChange(view);
  };
  el.addEventListener("click", onClick);

  return {
    current: () => view,
    detach: () => {
      el.removeEventListener("click", onClick);
      if (generated) el.innerHTML = ""; // we generated these buttons; hand-written markup stays
    },
  };
}
