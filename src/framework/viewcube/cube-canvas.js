// The view cube's renderer: one small 2D canvas, repainted only when the camera
// actually moved (viewcube-mode.js owns that decision). A canvas rather than
// SVG because the alternative rewrites ~26 polygon `points` attributes inside
// the rAF callback, and each write re-parses a string and invalidates style and
// paint for the subtree — spent during orbit, which is the worst time to spend
// it. Here an idle frame costs literally nothing.
//
// The 2D context is injected (happy-dom has no real one) — the createInkCanvas
// and dim3-scene paintLabel precedent.

export const CUBE_SIZE = 90; // CSS px; the backing store is this x devicePixelRatio

// Deliberately hardcoded rather than read from CSS vars: this paints into a
// bitmap where var() cannot reach, exactly like DIM_THEME in dim3-scene.js.
// Locked by the look-and-feel spike (plan Task 4).
export const CUBE_PALETTE = {
  dark: {
    backFill: "rgba(124, 143, 176, 0.10)",
    frontFill: "rgba(159, 180, 204, 0.22)",
    hoverFill: "rgba(122, 162, 247, 0.55)",
    edge: "rgba(190, 205, 226, 0.45)",
    axisX: "#e06c75",
    axisY: "#98c379",
    axisZ: "#61afef",
    label: "#d6e2ff",
  },
  light: {
    backFill: "rgba(70, 88, 118, 0.08)",
    frontFill: "rgba(90, 108, 138, 0.18)",
    hoverFill: "rgba(43, 108, 214, 0.45)",
    edge: "rgba(56, 72, 98, 0.45)",
    axisX: "#c0392b",
    axisY: "#2f7d32",
    axisZ: "#1f6feb",
    label: "#182a4e",
  },
};

const HEAD_HALF_WIDTH = 0.34; // arrowhead half-width as a fraction of its length

export function createCubeCanvas(host, {
  getContext2d = (canvas) => canvas.getContext("2d"),
  createCanvas = () => document.createElement("canvas"),
  size = CUBE_SIZE,
} = {}) {
  const canvas = createCanvas();
  canvas.className = "pf-viewcube-canvas";
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  host.appendChild(canvas);
  const ctx = getContext2d(canvas);

  let theme = "dark";
  let last = null; // the most recent { projected, hover }, so setTheme can repaint
  let backingDpr = 0;

  // The BACKING STORE is size x dpr while the CSS box stays `size` — and draw()
  // scales the context by the same dpr so it can keep working in CSS px. Sizing
  // the backing store in CSS px while scaling the context is the classic
  // version of this bug: everything renders at 2x on a retina display and the
  // cube is clipped to its top-left quarter. Re-checked per draw because a
  // window can move between displays of different density.
  function syncBackingStore(dpr) {
    if (dpr === backingDpr) return;
    backingDpr = dpr;
    canvas.width = Math.max(1, Math.round(size * dpr));
    canvas.height = Math.max(1, Math.round(size * dpr));
  }

  function polygon(points) {
    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
  }

  function head(arrow, colour) {
    const [tx, ty] = arrow.tip;
    const [bx, by] = arrow.tail;
    const dx = tx - bx, dy = ty - by;
    const nx = -dy * HEAD_HALF_WIDTH, ny = dx * HEAD_HALF_WIDTH;
    ctx.fillStyle = colour;
    polygon([[tx, ty], [bx + nx, by + ny], [bx - nx, by - ny]]);
    ctx.fill();
  }

  function draw(projected, { hover } = {}) {
    if (!ctx || !projected) return;
    last = { projected, hover };
    const p = CUBE_PALETTE[theme] ?? CUBE_PALETTE.dark;
    const dpr = globalThis.devicePixelRatio || 1;
    syncBackingStore(dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.lineWidth = 1;

    for (const cell of projected.back) {
      ctx.fillStyle = p.backFill;
      ctx.strokeStyle = p.edge;
      polygon(cell.points);
      ctx.fill();
      ctx.stroke();
    }

    const axisColour = { X: p.axisX, Y: p.axisY, Z: p.axisZ };
    for (const arrow of projected.arrows) {
      ctx.strokeStyle = axisColour[arrow.axis];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(arrow.from[0], arrow.from[1]);
      ctx.lineTo(arrow.tail[0], arrow.tail[1]);
      ctx.stroke();
    }
    ctx.lineWidth = 1;

    for (const cell of projected.front) {
      ctx.fillStyle = cell.id === hover ? p.hoverFill : p.frontFill;
      ctx.strokeStyle = p.edge;
      polygon(cell.points);
      ctx.fill();
      ctx.stroke();
    }

    for (const arrow of projected.arrows) head(arrow, axisColour[arrow.axis]);

    ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const arrow of projected.arrows) {
      ctx.fillStyle = p.label;
      ctx.fillText(arrow.axis, arrow.label[0], arrow.label[1]);
    }
  }

  function setTheme(mode) {
    theme = CUBE_PALETTE[mode] ? mode : "dark";
    if (last) draw(last.projected, { hover: last.hover });
  }

  function dispose() {
    canvas.remove();
    last = null;
  }

  return { element: canvas, draw, setTheme, size, dispose };
}
