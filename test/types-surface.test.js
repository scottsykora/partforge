// The shipped .d.ts files are a SECOND statement of a contract whose first
// statement is the running code — and a declaration that has drifted from
// runtime is worse than none, because a consumer's compiler will vouch for the
// wrong thing. `npm run typecheck` proves the declarations are internally
// consistent; nothing there can notice that `src/testing.js` grew an export.
// This file closes that gap the way test/kernel-contract.test.js and
// test/worker-layering.test.js close theirs: by holding the prose (here, the
// types) to the data.
//
// Four invariants:
//   1. package.json actually WIRES and SHIPS the declarations.
//   2. Every entry's declared value exports == its runtime exports, exactly.
//   3. The kernel interfaces == the op lists in geometry/kernel.js.
//   4. The verify/DFM vocabularies == the registries they mirror.
//
// The .d.ts scanner below is deliberately small and format-sensitive: it reads
// only files in types/, which this repo owns and formats one member per line.
// If it ever stops recognising a declaration, that is a signal to keep the
// declarations plain, not to make the scanner cleverer.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import {
  KERNEL_OPS, KERNEL_OPTIONAL_OPS, OCCT_ONLY_OPS,
  SHAPE2D_OPS, SOLID_OPS, SOLID_OPTIONAL_OPS,
} from "../src/framework/geometry/kernel.js";
import { SUBPART_METRICS, VIEW_METRICS } from "../src/framework/verify-metrics.js";
import { PROFILES } from "../src/framework/oracle/dfm-profiles.js";
import { CANONICAL_VIEWS } from "../src/framework/view-angles.js";

// Vitest runs from the project root.
//
// This file stays on the default NODE environment on purpose. `src/testing.js`
// reaches paper.js, which probes for a DOM at import time and then demands a
// real 2-D canvas context — under happy-dom that throws before a single export
// name can be read. Importing the DOM entries (mount, the viewer) is fine here:
// nothing they do at module scope touches `document`.
const ROOT = `${resolve(process.cwd())}/`;
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");
const pkg = JSON.parse(read("package.json"));

// Runtime modules behind each exports subpath, as STATIC specifiers so Vite can
// resolve them. Not derived from package.json — but the first test below asserts
// this table's keys are exactly the map's JS subpaths, so a new subpath fails
// here until it is added, which is the same protection with none of the
// dynamic-import fragility.
const RUNTIME = {
  ".": () => import("../src/index.js"),
  "./worker": () => import("../src/framework/worker.js"),
  "./geometry": () => import("../src/framework/geometry/polygon.js"),
  "./lint": () => import("../src/lint.js"),
  "./derive": () => import("../src/framework/derive.js"),
  "./testing": () => import("../src/testing.js"),
};

// Same comment-stripping rule the import-graph walker uses: this codebase
// explains WHY in prose, and that prose names the very identifiers we scan for.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

// --- a very small .d.ts scanner --------------------------------------------

// Value (runtime) exports declared by a .d.ts, following `export * from` into
// sibling declaration files. Type-only exports (`export type`, `interface`,
// `export type { … }`) are deliberately excluded — they have no runtime twin.
function declaredValueExports(rel, seen = new Set()) {
  if (seen.has(rel)) return new Set();
  seen.add(rel);
  const src = stripComments(read(rel));
  const out = new Set();
  for (const m of src.matchAll(/^export\s+(?:declare\s+)?(?:function|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
    out.add(m[1]); // overloads repeat a name; a Set folds them
  }
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const spec of m[1].split(",")) {
      const name = spec.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && !name.startsWith("type ")) out.add(name);
    }
  }
  const dir = rel.slice(0, rel.lastIndexOf("/") + 1);
  for (const m of src.matchAll(/^export\s+\*\s+from\s+"(\.[^"]+)"/gm)) {
    for (const n of declaredValueExports(dir + m[1].replace(/\.js$/, ".d.ts"), seen)) out.add(n);
  }
  return out;
}

