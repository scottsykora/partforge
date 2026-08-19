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

export function createInkCanvas(stage, { getContext2d = (canvas) => canvas.getContext("2d") } = {}) {
  const canvas = document.createElement("canvas");
  canvas.className = "pf-ink-canvas";
  canvas.hidden = true;
  stage.appendChild(canvas);
  const ctx = getContext2d(canvas);
  let strokes = [];

  function drawPass(color, widthScale) {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const short = Math.min(canvas.width, canvas.height);
    for (const stroke of strokes) {
      const w = stroke.width * short * widthScale;
      if (stroke.points.length === 1) {
        const [nx, ny] = stroke.points[0];
        ctx.beginPath();
        ctx.arc(nx * canvas.width, ny * canvas.height, w / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.lineWidth = w;
      ctx.beginPath();
      stroke.points.forEach(([nx, ny], i) => {
        const x = nx * canvas.width;
        const y = ny * canvas.height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }

  function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawPass(HALO_COLOR, HALO_RATIO);
    drawPass(CORE_COLOR, 1);
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
    toDataUrl: () => canvas.toDataURL("image/png"),
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
