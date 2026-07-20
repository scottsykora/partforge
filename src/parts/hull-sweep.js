// Demo part — a hull sweep. Showcases k.hull / k.hullChain: a row of circles of
// varying radius along an arched spine becomes either one convex blob (k.hull) or a
// smooth swept strap/taper (k.hullChain) — the capsule/rounded-slot/organic-taper
// payoff. Optionally bores a hole at each node (Shape2D.cutAll) to make a linkage.
// Open /hull-sweep.html after `npm run dev`. Toggle "Convex wrap" to see hull vs
// hullChain side by side.
import { circleProfile } from "partforge/geometry";

export default {
  meta: { title: "Hull sweep", units: "mm", background: 0x15181d },
  parameters: [
    {
      id: "sweep",
      title: "Sweep",
      description: "A row of circles along an arched spine. `k.hullChain` sweeps the hull from one to the next (a strap/taper); `k.hull` wraps them all in one convex outline (see the Mode toggle).",
      advanced: [
        { key: "nodes", label: "Nodes", unit: "", min: 2, max: 6, step: 1,
          description: "How many circles along the spine (2 = a single capsule)." },
        { key: "length", label: "Length", unit: "mm", min: 20, max: 120, step: 1,
          description: "Span from the first node to the last." },
        { key: "r0", label: "Start radius", unit: "mm", min: 2, max: 16, step: 0.5,
          description: "Radius of the first node." },
        { key: "r1", label: "End radius", unit: "mm", min: 1, max: 16, step: 0.5,
          description: "Radius of the last node — set it below the start for a taper." },
        { key: "bow", label: "Arch", unit: "mm", min: 0, max: 30, step: 1,
          description: "Vertical bow of the middle nodes. 0 = a straight strap; higher = a banana/arch." },
      ],
    },
    {
      id: "solid",
      title: "Solid",
      advanced: [
        { key: "thickness", label: "Thickness", unit: "mm", min: 1.5, max: 10, step: 0.5,
          description: "Extrude height." },
      ],
    },
    {
      id: "mode",
      title: "Mode",
      toggles: [
        { key: "wrap", label: "Convex wrap (k.hull instead of k.hullChain)", on: 1,
          description: "On: one convex hull of every node (a single convex blob). Off: the swept chain — the hull of each consecutive pair, unioned." },
        { key: "holes", label: "Bore a hole at each node", on: 1,
          description: "Cut a circular hole at every node (Shape2D.cutAll) — turns the strap into a linkage." },
      ],
    },
  ],
  defaults: { nodes: 3, length: 60, r0: 8, r1: 4, bow: 8, thickness: 4, wrap: 0, holes: 0 },
  parts: {
    sweep: {
      label: "Hull sweep",
      views: ["sweep"],
      export: { name: "hull-sweep" },
      build: (k, p) => {
        const n = Math.max(2, Math.round(p.nodes));
        const nodes = [];
        for (let i = 0; i < n; i++) {
          const t = i / (n - 1);
          nodes.push({ x: -p.length / 2 + t * p.length, y: p.bow * Math.sin(Math.PI * t), r: p.r0 + (p.r1 - p.r0) * t });
        }
        const circles = nodes.map((nd) => circleProfile(nd.r, [nd.x, nd.y]));
        let shape = p.wrap ? k.hull(circles) : k.hullChain(circles);
        if (p.holes)
          shape = shape.cutAll(nodes.map((nd) => circleProfile(Math.max(0.8, nd.r * 0.45), [nd.x, nd.y])));
        return k.extrude({ profile: shape, h: p.thickness });
      },
    },
  },
  views: { sweep: { label: "Hull sweep" } },
};
