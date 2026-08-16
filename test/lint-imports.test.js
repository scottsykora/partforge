// Import lint rules — static, geometry-free checks that catch what an import
// misdeclaration would otherwise throw for only at build/verify time (see
// rules-imports.js's own header comment). Pure: no kernel boots.
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

// --- import-unknown-name ---------------------------------------------------

test("k.import(\"name\") with no matching imports declaration is an error", () => {
  const part = partWith({
    imports: { scan: () => new ArrayBuffer(0) },
    parts: { body: { views: ["main"], build: (k) => k.import("nope") } },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("import-unknown-name");
  expect(find(r, "import-unknown-name").message).toContain("nope");
  expect(find(r, "import-unknown-name").message).toContain("scan");
});

test("k.import(\"name\") matching a declared import is not flagged", () => {
  const part = partWith({
    imports: { scan: () => new ArrayBuffer(0) },
    parts: { body: { views: ["main"], build: (k) => k.import("scan") } },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("import-unknown-name");
});

// --- import-mesh-on-occt ----------------------------------------------------

test("a declared STL import on an OCCT-routed part (meta.backend) is an error", () => {
  const part = partWith({
    meta: { title: "T", backend: "occt" },
    imports: { scan: new URL("https://example.com/scan.stl") },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("import-mesh-on-occt");
  expect(find(r, "import-mesh-on-occt").message).toContain("scan");
  expect(find(r, "import-mesh-on-occt").message).toMatch(/meta\.backend/);
});

test("a declared STL import on an OCCT-routed part (fillet op) names the CAD op as the cause", () => {
  const part = partWith({
    imports: { scan: new URL("https://example.com/scan.stl") },
    parts: { body: { views: ["main"], build: (k) => k.box({ size: [1, 1, 1] }).fillet({ r: 1 }) } },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("import-mesh-on-occt");
  expect(find(r, "import-mesh-on-occt").message).not.toMatch(/meta\.backend/);
});

test("a declared STL import on a Manifold-routed part is not flagged", () => {
  const part = partWith({ imports: { scan: new URL("https://example.com/scan.stl") } });
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("import-mesh-on-occt");
});

test("a declared STEP import on an OCCT-routed part is not flagged (STEP is fine on OCCT)", () => {
  const part = partWith({
    meta: { title: "T", backend: "occt" },
    imports: { scan: new URL("https://example.com/scan.step") },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("import-mesh-on-occt");
});

test("a bytes/thunk import source is skipped (format unknowable statically)", () => {
  const part = partWith({
    meta: { title: "T", backend: "occt" },
    imports: { scan: () => new ArrayBuffer(0) },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("import-mesh-on-occt");
});

// --- reference-unknown -------------------------------------------------------

test("a sub-part reference naming no declared import is an error", () => {
  const part = partWith({
    imports: { scan: () => new ArrayBuffer(0) },
    parts: {
      body: { views: ["main"], reference: "nope", build: (k) => k.box({ size: [1, 1, 1] }) },
    },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("reference-unknown");
  expect(find(r, "reference-unknown").message).toContain("nope");
});

test("a sub-part reference naming a declared import is not flagged", () => {
  const part = partWith({
    imports: { scan: () => new ArrayBuffer(0) },
    parts: {
      body: { views: ["main"], reference: "scan", build: (k) => k.box({ size: [1, 1, 1] }) },
    },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("reference-unknown");
});

// --- ref-metric-without-reference -------------------------------------------

test("a ref* verify metric on a sub-part with no reference is a warning", () => {
  const part = partWith({
    verify: { expect: { body: { refXorVolume: "<=50mm3" } } },
  });
  const r = lintPart(part);
  expect(ids(r.warnings)).toContain("ref-metric-without-reference");
  expect(find(r, "ref-metric-without-reference").message).toContain("body");
});

test("a ref* verify metric on a sub-part that declares a reference is not flagged", () => {
  const part = partWith({
    imports: { scan: () => new ArrayBuffer(0) },
    parts: {
      body: { views: ["main"], reference: "scan", build: (k) => k.box({ size: [1, 1, 1] }) },
    },
    verify: { expect: { body: { refXorVolume: "<=50mm3" } } },
  });
  const r = lintPart(part);
  expect(ids(r.warnings)).not.toContain("ref-metric-without-reference");
});

test("a non-ref metric on a sub-part with no reference is not flagged", () => {
  const part = partWith({
    verify: { expect: { body: { holes: 0 } } },
  });
  const r = lintPart(part);
  expect(ids(r.warnings)).not.toContain("ref-metric-without-reference");
});

test("a typo'd sub-part name in verify.expect is not double-flagged here (verify-unknown-subpart owns it)", () => {
  const part = partWith({
    verify: { expect: { boddy: { refXorVolume: "<=50mm3" } } },
  });
  const r = lintPart(part);
  expect(ids(r.warnings)).not.toContain("ref-metric-without-reference");
  expect(ids(r.errors)).toContain("verify-unknown-subpart");
});

// A function-form `verify.expect` is not statically inspectable in general, but
// `resolveExpectOnce()` (shared with the Group 4 verify rules) already resolves it
// safely against the probe's params — this rule intentionally does NOT skip the
// function form, so a ref* metric surfaced through it is checked exactly like the
// static-object form.
test("a ref* metric inside a function-form verify.expect with no reference is a warning", () => {
  const part = partWith({
    verify: { expect: (p, d) => ({ body: { refXorVolume: "<=50mm3" } }) },
  });
  const r = lintPart(part);
  expect(ids(r.warnings)).toContain("ref-metric-without-reference");
  expect(find(r, "ref-metric-without-reference").message).toContain("body");
});

test("a ref* metric inside a function-form verify.expect WITH a reference is not flagged", () => {
  const part = partWith({
    imports: { scan: () => new ArrayBuffer(0) },
    parts: {
      body: { views: ["main"], reference: "scan", build: (k) => k.box({ size: [1, 1, 1] }) },
    },
    verify: { expect: (p, d) => ({ body: { refXorVolume: "<=50mm3" } }) },
  });
  const r = lintPart(part);
  expect(ids(r.warnings)).not.toContain("ref-metric-without-reference");
});
