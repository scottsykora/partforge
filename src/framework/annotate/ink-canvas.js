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

function drawHandles(ctx, target, handlesEl, chrome) {
  if (!handlesEl) return;
  const toPx = mapper(target);
  const HS = 7;
  ctx.fillStyle = chrome.surface;
  ctx.strokeStyle = chrome.accent;
  ctx.lineWidth = 1.5;
  for (const h of handlesOf(handlesEl)) {
    const [x, y] = toPx(h);
    ctx.fillRect(x - HS / 2, y - HS / 2, HS, HS);
    ctx.strokeRect(x - HS / 2, y - HS / 2, HS, HS);
  }
}

function drawGuide(ctx, target, guide, chrome) {
  if (!guide) return;
  const toPx = mapper(target);
  ctx.strokeStyle = chrome.accent;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  if (guide.kind === "rect") {
    // w/h are stage-space extents, not a stroke width — map them with the
    // same factor as points (target.height), not the short-edge convention
    // strokePass/drawGlow use for line width.
    const [x, y] = toPx({ x: guide.cx - guide.w / 2, y: guide.cy - guide.h / 2 });
    const [x2, y2] = toPx({ x: guide.cx + guide.w / 2, y: guide.cy + guide.h / 2 });
    ctx.strokeRect(x, y, x2 - x, y2 - y);
  } else if (guide.kind === "cross") {
    const [x, y] = toPx({ x: guide.cx, y: guide.cy });
    ctx.beginPath();
    ctx.moveTo(x - 5, y);
    ctx.lineTo(x + 5, y);
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x, y + 5);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawLabel(ctx, target, label, chrome) {
  if (!label) return;
  const toPx = mapper(target);
  const [x, y] = toPx(label);
  ctx.font = "10px monospace";
  const metrics = ctx.measureText(label.text);
  const padX = 4;
  const padY = 3;
  const boxW = (metrics?.width || 0) + padX * 2;
  const boxH = 10 + padY * 2;
  const bx = x + 8;
  const by = y - 3 - boxH;
  ctx.fillStyle = chrome.surface;
  ctx.fillRect(bx, by, boxW, boxH);
  ctx.fillStyle = chrome.accent;
  ctx.fillText(label.text, bx + padX, by + boxH - padY);
}

function drawRotateGlyph(ctx, target, rotateGlyph, chrome) {
  if (!rotateGlyph) return;
  const toPx = mapper(target);
  const [x, y] = toPx(rotateGlyph);
  const r = 8;
  const start = -0.15 * Math.PI;
  const end = 1.15 * Math.PI;
  ctx.strokeStyle = chrome.text;
  ctx.fillStyle = chrome.text;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, r, start, end);
  ctx.stroke();
  const ax = x + r * Math.cos(end);
  const ay = y + r * Math.sin(end);
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(ax - 4, ay - 2);
  ctx.lineTo(ax - 2, ay + 4);
  ctx.closePath();
  ctx.fill();
}

function drawEraser(ctx, target, eraser, chrome) {
  if (!eraser) return;
  const toPx = mapper(target);
  const [x, y] = toPx(eraser);
  ctx.save();
  ctx.globalAlpha = 0.7;
  ctx.strokeStyle = chrome.text;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, 16, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
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

  // Live draw order: glow -> all halos -> all cores -> handles -> guide ->
  // label -> rotate glyph -> eraser ring. Glow renders before the elements'
  // own halo/core passes so it reads as a soft field behind the ink, not on
  // top of it.
  function draw() {
    if (!ctx) return;
    const overlay = scene.overlay || {};
    const chrome = chromeColors(canvas);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGlow(ctx, canvas, overlay.glowEl, chrome.accent);
    strokePass(canvas, ctx, scene.elements, HALO_RATIO, () => HALO_COLOR);
    strokePass(canvas, ctx, scene.elements, 1, (el) => INK_COLORS[el.color]);
    drawHandles(ctx, canvas, overlay.handlesEl, chrome);
    drawGuide(ctx, canvas, overlay.guide, chrome);
    drawLabel(ctx, canvas, overlay.label, chrome);
    drawRotateGlyph(ctx, canvas, overlay.rotateGlyph, chrome);
    drawEraser(ctx, canvas, overlay.eraser, chrome);
  }

  function resize() {
    const rect = stage.getBoundingClientRect();
    const dpr = globalThis.devicePixelRatio || 1;
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
