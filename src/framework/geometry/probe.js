// Geometry-free build execution. Two consumers share one Proxy implementation:
//
//  • createProbeKernel() — records op NAMES so detectBackend() can route a part to
//    OCCT when it uses fillet/chamfer/shell.
//  • createValidatingProbe() — additionally checks op names against the kernel
//    contract's op lists and routes options-form calls through the same op-options
//    normalizers the real backends use, so partforge/lint can catch a bad call in
//    microseconds instead of after a WASM boot.
//
// Catch-all proxies (rather than a hand-listed allowlist) mean new kernel/solid
// methods never have to be mirrored here — the probe can't drift out of sync with
// the real backends. (That drift previously broke the panel's relevance dimming
// when the build-step vocabulary was added but not taught to the probe.) The
// validating probe DOES need an allowlist, so it takes one from kernel.js's op
// lists, which test/kernel-contract.test.js pins to both backend implementations.
import {
  OCCT_ONLY_OPS, KERNEL_OPS, KERNEL_OPTIONAL_OPS,
  SOLID_OPS, SOLID_OPTIONAL_OPS, SHAPE2D_OPS,
} from "./kernel.js";
import { KERNEL_OP_SPECS, SOLID_OP_SPECS, isPlainOptions } from "./op-options.js";
import { resolveDerived } from "../derive.js";

const OCCT_ONLY = new Set(OCCT_ONLY_OPS);

// The probe returns ONE chainable handle for every non-query op, so it cannot tell a
// Solid from a Shape2D — k.box() and k.shape2d() yield the same object. The solid-scope
// allowlist is therefore the union of all three surfaces: deliberately permissive, so
// it never false-positives on an error-severity rule.
const KERNEL_ALLOWED = new Set([...KERNEL_OPS, ...KERNEL_OPTIONAL_OPS]);
const SOLID_ALLOWED = new Set([...SOLID_OPS, ...SOLID_OPTIONAL_OPS, ...SHAPE2D_OPS]);

export const MAX_PROBE_OPS = 100000;

// Thrown to unwind a runaway build. Never escapes runValidatingProbe.
export class ProbeRunawayError extends Error {
  constructor(message) { super(message); this.name = "ProbeRunawayError"; }
}

// Shared proxy construction. `onCall(scope, op, args)` observes every op; queries
// return realistic dummy values the build may read.
function makeProbe(onCall) {
  const solidQueries = {
    boundingBox: () => ({ min: [0, 0, 0], max: [1, 1, 1], center: [0.5, 0.5, 0.5], size: [1, 1, 1] }),
    volume: () => 1,
    toMesh: () => ({ positions: new Float32Array(9), normals: new Float32Array(9), triangles: 1, edges: new Float32Array(0) }),
    toSTL: () => new ArrayBuffer(0),
    toIndexedMesh: () => ({ positions: new Float32Array(9), indices: new Uint32Array(3) }),
  };
  const kernelQueries = {
    toSTEP: () => Promise.resolve(new ArrayBuffer(0)),
    cleanup: () => {},
  };

  // `ignore` keeps the proxy from masquerading as a thenable/internal handle: symbols,
  // `then` (so it's never await-unwrapped), and `_`-prefixed internals resolve to
  // undefined rather than a chainable op.
  const ignore = (key) => typeof key !== "string" || key === "then" || key[0] === "_";

  const opProxy = (queries, scope) => new Proxy({}, {
    get(_t, key) {
      if (ignore(key)) return undefined;
      if (key in queries) return queries[key];
      return (...args) => { onCall(scope, key, args); return proxy; };
    },
  });

  const proxy = opProxy(solidQueries, "solid");   // a solid handle: every op chains back to itself
  const kernel = opProxy(kernelQueries, "kernel"); // factory ops (cylinder/box/prism/…) return a solid
  return { kernel, proxy };
}

export function createProbeKernel() {
  const used = new Set();
  const { kernel } = makeProbe((_scope, key) => used.add(key));
  return { kernel, used };
}

export function createValidatingProbe({ maxOps = MAX_PROBE_OPS } = {}) {
  const calls = [];
  const issues = [];
  const used = new Set();
  let count = 0;
  let solidProxy = null;

  // Args are recorded as strings so two probe runs can be compared for determinism.
  // The chainable handle is a single shared object, so identity is enough to spot it —
  // and checking identity FIRST matters, because JSON.stringify would trip its traps.
  const describe = (a) => {
    if (a === solidProxy) return "<solid>";
    if (typeof a === "function") return "<fn>";
    try { return JSON.stringify(a) ?? String(a); } catch { return "<unserializable>"; }
  };

  const onCall = (scope, op, args) => {
    if (++count > maxOps) throw new ProbeRunawayError(`build exceeded ${maxOps} kernel operations`);
    used.add(op);
    const allowed = scope === "kernel" ? KERNEL_ALLOWED : SOLID_ALLOWED;
    if (!allowed.has(op)) issues.push({ kind: "unknown-op", scope, op });
    // Validate ONLY the options form — the normative rule (KERNEL-CONTRACT.md
    // "Calling convention") is that a call is options form when it receives exactly
    // one plain-object argument. Legacy positional calls have no options contract to
    // check against. We run `toArgs` (key + required validation) but never the spec's
    // separate `check` hook: `check` inspects real geometry (revolve's calls
    // boundingBox() on its profile), which is meaningless against a proxy.
    const specs = scope === "kernel" ? KERNEL_OP_SPECS : SOLID_OP_SPECS;
    if (specs[op] && args.length === 1 && isPlainOptions(args[0])) {
      try { specs[op].toArgs(args[0]); }
      catch (e) { issues.push({ kind: "invalid-options", scope, op, message: e?.message || String(e) }); }
    }
    calls.push({ scope, op, args: args.map(describe) });
  };

  const { kernel, proxy } = makeProbe(onCall);
  solidProxy = proxy;
  return { kernel, calls, issues, used };
}

/**
 * Execute every sub-part's build() against a validating probe.
 * Never throws: a build error becomes an entry in `throws`, a runaway sets `runaway`.
 */
export function runValidatingProbe(part, p, d, { maxOps = MAX_PROBE_OPS } = {}) {
  const probe = createValidatingProbe({ maxOps });
  const throws = [];
  let runaway = false;
  for (const [name, sp] of Object.entries(part?.parts ?? {})) {
    if (typeof sp?.build !== "function") continue; // no-buildable-parts already reports this
    try {
      sp.build(probe.kernel, p, d);
    } catch (e) {
      if (e instanceof ProbeRunawayError) { runaway = true; break; }
      throws.push({ subpart: name, message: e?.message || String(e) });
    }
  }
  return { calls: probe.calls, issues: probe.issues, used: probe.used, throws, runaway };
}

export function detectBackend(part, params = {}) {
  if (part.meta?.backend) return part.meta.backend;
  const p = { ...part.defaults, ...params };
  let d = {};
  // A throwing derive must not escape here — this runs on the main thread mid
  // regen (after the busy spinner goes up). Probe with an empty `d`; the worker
  // build hits the same throw and posts a proper error for the UI.
  try { d = resolveDerived(part, p); } catch { /* fall through with d = {} */ }
  const { kernel, used } = createProbeKernel();
  for (const name of Object.keys(part.parts)) {
    try { part.parts[name].build(kernel, p, d); } catch { /* probe miss → capability backstop covers it */ }
  }
  for (const op of used) if (OCCT_ONLY.has(op)) return "occt";
  return "manifold";
}
