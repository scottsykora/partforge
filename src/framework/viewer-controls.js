import { loadRotating, saveRotating, saveCamera, loadTheme, saveTheme } from "./view-state.js";

// Wire the optional viewer-chrome buttons on the host page (#pause / #reframe /
// #theme) to the viewer, plus persist the camera pose. Each button is optional —
// omit it from the page and its behavior is simply absent. Self-contained: touches
// only the viewer and the DOM, none of the part/params/regenerate state.
export function attachViewerControls(viewer) {
  const pauseBtn = document.getElementById("pause");
  const reframeBtn = document.getElementById("reframe");
  const themeBtn = document.getElementById("theme");

  // Theme: toggle the page chrome (CSS vars keyed off <html data-theme>) and the
  // scene together; remember the choice across reloads.
  let theme = loadTheme();
  function applyTheme(mode) {
    theme = mode;
    document.documentElement.dataset.theme = mode;
    viewer.setTheme(mode);
    themeBtn?.classList.toggle("on", mode === "light");
    saveTheme(mode);
  }
  applyTheme(theme);
  themeBtn?.addEventListener("click", () => applyTheme(theme === "light" ? "dark" : "light"));

  // Pause/resume the idle auto-rotation.
  let rotating = loadRotating();
  viewer.setAutoRotate(rotating);
  const syncPause = () => {
    if (!pauseBtn) return;
    pauseBtn.textContent = rotating ? "⏸" : "▶";
    pauseBtn.title = rotating ? "Pause rotation" : "Resume rotation";
  };
  syncPause();
  pauseBtn?.addEventListener("click", () => {
    rotating = !rotating;
    viewer.setAutoRotate(rotating);
    syncPause();
    saveRotating(rotating);
  });

  // Re-fit the camera to the current view.
  reframeBtn?.addEventListener("click", () => viewer.frame());

  // Persist the camera when the user finishes an orbit/zoom, and right before a
  // reload (captures the latest pose, including auto-rotation drift).
  viewer.onCameraEnd(() => saveCamera(viewer.getCameraState()));
  window.addEventListener("pagehide", () => saveCamera(viewer.getCameraState()));
}