// Member names of `export interface <name> { … }`, with the optional ones
// (`foo?(…)` / `foo?: …`) reported separately. Only depth-1 lines count, so a
// nested inline object type contributes nothing.
function interfaceMembers(rel, name) {
  const src = stripComments(read(rel));
  const start = src.search(new RegExp(`^export interface ${name}\\b[^{]*\\{`, "m"));
  expect(start, `types/${rel} declares no interface ${name}`).toBeGreaterThanOrEqual(0);
  const lines = src.slice(src.indexOf("{", start) + 1).split("\n");
  const all = new Set();
  const optional = new Set();
  let depth = 1;
  for (const line of lines) {
    if (depth === 1) {
      const m = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\??)\s*[(:<]/.exec(line);
      if (m) { all.add(m[1]); if (m[2]) optional.add(m[1]); }
    }
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth === 0) break;
  }
  return { all, optional };
}

// The string members of `export type <name> = "a" | "b" | …;`.
function unionMembers(rel, name) {
  const src = stripComments(read(rel));
  const m = new RegExp(`^export type ${name}\\s*=([^;]+);`, "m").exec(src);
  expect(m, `types/${rel} declares no type ${name}`).not.toBeNull();
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((q) => q[1]));
}

const sorted = (it) => [...it].sort();

