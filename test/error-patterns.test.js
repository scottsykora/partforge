// Format lint for docs/ERROR-PATTERNS.md — the symptom-indexed error→pattern
// library (issue #28). External consumers (issue #27 diagnostics, HARDWARE.md)
// cite entries as ERROR-PATTERNS.md#<id>, so this test keeps the contract honest:
// stable kebab-case IDs, uniform Symptom/Cause/Fix shape, section-scoped
// namespaces, ID permanence, and resolvable cited anchors.
import { readFileSync } from "node:fs";
import { describe, test, expect } from "vitest";

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

// Single-pass, fence-aware parse: a heading inside a ``` / ~~~ fence is quoted
// content, not structure. Each `## <id>` entry records the `# <section>` it sits
// under; its body runs to the next h1/h2 heading.
function parse(md) {
  const entries = [];
  let section = null;
  let entry = null;
  let inFence = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      if (entry) entry.body += line + "\n";
      continue;
    }
    if (!inFence) {
      const h1 = line.match(/^# (.+)$/);
      const h2 = line.match(/^## (.+)$/);
      if (h1) { section = h1[1]; entry = null; continue; }
      if (h2) { entry = { id: h2[1], section, body: "" }; entries.push(entry); continue; }
    }
    if (entry) entry.body += line + "\n";
  }
  return entries;
}

const entries = parse(doc);

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
});
