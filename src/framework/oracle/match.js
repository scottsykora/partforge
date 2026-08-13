// Mask comparison: score a candidate silhouette against a reference one. Consumes the
// masks oracle/silhouette.js produces and answers "how close is this shape?" four ways —
// area overlap (`iou`), rim overlap (`boundaryIoU`), a mean contour separation
// (`contourDist`), and a per-pixel `delta` map naming what is missing versus extra. No
// kernel, no DOM, no three, no `node:`, so it runs in the geometry worker like the rest
// of the oracle.
//
// Shape is compared POSE-NORMALIZED: each mask is cropped to its tight foreground bbox,
// scaled so its longest side fills 0.92 of a 256² frame, and centroid-aligned there. So
// `iou`, `boundaryIoU`, and `delta` are invariant to where the part sits and how big it
// is, which is what "does it look like the picture?" means. Absolute size is a separate
// question and only `{scaleAware: true}` asks it — and only when BOTH masks carry a
// finite mmPerPx: `iouScale` overlays them on the reference's own mm grid,
// centroid-aligned and never rescaled, so a part twice too big scores 0.25, and
// `contourDist` is then a real millimetre distance instead of a fraction of the
// reference's bbox diagonal.
//
// A mask with no foreground pixels — or no mask at all — is UNSCOREABLE, not
// zero-scoring: matchMasks returns null and matchViews leaves the view out. 0/0 is
// never a score.

import { MATCH_VIEWS } from "./silhouette.js";

const S = 256;            // internal normalization frame, whatever the input mask sizes
const FILL = 0.92;        // fraction of the frame the longest bbox side occupies
const BAND_PX = 2;        // boundary band thickness, per the Boundary IoU definition
const BIG = 1e20;         // "unreachable" seed for the distance transform's lower envelope
const MAX_MM_FRAME = 2048; // px ceiling on the scale-aware grid; see mmFrame

// candidate/reference: Task 1 masks. opts: {scaleAware}. → null when either is unscoreable.
export function matchMasks(candidate, reference, opts = {}) {
  const cs = stats(candidate), rs = stats(reference);
  if (!cs || !rs) return null;

  const nc = normalize(cs), nr = normalize(rs);
  const iou = maskIoU(nc, nr);
  const boundaryIoU = maskIoU(band(nc), band(nr));
  const delta = deltaMap(nc, nr);

  const scaleAware = opts.scaleAware === true && scaled(candidate) && scaled(reference);
  let contourDist, contourUnit, iouScale;
  if (scaleAware) {
    const [sc, sr, pitch] = mmFrame(cs, candidate.mmPerPx, rs, reference.mmPerPx);
    iouScale = maskIoU(sc, sr);
    contourDist = contourDistance(sc, sr) * pitch;
    contourUnit = "mm";
  } else {
    const diag = Math.hypot(nr.bw, nr.bh);
    contourDist = (contourDistance(nc, nr) / diag) * 100;
    contourUnit = "%bbox-diag";
  }

  const out = { iou, boundaryIoU, contourDist, contourUnit, delta };
  if (scaleAware) out.iouScale = iouScale;
  return out;
}

// viewMasks: {front: mask|null, ...} → {best: {view, ...scores}|null, views: {view: iou}}.
// Views are walked in MATCH_VIEWS order, so a tie on `iou` resolves to the earlier view
// regardless of the object's own key order.
export function matchViews(viewMasks, reference, opts = {}) {
  const views = {};
  let best = null;
  for (const view of MATCH_VIEWS) {
    const scores = matchMasks(viewMasks?.[view], reference, opts);
    if (!scores) continue;
    views[view] = scores.iou;
    if (!best || scores.iou > best.iou) best = { view, ...scores };
  }
  return { best, views };
}

