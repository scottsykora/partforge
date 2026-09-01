// A vector document -> a small inline <svg> preview, for the vector control's
// thumbnail. MAIN-THREAD ONLY (it builds DOM), but deliberately free of any
// heavy geometry import: `profile.js` is the one dependency and has no imports
// of its own. Reaching for `vector-format.js`'s expander instead would pull in
// contour-ops -> paper-bridge -> paper.js, ~1 MB of curve engine loaded on every
// page that merely SHOWS a vector control, whether or not anyone drops a file.
//
// `tessellateContour` is the geometry's OWN tessellator, which matters more than
// the saved bytes: a thumbnail that flattened curves its own way could show a
// shape the kernel would not build. Arcs are the specific trap — the format
// writes them as a point ON the arc, while SVG's `A` command wants radii and
// sweep flags, so "just map it to A" is a second interpretation waiting to
// diverge. At thumbnail size a tessellated arc is pixel-identical anyway.
import { tessellateContour } from "../../geometry/profile.js";

// Enough segments that a full circle reads as round at ~44 px, cheap enough that
// a document with hundreds of contours still renders in one frame.
const ARC_SEGS = 24;

const SVG_NS = "http://www.w3.org/2000/svg";

const finite = (n) => typeof n === "number" && Number.isFinite(n);
const finitePoint = (p) => Array.isArray(p) && p.length >= 2 && finite(p[0]) && finite(p[1]);

// The four contour kinds, reduced to a ring of points. The three primitives are
// sugar the format defines by expansion; `toInternalDocument` normally does this,
// but it lives behind the paper.js import described above — and these expansions
// are four lines each, so the thumbnail does them directly rather than paying
// that cost. `path` delegates to the canonical tessellator.
function ring(contour) {
  if (!contour || typeof contour !== "object") return null;
  switch (contour.kind) {
    case "circle": {
      const { center: c, r } = contour;
      if (!finitePoint(c) || !finite(r) || r <= 0) return null;
      return Array.from({ length: ARC_SEGS }, (_, i) => {
        const t = (i / ARC_SEGS) * Math.PI * 2;
        return [c[0] + Math.cos(t) * r, c[1] + Math.sin(t) * r];
      });
    }
    case "rect": {
      const { center: c, width: w, height: h } = contour;
      if (!finitePoint(c) || !finite(w) || !finite(h) || w <= 0 || h <= 0) return null;
      const hw = w / 2, hh = h / 2;
      // Corner radius is ignored: at thumbnail scale the rounding is sub-pixel,
      // and squaring it off never changes what the shape reads as.
      return [[c[0] - hw, c[1] - hh], [c[0] + hw, c[1] - hh], [c[0] + hw, c[1] + hh], [c[0] - hw, c[1] + hh]];
    }
    case "polygon":
      return Array.isArray(contour.points) && contour.points.length >= 3
        && contour.points.every(finitePoint) ? contour.points.map((p) => [p[0], p[1]]) : null;
    case "path":
    default: {
      if (!finitePoint(contour.start) || !Array.isArray(contour.segments)) return null;
      // The FILE format names an arc's midpoint `through`; the internal contour
      // IR names it `via`, and that is what `tessellateContour` reads. A document
      // read off disk or returned by `ingestSvg` therefore speaks `through`, and
      // a segment with neither key is treated as a straight line — so skipping
      // this rename does not fail loudly, it silently replaces every curve with
      // its chord. A circle becomes a triangle, which looks like a rendering bug
      // rather than a parsing one.
      const segments = contour.segments.map((seg) =>
        seg && seg.through && !seg.via ? { ...seg, via: seg.through } : seg);
      const pts = tessellateContour({ ...contour, segments }, ARC_SEGS);
      return Array.isArray(pts) && pts.length >= 3 && pts.every(finitePoint) ? pts : null;
    }
  }
}

// One subpath. Y is negated because the model frame is y-up and SVG is y-down;
// the viewBox is negated to match, so the flip is a coordinate convention rather
// than a transform the caller has to know about.
const subpath = (pts) =>
  `M ${pts.map(([x, y], i) => `${i ? "L " : ""}${+x.toFixed(3)} ${+(-y).toFixed(3)}`).join(" ")} Z`;

/**
 * Render a partforge-vector document as an inline <svg>, or return `null` when
 * there is nothing renderable — an empty document, or one whose coordinates are
 * not finite. Returning null rather than throwing keeps a malformed document
 * from taking the control down with it; the caller falls back to a placeholder.
 */
export function vectorThumb(doc) {
  const shapes = doc?.shapes;
  if (!shapes || typeof shapes !== "object") return null;

  // Every region from every shape lands in ONE path so `evenodd` composes them:
  // a `subtract` shape's regions then cut the shapes they overlap, which is what
  // the document means. The known limitation is that two overlapping regions of
  // the SAME role also cancel — real composition is a boolean the panel has no
  // business running. At preview size that trade is invisible, and a missing hole
  // would be far more misleading than a rare cancelled overlap.
  const subpaths = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const shape of Object.values(shapes)) {
    // A shape is either an array of regions, or `{ role, regions }` — §2.3.
    const regions = Array.isArray(shape) ? shape : shape?.regions;
    if (!Array.isArray(regions)) continue;
    for (const region of regions) {
      for (const contour of [region?.outer, ...(region?.holes ?? [])]) {
        if (contour === undefined) continue;
        const pts = ring(contour);
        if (!pts) return null;   // a bad coordinate anywhere means the preview would lie
        for (const [x, y] of pts) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        subpaths.push(subpath(pts));
      }
    }
  }
  if (!subpaths.length) return null;

  // `bbox` is optional and "recomputed when absent" (§2.1), so a hand-authored
  // document routinely has none. Trusting it when present keeps the preview
  // framed the way the document says it should be; deriving it otherwise is what
  // makes an authored file previewable at all.
  const b = doc.bbox;
  const box = b && [b.minX, b.minY, b.maxX, b.maxY].every(finite)
    ? b : { minX, minY, maxX, maxY };
  const w = box.maxX - box.minX, h = box.maxY - box.minY;
  if (!(w > 0) || !(h > 0)) return null;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `${+box.minX.toFixed(3)} ${+(-box.maxY).toFixed(3)} ${+w.toFixed(3)} ${+h.toFixed(3)}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("aria-hidden", "true");   // decorative; the control carries the label

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", subpaths.join(" "));
  path.setAttribute("fill-rule", "evenodd");
  svg.append(path);
  return svg;
}
