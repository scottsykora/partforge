import { loadRotating, saveRotating, saveCamera, loadTheme, saveTheme } from "./view-state.js";

// Wire the optional viewer-chrome buttons (pause / reframe / theme) to the viewer,
// plus persist the camera pose. Element refs in (mount resolves defaults); each
// button is optional — pass nothing and its behavior is simply absent. Returns
// { detach } removing every listener this attached.
export function attachViewerControls(viewer, { pause: pauseBtn, reframe: reframeBtn, theme: themeBtn } = {}) {
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
  const onThemeClick = () => applyTheme(theme === "light" ? "dark" : "light");
  themeBtn?.addEventListener("click", onThemeClick);

  // Pause/resume the idle auto-rotation.
  let rotating = loadRotating();
  viewer.setAutoRotate(rotating);
  const syncPause = () => {
    if (!pauseBtn) return;
    pauseBtn.textContent = rotating ? "⏸" : "▶";
    pauseBtn.title = rotating ? "Pause rotation" : "Resume rotation";
  };
  syncPause();
  const onPauseClick = () => {
    rotating = !rotating;
    viewer.setAutoRotate(rotating);
    syncPause();
    saveRotating(rotating);
  };
  pauseBtn?.addEventListener("click", onPauseClick);

  // Re-fit the camera to the current view.
  const onReframeClick = () => viewer.frame();
  reframeBtn?.addEventListener("click", onReframeClick);

  // Persist the camera when the user finishes an orbit/zoom, and right before a
  // reload (captures the latest pose, including auto-rotation drift).
  viewer.onCameraEnd(() => saveCamera(viewer.getCameraState()));
  const onPageHide = () => saveCamera(viewer.getCameraState());
  window.addEventListener("pagehide", onPageHide);

  return {
    detach: () => {
      themeBtn?.removeEventListener("click", onThemeClick);
      pauseBtn?.removeEventListener("click", onPauseClick);
      reframeBtn?.removeEventListener("click", onReframeClick);
      window.removeEventListener("pagehide", onPageHide);
      // the onCameraEnd listener lives on the OrbitControls object, which
      // viewer.dispose() destroys — nothing to remove here
    },
  };
}
