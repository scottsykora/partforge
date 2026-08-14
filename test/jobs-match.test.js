// The inspect job's optional `matchTargets`: score the part's own six silhouettes
// against a reference shape the caller supplies, and report the best-matching view.
// Driven through the real job handler with a real Manifold kernel, because the
// contract being pinned here is the WIRE the geometry worker answers on — the
// downstream consumer posts `inspect` and reads `report.match`, and nothing below
// that message boundary is its business.
//
// The part is the demo spacer at defaults: an 8 mm barrel with a 3.6 mm through
// bore (3.4 nominal + the part's own 0.2 print clearance), 10 mm tall. So its top
// and bottom silhouettes are an annulus, and its four side silhouettes are plain
// rectangles — which is what makes a ring-pair target unambiguous about which view
// it matches.
import { beforeAll, describe, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handle } from "../src/framework/jobs.js";
import { buildView } from "../src/framework/oracle/build.js";
import { rasterizeMeshMask } from "../src/framework/oracle/silhouette.js";
import part from "../src/parts/demo.js";

const VIEW = Object.keys(part.views)[0];

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(); });

const inspect = async (msg) => {
  const posts = [];
  await handle(kernel, part, { type: "inspect", view: VIEW, params: {}, ...msg }, (m) => posts.push(m));
  const error = posts.find((m) => m.type === "error");
  expect(error?.message ?? null).toBe(null);
  return posts.find((m) => m.type === "report");
};

// A closed circle as a ring of [x, y] pairs in mm, centred on the origin — where the
// spacer's own barrel and bore sit.
const circle = (r, n = 128) =>
  Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)]);

// The spacer's top silhouette, drawn as rings rather than measured from the part: an
// od-8 disc with a 3.6 mm bore through it. Rings share one even-odd group, so the
// inner ring is a hole.
const spacerRings = () => [circle(4), circle(1.8)];

