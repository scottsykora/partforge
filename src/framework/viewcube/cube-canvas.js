// The view cube's renderer: one small 2D canvas, repainted only when the camera
// actually moved (viewcube-mode.js owns that decision). A canvas rather than
// SVG because the alternative rewrites ~26 polygon `points` attributes inside
// the rAF callback, and each write re-parses a string and invalidates style and
// paint for the subtree — spent during orbit, which is the worst time to spend
// it. Here an idle frame costs literally nothing.
//
// The 2D context is injected (happy-dom has no real one) — the createInkCanvas
// and dim3-scene paintLabel precedent.
import { faceLabelUpSign } from "./cube-geom.js";

// The full-size cube. Below RAIL_NARROW_BREAKPOINT the shell has only one pane
// on screen at a time (rail.js), so the cube drops to CUBE_SIZE_NARROW —
// viewcube-mode.js is the one that watches the breakpoint and calls setSize().
export const CUBE_SIZE = 135; // CSS px; the backing store is this x devicePixelRatio
// Three quarters of the full size: below the rail's narrow breakpoint the stage
// is much tighter, but the cube stays VISIBLE there (the 2026-08-19 design
// decision) and so it still has to be legible — 26 hit regions and six face
// labels on a phone-sized widget. Deliberately a tuned literal rather than
// `Math.round(CUBE_SIZE * 0.75)`, like every other number in this file's
// exported blocks: a derived expression invites the next reader to retune the
// RATIO when what they actually want is a different number of pixels.
export const CUBE_SIZE_NARROW = 101;

// Deliberately hardcoded rather than read from CSS vars: this paints into a
// bitmap where var() cannot reach, exactly like DIM_THEME in dim3-scene.js.
// Locked by the look-and-feel spike (plan Task 4); the `edge` colour was
// retuned in the 2026-08-19 reshape (see CUBE_RENDER's comment below).
//
// `hoverFill` is the ONE opaque entry, and deliberately so (2026-08-20). Every
// other fill here is translucent because the cube is a ghost — but a
// translucent HIGHLIGHT cannot keep a promise the highlight has to keep. A
// hovered corner shows three cells at once, and whether each one has a
// back-face cell behind it or empty space depends on the rotation, so a
// translucent blue composites over `backFill` on some of them and over nothing
// on others: three visibly different blues for one region. The hue is exactly
// the old translucent colour at full alpha, so nothing but the compositing
// changed.
//
// The trade-off, written down rather than left to be rediscovered: an opaque
// highlight also hides any axis arrow drawn in the "behind" depth phase where
// the two overlap (that arrow used to read faintly through the highlight).
// That is accepted — a selection highlight that reads solidly is worth more
// than an arrow showing through it — and it only affects the hovered cells.
export const CUBE_PALETTE = {
  dark: {
    backFill: "rgba(124, 143, 176, 0.10)",
    frontFill: "rgba(159, 180, 204, 0.22)",
    hoverFill: "#7aa2f7", // OPAQUE on purpose — see the palette's note below
    edge: "rgba(190, 205, 226, 0.25)",
    faceLabel: "rgba(214, 226, 255, 0.65)",
    axisX: "#e06c75",
    axisY: "#98c379",
    axisZ: "#61afef",
    label: "#d6e2ff",
  },
  light: {
    backFill: "rgba(70, 88, 118, 0.08)",
    frontFill: "rgba(90, 108, 138, 0.18)",
    hoverFill: "#2b6cd6", // OPAQUE on purpose — see the palette's note below
    edge: "rgba(56, 72, 98, 0.25)",
    faceLabel: "rgba(24, 42, 78, 0.65)",
    axisX: "#c0392b",
    axisY: "#2f7d32",
    axisZ: "#1f6feb",
    label: "#182a4e",
  },
};

