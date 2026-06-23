// Example part exercising native CAD ops — it auto-routes to the OCCT backend
// because it uses fillet (and chamfer when enabled). Vertical edges are rounded
// and an optional bore drilled; the base chamfer is off by default (turn it up to
// try chamfering, kept off in defaults so the gating build uses only the fillet).
export default {
  meta: { title: "Filleted Box", units: "mm", background: 0x15181d },
  parameters: [
    {
      id: "box", title: "Box",
      advanced: [
        { key: "w", label: "Width", unit: "mm", min: 10, max: 80, step: 1 },
        { key: "d", label: "Depth", unit: "mm", min: 10, max: 80, step: 1 },
        { key: "h", label: "Height", unit: "mm", min: 5, max: 40, step: 1 },
        { key: "fillet", label: "Edge fillet", unit: "mm", min: 0, max: 10, step: 0.5 },
        { key: "top", label: "Top fillet", unit: "mm", min: 0, max: 5, step: 0.5 },
        { key: "chamfer", label: "Base chamfer", unit: "mm", min: 0, max: 5, step: 0.5 },
        { key: "bore", label: "Bore", unit: "mm", min: 0, max: 24, step: 0.5 },
      ],
    },
  ],
  defaults: { w: 40, d: 30, h: 16, fillet: 3, top: 2, chamfer: 0, bore: 8 },
  parts: {
    body: {
      label: "Body",
      views: ["box"],
      build: (k, p) => {
        let s = k.box([0, 0, 0], [p.w, p.d, p.h]);
        // Ordering matters for robustness:
        //  1. Chamfer the base on the RAW box first — straight edges. (Filleting the
        //     verticals first would force the chamfer onto curved fillet arcs, which
        //     OCCT handles poorly and breaks the bottom face.)
        //  2. Then fillet the vertical edges, then the top rim.
        //  3. Cut the bore LAST (booleans on a cleanly-rounded solid are fine).
        // Each radius is clamped to the geometry so it can't consume a whole face.
        const half = Math.min(p.w, p.d) / 2;
        const chamfer = Math.min(p.chamfer, half - 0.5, p.h - 0.5);
        if (chamfer > 0) s = s.chamfer(chamfer, { inPlane: "XY", at: 0 });      // base edges (keeps the bottom face)
        const vFillet = Math.min(p.fillet, half - 0.5, p.h - 0.5);
        if (vFillet > 0) s = s.fillet(vFillet, { dir: "Z" });                   // 4 vertical edges
        const topFillet = Math.min(p.top, half - vFillet - 0.5, p.h / 2 - 0.5);
        if (topFillet > 0) s = s.fillet(topFillet, { inPlane: "XY", at: p.h });  // top rim — curves all the way around
        if (p.bore > 0) s = s.cut(k.cylinder(p.bore / 2, p.bore / 2, p.h + 2).translate([p.w / 2, p.d / 2, -1]));
        return s;
      },
    },
  },
  views: { box: { label: "Box" } },
};
