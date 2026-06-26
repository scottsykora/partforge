// A small chat-style prompt banner that arms the selection picker for one click.
// Shared by request-a-pick's two drivers (an agent asking via SSE, and the
// click-to-copy button) so they look and behave identically. The look (position,
// theme colours, slide-in animation) lives in app.css (#pf-pick-banner).
import { attachPicker } from "../selection/pick.js";

export function createPromptBanner({ viewer, part, getContext }) {
  let onResolve = null; // called with the Selection on the next pick
  let onDismiss = null; // called when the user closes the banner via ×

  const banner = document.createElement("div");
  banner.id = "pf-pick-banner";
  banner.style.display = "none";

  const row = document.createElement("div");
  row.className = "pf-pick-row";
  const avatar = document.createElement("div");
  avatar.className = "pf-pick-avatar";
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

  const isOpen = () => banner.style.display !== "none";

  function dismiss() {
    onResolve = null;
    onDismiss = null;
    picker.setActive(false);
    banner.style.display = "none";
  }

  const picker = attachPicker(viewer, {
    part, getContext,
    onPick: (selection) => {
      const resolve = onResolve;
      onResolve = null;            // a pick resolves once; a stray click after is a no-op
      picker.setActive(false);     // consumer re-arms via request() if more clicks are wanted
      resolve?.(selection);
    },
  });

  close.addEventListener("click", () => {
    const dismissed = onDismiss;
    dismiss();
    dismissed?.();
  });

  // Show a prompt and arm the picker for one click. Prompt/label text is rendered via
  // textContent (never innerHTML) — it can carry agent-supplied strings.
  function request({ avatar: glyph, label: text, text: body, onResolve: resolve = null, onDismiss: dismissed = null }) {
    onResolve = resolve;
    onDismiss = dismissed;
    avatar.textContent = glyph;
    label.textContent = text || "";
    prompt.textContent = body;
    banner.style.display = "block";
    picker.setActive(true);
  }

  // Show a transient note (error or confirmation) with no pending pick. Keeps the
  // current avatar so a "✓ Copied" / "⚠ …" note stays in context.
  function message(body) {
    onResolve = null;
    picker.setActive(false);
    label.textContent = "";
    prompt.textContent = body;
    banner.style.display = "block";
  }

  return {
    request, message, dismiss, isOpen,
    detach: () => { picker.detach(); banner.remove(); },
  };
}
