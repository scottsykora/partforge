// The geometry Web Worker's import closure is a layering boundary, and until now it
// was held only by discipline. Nothing statically reachable from src/framework/worker.js
// may touch the DOM, three.js, or Node — the worker has no `document`, no `window`, and
// no `node:fs`. A contributor who imports tooltip.js into jobs.js for one convenient
// helper passes every other test in this suite and only explodes at worker runtime with
// "document is not defined", inside a WASM-booting worker, with no stack worth reading.
// So walk the graph and assert it.
//
// This is also what keeps the src/framework/oracle/ vs src/testing/ split honest: the
// oracle (measure/verify/build/BVH) runs inside this worker for the `inspect` job, while
// src/testing/ boots kernels from disk and writes PNGs. If someone moves a Node-only
// helper back under the oracle, the `node:` check below names the chain.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { walk, chainTo } from "./helpers/import-graph.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const ENTRY = `${ROOT}/src/framework/worker.js`;

// three.js is the viewer's dependency and drags in DOM assumptions; the rest are the
// Node builtins that a headless-harness module would bring along. Bare builtin names
// are listed alongside the `node:` prefix because both forms resolve in Node.
const BANNED_PACKAGES = ["three"];
const NODE_BUILTINS = ["fs", "path", "url", "module", "os", "crypto", "child_process", "worker_threads", "process", "util", "stream", "zlib"];

// Main-thread-only globals. `self`, `globalThis`, and `fetch` all exist in a worker and
// are deliberately absent from this list.
const DOM_GLOBALS = ["document", "window", "localStorage", "sessionStorage", "HTMLElement", "customElements"];

// Same comment-stripping rule the walker uses: this codebase explains WHY in prose, and
// that prose mentions `document` when describing what a module must not do.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const graph = () => walk(ENTRY, "worker-layering walk");

test("the worker import closure reaches no Node builtin", () => {
  const { bare, importer } = graph();
  for (const spec of bare) {
    const name = spec.replace(/^node:/, "").split("/")[0];
    const isBuiltin = spec.startsWith("node:") || NODE_BUILTINS.includes(name);
    expect(isBuiltin, isBuiltin
      ? `the geometry worker must not import the Node builtin "${spec}":\n  ${chainTo(spec, importer, ROOT)}`
      : "").toBe(false);
  }
});

test("the worker import closure reaches no DOM-bound package", () => {
  const { bare, importer } = graph();
  for (const banned of BANNED_PACKAGES) {
    expect(bare.has(banned), bare.has(banned)
      ? `the geometry worker must not import "${banned}":\n  ${chainTo(banned, importer, ROOT)}`
      : "").toBe(false);
  }
});

test("no module in the worker closure touches a main-thread-only global", () => {
  const { files, importer } = graph();
  for (const file of files) {
    const src = stripComments(readFileSync(file, "utf8"));
    const hit = DOM_GLOBALS.find((g) => new RegExp(`\\b${g}\\b`).test(src));
    expect(hit == null, hit
      ? `the geometry worker has no \`${hit}\` — this module cannot be in its import closure:\n  ${chainTo(file, importer, ROOT)}`
      : "").toBe(true);
  }
});

test("the worker import closure reaches nothing under src/testing/", () => {
  // src/testing/ is the Node-only harness (kernel booters, the PNG renderer, the
  // ERROR-PATTERNS reader). The worker-reachable oracle lives in src/framework/oracle/.
  const { files, importer } = graph();
  for (const file of files) {
    const inTesting = file.startsWith(`${ROOT}/src/testing/`);
    expect(inTesting, inTesting
      ? `src/testing/ is the Node-only harness; the geometry worker must not reach it:\n  ${chainTo(file, importer, ROOT)}`
      : "").toBe(false);
  }
});
