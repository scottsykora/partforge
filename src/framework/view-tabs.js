import { resolveDefaultView } from "./default-view.js";
import { loadView, saveView } from "./view-state.js";

// The view-tab segmented control. When the part declares `views`, the buttons are
// generated from it (part.views is the single source of truth — host pages leave
// the #part div empty); a part without `views` keeps whatever buttons the page
// hand-wrote. Which tab opens is resolveDefaultView's call, not key order. The
// active tab then persists per part for the rest of the browser session, so a
// Vite dev reload doesn't throw you back mid-edit.
export function createViewTabs(el, part, { onChange }) {
  const generated = !!(el && part.views);
  const partKey = part?.meta?.title ?? "";
  const resolved = resolveDefaultView(part);
  if (generated) {
    // Built node-by-node with textContent/dataset rather than an innerHTML
    // template — view keys and labels come from the part, which is untrusted
    // data (hosts run LLM-generated and user-supplied parts), so a label of
    // `<img src=x onerror=...>` must land as text, not as markup.
    el.replaceChildren(...Object.entries(part.views).map(([key, v]) => {
      const btn = document.createElement("button");
      btn.dataset.part = key;
      btn.textContent = v?.label ?? key;
      if (key === resolved) btn.classList.add("on");
      return btn;
    }));
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
    // Programmatic switch — the click path without the click. Used by an
    // embedder (mount's handle.setView) to change tabs from outside the DOM.
    // Returns false for a name that isn't a tab so callers can validate.
    select: (name) => {
      if (name === view) return true; // already active — nothing to do
      const btn = [...el.querySelectorAll("button[data-part]")].find((b) => b.dataset.part === name);
      if (!btn) return false;
      view = name;
      saveView(partKey, view);
      setActive(btn);
      onChange(view);
      return true;
    },
    detach: () => {
      el.removeEventListener("click", onClick);
      if (generated) el.innerHTML = ""; // we generated these buttons; hand-written markup stays
    },
  };
}
