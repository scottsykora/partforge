import { attachPicker } from "./pick.js";
import { formatSelection } from "./format.js";

// The ?pick clipboard mode: a fixed toggle button + a transient toast. Clicking the
// button arms the picker; clicking geometry copies a selection token and flashes it.
// Styles live in app.css (#pf-pick / #pf-pick-toast). Self-contained — dropping the
// call in mount and this file reverts the feature exactly.
export function attachPickToggle(viewer, { part, getContext }) {
  const btn = document.createElement("button");
  btn.id = "pf-pick";
  btn.textContent = "Pick";
  btn.title = "Click a surface to copy a selection token";
  document.body.appendChild(btn);

  const toast = document.createElement("div");
  toast.id = "pf-pick-toast";
  document.body.appendChild(toast);

  let hideTimer;
  const picker = attachPicker(viewer, {
    part,
    getContext,
    onPick: (selection) => {
      const token = formatSelection(selection, { style: "token" });
      navigator.clipboard?.writeText(token);
      toast.textContent = `copied: ${token}`;
      toast.classList.add("show");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => toast.classList.remove("show"), 4000);
    },
  });

  btn.addEventListener("click", () => picker.setActive(btn.classList.toggle("on")));
}
