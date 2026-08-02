import { resolveDefaultView } from "./default-view.js";
import { loadView, saveView } from "./view-state.js";

// The view-tab segmented control. When the part declares `views`, the buttons are
// generated from it (part.views is the single source of truth — host pages leave
// the #part div empty); a part without `views` keeps whatever buttons the page
// hand-wrote. The active tab persists per part for the rest of the browser session, so a Vite
// dev reload doesn't throw you back mid-edit.
// Which tab opens is resolveDefaultView's call, not key order.
export function createViewTabs(el, part, { onChange }) {
  const generated = !!(el && part.views);
  const partKey = part?.meta?.title ?? "";
  const resolved = resolveDefaultView(part);
  if (generated) {
    el.innerHTML = Object.entries(part.views)
      .map(([key, v]) => `<button data-part="${key}"${key === resolved ? ' class="on"' : ""}>${v?.label ?? key}</button>`)
      .join("");
  }

  const setActive = (btn) => { for (const b of el.children) b.classList.toggle("on", b === btn); };

  // Initial view: the session-saved one if it still matches a tab, else the active
  // button — the resolved default for a generated bar, or whatever the page's own
  // markup marked `on` for a hand-written one.
  const defaultView = el.querySelector("button.on")?.dataset.part ?? el.querySelector("button")?.dataset.part;
  const saved = loadView(partKey);
  const savedBtn = saved ? [...el.querySelectorAll("button[data-part]")].find((b) => b.dataset.part === saved) : null;
  let view = savedBtn ? saved : defaultView;
  if (savedBtn) setActive(savedBtn);

  const onClick = (e) => {
    const btn = e.target.closest("button[data-part]");
    if (!btn) return;
    view = btn.dataset.part;
    saveView(partKey, view);
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
