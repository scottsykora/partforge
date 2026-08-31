import { saveCamera, loadTheme, saveTheme } from "./view-state.js";
import { attachButtonTooltips } from "./tooltip.js";

// Wire the optional viewer-chrome buttons (reframe / theme) to the viewer,
// plus persist the camera pose. Element refs in (mount resolves defaults); each
// button is optional — pass nothing and its behavior is simply absent. Returns
// { detach } removing every listener this attached.
export function attachViewerControls(
  viewer,
  { reframe: reframeBtn, theme: themeBtn } = {},
  { tooltip } = {},
) {
  const tooltipBinding = tooltip
    ? attachButtonTooltips(tooltip, [reframeBtn, themeBtn].map((element) => ({ element })))
    : null;

  // Theme: toggle the page chrome (CSS vars keyed off <html data-theme>) and the
  // scene together; remember the choice across reloads.
  let theme = loadTheme();
  function applyTheme(mode) {
    theme = mode;
    document.documentElement.dataset.theme = mode;
    viewer.setTheme(mode);
    themeBtn?.classList.toggle("on", mode === "light");
    if (themeBtn) {
      const label = mode === "dark" ? "Switch to light mode" : "Switch to dark mode";
      themeBtn.setAttribute("aria-label", label);
      if (!tooltip) themeBtn.title = label;
    }
    saveTheme(mode);
    tooltipBinding?.sync();
  }
  applyTheme(theme);
  const onThemeClick = () => applyTheme(theme === "light" ? "dark" : "light");
  themeBtn?.addEventListener("click", onThemeClick);

  // Re-fit the camera to the current view.
  if (reframeBtn) {
    reframeBtn.setAttribute("aria-label", "Re-frame model");
    if (!tooltip) reframeBtn.title = "Re-frame model";
  }
  const onReframeClick = () => viewer.frame();
  reframeBtn?.addEventListener("click", onReframeClick);

  // Persist the camera when the user finishes an orbit/zoom, and right before a
  // reload (captures the latest pose).
  viewer.onCameraEnd(() => saveCamera(viewer.getCameraState()));
  const onPageHide = () => saveCamera(viewer.getCameraState());
  window.addEventListener("pagehide", onPageHide);

  return {
    detach: () => {
      // Third save site, and the one that catches what the other two miss: the
      // `end` event above fires for an orbit or a wheel-zoom, but NOT for a
      // view-cube click, Reframe, or an animation camera cue, so a session that
      // finished on one of those used to persist a pose the user had already
      // moved away from. Taking the live pose at teardown makes the stored
      // camera honest whatever last moved it.
      saveCamera(viewer.getCameraState());
      themeBtn?.removeEventListener("click", onThemeClick);
      reframeBtn?.removeEventListener("click", onReframeClick);
      window.removeEventListener("pagehide", onPageHide);
      tooltipBinding?.detach();
      // the onCameraEnd listener lives on the OrbitControls object, which
      // viewer.dispose() destroys — nothing to remove here
    },
  };
}
