// Browser side of request-a-pick: subscribe to the pick-server, show a prompt banner,
// arm the existing picker on demand, and POST each click back. Self-created DOM; the
// look (position, theme colours, slide-in animation) lives in app.css (#pf-pick-banner),
// so it follows the app's light/dark theme. Visibility is toggled via display.
import { attachPicker } from "../selection/pick.js";

export function createPickRequestClient({ serverUrl = "http://127.0.0.1:4518", viewer, part, getContext }) {
  let active = null; // { id, index } of the prompt we're waiting on

  // --- prompt banner: chat-style (avatar + message) ---------------------------
  const banner = document.createElement("div");
  banner.id = "pf-pick-banner";
  banner.style.display = "none";

  const row = document.createElement("div");
  row.className = "pf-pick-row";
  const avatar = document.createElement("div");
  avatar.className = "pf-pick-avatar";
  avatar.textContent = "🤖";
  const msg = document.createElement("div");
  msg.className = "pf-pick-msg";
  const label = document.createElement("div");
  label.className = "pf-pick-label";
  const prompt = document.createElement("div");
  prompt.className = "pf-pick-prompt";
  msg.append(label, prompt);
  row.append(avatar, msg);

  const close = document.createElement("button");
  close.id = "pf-pick-close";
  close.type = "button";
  close.textContent = "×";
  close.setAttribute("aria-label", "Dismiss");

  banner.append(row, close);
  document.body.appendChild(banner);

  const show = () => { banner.style.display = "block"; };
  const hide = () => { banner.style.display = "none"; };
  const showError = (text) => { label.textContent = ""; prompt.textContent = text; show(); };

  // Render a prompt as a chat message. The prompt text comes from the agent, so it goes
  // through textContent (never innerHTML) to stay injection-safe.
  const showPrompt = (v) => {
    label.textContent = v.total > 1 ? `Your agent asks: (${v.index + 1} of ${v.total})` : "Your agent asks:";
    prompt.textContent = v.prompt;
    show();
  };

  const postJson = (path, body) =>
    fetch(`${serverUrl}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }).catch(() => showError("⚠ couldn't reach pick-server — click not sent"));

  const picker = attachPicker(viewer, {
    part, getContext,
    onPick: (selection) => {
      if (!active) return;
      postJson("/resolve", { id: active.id, index: active.index, selection });
    },
  });

  // The × dismisses the request (cancels the active batch on the server) and hides the
  // banner immediately for responsiveness.
  close.addEventListener("click", () => {
    if (active) postJson("/cancel", { id: active.id });
    hide();
  });

  // --- dev test button: preview the banner locally, no agent round-trip -------
  const test = document.createElement("button");
  test.id = "pf-pick-test";
  test.type = "button";
  test.textContent = "🤖 test prompt";
  test.title = "Preview the agent prompt banner (local, no agent)";
  test.addEventListener("click", () => {
    if (banner.style.display !== "none") { hide(); return; } // toggle off (and re-arm the animation)
    showPrompt({ index: 0, total: 1, prompt: "Click a face — this is a test prompt" });
  });
  document.body.appendChild(test);

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
    detach: () => { es.close(); picker.detach(); banner.remove(); test.remove(); },
  };
}
