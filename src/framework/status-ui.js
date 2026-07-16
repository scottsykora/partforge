// The status line, busy overlay, and export-button enabling — mount's host-page
// chrome, as one small adapter. Element refs in (mount resolves defaults); no
// document queries here. status/busy/phase are required; export buttons are an
// array and any falsy entries are simply skipped.
export function createStatusUi({ status, busy, phase, exports = [] }) {
  const exportBtns = exports.filter(Boolean);

  return {
    setStatus(msg, isErr = false) { status.textContent = msg; status.classList.toggle("err", isErr); },
    showBusy(p) { phase.textContent = `${p}…`; busy.classList.add("show"); },
    hideBusy() { busy.classList.remove("show"); },
    setExportEnabled(on) { exportBtns.forEach((b) => { b.disabled = !on; }); },
    statusText: () => status.textContent,
  };
}
