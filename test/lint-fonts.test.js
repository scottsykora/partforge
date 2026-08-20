// Font-control lint rules — static, geometry-free checks that catch a picker
// wired to nothing (font-control-not-in-fonts) and a default its own allow
// list would refuse (font-source-scheme). See rules-fonts.js's own header for
// why both are silent runtime failures rather than throws.
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const ids = (findings) => findings.map((f) => f.rule);
const find = (r, rule) => [...r.errors, ...r.warnings].find((f) => f.rule === rule);

const partWith = (extra = {}) => ({
  meta: { title: "T" },
  defaults: {},
  parts: { body: { views: ["main"], build: (k) => k.box({ size: [1, 1, 1] }) } },
  views: { main: { label: "Main" } },
  ...extra,
});

// --- font-control-not-in-fonts ---------------------------------------------

test("a font control whose key a static fonts object never reads is an error", () => {
  const part = partWith({
    parameters: [{ id: "s", controls: [{ key: "face", type: "font", label: "T" }] }],
    defaults: { face: "https://fonts.gstatic.com/s/a/v1/a.ttf" },
    fonts: { face: "https://fonts.gstatic.com/s/a/v1/a.ttf" },   // STATIC — never reads p.face
  });
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("font-control-not-in-fonts");
  expect(find(r, "font-control-not-in-fonts").message).toContain("static object");
});

test("a font control with no `fonts` field at all is an error naming it missing", () => {
  const part = partWith({
    parameters: [{ id: "s", controls: [{ key: "face", type: "font", label: "T" }] }],
    defaults: { face: "https://fonts.gstatic.com/s/a/v1/a.ttf" },
    // no `fonts` field here at all — distinct from the static-object case above
  });
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("font-control-not-in-fonts");
  expect(find(r, "font-control-not-in-fonts").message).toContain("missing");
});

test("a function-form fonts clears the rule", () => {
  const part = partWith({
    parameters: [{ id: "s", controls: [{ key: "face", type: "font", label: "T" }] }],
    defaults: { face: "https://fonts.gstatic.com/s/a/v1/a.ttf" },
    fonts: (p) => ({ face: p.face }),
  });
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("font-control-not-in-fonts");
});

test("a part with no font control at all is untouched by both rules", () => {
  const part = partWith({
    parameters: [{ id: "s", controls: [{ key: "w", type: "slider", min: 1, max: 9 }] }],
    defaults: { w: 4 },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("font-control-not-in-fonts");
  expect(ids(r.warnings)).not.toContain("font-source-scheme");
});

// --- font-source-scheme -----------------------------------------------------

test("a default the control's own allow list rejects warns", () => {
  const part = partWith({
    parameters: [{ id: "s", controls: [{ key: "face", type: "font", allow: ["gstatic"] }] }],
    defaults: { face: "https://cdn.example.com/x.ttf" },
    fonts: (p) => ({ face: p.face }),
  });
  const r = lintPart(part);
  const f = find(r, "font-source-scheme");
  expect(f).toBeTruthy();
  expect(f.severity).toBe("warning");
  expect(f.message).toContain("cdn.example.com");
});

test("a default the control's own allow list accepts does not warn", () => {
  const part = partWith({
    parameters: [{ id: "s", controls: [{ key: "face", type: "font", allow: ["gstatic"] }] }],
    defaults: { face: "https://fonts.gstatic.com/s/a/v1/a.ttf" },
    fonts: (p) => ({ face: p.face }),
  });
  const r = lintPart(part);
  expect(ids(r.warnings)).not.toContain("font-source-scheme");
});

test("a default within the implicit https allow list does not warn", () => {
  const part = partWith({
    parameters: [{ id: "s", controls: [{ key: "face", type: "font" }] }],
    defaults: { face: "https://cdn.example.com/x.ttf" },
    fonts: (p) => ({ face: p.face }),
  });
  const r = lintPart(part);
  expect(ids(r.warnings)).not.toContain("font-source-scheme");
});

test("an empty-string default (no font declared) does not warn, even under a narrow allow list", () => {
  const part = partWith({
    parameters: [{ id: "s", controls: [{ key: "face", type: "font", allow: ["gstatic"] }] }],
    defaults: { face: "" },
    fonts: (p) => (p.face ? { face: p.face } : {}),
  });
  const r = lintPart(part);
  expect(ids(r.warnings)).not.toContain("font-source-scheme");
});

test("a disallowed non-empty default still warns under the same narrow allow list", () => {
  const part = partWith({
    parameters: [{ id: "s", controls: [{ key: "face", type: "font", allow: ["gstatic"] }] }],
    defaults: { face: "https://cdn.example.com/x.ttf" },
    fonts: (p) => (p.face ? { face: p.face } : {}),
  });
  const r = lintPart(part);
  expect(ids(r.warnings)).toContain("font-source-scheme");
});
