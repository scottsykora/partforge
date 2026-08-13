// PURE screen-space layout for measurement mode: specs + a projector ->
// engineering-drawing primitives (extension lines with true gap/overshoot,
// dimension lines with arrowheads, bent leaders, label boxes). Deterministic
// greedy collision pass; hysteresis via the previous frame's choices so dims
// stay planted during orbit. All coordinates in CSS pixels.
import { fmtMm } from "./feature-dims.js";

export const EXT_GAP = 4;        // drafting gap between geometry and extension line
export const EXT_OVERSHOOT = 3;  // extension line runs past the dimension line
export const ARROW = 7;          // arrowhead length
export const DIM_OFFSET = 18;    // dimension line offset from the geometry
export const CHAR_W = 7;         // label width estimate per character (mono)
export const LABEL_H = 16;
export const LABEL_PAD = 5;
const HYSTERESIS = 0.85;         // keep the previous choice unless beaten by >15%
const EDGE_MARGIN = 8;           // offscreen chips hug the viewport inside this
const MAX_NUDGE = 8;

const labelBox = (text, paramName) => {
  const chars = text.length + (paramName ? paramName.length + 3 : 0);
  return { w: chars * CHAR_W + LABEL_PAD * 2, h: LABEL_H };
};

// One linear dimension between projected points a and b, offset along unit o.
function linearDim(out, { id, a, b, o, text, tier, paramName, pinned }) {
  const off = (p, k) => ({ x: p.x + o.x * k, y: p.y + o.y * k });
  const dimA = off(a, DIM_OFFSET), dimB = off(b, DIM_OFFSET);
  for (const [p, dp] of [[a, dimA], [b, dimB]]) {
    out.lines.push({
      x1: p.x + o.x * EXT_GAP, y1: p.y + o.y * EXT_GAP,
      x2: dp.x + o.x * EXT_OVERSHOOT, y2: dp.y + o.y * EXT_OVERSHOOT,
      kind: "ext", tier,
    });
  }
  out.lines.push({ x1: dimA.x, y1: dimA.y, x2: dimB.x, y2: dimB.y, kind: "dim", tier });
  const ang = Math.atan2(dimB.y - dimA.y, dimB.x - dimA.x);
  out.arrows.push({ x: dimA.x, y: dimA.y, angle: ang + Math.PI, tier });
  out.arrows.push({ x: dimB.x, y: dimB.y, angle: ang, tier });
  const box = labelBox(text, paramName);
  const mid = { x: (dimA.x + dimB.x) / 2, y: (dimA.y + dimB.y) / 2 };
  out.labels.push({
    id, text, tier, kind: "chip", paramName: paramName ?? null, pinned: !!pinned,
    x: mid.x - box.w / 2 + o.x * (box.h / 2 + 2),
    y: mid.y - box.h / 2 + o.y * (box.h / 2 + 2),
    ...box,
    // slide dir for the collision pass: along the dimension line
    _slide: { x: Math.cos(ang), y: Math.sin(ang) },
  });
}

const onScreen = (p, vp) => !p.behind
  && p.x >= 0 && p.x <= vp.width && p.y >= 0 && p.y <= vp.height;

// The 8 corners of a min/max box.
const boxCorners = (min, max) => [
  [min[0], min[1], min[2]], [max[0], min[1], min[2]], [min[0], max[1], min[2]], [max[0], max[1], min[2]],
  [min[0], min[1], max[2]], [max[0], min[1], max[2]], [min[0], max[1], max[2]], [max[0], max[1], max[2]],
];
// Corner-index pairs of the 4 box edges parallel to each axis.
const AXIS_EDGES = [
  [[0, 1], [2, 3], [4, 5], [6, 7]], // X
  [[0, 2], [1, 3], [4, 6], [5, 7]], // Y
  [[0, 4], [1, 5], [2, 6], [3, 7]], // Z
];

