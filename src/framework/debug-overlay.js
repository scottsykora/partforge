// src/framework/debug-overlay.js
// A dev-only overlay (shown under ?debug) with a caching on/off toggle and a
// readout of the last build's time + what the cache did. Self-contained: it
// creates its own DOM and knows nothing about geometry — mount.js wires it in.
export function createDebugOverlay({ initialCachingOn = true, onToggle } = {}) {
  const box = document.createElement("div");
  box.id = "pf-debug";
  Object.assign(box.style, {
    position: "fixed", bottom: "12px", right: "12px", zIndex: "9999",
    font: "12px ui-monospace, monospace", background: "rgba(0,0,0,0.7)",
    color: "#e6e6e6", padding: "8px 10px", borderRadius: "6px",
    lineHeight: "1.5", whiteSpace: "pre",
  });

  const label = document.createElement("label");
  label.style.cssText = "display:block;cursor:pointer;margin-bottom:4px";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = initialCachingOn;
  cb.style.marginRight = "6px";
  label.append(cb, document.createTextNode("Caching"));

  const readout = document.createElement("div");
  readout.textContent = "build: —";

  box.append(label, readout);
  document.body.appendChild(box);

  cb.addEventListener("change", () => onToggle?.(cb.checked));

  return {
    update({ ms, hits = 0, misses = 0, skipped = 0, rebuilt = 0 } = {}) {
      const l2 = cb.checked ? `${hits} hit / ${misses} miss` : "off";
      readout.textContent =
        `build: ${ms != null ? Math.round(ms) + " ms" : "—"}\n` +
        `L2 ops: ${l2}\n` +
        `L1 parts: ${skipped} skipped / ${rebuilt} rebuilt`;
    },
    detach: () => box.remove(),
  };
}