// Render proportions the look-and-feel spike sweeps (plan Task 4), kept here
// rather than inline for the same reason CUBE_PALETTE is: a tunable nobody can
// find is a tunable nobody tunes. Geometry proportions live in cube-geom.js's
// CUBE_CONSTANTS; these are the ones that only affect how it is PAINTED.
//
// The 2026-08-19 reshape dropped per-cell strokes entirely (the 26 regions are
// invisible until hovered) in favour of the cube's own 12 edges: `edge`
// above is now a plain, quiet cube-edge colour rather than a busy grid line,
// and its alpha was cut roughly in half from the old cell-outline value for
// exactly that reason.
//
// A same-day follow-up moved the arrowhead and its label fully into SCREEN
// space: an arrowhead sized from the (foreshortened) projected shaft grew and
// shrank as the cube turned, which read as a glitch. `headLengthPx` and
// `headHalfWidthPx` (replacing the old fraction-of-shaft `headHalfWidth`) are
// now fixed CSS px, built from the shaft's normalised screen direction, so the
// head is the same size at every rotation and its back edge sits flush
// against the cube (the shaft itself now ends exactly on the far face — see
// cube-geom.js). `labelGapPx` is the fixed px gap from the head's tip to the
// axis label anchor beyond it.
//
// `faceLabelScale` sizes the FRONT/BACK/... names painted ON their faces
// (see drawFaceLabel below) — it is a font size in FACE-LOCAL units, not CSS
// px: 1 unit is half the centre cell's own width, so the label scales with
// the cube (and with the 135px/90px breakpoint switch) for free instead of
// needing its own px tunable.
export const CUBE_RENDER = {
  headLengthPx: 9,      // arrowhead length, CSS px, constant regardless of rotation
  headHalfWidthPx: 3.5, // arrowhead half-width, CSS px
  labelGapPx: 4,         // gap from the head's tip to the axis label anchor, CSS px
  arrowWidth: 2,         // axis arrow shaft stroke, CSS px
  edgeWidth: 1,          // cube-edge stroke, CSS px
  labelPx: 10,           // axis label (X/Y/Z) size, CSS px
  faceLabelScale: 0.45,  // face label (FRONT/BACK/...) font size, in face-local units
};

// Below this projected shaft length (CSS px) the axis points almost exactly
// at or away from the camera: the shaft is a dot on screen, its direction is
// numerically meaningless, and normalising it would produce NaN. Not a visual
// tunable (nobody wants to "nudge" a numerical safety epsilon by eye) so it
// sits outside CUBE_RENDER, same as viewcube-mode.js's DRAG_THRESHOLD_PX.
const MIN_ARROW_DIR_PX = 0.5;

// Lays the face name flat ON the face — the label rotates with the face rather
// than hovering in front of it always facing the screen (the 2026-08-19 design
// decision, and the thing this must not regress). Returns the affine basis
// drawFaceLabel hands the context: the cell's screen centroid plus two axes
// where 1 local unit is half the cell's own on-screen width/height, so text
// sized in that space (CUBE_RENDER.faceLabelScale) scales with the cube for
// free. Pure and exported so the six faces' orientations can be asserted
// directly, including for faces the renderer would not have drawn.
//
// The v (down-the-glyph) axis is deliberately NOT taken from the corner
// ordering. That ordering is consistent, but consistency is not orientation:
// the old basis was `u = (p1-p0)/2, v = (p3-p0)/2` with a single determinant
// guard, and a determinant only catches MIRRORING. A basis rotated 180 degrees
// is non-mirrored too, so LEFT and BACK sailed through it reading upside down.
//
// Instead each face declares an up direction in model space (cube-geom.js's
// FACE_LABEL_UP) and faceLabelUpSign says which way that lies along this cell's
// own projected v edge. v is that edge pointed the OTHER way, because canvas +y
// is down: local +y, the direction a glyph descends, has to run DOWN the face.
export function faceLabelBasis(cell) {
  const [p0, p1, , p3] = cell.points;
  const cx0 = cell.points.reduce((s, pt) => s + pt[0], 0) / cell.points.length;
  const cy0 = cell.points.reduce((s, pt) => s + pt[1], 0) / cell.points.length;
  let ux = (p1[0] - p0[0]) / 2, uy = (p1[1] - p0[1]) / 2;
  const bx = (p3[0] - p0[0]) / 2, by = (p3[1] - p0[1]) / 2;
  const down = -faceLabelUpSign(cell.face);
  const vx = down * bx, vy = down * by;
  // The handedness guard, kept as a backstop but now applied to U. Only
  // camera-facing faces get labelled, so "toward the camera" is the handedness
  // the basis should keep, and a negative determinant still means this pairing
  // would mirror the text. What changed is which axis is free to fix it: v now
  // carries the orientation, so flipping v would undo the correction above and
  // put the label back upside down. Negating u instead reflects the pair across
  // v, which un-mirrors the glyph while leaving its up direction alone.
  if (ux * vy - uy * vx < 0) { ux = -ux; uy = -uy; }
  return { cx: cx0, cy: cy0, ux, uy, vx, vy };
}

