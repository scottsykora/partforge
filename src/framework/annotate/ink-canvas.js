// The annotation ink layer: a transparent 2D canvas stacked over the viewer
// canvas (the first screen-space overlay canvas in the framework — everything
// else that follows the model is in-scene, see dim3-scene.js). Appended to the
// STAGE, not document.body, so it lives in .pf-stage's positioning context and
// behaves under the narrow-pane layout. While visible it owns all pointer
// events, which is what freezes orbit controls during annotation — no viewer
// changes needed. Elements render dark-core-over-light-halo so ink reads on
// both themes and any model color; a tool-driven overlay (handles, guides,
// labels, ...) is drawn on top in chrome colors, and is excluded from export.
import { runCleanupSteps } from "../teardown.js";
import { visibleRuns, handlesOf, INK_COLORS } from "./elements.js";

const HALO_COLOR = "rgba(255, 255, 255, 0.85)";
const HALO_RATIO = 2.2; // halo pass width relative to the core width

// Stage space -> pixels. Stage y ranges over [0,1] and spans the bitmap
// height; stage x is pre-scaled by the viewport aspect (bitmap width =
// aspect x height by construction, see elements.js), so the same factor
// (target.height) maps both axes.
const mapper = (target) => {
  const s = target.height;
  return (p) => [p.x * s, p.y * s];
};

