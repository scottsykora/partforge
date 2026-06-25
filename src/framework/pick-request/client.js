// Browser side of request-a-pick: subscribe to the pick-server, show a prompt banner,
// arm the existing picker on demand, and POST each click back. Self-created DOM; the
// look (position, theme colours, slide-in animation) lives in app.css (#pf-pick-banner),
// so it follows the app's light/dark theme. Visibility is toggled via display.
import { attachPicker } from "../selection/pick.js";

export function createPickRequestClient({ serverUrl = "http://127.0.0.1:4518", viewer, part, getContext }) {
  let active = null; // { id, index } of the prompt we're waiting on

  const banner = document.createElement("div");
  banner.id = "pf-pick-banner";
  banner.style.display = "none";

  const text = document.createElement("span");
  text.className = "pf-pick-text";

  const close = document.createElement("button");
  close.id = "pf-pick-close";
  close.type = "button";
  close.textContent = "×";
  close.setAttribute("aria-label", "Dismiss");

  banner.append(text, close);
  document.body.appendChild(banner);

  const show = () => { banner.style.display = "block"; };
  const hide = () => { banner.style.display = "none"; };
  const showError = (msg) => { text.textContent = msg; show(); };

  // Render the current prompt, emphasising the instruction. The prompt text comes from
  // the agent, so it goes through textContent (never innerHTML) to stay injection-safe.
  const showPrompt = (v) => {
    text.textContent = `🤖 Claude needs you to click (${v.index + 1} of ${v.total}): `;
    const strong = document.createElement("strong");
    strong.className = "pf-pick-prompt";
    strong.textContent = v.prompt;
    text.append(strong);
    show();
  };

  const post = (path, body) =>
    fetch(`${serverUrl}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }).catch(() => showError("⚠ couldn't reach pick-server — click not sent"));

  const picker = attachPicker(viewer, {
    part, getContext,
    onPick: (selection) => {
      if (!active) return;
      post("/resolve", { id: active.id, index: active.index, selection });
    },
  });

  // The × dismisses the request (cancels the active batch on the server).
  close.addEventListener("click", () => { if (active) post("/cancel", { id: active.id }); });

  const es = new globalThis.EventSource(`${serverUrl}/events`);
  es.addEventListener("prompt", (e) => {
    const v = JSON.parse(e.data);
    active = { id: v.id, index: v.index };
    showPrompt(v);
    picker.setActive(true);
  });
  es.addEventListener("cleared", () => {
    active = null;
    hide();
    picker.setActive(false);
  });
  es.onerror = () => { showError("⚠ agent pick-server not reachable"); };
  es.onopen = () => { if (!active) hide(); };

  return {
    detach: () => { es.close(); picker.detach(); banner.remove(); },
  };
}