// Squared-then-rooted Euclidean distance (in px) from every pixel to the nearest non-zero
// pixel of `data`, by Felzenszwalb–Huttenlocher: a 1D lower-envelope pass over rows, then
// over columns. With no non-zero pixel at all every entry comes back astronomically large
// rather than infinite, which keeps the envelope's arithmetic finite.
export function distanceTransform(data, width, height) {
  const n = width * height;
  const sq = new Float64Array(n);
  for (let i = 0; i < n; i++) sq[i] = data[i] ? 0 : BIG;

  const m = Math.max(width, height);
  const f = new Float64Array(m), d = new Float64Array(m);
  const v = new Int32Array(m), z = new Float64Array(m + 1);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) f[c] = sq[r * width + c];
    envelope(f, width, d, v, z);
    for (let c = 0; c < width; c++) sq[r * width + c] = d[c];
  }
  for (let c = 0; c < width; c++) {
    for (let r = 0; r < height; r++) f[r] = sq[r * width + c];
    envelope(f, height, d, v, z);
    for (let r = 0; r < height; r++) sq[r * width + c] = d[r];
  }

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sqrt(sq[i]);
  return out;
}

// Lower envelope of the parabolas (q - x)² + f[q]: `v` holds the parabolas in the
// envelope and `z` the boundaries between them. d[] comes back as squared distances.
function envelope(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

const scaled = (mask) => Number.isFinite(mask?.mmPerPx) && mask.mmPerPx > 0;

// Foreground bbox, centroid, and pixel count — null when there is nothing to score.
function stats(mask) {
  const data = mask?.data, w = mask?.width | 0, h = mask?.height | 0;
  if (!data || !(w > 0) || !(h > 0) || data.length < w * h) return null;
  let c0 = w, c1 = -1, r0 = h, r1 = -1, n = 0, sc = 0, sr = 0;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    if (!data[r * w + c]) continue;
    n++; sc += c; sr += r;
    if (c < c0) c0 = c;
    if (c > c1) c1 = c;
    if (r < r0) r0 = r;
    if (r > r1) r1 = r;
  }
  return n ? { data, w, h, c0, c1, r0, r1, cx: sc / n, cy: sr / n, count: n } : null;
}

// Crop to the bbox, scale the longer side to FILL*S, centroid-align into the S² frame,
// nearest-neighbour. Sampling is done backwards from the output so the two masks share
// one mapping form and identical shapes at different scales land on identical pixels.
//
// The scale is bbox-derived while the alignment is centroid-derived, so a shape whose
// centroid sits far from its bbox centre (an L) would run past the frame edge and be
// silently clipped. The guard shrinks such a shape to fit; it is a function of the
// shape's own proportions, so two copies of it at different scales still normalize
// identically and still score 1.
function normalize(st) {
  const bw = st.c1 - st.c0 + 1, bh = st.r1 - st.r0 + 1;
  let s = (FILL * S) / Math.max(bw, bh);
  const reach = Math.max(st.cx - st.c0, st.c1 - st.cx, st.cy - st.r0, st.r1 - st.cy) + 0.5;
  const room = (S - 2) / 2;
  if (reach * s > room) s = room / reach;

  const mid = (S - 1) / 2;
  const data = new Uint8Array(S * S);
  for (let R = 0; R < S; R++) {
    const r = Math.round((R - mid) / s + st.cy);
    if (r < st.r0 || r > st.r1) continue;
    for (let C = 0; C < S; C++) {
      const c = Math.round((C - mid) / s + st.cx);
      if (c < st.c0 || c > st.c1) continue;
      if (st.data[r * st.w + c]) data[R * S + C] = 1;
    }
  }
  return { data, width: S, height: S, bw: bw * s, bh: bh * s };
}

