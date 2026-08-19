// The annotation ink layer: a transparent 2D canvas stacked over the viewer
// canvas (the first screen-space overlay canvas in the framework — everything
// else that follows the model is in-scene, see dim3-scene.js). Appended to the
// STAGE, not document.body, so it lives in .pf-stage's positioning context and
// behaves under the narrow-pane layout. While visible it owns all pointer
// events, which is what freezes orbit controls during annotation — no viewer
// changes needed. Strokes render dark-core-over-light-halo so ink reads on
// both themes and any model color.
import { runCleanupSteps } from "../teardown.js";

const CORE_COLOR = "#d92d20";
const HALO_COLOR = "rgba(255, 255, 255, 0.85)";
const HALO_RATIO = 2.2; // halo pass width relative to the core width

export function createInkCanvas(stage, {
  getContext2d = (canvas) => canvas.getContext("2d"),
  createCanvas = () => document.createElement("canvas"),
} = {}) {
  const canvas = createCanvas();
  canvas.className = "pf-ink-canvas";
  canvas.hidden = true;
  stage.appendChild(canvas);
  const ctx = getContext2d(canvas);
  let strokes = [];

  // Strokes are normalized, so a pass is written against whatever bitmap it is
  // handed — the live canvas, or the scratch one toDataUrl uses to bound an
  // export. Width scales with the target's short edge for the same reason.
  function drawPass(target, targetCtx, color, widthScale) {
    targetCtx.strokeStyle = color;
    targetCtx.fillStyle = color;
    targetCtx.lineCap = "round";
    targetCtx.lineJoin = "round";
    const short = Math.min(target.width, target.height);
    for (const stroke of strokes) {
      const w = stroke.width * short * widthScale;
      if (stroke.points.length === 1) {
        const [nx, ny] = stroke.points[0];
        targetCtx.beginPath();
        targetCtx.arc(nx * target.width, ny * target.height, w / 2, 0, Math.PI * 2);
        targetCtx.fill();
        continue;
      }
      targetCtx.lineWidth = w;
      targetCtx.beginPath();
      stroke.points.forEach(([nx, ny], i) => {
        const x = nx * target.width;
        const y = ny * target.height;
        if (i === 0) targetCtx.moveTo(x, y);
        else targetCtx.lineTo(x, y);
      });
      targetCtx.stroke();
    }
  }

  function drawInto(targetCtx, target) {
    targetCtx.clearRect(0, 0, target.width, target.height);
    drawPass(target, targetCtx, HALO_COLOR, HALO_RATIO);
    drawPass(target, targetCtx, CORE_COLOR, 1);
  }

  function draw() {
    if (!ctx) return;
    drawInto(ctx, canvas);
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
  // hook), so the overlay runs its own — ink is normalized, so a resize is
  // just a re-rasterize at the new bitmap size. Skip it while hidden: the
  // stage keeps resizing (rail drags, window resizes) whether or not
  // annotate mode is on, and re-rasterizing an invisible canvas is wasted
  // work; show() already calls resize() so nothing is missed on re-entry.
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
    setStrokes(next) { strokes = next; draw(); },
    // The ink layer as a transparent PNG. `maxEdge` bounds the exported
    // bitmap: the live canvas is stage-sized × devicePixelRatio, so on a large
    // hi-DPI display it runs to several thousand pixels a side, and a PNG that
    // big is both slow to encode and large enough that a host with a payload
    // ceiling would have to drop it — losing the drawing while keeping the
    // picture of the model, which is the one outcome worse than failing. Above
    // the bound the strokes are re-rasterized into a scratch canvas rather than
    // resampled, so thin ink stays crisp instead of turning to mush. Under it
    // (the ordinary case) nothing is copied and the live canvas exports
    // directly.
    toDataUrl({ maxEdge } = {}) {
      const long = Math.max(canvas.width, canvas.height);
      if (!maxEdge || long <= maxEdge) return canvas.toDataURL("image/png");
      const scale = maxEdge / long;
      const scratch = createCanvas();
      scratch.width = Math.max(1, Math.round(canvas.width * scale));
      scratch.height = Math.max(1, Math.round(canvas.height * scale));
      const scratchCtx = getContext2d(scratch);
      if (!scratchCtx) return canvas.toDataURL("image/png");
      drawInto(scratchCtx, scratch);
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
