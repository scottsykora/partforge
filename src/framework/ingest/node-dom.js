// src/framework/ingest/node-dom.js
// A headless DOM for the `partforge ingest` CLI verb, promoted from the old
// scripts/ingest-svg.mjs (deleted — see bin/cli.js's `ingest` command).
// paper-core (imported by svg-ingest.js) builds a canvas and asks for a 2D
// context at MODULE LOAD time, so installNodeDom() must run and finish BEFORE
// svg-ingest.js is ever imported — the CLI installs this DOM first and only
// then dynamically imports the converter (registry.js's `convert` thunk for
// the "vector" kind).
//
// happy-dom is an OPTIONAL peer dependency (see package.json): most consumers
// never touch the SVG ingest path, and this keeps its ~17 MB out of their
// installs. It is imported dynamically, HERE, inside installNodeDom() — never
// at this module's top level — so bin/cli.js (and every other CLI verb) keeps
// loading and working when happy-dom isn't installed; the failure only
// surfaces on this path, with a message naming the install command.
//
// stubCanvas2dContext is exported separately from installNodeDom's own DOM
// setup: test/setup/happy-dom-patches.js needs the identical no-op 2D context
// for VITEST's own happy-dom test environment (a wholly different Window than
// the one installNodeDom() constructs here — vitest boots its own). Importing
// this one function from both places is what replaces what used to be two
// independently hand-typed copies of the same stub.
export function stubCanvas2dContext() {
  return {
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
  };
}

// Installs a headless DOM as globals, for a plain Node process (the CLI) that
// otherwise has none. Idempotent enough for the CLI's one-shot use — it is not
// meant to be called more than once per process.
export async function installNodeDom() {
  let Window;
  try {
    ({ Window } = await import("happy-dom"));
  } catch {
    throw new Error(
      "ingest: converting SVG headlessly needs happy-dom (an optional peer dependency) — " +
      "install it with `npm install happy-dom`",
    );
  }
  const window = new Window();
  // Node 21+ defines a getter-only `navigator` global of its own, so a plain
  // Object.assign throws ("Cannot set property navigator of #<Object> which
  // has only a getter") the moment it reaches that key. Define each property
  // explicitly instead, overriding whatever accessor Node already installed.
  for (const [key, value] of Object.entries({
    window, self: window, document: window.document, navigator: window.navigator,
    DOMParser: window.DOMParser, HTMLCanvasElement: window.HTMLCanvasElement,
    Image: window.Image, SVGElement: window.SVGElement,
  })) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true, enumerable: true });
  }
  // paper-core builds a canvas and asks for a 2D context at module load;
  // happy-dom has no canvas backend, and paper never touches the raster
  // context for geometry (see svg-ingest.js's own header for why a no-op
  // stub is enough).
  globalThis.HTMLCanvasElement.prototype.getContext = stubCanvas2dContext;
}
