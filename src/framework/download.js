import { zipSync } from "fflate";

// Browser file-download helpers. Pure DOM/Blob utilities with no app state — the
// worker produces the bytes; these just hand them to the browser as a download.

// Trigger a download of one binary blob under `filename`.
export function triggerDownload(data, filename, mime) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Download a set of built parts: a single part downloads directly; multiple parts
// are bundled into one flat, store-only (level 0) zip named `zipName`.
export function downloadParts({ parts, ext, mime }, zipName) {
  if (parts.length === 1) return triggerDownload(parts[0].data, `${parts[0].name}.${ext}`, mime);
  const entries = {};
  for (const p of parts) entries[`${p.name}.${ext}`] = new Uint8Array(p.data);
  triggerDownload(zipSync(entries, { level: 0 }), zipName, "application/zip");
}