describe("inspect job match scoring", () => {
  test("a ring target matching the part's own top silhouette scores the top view", async () => {
    const report = await inspect({ matchTargets: [{ kind: "profile", rings: spacerRings() }] });

    expect(report.match).toHaveLength(1);
    const [m] = report.match;
    expect(m.kind).toBe("profile");
    expect(["top", "bottom"]).toContain(m.best.view);
    expect(m.best.iou).toBeGreaterThan(0.9);
    expect(m.best.boundaryIoU).toBeGreaterThan(0);
    // A profile target is millimetres on both sides, so the job must ask for the
    // scale-aware comparison: `mm` here (rather than `%bbox-diag`) is the proof that
    // it did, and `iouScale` is the absolute-size score that only that path produces.
    expect(m.best.contourUnit).toBe("mm");
    expect(m.best.iouScale).toBeGreaterThan(0.9);
    // A flat rectangle is a poor match for an annulus — the report must not collapse
    // to "every view is the best view".
    expect(Object.keys(m.views).sort()).toEqual(["back", "bottom", "front", "left", "right", "top"]);
    expect(m.views[m.best.view]).toBe(m.best.iou);
    expect(m.views.front).toBeLessThan(0.9);
    // The delta map names the view it belongs to, and is a full frame of class codes.
    expect(m.delta.view).toBe(m.best.view);
    expect(m.delta.data.length).toBe(m.delta.width * m.delta.height);
    expect(m.delta.data.some((v) => v === 1)).toBe(true);
    // The scores object carries no mask of its own — the delta is reported once.
    expect(m.best.delta).toBeUndefined();
  });

  test("an image target is scored without scale, since a photo carries no millimetres", async () => {
    // The part's own top silhouette, stripped of its mmPerPx — exactly the shape a
    // caller's segmented photo arrives in.
    const built = buildView(kernel, part, VIEW, {});
    const mask = rasterizeMeshMask(built.map((b) => b.mesh), "top");
    kernel.cleanup?.();

    const report = await inspect({
      matchTargets: [{ kind: "image", mask: { data: mask.data, width: mask.width, height: mask.height } }],
    });

    const [m] = report.match;
    expect(m.kind).toBe("image");
    expect(m.best.iou).toBeGreaterThan(0.9);
    expect(m.best.contourUnit).toBe("%bbox-diag");
    expect(m.best.iouScale).toBeUndefined();
  });

  test("a mixed image + profile pair is reported in input order, each scored its own way", async () => {
    // The shape a real caller sends: the user's reference photo alongside a profile
    // traced from it. Results are attributed by `kind` and input order — never by
    // index, since an unscoreable target is dropped rather than padded.
    const built = buildView(kernel, part, VIEW, {});
    const mask = rasterizeMeshMask(built.map((b) => b.mesh), "top");
    kernel.cleanup?.();

    const report = await inspect({
      matchTargets: [
        { kind: "image", mask: { data: mask.data, width: mask.width, height: mask.height } },
        { kind: "profile", rings: spacerRings() },
      ],
    });

    expect(report.match.map((m) => m.kind)).toEqual(["image", "profile"]);
    // Each target keeps its own comparison: the photo has no millimetres, the
    // profile does — one shared rasterization of the part, two different questions.
    expect(report.match[0].best.contourUnit).toBe("%bbox-diag");
    expect(report.match[0].best.iouScale).toBeUndefined();
    expect(report.match[1].best.contourUnit).toBe("mm");
    expect(report.match[1].best.iouScale).toBeGreaterThan(0.9);
    // Two targets, two independent delta frames.
    expect(report.match[0].delta.data).not.toBe(report.match[1].delta.data);
  });

  test("an inspect without matchTargets carries no match key at all", async () => {
    const report = await inspect({});
    expect(report.measure.subparts.length).toBeGreaterThan(0);
    expect(report.verify).toHaveProperty("ok");
    expect("match" in report).toBe(false);
  });

  test("an empty matchTargets list is the same as none", async () => {
    expect("match" in (await inspect({ matchTargets: [] }))).toBe(false);
  });

  test("a malformed target is skipped one at a time, never thrown and never fatal", async () => {
    const report = await inspect({
      matchTargets: [
        { kind: "nope" },
        { kind: "profile", rings: "not-an-array" },
        { kind: "image", mask: null },
        { kind: "profile", rings: spacerRings() },
      ],
    });
    // The three bad targets vanish; the good one still scores, and the geometry
    // report itself is untouched.
    expect(report.match).toHaveLength(1);
    expect(report.match[0].best.iou).toBeGreaterThan(0.9);
    expect(report.measure.subparts.length).toBeGreaterThan(0);
  });

  test("a target that nothing can be scored against is dropped, not reported as a zero", async () => {
    const report = await inspect({
      matchTargets: [{ kind: "image", mask: { data: new Uint8Array(64 * 64), width: 64, height: 64 } }],
    });
    expect("match" in report).toBe(false);
  });

  // The exact message partforge-cloud's requestReport has always sent: no `view` at
  // all, meaning "the default". buildView has no view default (viewSubParts returns []
  // for an unknown view without erroring), so before jobs.js defaulted the view
  // itself, this message built an EMPTY view: measure reported zero subparts and a
  // [0,0,0] bbox, match scored nothing, and verify still passed — every consumer
  // degraded silently. Regression-pinned on the wire shape, not on internals.
  test("an inspect with no view measures and scores the default view (the cloud's wire shape)", async () => {
    const report = await inspect({ view: undefined, matchTargets: [{ kind: "profile", rings: spacerRings() }] });

    expect(report.measure.subparts.length).toBeGreaterThan(0);
    expect(report.measure.aggregate.volume).toBeGreaterThan(0);
    expect(report.match).toHaveLength(1);
    expect(report.match[0].best.iou).toBeGreaterThan(0.9);
  });
});
