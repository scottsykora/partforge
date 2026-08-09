// Registry ↔ docs coherence: a control type that exists but is undocumented is
// how the downstream prompt corpus rots — partforge-cloud regenerates its
// prompts from this file.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { WIDGET_SPECS } from "../../src/framework/panel/widget-specs.js";

const guide = readFileSync(
  fileURLToPath(new URL("../../docs/AUTHORING-PARTS.md", import.meta.url)), "utf8");

test("every widget type in the registry appears in the authoring guide", () => {
  for (const spec of WIDGET_SPECS) {
    expect(guide.includes(`"${spec.type}"`) || guide.includes(`\`${spec.type}\``),
      `AUTHORING-PARTS.md never mentions type "${spec.type}"`).toBe(true);
  }
});

test("the guide documents the node-model keywords", () => {
  for (const kw of ["controls", "type: \"group\"", "type: \"preset\"", "when", "whenFalse",
                    "collapsed", "recommended", "derivedKey"]) {
    expect(guide.includes(kw), `guide is missing ${kw}`).toBe(true);
  }
});
