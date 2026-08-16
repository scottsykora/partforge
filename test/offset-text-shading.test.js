import { afterAll, beforeAll, expect, test } from "vitest";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { bootManifoldKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });
afterAll(() => { k.cleanup(); });

const pointSegmentDistance = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const d2 = dx * dx + dy * dy;
  const t = d2 > 0
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / d2))
    : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};

test("offset text extrudes without divider lines across its flat cap", () => {
  const h = 3;
  const profile = k.text2d("Scott", { size: 10, align: "left", valign: "baseline" }).offset(1.5);
  const edges = profile.extrude({ h }).toMesh().edges;
  const rings = profile._regions.flatMap((r) => [r.outer, ...r.holes])
    .map((c) => tessellateContour(c, 116));
  const boundary = rings.flatMap((ring) => ring.map((a, i) => [a, ring[(i + 1) % ring.length]]));

  const interiorCapEdges = [];
  for (let i = 0; i < edges.length; i += 6) {
    if (Math.abs(edges[i + 2] - h) > 1e-5 || Math.abs(edges[i + 5] - h) > 1e-5) continue;
    const midpoint = [(edges[i] + edges[i + 3]) / 2, (edges[i + 1] + edges[i + 4]) / 2];
    if (boundary.every(([a, b]) => pointSegmentDistance(midpoint, a, b) > 1e-3))
      interiorCapEdges.push(Array.from(edges.slice(i, i + 6)));
  }

  expect(interiorCapEdges).toEqual([]);
});
