// Test-only setup: patches a happy-dom bug where Node.prototype.nodeName returns
// "" for all nodes, causing DOMPurify to strip every element as "unknown".
//
// DOMPurify caches Node.prototype.nodeName to resist DOM-clobbering attacks.
// happy-dom puts the correct nodeName implementation on Element.prototype but
// leaves Node.prototype.nodeName returning "" for all nodes. This patch fixes
// the getter so DOMPurify sees correct tag names.
//
// Guards:
//   1. No-op when document is not defined (plain-Node / WASM test files).
//   2. Only patches when the getter is actually broken (probe returns "").
//      In real browsers and fixed versions of happy-dom this is a safe no-op.
if (typeof document !== "undefined") {
  const nodeDesc = Object.getOwnPropertyDescriptor(Node.prototype, "nodeName");
  const elemDesc = Object.getOwnPropertyDescriptor(Element.prototype, "nodeName");
  if (nodeDesc?.get && elemDesc?.get) {
    if (nodeDesc.get.call(document.createElement("span")) === "") {
      const origGet = nodeDesc.get;
      const elemGet = elemDesc.get;
      // nodeType constants (per DOM spec)
      const NODE_NAMES = { 3: "#text", 7: "#pi", 8: "#comment", 9: "#document", 10: "#doctype", 11: "#document-fragment" };
      Object.defineProperty(Node.prototype, "nodeName", {
        get() {
          if (this instanceof Element) return elemGet.call(this);
          const raw = origGet.call(this);
          if (raw !== "") return raw;
          return NODE_NAMES[this.nodeType] ?? "#unknown";
        },
        configurable: true,
      });
    }
  }
}

// happy-dom does not implement the Pointer Capture API. The rail's drag path
// calls setPointerCapture/releasePointerCapture (never hasPointerCapture), so
// stub only those to no-ops — this makes the pointer path EXERCISED, not
// proven. Proof lives in scripts/check-app.mjs, which drags for real in
// Chromium (no headless DOM models an iframe consuming pointer events).
if (typeof Element !== "undefined") {
  Element.prototype.setPointerCapture ??= function () {};
  Element.prototype.releasePointerCapture ??= function () {};
}

// paper-core creates a canvas and asks for a 2D context at MODULE LOAD time.
// happy-dom HAS a getContext (unlike the "absent" case this comment first
// assumed) but it always returns null — there is no canvas backend — so the
// call throws before any test importing paper runs its first line. Geometry
// never touches the raster context — paper only wants it to construct a
// CanvasView — so a no-op stub is enough, and it keeps ingest tests on a
// plain static import. Because happy-dom's getContext already exists (it's
// the return value, not the method, that's missing), the fix overwrites it
// unconditionally rather than guarding on its absence. Real browsers have a
// real context and never reach this.
//
// This overwrite is GLOBAL — every HTMLCanvasElement in every happy-dom test
// gets a truthy ctx now, not just paper's. Several framework modules
// (cube-canvas.js, ink-canvas.js) previously relied on happy-dom's null
// return to take an early "nothing to draw here" exit; with a truthy stub
// they instead run their real draw path against it. So the stub must cover
// every 2D method any of those callers actually invoke, not just what paper
// needs — an incomplete stub traded "getContext throws" for "ctx.fillText is
// not a function" deeper in cube-canvas.js/dim3-scene.js. All of it is still
// a no-op: nothing here ever asserts on pixels.
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = () => ({
    save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    bezierCurveTo() {}, quadraticCurveTo() {}, arc() {}, rect() {}, fill() {}, stroke() {},
    clip() {}, translate() {}, scale() {}, rotate() {}, transform() {}, setTransform() {},
    clearRect() {}, fillRect() {}, strokeRect() {}, setLineDash() {},
    fillText() {}, strokeText() {},
    measureText: () => ({ width: 0 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4), width: w, height: h }),
    putImageData() {}, drawImage() {}, isPointInPath: () => false,
    createLinearGradient: () => ({ addColorStop() {} }),
    canvas: { width: 1, height: 1 },
  });
}
