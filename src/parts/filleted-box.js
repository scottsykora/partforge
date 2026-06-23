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
        const half = Math.min(p.w, p.d) / 2;
        // Round the vertical edges, then the top rim — each clamped to the box so a
        // radius can't exceed the available material.
        const vFillet = Math.min(p.fillet, half - 0.5, p.h - 0.5);
        if (vFillet > 0) s = s.fillet(vFillet, { dir: "Z" });                   // 4 vertical edges
        const topFillet = Math.min(p.top, half - vFillet - 0.5, p.h / 2 - 0.5);
        if (topFillet > 0) s = s.fillet(topFillet, { inPlane: "XY", at: p.h });  // top rim — curves all the way around
        // Base chamfer AFTER the fillets, so it cuts a clean curve across the rounded
        // corners. Because it then runs onto the vertical fillets' bottom arcs, its
        // real geometric limit is the FILLET RADIUS — past that OCCT mangles the
        // bottom face. (With no vertical fillet the limit is the box half.) Clamp to it.
        const maxChamfer = (vFillet > 0 ? vFillet : half) - 0.5;
        const chamfer = Math.min(p.chamfer, maxChamfer, p.h - 0.5);
        if (chamfer > 0) s = s.chamfer(chamfer, { inPlane: "XY", at: 0 });       // base edges
        if (p.bore > 0) s = s.cut(k.cylinder(p.bore / 2, p.bore / 2, p.h + 2).translate([p.w / 2, p.d / 2, -1]));
        return s;
      },
    },
  },
  views: { box: { label: "Box" } },
};
