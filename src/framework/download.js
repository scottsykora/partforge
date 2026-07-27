import { zipSync } from "fflate";

// Browser file-download helpers. Pure DOM/Blob utilities with no app state — the
// worker produces the bytes; these just hand them to the browser as a download.
//
// `sink` is an optional escape hatch for embedders that cannot download from
// their own document — e.g. partforge running inside a null-origin sandboxed
// iframe, where a blob: URL is blob:null and browsers such as WebKit refuse to
// load it. When `sink` is supplied it receives the FINAL bytes and no DOM work
// happens here; the embedder saves them from a context that can.

// Trigger a download of one binary blob under `filename` (or hand it to `sink`).
export function triggerDownload(data, filename, mime, sink) {
  if (typeof sink === "function") { sink({ data, filename, mime }); return; }
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Download a set of built parts: a single part downloads directly; multiple parts
// are bundled into one flat, store-only (level 0) zip named `zipName`. `sink`, if
// given, is forwarded to triggerDownload so it receives the final bytes.
export function downloadParts({ parts, ext, mime }, zipName, sink) {
  if (parts.length === 1) return triggerDownload(parts[0].data, `${parts[0].name}.${ext}`, mime, sink);
  const entries = {};
  for (const p of parts) entries[`${p.name}.${ext}`] = new Uint8Array(p.data);
  triggerDownload(zipSync(entries, { level: 0 }), zipName, "application/zip", sink);
}
