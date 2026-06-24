# partforge

Turn a declarative **part definition** into a full parametric-CAD web app — a 3-D
viewer, a control panel, geometry workers, and STL / STEP / 3MF export. You write one
script (geometry build functions + a parameter schema); partforge renders the app.

Two geometry backends run in Web Workers: [Manifold](https://github.com/elalish/manifold)
for fast preview meshes + STL/3MF, and [Replicad](https://replicad.xyz)
(OpenCASCADE-in-WebAssembly) for exact STEP export. The viewer is [three.js](https://threejs.org).

> **Requires a Vite-based app.** partforge is published as plain ESM source and relies
> on Vite's worker / WASM / CSS import handling.

## Install

```bash
npm install partforge
```

## Use

```js
// app.js
import { mount } from "partforge";
import part from "./parts/my-part.js";
mount(part, {
  createWorker: (name) =>
    new Worker(new URL("./part-worker.js", import.meta.url), { type: "module", name }),
});

// part-worker.js
import { runWorker } from "partforge/worker";
import part from "./parts/my-part.js";
runWorker(part);
```

Test your parts headlessly with `partforge/testing`
(`createManifoldKernel`, `handle`, `assemblyOverlaps`, `bootOcctKernel`, `meshVolume`, `bboxSize`).

**Smoke-test that an app actually boots** (real Chromium, real worker/WASM): `npm run check`
(or `node scripts/check-app.mjs <entry>.html`) — it loads the app and verifies the kernel
boots with no errors. Needs Playwright: `npm i -D playwright && npx playwright install chromium`.

## Authoring guide

**[docs/AUTHORING-PARTS.md](docs/AUTHORING-PARTS.md)** is the full guide — the part
contract, the geometry kernel API, the parameter schema, app wiring, testing, and
gotchas. See **Designing the control panel** in that guide for how to write descriptions,
hide internal params, and keep the interface simple while staying deeply adjustable.
`src/parts/demo.js` is a minimal worked example; run `npm run dev` and open
`/demo.html` to see it live.

## License

MIT
