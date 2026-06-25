// Browser side of request-a-pick: subscribe to the pick-server, show a prompt banner,
// arm the existing picker on demand, and POST each click back. Self-created DOM.
import { attachPicker } from "../selection/pick.js";

export function createPickRequestClient({ serverUrl = "http://127.0.0.1:4518", viewer, part, getContext }) {
  let active = null; // { id, index } of the prompt we're waiting on

  const banner = document.createElement("div");
  banner.id = "pf-pick-banner";
  Object.assign(banner.style, {
    position: "fixed", left: "12px", bottom: "12px", zIndex: 9999, maxWidth: "60ch",
    font: "13px system-ui, sans-serif", padding: "8px 12px", borderRadius: "6px",
    background: "rgba(20,24,29,0.94)", color: "#e7edf5", display: "none",
  });
  const text = document.createElement("span");
  const cancel = document.createElement("button");
  cancel.id = "pf-pick-cancel";
  cancel.textContent = "Can't find it / cancel";
  Object.assign(cancel.style, { marginLeft: "10px", font: "12px system-ui", cursor: "pointer" });
  banner.append(text, cancel);
  document.body.appendChild(banner);

  const picker = attachPicker(viewer, {
    part, getContext,
    onPick: (selection) => {
      if (!active) return;
      fetch(`${serverUrl}/resolve`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: active.id, index: active.index, selection }),
      });
    },
  });

  cancel.addEventListener("click", () => {
    if (active) fetch(`${serverUrl}/cancel`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: active.id }),
    });
  });

  const es = new globalThis.EventSource(`${serverUrl}/events`);
  es.addEventListener("prompt", (e) => {
    const v = JSON.parse(e.data);
    active = { id: v.id, index: v.index };
    text.textContent = `🤖 Claude needs you to click (${v.index + 1} of ${v.total}): ${v.prompt}`;
    banner.style.display = "block";
    picker.setActive(true);
  });
  es.addEventListener("cleared", () => {
    active = null;
    banner.style.display = "none";
    picker.setActive(false);
  });
  es.onerror = () => { text.textContent = "⚠ agent pick-server not reachable"; banner.style.display = "block"; };
  es.onopen = () => { if (!active) banner.style.display = "none"; };

  return {
    detach: () => { es.close(); picker.detach(); banner.remove(); },
  };
}
