#!/usr/bin/env node
// Dev-only: run partforge's browser-side SVG ingest headlessly, over the
// happy-dom devDependency, and print the resulting partforge-vector JSON.
//
//   node scripts/ingest-svg.mjs src/parts/assets/emblem.svg > src/parts/assets/emblem.svg.json
//
// This is NOT part of the published package — `partforge/ingest` is browser-side
// by design (see the spec). It exists so repo fixtures are reproducible instead
// of being magic checked-in blobs, and as a worked example for agents.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Window } from "happy-dom";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/ingest-svg.mjs <file.svg> [--strokes ignore]");
  process.exit(2);
}
const strokes = process.argv.includes("--strokes") ? process.argv[process.argv.indexOf("--strokes") + 1] : "outline";

// paper-core builds a canvas and asks for a 2D context at module load; happy-dom
// has no canvas backend, and paper never touches the raster context for geometry.
const window = new Window();
// Node 21+ defines a getter-only `navigator` global of its own, so a plain
// Object.assign throws ("Cannot set property navigator of #<Object> which has
// only a getter") the moment it reaches that key. Define each property
// explicitly instead, overriding whatever accessor Node already installed.
for (const [key, value] of Object.entries({
  window, self: window, document: window.document, navigator: window.navigator,
  DOMParser: window.DOMParser, HTMLCanvasElement: window.HTMLCanvasElement,
  Image: window.Image, SVGElement: window.SVGElement,
})) {
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true, enumerable: true });
}
globalThis.HTMLCanvasElement.prototype.getContext = () => ({
  save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
  bezierCurveTo() {}, quadraticCurveTo() {}, arc() {}, rect() {}, fill() {}, stroke() {},
  clip() {}, translate() {}, scale() {}, rotate() {}, transform() {}, setTransform() {},
  clearRect() {}, fillRect() {}, strokeRect() {}, setLineDash() {},
  measureText: () => ({ width: 0 }),
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  putImageData() {}, drawImage() {}, isPointInPath: () => false,
  createLinearGradient: () => ({ addColorStop() {} }),
  canvas: { width: 1, height: 1 },
});

// Dynamic import: a static one would hoist above the globals above.
const { ingestSvg } = await import("../src/framework/ingest/svg-ingest.js");
const doc = ingestSvg(readFileSync(file, "utf8"), { strokes, source: basename(file) });
process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
