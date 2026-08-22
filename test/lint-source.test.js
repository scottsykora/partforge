import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { lintPart, SOURCE_RULE_IDS } from "../src/lint.js";

// A minimal evaluated part binding `keys` to controls, defaults given directly.
const partWith = (defaults, keys = Object.keys(defaults)) => ({
  meta: { title: "T", units: "mm" },
  defaults,
  parameters: [{ title: "S", controls: keys.map((key) => ({ key, label: key, min: 0, max: 100, step: 1 })) }],
  parts: { body: { build: (k) => k.box({ size: [1, 1, 1] }), views: ["main"] } },
  views: { main: { label: "Main" } },
});

const srcWith = (defaultsText) => ({
  files: { "part.js": `export default {\n  defaults: ${defaultsText},\n};\n` },
  entrypoint: "part.js",
});

const findingsFor = (report, rule) =>
  [...report.errors, ...report.warnings].filter((f) => f.rule === rule);

describe("control-default-not-literal", () => {
  it("errors on a control-bound expression default, with file and line", () => {
    const report = lintPart(partWith({ wall: 13 / 3 }), {
      sources: srcWith("{\n    wall: 13 / 3,\n  }"),
    });
    const found = findingsFor(report, "control-default-not-literal");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].file).toBe("part.js");
    expect(found[0].line).toBe(3);
    expect(found[0].path).toBe("defaults.wall");
    expect(found[0].message).toContain("13 / 3");
  });

  it("stays silent for an UNBOUND non-literal default (legal by design)", () => {
    const part = partWith({ wall: 2 }, ["wall"]);
    part.defaults.pts = [[0, 0], [1, 0]];
    const report = lintPart(part, {
      sources: srcWith("{\n    wall: 2,\n    pts: [[0, 0], [1, 0]],\n  }"),
    });
    expect(findingsFor(report, "control-default-not-literal")).toHaveLength(0);
  });

  it("flags hex / separator spellings the settings rewriter refuses", () => {
    const report = lintPart(partWith({ a: 255, b: 1000 }), {
      sources: srcWith("{ a: 0xff, b: 1_000 }"),
    });
    expect(findingsFor(report, "control-default-not-literal")).toHaveLength(2);
  });

  it("accepts plain literals: numbers, strings with escapes, booleans", () => {
    const report = lintPart(partWith({ a: -2.5, b: "x\ny", c: true }), {
      sources: srcWith('{ a: -2.5, b: "x\\ny", c: true }'),
    });
    expect(findingsFor(report, "control-default-not-literal")).toHaveLength(0);
  });
});

describe("impure-source-token", () => {
  it("warns on impurity tokens, naming file and line", () => {
    const report = lintPart(partWith({ a: 1 }), {
      sources: {
        files: {
          "part.js": 'export default { defaults: { a: 1 } };\n',
          "jig.js": "export const jig = () => Math.random();\nexport const t = Date.now();\nexport const d = new Date();\n",
        },
        entrypoint: "part.js",
      },
    });
    const found = findingsFor(report, "impure-source-token");
    expect(found.map((f) => [f.file, f.line, f.severity])).toEqual([
      ["jig.js", 1, "warning"], ["jig.js", 2, "warning"], ["jig.js", 3, "warning"],
    ]);
  });

  it("ignores tokens inside strings and comments, and new Date(0)", () => {
    const report = lintPart(partWith({ a: 1 }), {
      sources: srcWith("{ a: 1 }" ) , // literal fine; add a second file below
    });
    const report2 = lintPart(partWith({ a: 1 }), {
      sources: {
        files: {
          "part.js": 'export default { defaults: { a: 1 } };\n// Math.random()\nconst s = "Date.now()";\nconst d = new Date(0);\n',
        },
        entrypoint: "part.js",
      },
    });
    expect(findingsFor(report, "impure-source-token")).toHaveLength(0);
    expect(findingsFor(report2, "impure-source-token")).toHaveLength(0);
  });
});

describe("sources plumbing", () => {
  it("no sources → no source findings, report otherwise unchanged", () => {
    const withS = lintPart(partWith({ a: 1 }), { sources: srcWith("{ a: 1 }") });
    const without = lintPart(partWith({ a: 1 }));
    expect(findingsFor(withS, "control-default-not-literal")).toHaveLength(0);
    expect(without.errors.filter((f) => SOURCE_RULE_IDS.has(f.rule))).toHaveLength(0);
  });

  it("hostile sources shapes never throw", () => {
    for (const sources of [null, 42, "x", {}, { files: null }, { files: { a: 1 }, entrypoint: 2 }]) {
      expect(() => lintPart(partWith({ a: 1 }), { sources })).not.toThrow();
    }
  });

  it("SOURCE_RULE_IDS names exactly the source rules", () => {
    expect([...SOURCE_RULE_IDS].sort()).toEqual(["control-default-not-literal", "impure-source-token"]);
  });
});

describe("exemplar parts lint clean with their own source", () => {
  it("no source findings on any src/parts/*.js", async () => {
    for (const name of readdirSync("src/parts").filter((f) => f.endsWith(".js"))) {
      const source = readFileSync(`src/parts/${name}`, "utf8");
      const mod = await import(`../src/parts/${name}`);
      const report = lintPart(mod.default, { sources: { files: { [name]: source }, entrypoint: name } });
      const bad = [...report.errors, ...report.warnings].filter((f) => SOURCE_RULE_IDS.has(f.rule));
      expect(bad, `${name}: ${JSON.stringify(bad)}`).toHaveLength(0);
    }
  });
});