// Every JS subpath in the exports map, paired with its declaration file.
const jsEntries = Object.entries(pkg.exports)
  .filter(([, t]) => typeof t === "object")
  .map(([subpath, t]) => ({ subpath, runtime: t.default, decl: t.types.replace(/^\.\//, "") }));

// --- 1. package.json wiring -------------------------------------------------

describe("package.json ships and wires the declarations", () => {
  test("`files` includes types/, so npm pack publishes them", () => {
    expect(pkg.files).toContain("types");
  });

  test("the root `types` field points at an existing declaration", () => {
    expect(pkg.types).toBe("./types/index.d.ts");
    expect(() => read(pkg.types)).not.toThrow();
  });

  test("every JS subpath carries a `types` condition, listed first", () => {
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (typeof target === "string") {
        // Only the stylesheets may stay bare — CSS has nothing to declare.
        expect(target, `exports["${subpath}"] is a bare string`).toMatch(/\.css$/);
        continue;
      }
      expect(Object.keys(target), `exports["${subpath}"]`).toEqual(["types", "default"]);
      expect(() => read(target.types), `exports["${subpath}"].types is missing`).not.toThrow();
      expect(target.default).toMatch(/^\.\/src\/.*\.js$/);
    }
  });

  test("the root subpath's declaration is the one the `types` field names", () => {
    expect(pkg.exports["."].types).toBe(pkg.types);
  });

  test("`typesVersions` covers every non-root subpath, for legacy resolution", () => {
    // A consumer on the classic `moduleResolution: "node"` never reads the
    // exports map's `types` condition. The root entry is covered by the `types`
    // field above; every other subpath needs a typesVersions mapping or it
    // resolves to `any` there.
    const mapped = pkg.typesVersions?.["*"] ?? {};
    const want = jsEntries.map((e) => e.subpath).filter((s) => s !== ".").map((s) => s.replace(/^\.\//, ""));
    expect(sorted(Object.keys(mapped))).toEqual(sorted(want));
    for (const [key, targets] of Object.entries(mapped)) {
      expect(targets, `typesVersions["*"]["${key}"]`).toEqual([pkg.exports[`./${key}`].types]);
    }
  });
});

// --- 2. declared exports == runtime exports ---------------------------------

describe("declared value exports match the runtime module, exactly", () => {
  test("every JS subpath has an entry in this file's RUNTIME table", () => {
    expect(sorted(Object.keys(RUNTIME))).toEqual(sorted(jsEntries.map((e) => e.subpath)));
  });

  test.each(jsEntries)("partforge$subpath", async ({ subpath, runtime, decl }) => {
    const mod = await RUNTIME[subpath]();
    const runtimeNames = sorted(Object.keys(mod).filter((n) => n !== "default"));
    const declaredNames = sorted(declaredValueExports(decl));
    expect(declaredNames, [
      `partforge${subpath === "." ? "" : subpath} declares a surface that has drifted from ${runtime}.`,
      `Update ${decl} (add or remove the declaration), or the export it mirrors.`,
    ].join("\n")).toEqual(runtimeNames);
  });
});

// --- 3. the kernel interfaces == the op lists -------------------------------

describe("the kernel declarations cover the contract's op lists", () => {
  test("GeometryKernel declares exactly KERNEL_OPS + KERNEL_OPTIONAL_OPS", () => {
    const { all, optional } = interfaceMembers("types/kernel.d.ts", "GeometryKernel");
    expect(sorted(all)).toEqual(sorted([...KERNEL_OPS, ...KERNEL_OPTIONAL_OPS]));
    // A backend may omit the optional ops entirely (jobs.js calls them via `?.`),
    // so they must be declared optional — and the required ones must not be.
    expect(sorted(optional)).toEqual(sorted(KERNEL_OPTIONAL_OPS));
  });

  test("Solid declares exactly SOLID_OPS + SOLID_OPTIONAL_OPS", () => {
    const { all, optional } = interfaceMembers("types/kernel.d.ts", "Solid");
    expect(sorted(all)).toEqual(sorted([...SOLID_OPS, ...SOLID_OPTIONAL_OPS]));
    expect(sorted(optional)).toEqual(sorted(SOLID_OPTIONAL_OPS));
  });

  test("Shape2D declares exactly SHAPE2D_OPS", () => {
    const { all, optional } = interfaceMembers("types/kernel.d.ts", "Shape2D");
    expect(sorted(all)).toEqual(sorted(SHAPE2D_OPS));
    expect([...optional]).toEqual([]);
  });

  test("the OCCT-only ops are declared on Solid (they are real, just unimplemented on Manifold)", () => {
    const { all } = interfaceMembers("types/kernel.d.ts", "Solid");
    for (const op of OCCT_ONLY_OPS) expect(all.has(op), `Solid.${op}`).toBe(true);
  });
});

// --- 4. the verify / DFM / view vocabularies --------------------------------

describe("the verify declarations mirror the metric registries", () => {
  test("SubPartExpectations declares exactly SUBPART_METRICS", () => {
    const { all } = interfaceMembers("types/part.d.ts", "SubPartExpectations");
    expect(sorted(all)).toEqual(sorted(Object.keys(SUBPART_METRICS)));
  });

  test("ViewExpectations declares VIEW_METRICS plus the two pair-wise keys", () => {
    const { all } = interfaceMembers("types/part.d.ts", "ViewExpectations");
    // contacts/clearance are per-pair, so verify.js peels them off before the
    // scalar registry loop — they are real `_view` keys with no registry entry.
    expect(sorted(all)).toEqual(sorted([...Object.keys(VIEW_METRICS), "contacts", "clearance"]));
  });

  test("DfmProfileName declares exactly the built-in process profiles", () => {
    expect(sorted(unionMembers("types/part.d.ts", "DfmProfileName"))).toEqual(sorted(Object.keys(PROFILES)));
  });

  test("CanonicalView declares exactly the viewer's canonical angles", () => {
    // Defined in part.d.ts so CameraCue can alias it without an import cycle; the
    // app entry re-exports it through `export * from "./part.js"`.
    expect(sorted(unionMembers("types/part.d.ts", "CanonicalView"))).toEqual(sorted(CANONICAL_VIEWS));
  });

  test("CameraCue is the canonical angle union, not a bare string", () => {
    // lint's animation-camera-invalid rejects anything else, so a bare `string`
    // here would let the declarations accept a cue lint refuses. Asserted on the
    // alias text rather than via unionMembers, which reads literal members only.
    const rhs = /^export type CameraCue\s*=([^;]+);/m.exec(stripComments(read("types/part.d.ts")));
    expect(rhs, "types/part.d.ts declares no type CameraCue").not.toBeNull();
    expect(rhs[1].trim()).toBe("CanonicalView");
  });
});
