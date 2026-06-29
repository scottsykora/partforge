// Regenerate the landing-page hero drawing from the REAL planter model.
//
//   node scripts/gen-hero-drawing.mjs
//
// Prints an SVG fragment (the <g class="edges"> … and dimension groups) to stdout.
// Paste it between the <svg class="drawing"> … <defs> markers in index.html when the
// planter's defaults change. The drawing is derived from the exact part parameters (the
// same ngon + taper + twist math planter.js feeds the kernel) — not the tessellated mesh
// (whose twist subdivision is too noisy to draw cleanly) — and projected in a slight
// top-down front view, with dimensions computed from the same projection so the ⌀/height/
// wall callouts line up with the geometry.
import part from "../src/parts/planter.js";

const p = { ...part.defaults };                  // facets 6, dia 70, height 90, taper 1.2, wall 1.6, twist 30, floor 3
const n = p.facets, R = p.dia / 2, H = p.height, taper = p.taper, twist = p.twist * Math.PI / 180;
const Rin = R - p.wall / Math.cos(Math.PI / n);  // same inner offset as planter.js derive()
const innerTaper = 1 + (R * (taper - 1)) / Rin;
const offset = Math.PI / n - Math.PI / 2;        // ngon() seating from planter.js

const pt = (i, t, baseR, scaleTop) => {
  const ang = (2 * Math.PI * i) / n + offset + twist * t;
  const r = baseR * (1 + (scaleTop - 1) * t);
  return [r * Math.cos(ang), r * Math.sin(ang), H * t];
};

// project: planter axis is Z (up); slight top-down pitch about X so the open rim reads.
const a = 20 * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
const proj = ([x, y, z]) => [x, z * ca - y * sa, y * ca + z * sa]; // [sx, sy-up, depth]

const SAMP = 14;
const seams = [];
for (let i = 0; i < n; i++) {
  const col = [];
  for (let s = 0; s <= SAMP; s++) col.push(proj(pt(i, s / SAMP, R, taper)));
  seams.push(col);
}
const ringPts = (t, baseR, scaleTop) => Array.from({ length: n }, (_, i) => proj(pt(i, t, baseR, scaleTop)));
const topOuter = ringPts(1, R, taper);
const topInner = ringPts(1, Rin, innerTaper);
const baseOuter = ringPts(0, R, taper);

const all = [...seams.flat(), ...topOuter, ...topInner, ...baseOuter];
const box = { x0: 78, y0: 74, x1: 282, y1: 300 };
const ex = (f) => all.map(f);
const minx = Math.min(...ex(q => q[0])), maxx = Math.max(...ex(q => q[0]));
const miny = Math.min(...ex(q => q[1])), maxy = Math.max(...ex(q => q[1]));
const mind = Math.min(...ex(q => q[2])), maxd = Math.max(...ex(q => q[2]));
const s = Math.min((box.x1 - box.x0) / (maxx - minx), (box.y1 - box.y0) / (maxy - miny));
const ox = (box.x0 + box.x1) / 2 - s * (minx + maxx) / 2;
const oy = (box.y0 + box.y1) / 2 + s * (miny + maxy) / 2;
const X = (q) => (ox + s * q[0]).toFixed(1);
const Y = (q) => (oy - s * q[1]).toFixed(1);
const near = (q) => (maxd - mind ? (q[2] - mind) / (maxd - mind) : 1);
const op = (q) => (0.34 + 0.66 * near(q)).toFixed(2);

const out = [];
out.push(`<g class="edges">`);
for (const col of seams) {
  const mid = col[Math.floor(col.length / 2)];
  out.push(`  <polyline class="edge" points="${col.map(q => `${X(q)},${Y(q)}`).join(" ")}" style="opacity:${op(mid)}"/>`);
}
const ring = (pts, cls) => {
  for (let i = 0; i < pts.length; i++) {
    const A = pts[i], B = pts[(i + 1) % pts.length];
    out.push(`  <line class="${cls}" x1="${X(A)}" y1="${Y(A)}" x2="${X(B)}" y2="${Y(B)}" style="opacity:${((+op(A) + +op(B)) / 2).toFixed(2)}"/>`);
  }
};
ring(baseOuter, "edge");
ring(topOuter, "edge rim");
ring(topInner, "edge inner");
out.push(`</g>`);

const xs = topOuter.map(q => +X(q)), ys = all.map(q => +Y(q));
const rL = Math.min(...xs), rR = Math.max(...xs);
const rYtop = Math.min(...topOuter.map(q => +Y(q)));
const topY = Math.min(...ys), baseY = Math.max(...ys);
const dimY = Math.max(rYtop - 26, 30);
const rRpt = topOuter.reduce((m, q) => +X(q) > +X(m) ? q : m, topOuter[0]);
const topLx = Math.min(...topOuter.map(q => +X(q)));
const baseLx = Math.min(...baseOuter.map(q => +X(q)));

out.push(`<g class="dimgroup">
  <line class="ext" x1="${rL}" y1="${rYtop - 4}" x2="${rL}" y2="${(dimY - 6).toFixed(1)}"/>
  <line class="ext" x1="${rR}" y1="${rYtop - 4}" x2="${rR}" y2="${(dimY - 6).toFixed(1)}"/>
  <line class="dim-hot" x1="${rL}" y1="${dimY.toFixed(1)}" x2="${rR}" y2="${dimY.toFixed(1)}" marker-start="url(#b)" marker-end="url(#b)"/>
  <text class="hot" x="${((rL + rR) / 2).toFixed(1)}" y="${(dimY - 8).toFixed(1)}" text-anchor="middle">⌀ 70 mm</text>
</g>
<g class="dimgroup">
  <line class="ext" x1="${topLx.toFixed(1)}" y1="${topY.toFixed(1)}" x2="58" y2="${topY.toFixed(1)}"/>
  <line class="ext" x1="${baseLx.toFixed(1)}" y1="${baseY.toFixed(1)}" x2="58" y2="${baseY.toFixed(1)}"/>
  <line class="dim" x1="58" y1="${topY.toFixed(1)}" x2="58" y2="${baseY.toFixed(1)}" marker-start="url(#a)" marker-end="url(#a)"/>
  <text x="52" y="${((topY + baseY) / 2).toFixed(1)}" transform="rotate(-90 52 ${((topY + baseY) / 2).toFixed(1)})" text-anchor="middle">90 mm</text>
</g>
<g class="dimgroup">
  <line class="dim" x1="${X(rRpt)}" y1="${Y(rRpt)}" x2="346" y2="${(+Y(rRpt) - 18).toFixed(1)}" marker-start="url(#a)"/>
  <text x="344" y="${(+Y(rRpt) - 21).toFixed(1)}" text-anchor="end">wall 1.6</text>
</g>
<g class="dimgroup"><text class="tag" x="180" y="330" text-anchor="middle">n = 6 facets · twist 30°</text></g>`);

console.log(out.join("\n"));
