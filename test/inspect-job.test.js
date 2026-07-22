import { describe, it, expect } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { handle } from "../src/framework/jobs.js";
import part from "../src/parts/planter.js";

describe("inspect job", () => {
  it("posts a report with measure + verify for the default view", async () => {
    const kernel = await bootManifoldKernel();
    const view = Object.keys(part.views)[0];
    const posts = [];
    await handle(kernel, part, { type: "inspect", view, params: {} }, (m) => posts.push(m));

    const report = posts.find((m) => m.type === "report");
    expect(report).toBeTruthy();
    expect(report.measure.subparts.length).toBeGreaterThan(0);
    expect(report.measure.subparts[0]).toHaveProperty("volume");
    expect(report.measure).toHaveProperty("overlaps");
    expect(report.verify).toHaveProperty("ok");
    expect(report.verify).toHaveProperty("failures");
  });
});
