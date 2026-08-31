// Image-control lint rules — static, geometry-free checks that catch a picker
// wired to nothing (image-control-not-in-images), a default its own allow list
// would refuse (image-source-scheme), and a k.heightfield() name absent from a
// static `images` declaration (heightfield-unknown-image). See rules-images.js's
// own header for why the first two rules are complementary rather than
// overlapping, and for the inline-grid false-positive trap the third avoids.
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

// --- image-control-not-in-images --------------------------------------------

test("an image control whose key a function-form images never reads is an error", () => {
  const part = partWith({
    parameters: [{ id: "s", controls: [{ key: "relief", type: "image", label: "Depth map" }] }],
    defaults: { relief: "", w: 10 },
    images: () => ({}), // never reads p.relief
    parts: { body: { views: ["main"], build: (k, p) => k.box({ min: [0, 0, 0], max: [p.w, p.w, 1] }) } },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("image-control-not-in-images");
  expect(find(r, "image-control-not-in-images").message).toContain("relief");
});

test("a control whose key does reach images is not flagged", () => {
  const part = partWith({
    parameters: [{ id: "s", controls: [{ key: "relief", type: "image", label: "Depth map" }] }],
    defaults: { relief: "", w: 10 },
    images: (p) => (p.relief ? { relief: p.relief } : {}),
    parts: { body: { views: ["main"], build: (k, p) => k.heightfield("relief", { w: p.w, d: p.w }) } },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("image-control-not-in-images");
});

test("a static-object images is never flagged by this rule (a different mistake)", () => {
  const part = partWith({
    parameters: [{ id: "s", controls: [{ key: "relief", type: "image", label: "Depth map" }] }],
    defaults: { relief: "https://cdn.test/r.png" },
    images: { relief: "https://cdn.test/r.png" }, // STATIC — provably can't read p.relief
  });
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("image-control-not-in-images");
});

test("a part with no image control at all is untouched", () => {
  const part = partWith({
    parameters: [{ id: "s", controls: [{ key: "w", type: "slider", min: 1, max: 9 }] }],
    defaults: { w: 4 },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("image-control-not-in-images");
});

// --- heightfield-unknown-image ----------------------------------------------

test("a heightfield name absent from a static images map is an error", () => {
  const part = partWith({
    defaults: { w: 10 },
    images: { other: "https://cdn.test/o.png" },
    parts: { body: { views: ["main"], build: (k, p) => k.heightfield("relief", { w: p.w, d: p.w }) } },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("heightfield-unknown-image");
  expect(find(r, "heightfield-unknown-image").message).toContain("relief");
});

test("a heightfield name present in a static images map is not flagged", () => {
  const part = partWith({
    defaults: { w: 10 },
    images: { relief: "https://cdn.test/r.png" },
    parts: { body: { views: ["main"], build: (k, p) => k.heightfield("relief", { w: p.w, d: p.w }) } },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("heightfield-unknown-image");
});

test("does not flag an unknown name when images is a function (names not statically known)", () => {
  const part = partWith({
    parameters: [{ id: "s", controls: [{ key: "relief", type: "image" }] }],
    defaults: { relief: "", w: 10 },
    images: (p) => (p.relief ? { relief: p.relief } : {}),
    parts: { body: { views: ["main"], build: (k, p) => k.heightfield("relief", { w: p.w, d: p.w }) } },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("heightfield-unknown-image");
});

test("an inline grid first argument is never flagged as an unknown image name", () => {
  const part = partWith({
    defaults: { w: 10 },
    images: { other: "https://cdn.test/o.png" },
    parts: {
      body: {
        views: ["main"],
        build: (k, p) => k.heightfield({ width: 2, height: 2, data: new Uint16Array(4) }, { w: p.w, d: p.w }),
      },
    },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).not.toContain("heightfield-unknown-image");
});

test("no images field at all still flags a heightfield call by name", () => {
  const part = partWith({
    defaults: { w: 10 },
    parts: { body: { views: ["main"], build: (k, p) => k.heightfield("relief", { w: p.w, d: p.w }) } },
  });
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("heightfield-unknown-image");
});

// --- image-source-scheme -----------------------------------------------------

test("a default the control's own allow list rejects warns", () => {
  const part = partWith({
    parameters: [{ id: "s", controls: [{ key: "relief", type: "image", allow: ["asset"] }] }],
    defaults: { relief: "https://cdn.example.com/x.png" },
    images: (p) => (p.relief ? { relief: p.relief } : {}),
  });
  const r = lintPart(part);
  const f = find(r, "image-source-scheme");
  expect(f).toBeTruthy();
  expect(f.severity).toBe("warning");
  expect(f.message).toContain("cdn.example.com");
});

test("a default within the implicit https allow list does not warn", () => {
  const part = partWith({
    parameters: [{ id: "s", controls: [{ key: "relief", type: "image" }] }],
    defaults: { relief: "https://cdn.example.com/x.png" },
    images: (p) => (p.relief ? { relief: p.relief } : {}),
  });
  const r = lintPart(part);
  expect(ids(r.warnings)).not.toContain("image-source-scheme");
});

test("an empty-string default (no image declared) does not warn, even under a narrow allow list", () => {
  const part = partWith({
    parameters: [{ id: "s", controls: [{ key: "relief", type: "image", allow: ["asset"] }] }],
    defaults: { relief: "" },
    images: (p) => (p.relief ? { relief: p.relief } : {}),
  });
  const r = lintPart(part);
  expect(ids(r.warnings)).not.toContain("image-source-scheme");
});