function bboxItem(out, item, vp, prevChoice, choices) {
  const { spec, project } = item;
  const corners = boxCorners(spec.anchors.min, spec.anchors.max).map(project);
  if (corners.some((c) => c.behind)) return;
  const cx = corners.reduce((s, c) => s + c.x, 0) / 8;
  const cy = corners.reduce((s, c) => s + c.y, 0) / 8;
  const texts = [fmtMm(spec.values.w), fmtMm(spec.values.d), fmtMm(spec.values.h)];
  const chosen = [];
  for (let axis = 0; axis < 3; axis++) {
    if (spec.values[["w", "d", "h"][axis]] === 0) { chosen.push(-1); continue; }
    // Silhouette rule: the edge whose midpoint sits furthest from the projected
    // center never crosses the model. Hysteresis: keep the previous edge unless
    // the best beats it by >15%.
    let bestIdx = 0, bestScore = -1;
    const scores = AXIS_EDGES[axis].map(([i, j]) => {
      const mx = (corners[i].x + corners[j].x) / 2, my = (corners[i].y + corners[j].y) / 2;
      return Math.hypot(mx - cx, my - cy);
    });
    scores.forEach((s, i) => { if (s > bestScore) { bestScore = s; bestIdx = i; } });
    const prevIdx = prevChoice?.[axis];
    const idx = prevIdx != null && prevIdx >= 0 && scores[prevIdx] >= HYSTERESIS * bestScore
      ? prevIdx : bestIdx;
    chosen.push(idx);
    const [i, j] = AXIS_EDGES[axis][idx];
    const a = corners[i], b = corners[j];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const oLen = Math.hypot(mx - cx, my - cy) || 1;
    const o = { x: (mx - cx) / oLen, y: (my - cy) / oLen };
    linearDim(out, { id: `${item.id}:${axis}`, a, b, o, text: texts[axis],
      tier: item.tier, paramName: item.paramName, pinned: item.pinned });
  }
  choices[item.id] = chosen;
}

function planeItem(out, item) {
  const { spec, project } = item;
  const dims = [
    { key: "width", pair: spec.anchors.width },
    { key: "height", pair: spec.anchors.height },
  ];
  const pts = dims.flatMap((d) => [project(d.pair.a), project(d.pair.b)]);
  if (pts.some((p) => p.behind)) return;
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  for (const d of dims) {
    const a = project(d.pair.a), b = project(d.pair.b);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    // outward = perpendicular to the dim direction, pointing away from center
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    let o = { x: -Math.sin(ang), y: Math.cos(ang) };
    if (o.x * (mx - cx) + o.y * (my - cy) < 0) o = { x: -o.x, y: -o.y };
    linearDim(out, { id: `${item.id}:${d.key}`, a, b, o, text: fmtMm(spec.values[d.key]),
      tier: item.tier, paramName: item.paramName, pinned: item.pinned });
  }
}