// Both masks resampled onto ONE grid at the reference's mmPerPx, centroid-aligned and
// never rescaled — the frame where absolute size is the question. Sized to hold both, so
// an oversized candidate is measured rather than cropped by the reference's own extent.
// Returns the two masks and the grid's pitch in mm/px, which is the reference's own
// except when a wildly oversized candidate would need a frame past MAX_MM_FRAME: then the
// grid COARSENS rather than crops, since a truncated union would flatter the candidate.
function mmFrame(cs, cmm, rs, rmm) {
  // Half-extents in mm from each mask's own centroid, unioned so neither is cropped.
  const span = (st, mm) => [
    (st.cx - st.c0) * mm + mm / 2, (st.c1 - st.cx) * mm + mm / 2,
    (st.cy - st.r0) * mm + mm / 2, (st.r1 - st.cy) * mm + mm / 2,
  ];
  const other = span(rs, rmm);
  const [left, right, up, down] = span(cs, cmm).map((v, i) => Math.max(v, other[i]));

  const longest = Math.max(left + right, up + down);
  const p = Math.max(rmm, longest / MAX_MM_FRAME);
  const gx = Math.ceil(left / p) + 1, gy = Math.ceil(up / p) + 1;
  const width = gx + Math.ceil(right / p) + 2, height = gy + Math.ceil(down / p) + 2;

  const draw = (st, mm) => {
    const data = new Uint8Array(width * height);
    for (let R = 0; R < height; R++) {
      const r = Math.round(((R - gy) * p) / mm + st.cy);
      if (r < st.r0 || r > st.r1) continue;
      for (let C = 0; C < width; C++) {
        const c = Math.round(((C - gx) * p) / mm + st.cx);
        if (c < st.c0 || c > st.c1) continue;
        if (st.data[r * st.w + c]) data[R * width + C] = 1;
      }
    }
    return { data, width, height };
  };
  return [draw(cs, cmm), draw(rs, rmm), p];
}

function maskIoU(a, b) {
  let inter = 0, union = 0;
  for (let i = 0; i < a.data.length; i++) {
    const x = a.data[i], y = b.data[i];
    if (x && y) inter++;
    if (x || y) union++;
  }
  return union ? inter / union : 0;
}

// Boundary IoU's band: the mask minus its own erosion by BAND_PX. Erosion by a disk is
// the distance transform of the background, so the band is "foreground within BAND_PX of
// some background pixel".
function band(m) {
  const inv = new Uint8Array(m.data.length);
  for (let i = 0; i < inv.length; i++) inv[i] = m.data[i] ? 0 : 1;
  const dt = distanceTransform(inv, m.width, m.height);
  const data = new Uint8Array(m.data.length);
  for (let i = 0; i < data.length; i++) if (m.data[i] && dt[i] <= BAND_PX) data[i] = 1;
  return { data, width: m.width, height: m.height };
}

// Contour = foreground with at least one background 4-neighbour; outside the image counts
// as background, so a shape flush with the edge still has one.
function contour(m) {
  const { data, width, height } = m;
  const out = new Uint8Array(data.length);
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) {
    const i = r * width + c;
    if (!data[i]) continue;
    if (r === 0 || r === height - 1 || c === 0 || c === width - 1
      || !data[i - width] || !data[i + width] || !data[i - 1] || !data[i + 1]) out[i] = 1;
  }
  return out;
}

// Symmetric mean contour separation in px: mean distance from each mask's contour to the
// other's, averaged both directions so neither shape's rim length dominates.
function contourDistance(a, b) {
  const ca = contour(a), cb = contour(b);
  const da = distanceTransform(ca, a.width, a.height);
  const db = distanceTransform(cb, b.width, b.height);
  const mean = (pts, dt) => {
    let n = 0, sum = 0;
    for (let i = 0; i < pts.length; i++) if (pts[i]) { n++; sum += dt[i]; }
    return n ? sum / n : 0;
  };
  return (mean(cb, da) + mean(ca, db)) / 2;
}

// 0 = background, 1 = overlap, 2 = missing (reference only), 3 = excess (candidate only).
function deltaMap(c, r) {
  const data = new Uint8Array(c.data.length);
  for (let i = 0; i < data.length; i++) {
    const inC = c.data[i], inR = r.data[i];
    data[i] = inC && inR ? 1 : inR ? 2 : inC ? 3 : 0;
  }
  return { width: c.width, height: c.height, data };
}
