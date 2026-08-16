// A part that declares a named font and renders text with it — the regression rig
// for the CLI fonts plumbing. The browser worker preloads `part.fonts` into the
// kernel before building (jobs.js); the CLI's bootKernel must do the same, or a
// part like this builds fine in the app but crashes under `partforge measure` /
// `render` with the misleading `text2d: unknown font "heading"`.
import { readFileSync } from "node:fs";

export default {
  meta: { title: "FontRig", units: "mm" },
  defaults: {},
  fonts: {
    // A thunk returning bytes — reuses the vendored default font as a *named*
    // font so the fixture adds no binary to the repo. (A test-only fixture, so
    // the node:fs import is fine; real parts pass a URL or bundled bytes.)
    heading: () => readFileSync(new URL("../../src/framework/geometry/fonts/Roboto-Regular.ttf", import.meta.url)),
  },
  parts: {
    text: {
      views: ["v"],
      build: (k) => k.extrude({ profile: k.text2d("Hi", { font: "heading", size: 10 }), h: 2 }),
    },
  },
  views: { v: { label: "V" } },
};
