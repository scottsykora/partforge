// Dimensioned captures: composite the measurement overlay onto a captured
// frame. Serialized SVG carries no stylesheet, so computed styles are inlined
// as presentation attributes first. Fonts do not travel into rasterized SVG
// either — composited captures fall back through the --pf-mono stack
// (ui-monospace instead of Geist Mono); embedding a WOFF subset is the
// upgrade path if that grates.
const STYLE_PROPS = [
  "stroke", "stroke-width", "stroke-linejoin", "stroke-linecap", "fill",
  "opacity", "font-family", "font-size", "font-weight", "letter-spacing",
  "paint-order", "text-anchor", "dominant-baseline",
];

export function inlineOverlayStyles(svg) {
  const clone = svg.cloneNode(true);
  const walk = (orig, copy) => {
    if (orig.nodeType === 1) {
      const cs = getComputedStyle(orig);
      for (const prop of STYLE_PROPS) {
        const v = cs.getPropertyValue(prop);
        if (v && v !== "none" && v !== "normal" && v !== "auto") copy.setAttribute(prop, v);
      }
    }
    for (let i = 0; i < orig.children.length; i++) walk(orig.children[i], copy.children[i]);
  };
  walk(svg, clone);
  return clone;
}

export function overlaySvgString(svg, { width, height }) {
  const clone = inlineOverlayStyles(svg);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.removeAttribute("hidden");
  return new XMLSerializer().serializeToString(clone);
}

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error("capture-overlay: image failed to decode"));
  img.src = src;
});

// frameDataUrl: viewer.captureCurrent()'s output. svgString: overlaySvgString().
export async function compositeOverlay(frameDataUrl, svgString, { width, height }) {
  const [frame, dims] = await Promise.all([
    loadImage(frameDataUrl),
    loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`),
  ]);
  const canvas = document.createElement("canvas");
  canvas.width = frame.naturalWidth;
  canvas.height = frame.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(frame, 0, 0);
  // the overlay is laid out in CSS pixels; scale it to the frame's resolution
  ctx.drawImage(dims, 0, 0, width, height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}
