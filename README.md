# partforge

**AI-built parametric CAD for 3D printing.** Describe a part to an AI agent and get a
*forge* — a self-contained web app for that one part: a 3-D viewer, a control panel with
just the parameters that matter, and STL / STEP / 3MF export. Share the forge and anyone
can dial in their own version and print it.

A forge isn't a frozen STL. It's open-source code that renders and regenerates the model
live, so the part stays **editable** — resize it for a different bearing, screw, or motor
without relearning a heavy CAD tool — and anyone (or their own agent) can read the source
and extend it.

partforge is the engine behind the forge: a small npm framework that an LLM tuned for tool
use can drive to author, test, and measure a part, then ship it as a browser app.

## See it

- **Live showcase** — https://scottsykora.github.io/partforge/ — example forges (Faceted
  Planter, Spacer, Filleted Box) you can open, adjust, and export.
- **A real forge** — https://scottsykora.github.io/Drum-Machine/ — a parametric capstan
  drum built with partforge for a robotics project.

## Build your own forge

You don't write CAD by hand. Point a tool-using AI agent (Claude Code, or the Claude /
ChatGPT desktop apps with file access) at this repo and describe what you want:

> Using the partforge framework at https://github.com/scottsykora/partforge, build me a
> _\<your part\>_ — _\<the dimensions, fits, and features that matter\>_.

Expect a few turns. The first attempt is often rough, but you refine it in plain language
— "make the bore fit an M3", "add a 2 mm fillet", "thinner walls", "taller by 10" — until
the part is right. You end up with a forge you can host anywhere and hand to anyone.

## How it works

You — or an agent — write one **part definition**: geometry *build functions* plus a
*parameter schema*. partforge renders everything else: the 3-D viewer, the control panel,
the geometry workers, and the export buttons. Each control can carry a description, a
preset, or be hidden, so the interface stays simple while the part stays deeply adjustable.

Two geometry backends run in Web Workers, and partforge routes each part to whichever it
needs:

- **[Manifold](https://github.com/elalish/manifold)** — fast preview meshes and STL / 3MF.
- **[Replicad](https://replicad.xyz)** (OpenCASCADE-in-WebAssembly) — exact B-rep for STEP
  export and native fillet / chamfer.

The viewer is [three.js](https://threejs.org).

Because a part is just code, an agent can build it **and check its own work**: the
`partforge/testing` helpers measure volume and bounding box, probe geometry, detect
self-overlap between sub-parts, and render the model so a multimodal agent can *see* what
it made. A part can also declare a `verify` block — a manufacturing (DFM) profile plus
design-intent assertions — that flags problems like a too-thin wall or a part that won't
fit the print bed before anyone hits export.

> **Requires a Vite-based app.** partforge is published as plain ESM source and relies on
> Vite's worker / WASM / CSS import handling.

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
(`bootManifoldKernel`, `bootOcctKernel`, `assemblyOverlaps`, `measure`, `verify`, `meshVolume`, `bboxSize`).

**Smoke-test that an app actually boots** (real Chromium, real worker/WASM): `npm run check`
(or `node scripts/check-app.mjs <entry>.html`) — it loads the app and verifies the kernel
boots with no errors. Needs Playwright: `npm i -D playwright && npx playwright install chromium`.

### Embedding (0.12.0+)

`mount()` returns a runtime handle and accepts element references, so an
embedding app (React, iframe, multiple mounts) can size, await, and tear down
the viewer without global IDs:

```js
const runtime = mount(part, {
  createWorker,
  elements: {
    viewer, controls,                       // canvas host + param-panel host
    status: { status, busy, phase },        // status chrome
    tabs,                                   // view-tab segmented control
    exports: { stl, step, threeMf },        // export buttons
    chrome: { pause, reframe, theme },      // viewer buttons
  },
  onBuild: ({ status, ms, error }) => {},   // per accepted build: "success" | "error"
  onPick: ({ selection, label, prompt, token }) => {}, // programmatic click-to-select
});
await runtime.ready;   // first successful build (rejects on a first-build error)
runtime.dispose();     // stops loops, workers, observers, listeners; frees GPU resources
```

Every `elements` entry defaults to the legacy global ID (`#app`, `#controls`,
`#status`/`#busy`/`#phase`, `#part`, `#download`/`#download-step`/`#download-3mf`,
`#pause`/`#reframe`/`#theme`), so a classic host page needs no changes. The viewer
sizes from its container via ResizeObserver — no window coupling.

`onPick` arms click-to-select permanently: `label` is the feature label (falling
back to the sub-part label/name) for compact UI, `prompt` is the LLM-ready
sentence, `token` the compact form, `selection` the raw object. When `onPick` is
set, the `?pick` / `?pickserver` URL modes are ignored (one click listener ever
live); hover labels stay always-on.

## Authoring guide

**[docs/AUTHORING-PARTS.md](docs/AUTHORING-PARTS.md)** is the full guide — the part
contract, the geometry kernel API, the parameter schema, app wiring, testing, and gotchas.
See **Designing the control panel** in that guide for how to write descriptions, hide
internal params, and keep the interface simple while staying deeply adjustable.
`src/parts/demo.js` is a minimal worked example; `src/parts/planter.js` is a richer one
(facets, taper, twist, even walls, an optional feature, and a `verify` block).

Locally, `npm run dev` then open `/demo.html`, `/planter.html`, or `/filleted-box.html`.

- **Agent clarification (`request-a-pick`):** an external tool can ask the user to click
  geometry and get the `Selection` back — serve with `?pickserver`, drive with
  `partforge pick-serve` + `partforge pick "<prompt>" …`. See
  `skills/partforge/SKILL.md` and the authoring guide.

## License

MIT
