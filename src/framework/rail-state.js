// Pure state for the controls rail: width clamping, the drag state machine
// (including snap-to-collapsed), and the stored preference. No DOM here on
// purpose — this is the part worth testing exhaustively, and a pointer drag in a
// headless DOM proves very little (scripts/check-app.mjs covers that path in
// real Chromium).
//
// Mirror image of partforge-cloud's left-hand chat pane: this rail is on the
// RIGHT, so callers convert a pointer position into an intended rail WIDTH
// (shellRect.right - clientX, grab-offset corrected) before calling in. Nothing
// here ever sees a raw clientX.
export const RAIL_DEFAULT_WIDTH = 288;
export const RAIL_MIN_WIDTH = 240; // a slider label + its numeric field, still readable
export const RAIL_MAX_WIDTH = 560;
// Two thresholds rather than one: the 60px between them is hysteresis, so a
// shaky hand at the boundary can't flap the rail open and shut. Kept
// PROPORTIONAL to RAIL_MIN_WIDTH (58%-83%) rather than copying the cloud's
// literals, which are sized against its wider 280px floor.
export const RAIL_COLLAPSE_AT = 140;
export const RAIL_REOPEN_AT = 200;
// Below this the rail stacks under the viewer and resize is absent entirely.
export const RAIL_NARROW_BREAKPOINT = 720;
export const RAIL_STORAGE_KEY = "partforge:rail";

// The rail may never take more than half the shell, so the viewer can't be
// squeezed narrower than the rail. Floored at RAIL_MIN_WIDTH so the function
// stays total (and max >= min) for a transient zero-width measurement.
export function railMaxWidth(shellWidth) {
  const half = Number.isFinite(shellWidth) ? Math.floor(shellWidth / 2) : RAIL_MAX_WIDTH;
  return Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, half));
}

export function clampRailWidth(width, shellWidth) {
  const w = Number.isFinite(width) ? Math.round(width) : RAIL_DEFAULT_WIDTH;
  return Math.min(railMaxWidth(shellWidth), Math.max(RAIL_MIN_WIDTH, w));
}

// railX is the pointer's intended rail width. Returns the SAME state object
// when nothing changes, so a caller can cheaply skip redundant DOM writes.
export function resolveRailDrag(railX, state, shellWidth) {
  const open = () => ({ collapsed: false, width: clampRailWidth(railX, shellWidth) });
  if (state.collapsed) {
    // Reopening takes a deliberate push past the far threshold.
    return railX < RAIL_REOPEN_AT ? state : open();
  }
  // Collapsing keeps the last open width, so the toggle restores it later.
  if (railX < RAIL_COLLAPSE_AT) return { collapsed: true, width: state.width };
  return open();
}

export function readRailPref(storage, shellWidth) {
  const fallback = { width: RAIL_DEFAULT_WIDTH, collapsed: false };
  let raw;
  try { raw = storage.getItem(RAIL_STORAGE_KEY); } catch { return fallback; }
  if (!raw) return fallback;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return fallback; }
  if (!parsed || typeof parsed !== "object") return fallback;
  return {
    // Re-clamp on read: a width saved on a wide monitor must not leave a laptop
    // with a 560px rail and no room for the viewer.
    width: clampRailWidth(parsed.width, shellWidth),
    collapsed: parsed.collapsed === true,
  };
}

export function writeRailPref(state, storage) {
  try {
    storage.setItem(RAIL_STORAGE_KEY, JSON.stringify({
      width: state.width,
      collapsed: state.collapsed,
    }));
  } catch { /* storage unavailable — no-op, matching view-state.js */ }
}
