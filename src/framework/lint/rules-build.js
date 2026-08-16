// Group 3 — how the build uses the kernel, discovered by executing build() against
// the validating probe with no geometry kernel. Every error in this group already
// throws at runtime; the value is reaching it in microseconds, before a WASM boot.
import { err, warn } from "./finding.js";
import { ROUTED_CAD_OPS } from "../geometry/kernel.js";
import { MAX_PROBE_OPS } from "../geometry/probe.js";

// fillet/chamfer are implemented on the mesh backend now (mesh-fillet.js), so a
// pinned-Manifold part may use them; only the still-unimplemented ops error here.
const OCCT_ONLY = new Set(ROUTED_CAD_OPS);
const unique = (xs) => [...new Set(xs)];

export const BUILD_RULES = [
  {
    id: "derive-throws",
    run: ({ deriveError }) => (deriveError ? [
      err("derive-throws", `derive(p) threw: ${deriveError}`,
        "derive(p) must return derived values for any parameter set the defaults allow — fix the error so it does not throw. As written, the app is left spinning with no geometry: resolveParams's catch reports the failure but no build ever runs.",
        "derive"),
    ] : []),
  },
  {
    id: "unknown-kernel-op",
    run: ({ probe }) => unique(probe().issues
      .filter((i) => i.kind === "unknown-op" && i.scope === "kernel").map((i) => i.op))
      .map((op) => err("unknown-kernel-op", `\`k.${op}(…)\` is not a kernel operation`,
        `Remove the call or correct the name — see the kernel op table in docs/AUTHORING-PARTS.md for the full list.`,
        "parts")),
  },
  {
    id: "unknown-solid-op",
    run: ({ probe }) => unique(probe().issues
      .filter((i) => i.kind === "unknown-op" && i.scope !== "kernel").map((i) => i.op))
      .map((op) => err("unknown-solid-op", `\`.${op}(…)\` is not a Solid or Shape2D method`,
        `Remove the call or correct the name — see the Solid and Shape2D method tables in docs/AUTHORING-PARTS.md.`,
        "parts")),
  },
  {
    id: "invalid-op-options",
    run: ({ probe }) => unique(probe().issues
      .filter((i) => i.kind === "invalid-options").map((i) => i.message))
      .map((message) => err("invalid-op-options", message,
        "Correct the options object to match the op's documented keys — the message above names the offending key or the missing required one.",
        "parts")),
  },
  {
    id: "build-throws",
    run: ({ probe }) => probe().throws.map(({ subpart, message }) =>
      err("build-throws", `sub-part "${subpart}" threw during a geometry-free build: ${message}`,
        "Fix the error in build(). This was raised with no kernel attached, so it is a fault in the build's own logic (bad arithmetic, a missing param, a null dereference) rather than a geometry failure.",
        `parts.${subpart}.build`)),
  },
  {
    id: "manifold-backend-uses-occt-op",
    run: ({ part, probe }) => {
      if (part?.meta?.backend !== "manifold") return [];
      // solidUsed, not used: `Shape2D.fillet`/`.chamfer` are backend-identical pure
      // JS and are fine under a pinned Manifold backend; only Solid-handle uses of
      // these names are CAD-only.
      return [...probe().solidUsed].filter((op) => OCCT_ONLY.has(op))
        .map((op) => err("manifold-backend-uses-occt-op",
          `\`meta.backend\` pins Manifold, but the build calls \`${op}\`, which only OCCT implements`,
          `Remove \`meta.backend: "manifold"\` and let the probe route this part to OCCT, or replace \`${op}\` with a mesh-friendly construction — as written the build throws KernelCapabilityError.`,
          "meta.backend"));
    },
  },
  {
    id: "build-runaway",
    run: ({ probe }) => (probe().runaway ? [
      err("build-runaway", `the build exceeded ${MAX_PROBE_OPS} kernel operations`,
        "A loop in build() is not terminating, or a count parameter is far larger than intended. Bound the loop, or reduce the governing parameter.",
        "parts"),
    ] : []),
  },
  {
    id: "nondeterministic-build",
    run: ({ probe, probeAgain }) => {
      const a = probe();
      if (a.runaway || a.throws.length > 0) return []; // an aborted build can't be compared
      const b = probeAgain();
      if (b.runaway || b.throws.length > 0) return [];
      if (JSON.stringify(a.calls) === JSON.stringify(b.calls)) return [];
      return [warn("nondeterministic-build",
        "two builds with identical parameters produced different kernel calls",
        "build() must be a pure function of (k, p, d). Remove Math.random(), Date/clock reads, and module-level mutable state — the preview kernel memoizes geometry by content hash, so an impure build silently returns stale geometry.",
        "parts", "impure-build-stale-preview")];
    },
  },
];
