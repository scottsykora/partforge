// A tiny static import-graph walker shared by the layering guards
// (lint-purity.test.js, worker-layering.test.js). Regex over source text on
// purpose: these guards must have zero dependencies of their own, or the thing
// they police could sneak in through their own toolchain.
//
// Not a general ESM resolver — it only understands relative specifiers (which it
// resolves the way Vite/Node would) and records everything else as a bare
// specifier for the caller to judge.
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Collect every static import specifier in a module — including side-effect-only
// imports (`import "three";`), which have no `from` clause and so are invisible to
// the first pattern below. Dynamic `import("…")` with a literal specifier counts
// too: Vite splits it into its own chunk, but that chunk still ships with, and
// runs inside, the importing bundle. Order doesn't risk double-counting: a
// specifier with `from` never matches the side-effect pattern (it requires a quote
// immediately after `import`), and vice versa.
//
// `eager: true` drops the dynamic-import pattern: the walk then covers only what
// the module loader evaluates at import time — the boot-cost graph — which is what
// the worker's oracle-laziness guard measures. The layering guards keep the
// default (full) walk: a lazily-loaded chunk still runs inside the worker, so it
// must obey the same DOM/Node bans.
export const importsOf = (rawSrc, { eager = false } = {}) => {
  const src = stripComments(rawSrc);
  const specs = [...src.matchAll(/^\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1])
    .concat([...src.matchAll(/^\s*import\s*["']([^"']+)["']/gm)].map((m) => m[1]));
  if (eager) return specs;
  return specs.concat([...src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]));
};

// Comments must go first, or prose about imports becomes an import. This house
// style explains WHY in comments, so `import('./x.ttf')` appears in fonts.js's
// header as an example and would otherwise blow up the walker. The `[^:]` guard
// keeps a `//` inside a `https://` literal from eating the rest of the line.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

// Resolve a relative specifier the way Vite/Node ESM resolution would for an
// extensionless import: exact path, then `.js`, then `/index.js`.
function resolveRelative(path) {
  if (existsSync(path)) return path;
  if (existsSync(`${path}.js`)) return `${path}.js`;
  if (existsSync(`${path}/index.js`)) return `${path}/index.js`;
  return null;
}

// Walk the static import closure of `entry`.
// Returns { files, bare, importer } where `importer` maps each discovered
// file/bare specifier to the file that first pulled it in — enough to reconstruct
// the chain that a guard needs to name in its failure message.
export function walk(entry, label = "import walk", { eager = false } = {}) {
  const seen = new Set();
  const bare = new Set();
  const importer = new Map();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(readFileSync(file, "utf8"), { eager })) {
      if (spec.startsWith(".")) {
        const next = resolveRelative(resolve(dirname(file), spec));
        // An unresolvable relative import must never be silently dropped — Vite
        // resolves extensionless specifiers fine at runtime, so a `continue` here
        // would let an entire unexamined subtree (and whatever it imports) pass
        // the check for free. Fail loudly instead: this walker exists to catch
        // exactly this class of drift, so it must itself be trustworthy.
        if (!next) {
          throw new Error(`${label}: cannot resolve "${spec}" imported from ${file} (tried the exact path, "${spec}.js", and "${spec}/index.js")`);
        }
        if (!importer.has(next)) importer.set(next, file);
        queue.push(next);
      } else {
        if (!importer.has(spec)) importer.set(spec, file);
        bare.add(spec);
      }
    }
  }
  return { files: seen, bare, importer };
}

// Reconstruct entry → … → target as a readable arrow chain of paths relative to
// `root`. `importer` records the FIRST module that pulled each file in, so this is
// one real chain, not necessarily the shortest one.
export function chainTo(target, importer, root) {
  const rel = (p) => (p.startsWith(root) ? p.slice(root.length + 1) : p);
  const chain = [target];
  const guard = new Set(chain);
  let cur = importer.get(target);
  while (cur && !guard.has(cur)) {
    chain.unshift(cur);
    guard.add(cur);
    cur = importer.get(cur);
  }
  return chain.map(rel).join("\n  → ");
}
