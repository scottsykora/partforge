// src/framework/export-controller.js
// Owns the jobId correlation for headless exportParts(): matches worker
// replies (progress/download/error) back to the Promise that started them.
// Pure — no DOM, no worker; `send` and the sink are injected.
import { triggerDownload, downloadParts } from "./download.js";
import { safeName } from "./safe-name.js";

// The one place the "which backend does this export format need" policy lives.
// STEP is always OCCT — only OCCT (OpenCASCADE) emits exact B-rep; Manifold's mesh
// CSG has no STEP writer. Every other format is free to use whichever backend the
// caller is already using for preview. Both the UI export buttons (mount.js) and
// the headless exportParts() API route through this so the rule is never encoded
// twice.
export function backendForFormat(format, defaultBackend) {
  return format === "step" ? "occt" : defaultBackend();
}

export function createExportController({ send, currentView, title, defaultBackend = () => "manifold", currentParams = () => ({}) }) {
  const pending = new Map(); // jobId -> { resolve, reject, onProgress }
  let nextId = 1;

  function exportParts({ parts, format, quality = "print", onProgress } = {}) {
    const jobId = nextId++;
    const type = `export-${format}`;
    const backend = backendForFormat(format, defaultBackend);
    return new Promise((resolve, reject) => {
      pending.set(jobId, { resolve, reject, onProgress });
      send({ type, jobId, parts, view: currentView(), params: currentParams(), name: title(), quality }, backend);
    });
  }

  // Returns true iff this message belonged to a pending export (so the caller
  // can skip legacy handling). `sink` is partforge's onDownload.
  function handleMessage(m, sink) {
    const entry = m && m.jobId != null ? pending.get(m.jobId) : undefined;
    if (!entry) return false;
    if (m.type === "progress") { entry.onProgress?.(m.phase); return true; }
    if (m.type === "download") {
      pending.delete(m.jobId);
      triggerDownload(m.data, m.filename, m.mime, sink);
      entry.resolve();
      return true;
    }
    if (m.type === "download-parts") {
      pending.delete(m.jobId);
      const zipName = `${safeName(title(), "parts")}.zip`; // title() is the part's meta.title — untrusted
      downloadParts(m, zipName, sink);
      entry.resolve();
      return true;
    }
    if (m.type === "error") { pending.delete(m.jobId); entry.reject(new Error(m.message)); return true; }
    if (m.type === "needs-occt") { pending.delete(m.jobId); entry.reject(new Error("needs OCCT backend")); return true; }
    return false;
  }

  // Reject every in-flight export and clear the map — for teardown / worker
  // death, where worker replies will never arrive to settle these Promises.
  function dispose(reason) {
    const err = new Error(reason ?? "export cancelled");
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  }

  return { exportParts, handleMessage, dispose };
}
