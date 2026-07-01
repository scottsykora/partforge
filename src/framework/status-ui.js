// The status line, busy overlay, and export-button enabling — mount's host-page
// chrome, as one small adapter. #status/#busy/#phase are required page elements;
// export buttons are looked up by id and any that are absent are simply skipped.
export function createStatusUi(doc = document) {
  const statusEl = doc.getElementById("status");
  const busyEl = doc.getElementById("busy");
  const phaseEl = doc.getElementById("phase");
  const exportBtns = ["download", "download-step", "download-3mf"]
    .map((id) => doc.getElementById(id)).filter(Boolean);

  return {
    setStatus(msg, isErr = false) { statusEl.textContent = msg; statusEl.classList.toggle("err", isErr); },
    showBusy(phase) { phaseEl.textContent = `${phase}…`; busyEl.classList.add("show"); },
    hideBusy() { busyEl.classList.remove("show"); },
    setExportEnabled(on) { exportBtns.forEach((b) => { b.disabled = !on; }); },
    statusText: () => statusEl.textContent,
  };
}
