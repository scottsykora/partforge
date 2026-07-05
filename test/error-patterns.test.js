// Format lint for docs/ERROR-PATTERNS.md — the symptom-indexed error→pattern
// library (issue #28). External consumers (issue #27 diagnostics, HARDWARE.md)
// cite entries as ERROR-PATTERNS.md#<id>, so this test keeps the contract honest:
// stable kebab-case IDs, uniform Symptom/Cause/Fix shape, section-scoped
// namespaces, ID permanence, and resolvable cited anchors.
import { readFileSync } from "node:fs";
import { describe, test, expect } from "vitest";
import { parsePatterns, matchPattern } from "../src/testing/error-patterns.js";

const doc = readFileSync(new URL("../docs/ERROR-PATTERNS.md", import.meta.url), "utf8");

// Section (`# `) → required ID prefix for its entries. Core framework entries are
// bare slugs and must not squat on a reserved prefix. Extend when a new namespace
// section is added; never repurpose a prefix.
const NAMESPACE_SECTIONS = { "Hardware library": "hardware" };

// Append-only snapshot of committed IDs — IDs are permanent (external consumers
// cite ERROR-PATTERNS.md#<id>). Add new IDs when entries land; never remove or
// rename one. A failure here means a committed ID was renamed or deleted.
const BASELINE_IDS = [
  "worker-imports-main-entry",
  "impure-build-stale-preview",
  "replicad-consumed-operand",
  "probe-routed-to-occt",
  "boolean-not-watertight",
  "dual-kernel-same-process",
  "view-dependent-display-place",
  "wrong-node-version",
  "worker-url-not-inline",
  "minwall-sliver-triangles",
  "param-key-missing-from-defaults",
  "dimmed-control-vestigial-param",
  "linked-checkout-wasm-403",
  "ring-sector-full-circle",
  "occt-closed-loop-unsupported",
  "smooth-geometry-faceted-preview",
  "scale-moved-the-part",
  "occt-holes-watertight-na",
  "html-page-missing-in-prod",
];

const entries = parsePatterns(doc);

describe("ERROR-PATTERNS.md format contract", () => {
  test("has at least 15 patterns", () => {
    expect(entries.length).toBeGreaterThanOrEqual(15);
  });

  test("every heading is a kebab-case ID", () => {
    for (const e of entries) expect(e.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test("IDs are unique", () => {
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every entry has Symptom, Cause, Fix lines in order, non-empty", () => {
    for (const e of entries) {
      const iS = e.body.indexOf("- **Symptom:**");
      const iC = e.body.indexOf("- **Cause:**");
      const iF = e.body.indexOf("- **Fix:**");
      expect(iS, `${e.id}: missing Symptom`).toBeGreaterThanOrEqual(0);
      expect(iC, `${e.id}: missing Cause`).toBeGreaterThan(iS);
      expect(iF, `${e.id}: missing Fix`).toBeGreaterThan(iC);
      for (const [label, i] of [["Symptom", iS], ["Cause", iC], ["Fix", iF]]) {
        const line = e.body.slice(i).split("\n")[0];
        expect(line.replace(/- \*\*\w+:\*\*/, "").trim().length,
          `${e.id}: empty ${label} line`).toBeGreaterThan(0);
      }
    }
  });

  test("entries are namespaced by their section", () => {
    const reserved = Object.values(NAMESPACE_SECTIONS);
    for (const e of entries) {
      const required = NAMESPACE_SECTIONS[e.section];
      if (required) {
        expect(e.id.startsWith(`${required}-`),
          `${e.id}: entries under "# ${e.section}" must be ${required}-*`).toBe(true);
      } else {
        for (const p of reserved) {
          expect(e.id === p || e.id.startsWith(`${p}-`),
            `${e.id}: reserved prefix "${p}-*" used outside its "# " section`).toBe(false);
        }
      }
    }
  });

  test("every committed ID still exists (IDs are permanent)", () => {
    const ids = new Set(entries.map((e) => e.id));
    for (const id of BASELINE_IDS) {
      expect(ids.has(id), `${id}: committed ID missing — IDs are permanent`).toBe(true);
    }
  });

  test("ERROR-PATTERNS.md#<id> anchors cited from other docs resolve", () => {
    const ids = new Set(entries.map((e) => e.id));
    const citing = ["../docs/AUTHORING-PARTS.md", "../CLAUDE.md", "../skills/partforge/SKILL.md"];
    for (const rel of citing) {
      const text = readFileSync(new URL(rel, import.meta.url), "utf8");
      for (const m of text.matchAll(/ERROR-PATTERNS\.md#([a-z0-9-]+)/g)) {
        expect(ids.has(m[1]), `${rel}: dangling anchor #${m[1]}`).toBe(true);
      }
    }
  });

  test("every verify registry metric has a hint (report contract: hint on every fail/warn)", async () => {
    const { SUBPART_METRICS, VIEW_METRICS } = await import("../src/testing/verify.js");
    for (const [name, reg] of [...Object.entries(SUBPART_METRICS), ...Object.entries(VIEW_METRICS)]) {
      expect(typeof reg.hint, `${name}: missing registry hint`).toBe("string");
    }
  });

  test("every pattern ID cited by the verify registries resolves", async () => {
    const { SUBPART_METRICS, VIEW_METRICS } = await import("../src/testing/verify.js");
    const ids = new Set(entries.map((e) => e.id));
    for (const [name, reg] of [...Object.entries(SUBPART_METRICS), ...Object.entries(VIEW_METRICS)]) {
      if (reg.pattern) expect(ids.has(reg.pattern), `${name}: dangling pattern "${reg.pattern}"`).toBe(true);
    }
  });
});

describe("matchPattern", () => {
  const md = [
    "# Core framework",
    "## short-string",
    "- **Symptom:** `boom` everywhere.",
    "- **Cause:** x.",
    "- **Fix:** do the short fix.",
    "## long-string",
    "- **Symptom:** `boom in the geometry worker` on build.",
    "- **Cause:** y.",
    "- **Fix:** do the long fix.",
  ].join("\n");
  const patterns = parsePatterns(md);

  test("parses symptom strings and fix text", () => {
    expect(patterns[1].symptomStrings).toEqual(["boom in the geometry worker"]);
    expect(patterns[1].fix).toBe("do the long fix.");
  });

  test("longest matching symptom string wins", () => {
    const m = matchPattern("Error: boom in the geometry worker (job 3)", patterns);
    expect(m).toEqual({ id: "long-string", fix: "do the long fix." });
  });

  test("symptom strings under 6 chars never match (guards generic backticks)", () => {
    expect(matchPattern("boom", patterns)).toBeNull();
  });

  test("no match, null patterns, and non-string messages return null, never throw", () => {
    expect(matchPattern("totally unrelated", patterns)).toBeNull();
    expect(matchPattern("anything", null)).toBeNull();
    expect(matchPattern(undefined, patterns)).toBeNull();
  });

  test("matches a real thrown string from the live doc", () => {
    // assert-dsl.js throws `assertion: unrecognized form: "…"`; if no live entry
    // covers it yet this test documents the gap — match against the real doc and
    // accept either null or a { id, fix } shape, but never a throw.
    const m = matchPattern('assertion: unrecognized form: "wat"', parsePatterns(doc));
    expect(m === null || (typeof m.id === "string" && typeof m.fix === "string")).toBe(true);
  });
});
