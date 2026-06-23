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
        // Booleans before fillets/chamfers: cut the bore first so the rounding ops
        // act on the final outer form (OCCT booleans on a heavily-rounded solid are
        // fragile). Out-of-range radii are skipped by the backend, not fatal.
        if (p.bore > 0) s = s.cut(k.cylinder(p.bore / 2, p.bore / 2, p.h + 2).translate([p.w / 2, p.d / 2, -1]));
        if (p.fillet > 0) s = s.fillet(p.fillet, { dir: "Z" });          // 4 vertical edges
        if (p.top > 0) s = s.fillet(p.top, { inPlane: "XY", at: p.h });   // top rim — curves all the way around
        if (p.chamfer > 0) s = s.chamfer(p.chamfer, { inPlane: "XY", at: 0 }); // base edges
        return s;
      },
    },
  },
  views: { box: { label: "Box" } },
};