// One halo-or-core pass over every element's visible runs. Shared by the
// live draw and the elements-only export path.
function strokePass(target, ctx, elements, widthScale, colorOf) {
  const short = Math.min(target.width, target.height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const toPx = mapper(target);
  for (const el of elements) {
    const w = el.width * short * widthScale;
    ctx.strokeStyle = colorOf(el);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = w;
    for (const run of visibleRuns(el)) {
      if (run.length === 1) {
        const [x, y] = toPx(run[0]);
        ctx.beginPath();
        ctx.arc(x, y, w / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      run.forEach((p, i) => {
        const [x, y] = toPx(p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }
}

// Elements only — halo pass then core pass. This is both the export path
// (toDataUrl draws only this into a scratch canvas) and the base of the live
// draw.
function drawElements(ctx, target, elements) {
  ctx.clearRect(0, 0, target.width, target.height);
  strokePass(target, ctx, elements, HALO_RATIO, () => HALO_COLOR);
  strokePass(target, ctx, elements, 1, (el) => INK_COLORS[el.color]);
}

// Chrome (accent/surface/text) colors for overlay adornments, resolved from
// CSS custom properties on the canvas so the ink layer follows the host's
// theme. Falls back to literal defaults — required in bare test environments
// where getComputedStyle may be absent or return unset custom properties.
const chromeColor = (canvas, name, fallback) => {
  try {
    const v = globalThis.getComputedStyle?.(canvas)?.getPropertyValue(name)?.trim();
    return v || fallback;
  } catch {
    return fallback;
  }
};

const chromeColors = (canvas) => ({
  accent: chromeColor(canvas, "--pf-accent", "#3f7bf0"),
  surface: chromeColor(canvas, "--pf-surface", "#ffffff"),
  text: chromeColor(canvas, "--pf-text", "#111111"),
});

function drawGlow(ctx, target, glowEl, accent) {
  if (!glowEl) return;
  const short = Math.min(target.width, target.height);
  const toPx = mapper(target);
  const w = glowEl.width * short * HALO_RATIO * 1.6;
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = accent;
  ctx.fillStyle = accent;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = w;
  for (const run of visibleRuns(glowEl)) {
    if (run.length === 1) {
      const [x, y] = toPx(run[0]);
      ctx.beginPath();
      ctx.arc(x, y, w / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    run.forEach((p, i) => {
      const [x, y] = toPx(p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  ctx.restore();
}

// Handles/labels/glyph geometry and the chrome stroke widths below are
// specified as CSS pixels, but the bitmap they draw into is device pixels
// (CSS size × dpr, see resize()) — the same distinction the ink strokes
// already get for free via el.width being a fraction of the (dpr-scaled)
// short edge. Every literal constant here is multiplied by `dpr` (the
// current bitmap dpr, threaded in from draw()) so this chrome renders at its
// intended CSS size instead of shrinking to half that on a dpr-2 display.
function drawHandles(ctx, target, handlesEl, chrome, dpr) {
  if (!handlesEl) return;
  const toPx = mapper(target);
  const HS = 7 * dpr;
  ctx.fillStyle = chrome.surface;
  ctx.strokeStyle = chrome.accent;
  ctx.lineWidth = 1.5 * dpr;
  for (const h of handlesOf(handlesEl)) {
    const [x, y] = toPx(h);
    ctx.fillRect(x - HS / 2, y - HS / 2, HS, HS);
    ctx.strokeRect(x - HS / 2, y - HS / 2, HS, HS);
  }
}

function drawGuide(ctx, target, guide, chrome, dpr) {
  if (!guide) return;
  const toPx = mapper(target);
  ctx.strokeStyle = chrome.accent;
  ctx.lineWidth = 1 * dpr;
  ctx.setLineDash([4 * dpr, 3 * dpr]);
  if (guide.kind === "rect") {
    // w/h are stage-space extents, not a stroke width — map them with the
    // same factor as points (target.height), not the short-edge convention
    // strokePass/drawGlow use for line width.
    const [x, y] = toPx({ x: guide.cx - guide.w / 2, y: guide.cy - guide.h / 2 });
    const [x2, y2] = toPx({ x: guide.cx + guide.w / 2, y: guide.cy + guide.h / 2 });
    ctx.strokeRect(x, y, x2 - x, y2 - y);
  } else if (guide.kind === "cross") {
    const [x, y] = toPx({ x: guide.cx, y: guide.cy });
    const arm = 5 * dpr;
    ctx.beginPath();
    ctx.moveTo(x - arm, y);
    ctx.lineTo(x + arm, y);
    ctx.moveTo(x, y - arm);
    ctx.lineTo(x, y + arm);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawLabel(ctx, target, label, chrome, dpr) {
  if (!label) return;
  const toPx = mapper(target);
  const [x, y] = toPx(label);
  ctx.font = `${10 * dpr}px monospace`;
  const metrics = ctx.measureText(label.text);
  const padX = 4 * dpr;
  const padY = 3 * dpr;
  const boxW = (metrics?.width || 0) + padX * 2;
  const boxH = 10 * dpr + padY * 2;
  // Offset the plate clear of the pointer: the label anchors at the dragged
  // corner/handle, i.e. under the cursor, so 16px right + 12px up keeps it
  // outside both the arrow cursor's body and the crosshair's arms.
  const bx = x + 16 * dpr;
  const by = y - 12 * dpr - boxH;
  ctx.fillStyle = chrome.surface;
  ctx.fillRect(bx, by, boxW, boxH);
  ctx.fillStyle = chrome.accent;
  ctx.fillText(label.text, bx + padX, by + boxH - padY);
}

export function createInkCanvas(stage, {
  getContext2d = (canvas) => canvas.getContext("2d"),
  createCanvas = () => document.createElement("canvas"),
} = {}) {
  const canvas = createCanvas();
  canvas.className = "pf-ink-canvas";
  canvas.hidden = true;
  stage.appendChild(canvas);
  const ctx = getContext2d(canvas);
  let scene = { elements: [], overlay: {} };
  // The bitmap's current dpr, set by resize()/size() below and read by draw()
  // to scale the overlay chrome's fixed-CSS-pixel constants (handles, label,
  // chrome line widths) up to device pixels. Defaults to 1 so a
  // draw() before the first resize() (there isn't one on this path, but
  // belt-and-suspenders) doesn't under/over-scale.
  let currentDpr = 1;

  // Live draw order: glow -> all halos -> all cores -> handles -> guide ->
  // label. Glow renders before the elements' own halo/core passes so it reads
  // as a soft field behind the ink, not on top of it. Pointer-followers (the
  // eraser ring, the rotate glyph) are deliberately NOT drawn here: anything
  // that must track the cursor per-mousemove would force a full-canvas redraw
  // per event — they are CSS cursors instead (app.css), rendered by the
  // compositor at zero canvas cost.
  function draw() {
    if (!ctx) return;
    const overlay = scene.overlay || {};
    const chrome = chromeColors(canvas);
    const dpr = currentDpr;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGlow(ctx, canvas, overlay.glowEl, chrome.accent);
    strokePass(canvas, ctx, scene.elements, HALO_RATIO, () => HALO_COLOR);
    strokePass(canvas, ctx, scene.elements, 1, (el) => INK_COLORS[el.color]);
    drawHandles(ctx, canvas, overlay.handlesEl, chrome, dpr);
    drawGuide(ctx, canvas, overlay.guide, chrome, dpr);
    drawLabel(ctx, canvas, overlay.label, chrome, dpr);
  }

  function resize() {
    const rect = stage.getBoundingClientRect();
    const dpr = globalThis.devicePixelRatio || 1;
    currentDpr = dpr;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    draw();
  }

  // The viewer's own ResizeObserver is internal (viewer.js exposes no resize
  // hook), so the overlay runs its own — a resize is just a re-rasterize at
  // the new bitmap size. Skip it while hidden: the stage keeps resizing (rail
  // drags, window resizes) whether or not annotate mode is on, and
  // re-rasterizing an invisible canvas is wasted work; show() already calls
  // resize() so nothing is missed on re-entry.
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
    if (canvas.hidden) return;
    resize();
  });
  observer?.observe(stage);

  let disposed = false;
  return {
    element: canvas,
    show() { canvas.hidden = false; resize(); },
    hide() { canvas.hidden = true; },
    setScene(next) { scene = next; draw(); },
    // The ink layer as a transparent PNG, elements only — overlay adornments
    // (handles, guides, labels, the eraser ring, ...) are tool chrome, not
    // part of the drawing, and must never reach the export. Since the live
    // canvas now carries that overlay, export always re-rasterizes elements
    // into a scratch canvas rather than reading the live bitmap directly.
    // `maxEdge` bounds the exported bitmap: the live canvas is stage-sized ×
    // devicePixelRatio, so on a large hi-DPI display it runs to several
    // thousand pixels a side, and a PNG that big is both slow to encode and
    // large enough that a host with a payload ceiling would have to drop it —
    // losing the drawing while keeping the picture of the model, which is the
    // one outcome worse than failing. Above the bound the elements are
    // re-rasterized at the scaled-down size rather than resampled, so thin
    // ink stays crisp instead of turning to mush.
    toDataUrl({ maxEdge } = {}) {
      const long = Math.max(canvas.width, canvas.height);
      const scale = maxEdge && long > maxEdge ? maxEdge / long : 1;
      const scratch = createCanvas();
      scratch.width = Math.max(1, Math.round(canvas.width * scale));
      scratch.height = Math.max(1, Math.round(canvas.height * scale));
      const scratchCtx = getContext2d(scratch);
      if (!scratchCtx) return canvas.toDataURL("image/png");
      drawElements(scratchCtx, scratch, scene.elements);
      return scratch.toDataURL("image/png");
    },
    size: () => ({ width: canvas.width, height: canvas.height, dpr: globalThis.devicePixelRatio || 1 }),
    dispose() {
      if (disposed) return;
      disposed = true;
      runCleanupSteps([
        () => observer?.disconnect(),
        () => canvas.remove(),
      ], "ink canvas cleanup failed");
    },
  };
}
