// Browser side of request-a-pick: drives the shared prompt banner from two sources —
// an agent asking for clicks over SSE, and a click-to-copy button in the viewbar.
// Created only under ?pickserver (see mount.js), so both are present exactly when the
// user is working with an agent.
import { createPromptBanner } from "./prompt-banner.js";
import { formatSelection } from "../selection/format.js";

export function createPickRequestClient({ serverUrl = "http://127.0.0.1:4518", viewer, part, getContext }) {
  let active = null; // { id, index } of the agent prompt we're waiting on
  const banner = createPromptBanner({ viewer, part, getContext });

  const postJson = (path, body) =>
    fetch(`${serverUrl}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }).catch(() => banner.message("⚠ couldn't reach pick-server — click not sent"));

  // --- agent prompts over SSE -------------------------------------------------
  const es = new globalThis.EventSource(`${serverUrl}/events`);
  es.addEventListener("prompt", (e) => {
    const v = JSON.parse(e.data);
    active = { id: v.id, index: v.index };
    banner.request({
      avatar: "🤖",
      label: v.total > 1 ? `Your agent asks: (${v.index + 1} of ${v.total})` : "Your agent asks:",
      text: v.prompt,
      onResolve: (selection) => postJson("/resolve", { id: active.id, index: active.index, selection }),
      onDismiss: () => { if (active) postJson("/cancel", { id: active.id }); },
    });
  });
  es.addEventListener("cleared", () => { active = null; banner.dismiss(); });
  es.onerror = () => { banner.message("⚠ agent pick-server not reachable"); };
  es.onopen = () => { if (!active) banner.dismiss(); };

  // --- click-to-copy button, prepended into the viewbar (left of the play btn) -
  // Copies the SAME description an agent receives for a click, so the two paths match.
  const viewbar = document.getElementById("viewbar");
  let copyBtn = null;
  if (viewbar) {
    copyBtn = document.createElement("button");
    copyBtn.id = "copy";
    copyBtn.type = "button";
    // Flat single-colour copy glyph (inherits the viewbar button's currentColor).
    copyBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4V9A1.5 1.5 0 0 0 4 10.5H5.5"/></svg>';
    copyBtn.title = "Click a detail to copy its agent description";
    copyBtn.setAttribute("aria-label", "Copy a detail's agent description");
    copyBtn.addEventListener("click", () => {
      if (banner.isOpen()) { banner.dismiss(); return; } // toggle off
      banner.request({
        avatar: "📋",
        label: "Copy to clipboard",
        text: "Click on a detail to copy its agent description to the clipboard.",
        onResolve: (selection) => {
          navigator.clipboard?.writeText(formatSelection(selection, { style: "prompt" }));
          banner.message("✓ Copied to clipboard");
          setTimeout(() => banner.dismiss(), 1000);
        },
      });
    });
    viewbar.prepend(copyBtn);
  }

  return {
    detach: () => { es.close(); banner.detach(); copyBtn?.remove(); },
  };
}