function cylinderItem(out, item, vp, prevChoice, choices) {
  const { spec, project } = item;
  const center = project(spec.anchors.center);
  if (center.behind) return;
  const text = spec.values.partial
    ? `R${fmtMm(spec.values.diameter / 2)}` : `⌀${fmtMm(spec.values.diameter)}`;
  // leader quadrant: away from the viewport center; hysteresis keeps it planted
  const quads = [{ x: 1, y: -1 }, { x: -1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];
  const away = { x: center.x - vp.width / 2, y: center.y - vp.height / 2 };
  const scores = quads.map((q) => q.x * away.x + q.y * away.y);
  let bestIdx = 0;
  scores.forEach((s, i) => { if (s > scores[bestIdx]) bestIdx = i; });
  const prevIdx = prevChoice?.[0];
  const idx = prevIdx != null && scores[prevIdx] >= HYSTERESIS * scores[bestIdx] ? prevIdx : bestIdx;
  choices[item.id] = [idx];
  const q = quads[idx];
  const L = 34; // leader run
  const elbow = { x: center.x + q.x * L, y: center.y + q.y * L * 0.6 };
  const box = labelBox(text, item.paramName);
  const labelX = q.x > 0 ? elbow.x + 8 : elbow.x - 8 - box.w;
  out.lines.push({ x1: elbow.x, y1: elbow.y, x2: center.x, y2: center.y, kind: "leader", tier: item.tier });
  out.lines.push({ x1: elbow.x, y1: elbow.y, x2: q.x > 0 ? labelX : labelX + box.w, y2: elbow.y, kind: "leader", tier: item.tier });
  out.arrows.push({ x: center.x, y: center.y, angle: Math.atan2(center.y - elbow.y, center.x - elbow.x), tier: item.tier });
  out.labels.push({
    id: `${item.id}:dia`, text, tier: item.tier, kind: "chip",
    paramName: item.paramName ?? null, pinned: !!item.pinned,
    x: labelX, y: elbow.y - box.h / 2, ...box,
    _slide: { x: 0, y: q.y },
  });
  // depth as a linear dim along the axis (skip degenerate depths)
  if (spec.values.depth > 0.01) {
    const a = project(spec.anchors.bottom), b = project(spec.anchors.top);
    if (!a.behind && !b.behind) {
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      let o = { x: -Math.sin(ang), y: Math.cos(ang) };
      if (o.x * q.x + o.y * q.y < 0) o = { x: -o.x, y: -o.y }; // same side as the leader
      linearDim(out, { id: `${item.id}:depth`, a, b, o, text: fmtMm(spec.values.depth),
        tier: item.tier, pinned: item.pinned });
    }
  }
}

// Representative projected points of a spec, for the offscreen test.
function specPoints(spec, project) {
  if (spec.kind === "bbox") return boxCorners(spec.anchors.min, spec.anchors.max).map(project);
  if (spec.kind === "plane") {
    return [spec.anchors.width.a, spec.anchors.width.b, spec.anchors.height.b].map(project);
  }
  return [spec.anchors.center, spec.anchors.bottom, spec.anchors.top].map(project);
}

export function layout(items, viewport, prev) {
  const out = { lines: [], arrows: [], labels: [], choices: {} };
  // hover first so it claims its natural spot; pinned, then static yield to it
  const order = { hover: 0, pinned: 1, static: 2 };
  const sorted = [...items].sort((a, b) => (order[a.tier] ?? 3) - (order[b.tier] ?? 3));
  for (const item of sorted) {
    const pts = specPoints(item.spec, item.project);
    if (pts.every((p) => !onScreen(p, viewport))) {
      if (!item.pinned) continue;
      // Pinned-but-offscreen: one edge chip pointing at the anchor, clamped in.
      const p = pts[0];
      if (p.behind) continue;
      const text = item.spec.kind === "cylinder"
        ? `⌀${fmtMm(item.spec.values.diameter)}`
        : fmtMm(Object.values(item.spec.values).find((v) => typeof v === "number") ?? 0);
      const box = labelBox(text, item.paramName);
      out.labels.push({
        id: item.id, text, tier: item.tier, kind: "offscreen",
        paramName: item.paramName ?? null, pinned: true,
        x: Math.min(Math.max(p.x, EDGE_MARGIN), viewport.width - box.w - EDGE_MARGIN),
        y: Math.min(Math.max(p.y, EDGE_MARGIN), viewport.height - box.h - EDGE_MARGIN),
        ...box, _slide: { x: 0, y: 1 },
      });
      continue;
    }
    const prevChoice = prev?.choices?.[item.id];
    if (item.spec.kind === "bbox") bboxItem(out, item, viewport, prevChoice, out.choices);
    else if (item.spec.kind === "plane") planeItem(out, item);
    else if (item.spec.kind === "cylinder") cylinderItem(out, item, viewport, prevChoice, out.choices);
  }
  // Deterministic greedy collision pass: nudge along the label's slide dir.
  const placed = [];
  for (const l of out.labels) {
    const slide = l._slide ?? { x: 0, y: 1 };
    let tries = 0;
    const hits = () => placed.some((p) =>
      l.x < p.x + p.w && p.x < l.x + l.w && l.y < p.y + p.h && p.y < l.y + l.h);
    while (hits() && tries < MAX_NUDGE) {
      l.x += slide.x * (LABEL_H + 2);
      l.y += slide.y * (LABEL_H + 2);
      tries++;
    }
    placed.push(l);
    delete l._slide;
  }
  return out;
}
