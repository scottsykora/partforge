// Format lint for docs/ERROR-PATTERNS.md — the symptom-indexed error→pattern
// library (issue #28). External consumers (issue #27 diagnostics, HARDWARE.md)
// cite entries as ERROR-PATTERNS.md#<id>, so this test keeps the contract honest:
// stable kebab-case IDs, uniform Symptom/Cause/Fix shape.
import { readFileSync } from "node:fs";
import { describe, test, expect } from "vitest";

const doc = readFileSync(new URL("../docs/ERROR-PATTERNS.md", import.meta.url), "utf8");

// An entry = a `## <id>` heading plus everything until the next h1/h2 heading.
function parseEntries(md) {
  const entries = [];
  const re = /^## (.+)$/gm;
  let m;
  const marks = [];
  while ((m = re.exec(md)) !== null) marks.push({ id: m[1], start: m.index + m[0].length });
  for (let i = 0; i < marks.length; i++) {
    const end = md.slice(marks[i].start).search(/^#{1,2} /m);
    const body = end === -1 ? md.slice(marks[i].start) : md.slice(marks[i].start, marks[i].start + end);
    entries.push({ id: marks[i].id, body });
  }
  return entries;
}

const entries = parseEntries(doc);

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

  test("non-core patterns are namespaced with a known prefix", () => {
    // Core patterns are bare slugs; subsystem patterns must use a reserved prefix.
    // Today only hardware-* is reserved (issue #30). Extend this list, never repurpose.
    const reserved = ["hardware"];
    for (const e of entries) {
      const prefix = e.id.split("-")[0];
      if (reserved.includes(prefix)) {
        expect(e.id.startsWith(`${prefix}-`)).toBe(true);
      }
    }
  });
});