export function createCubeCanvas(host, {
  getContext2d = (canvas) => canvas.getContext("2d"),
  createCanvas = () => document.createElement("canvas"),
  size: initialSize = CUBE_SIZE,
} = {}) {
  const canvas = createCanvas();
  canvas.className = "pf-viewcube-canvas";
  let size = initialSize;
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
  function resizeBackingStore(dpr) {
    backingDpr = dpr;
    canvas.width = Math.max(1, Math.round(size * dpr));
    canvas.height = Math.max(1, Math.round(size * dpr));
  }

  function syncBackingStore(dpr) {
    if (dpr === backingDpr) return;
    resizeBackingStore(dpr);
  }

  function polygon(points) {
    ctx.beginPath();
    points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
  }

  function strokeEdges(edges, colour) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = CUBE_RENDER.edgeWidth;
    for (const edge of edges) {
      // The 3 axis-tagged edges are drawn by their arrow instead (shaft +
      // head, in the axis colour) — stroking them here too would just be a
      // duller line sitting under a brighter one.
      if (edge.axis) continue;
      // Neither adjoining face is camera-facing (cube-geom.js's `hidden`) —
      // an edge on the cube's far side, or one that projects onto a
      // silhouette edge already drawn from the near side.
      if (edge.hidden) continue;
      ctx.beginPath();
      ctx.moveTo(edge.points[0][0], edge.points[0][1]);
      ctx.lineTo(edge.points[1][0], edge.points[1][1]);
      ctx.stroke();
    }
  }

  // The shaft (arrow.from -> arrow.tip) is real cube geometry — it ends
  // exactly on the far face. Everything past that is built here in constant
  // SCREEN pixels from the shaft's normalised on-screen direction, so the
  // head reads the same size at every rotation instead of growing and
  // shrinking with the shaft's foreshortened projected length. Below
  // MIN_ARROW_DIR_PX the direction is numerically meaningless (the axis
  // points almost straight at/away from the camera, so the shaft is a dot on
  // screen) — returning null here rather than a near-zero/NaN vector is what
  // keeps that case from poisoning the head or label.
  function arrowDirection(arrow) {
    const dx = arrow.tip[0] - arrow.from[0];
    const dy = arrow.tip[1] - arrow.from[1];
    const len = Math.hypot(dx, dy);
    if (len < MIN_ARROW_DIR_PX) return null;
    return [dx / len, dy / len];
  }

  // Where the head's outward tip and the label anchor land, given the
  // shaft's screen direction — shared by drawArrow (which also needs the
  // head's base corners) and the axis-label pass (drawn last, over
  // everything, regardless of which depth phase drew the arrow itself).
  function arrowFurniture(arrow, dir) {
    const headTip = [
      arrow.tip[0] + dir[0] * CUBE_RENDER.headLengthPx,
      arrow.tip[1] + dir[1] * CUBE_RENDER.headLengthPx,
    ];
    const label = [
      headTip[0] + dir[0] * CUBE_RENDER.labelGapPx,
      headTip[1] + dir[1] * CUBE_RENDER.labelGapPx,
    ];
    return { headTip, label };
  }

  function drawArrow(arrow, colour) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = CUBE_RENDER.arrowWidth;
    ctx.beginPath();
    ctx.moveTo(arrow.from[0], arrow.from[1]);
    ctx.lineTo(arrow.tip[0], arrow.tip[1]);
    ctx.stroke();

    const dir = arrowDirection(arrow);
    if (!dir) return; // degenerate: axis points at/away from the camera, no head to draw
    const { headTip } = arrowFurniture(arrow, dir);
    const nx = -dir[1] * CUBE_RENDER.headHalfWidthPx, ny = dir[0] * CUBE_RENDER.headHalfWidthPx;
    ctx.fillStyle = colour;
    polygon([headTip, [arrow.tip[0] + nx, arrow.tip[1] + ny], [arrow.tip[0] - nx, arrow.tip[1] - ny]]);
    ctx.fill();
  }

  // faceLabelBasis (module scope, above) does the geometry; this composes it
  // onto the DPR scale with save()/transform() rather than replacing it via
  // setTransform().
  function drawFaceLabel(cell, colour) {
    const { cx: cx0, cy: cy0, ux, uy, vx, vy } = faceLabelBasis(cell);
    ctx.save();
    ctx.transform(ux, uy, vx, vy, cx0, cy0);
    ctx.font = `600 ${CUBE_RENDER.faceLabelScale}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = colour;
    ctx.fillText(cell.face.toUpperCase(), 0, 0);
    ctx.restore();
  }

  // Draw order (2026-08-19 reshape): back faces, back edges, the hovered
  // region (if any), front faces, front edges, the 3 axis arrows in their own
  // depth order, face labels, axis labels. No cell is ever stroked — the grid
  // is gone, replaced by the cube's own 12 (quiet) edges — and face labels are
  // skipped entirely while hovering so the highlight reads unobstructed.
  function draw(projected, { hover } = {}) {
    if (!ctx || !projected) return;
    last = { projected, hover };
    const p = CUBE_PALETTE[theme] ?? CUBE_PALETTE.dark;
    const dpr = globalThis.devicePixelRatio || 1;
    syncBackingStore(dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const axisColour = { X: p.axisX, Y: p.axisY, Z: p.axisZ };
    // Arrows are routed by real depth rather than drawn unconditionally on
    // top: one whose corner has rotated to the back must be drawn BEFORE the
    // (translucent) front faces so it reads dimly through them, not floating
    // over geometry that should be hiding it.
    const behind = projected.arrows.filter((a) => a.depth < 0).sort((a, b) => a.depth - b.depth);
    const ahead = projected.arrows.filter((a) => a.depth >= 0).sort((a, b) => a.depth - b.depth);

    // 1. back faces
    ctx.fillStyle = p.backFill;
    for (const cell of projected.back) {
      polygon(cell.points);
      ctx.fill();
    }

    // 2. back edges (the 9 quiet ones; the 3 axis edges are arrows only)
    strokeEdges(projected.backEdges, p.edge);

    for (const arrow of behind) drawArrow(arrow, axisColour[arrow.axis]);

    // 3. the hovered region — EVERY camera-facing cell of it, not just one.
    // A face id owns 1 cell, an edge id 2, a corner id 3 (see cube-geom.js),
    // and step 4 below skips all of them, so resolving a single cell here left
    // an edge's second cell and a corner's other two unpainted altogether.
    if (hover) {
      ctx.fillStyle = p.hoverFill;
      for (const cell of projected.front) {
        if (cell.id !== hover) continue;
        polygon(cell.points);
        ctx.fill();
      }
    }

    // 4. front faces (skip the hovered one — its highlight is already down)
    ctx.fillStyle = p.frontFill;
    for (const cell of projected.front) {
      if (cell.id === hover) continue;
      polygon(cell.points);
      ctx.fill();
    }

    // 5. front edges
    strokeEdges(projected.frontEdges, p.edge);

    // 6. axis arrows, in depth order relative to the faces
    for (const arrow of ahead) drawArrow(arrow, axisColour[arrow.axis]);

    // 7. face labels — camera-facing faces only, and none at all while
    // hovering so the highlighted region is unobstructed.
    if (!hover) {
      for (const cell of projected.front) {
        if (cell.isCentre) drawFaceLabel(cell, p.faceLabel);
      }
    }

    // 8. axis labels — always drawn, in both depth phases, since they sit
    // outside the cube's silhouette and cover nothing.
    ctx.font = `600 ${CUBE_RENDER.labelPx}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const arrow of projected.arrows) {
      const dir = arrowDirection(arrow);
      if (!dir) continue; // no meaningful direction to place the label along
      const { label } = arrowFurniture(arrow, dir);
      ctx.fillStyle = p.label;
      ctx.fillText(arrow.axis, label[0], label[1]);
    }
  }

  function setTheme(mode) {
    theme = CUBE_PALETTE[mode] ? mode : "dark";
    if (last) draw(last.projected, { hover: last.hover });
  }

  // Resizes the CSS box and the DPR backing store, then repaints with
  // whatever projection is on hand. That repaint is necessarily stale (it
  // still uses the old size's geometry) — viewcube-mode.js, which owns the
  // projection, re-projects at the new size and calls draw() again right
  // after; this one just keeps the canvas from sitting blank or mis-scaled
  // for the tick in between. Bypasses syncBackingStore's dpr-equality check
  // on purpose: a size change with no DPR change would otherwise be ignored.
  function setSize(px) {
    size = px;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    resizeBackingStore(globalThis.devicePixelRatio || 1);
    if (last) draw(last.projected, { hover: last.hover });
  }

  function dispose() {
    canvas.remove();
    last = null;
  }

  return { element: canvas, draw, setTheme, setSize, get size() { return size; }, dispose };
}
