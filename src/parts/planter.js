// Example PartDefinition — a faceted planter / cup / vase. A second worked example
// alongside parts/demo.js (the Spacer): it shows a prism-based body (Manifold backend,
// so it stays fast — no OCCT), per-control descriptions, presets, an optional feature
// (drainage), a hidden internal constant (floor), and a derive() that turns raw inputs
// into the n-gon point lists and dependent dimensions the build consumes.
//
// Why it's a good demo: every control has an obvious reason to touch it before
// printing. Facets/twist are pure fun, height/diameter/taper fit it to your plant or
// pens, the drainage hole is a real functional choice (planter vs. cup), and dropping
// Wall below the fdm-pla 1.2 mm minimum trips partforge's min-wall warning.

// A regular n-gon of circumradius R, in the XY plane, as [[x,y],…] for k.prism.
// A small rotation seats a flat edge toward the viewer so even-sided shapes read right.
const ngon = (R, n) => {
  const pts = [];
  const offset = Math.PI / n - Math.PI / 2; // flat side facing -Y
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n + offset;
    pts.push([R * Math.cos(a), R * Math.sin(a)]);
  }
  return pts;
};

export default {
  meta: { title: "Faceted Planter", units: "mm", background: 0x15181d },
  parameters: [
    {
      id: "body",
      title: "Body",
      description:
        "The faceted vessel. Pick a preset to start, or open **Advanced** for exact dimensions. " +
        "**Facets** and **Twist** are pure styling; **Wall** is the one that decides whether it prints cleanly.",
      presets: {
        "Pen cup": { facets: 6, dia: 80, height: 100, taper: 1.0, twist: 0, drain: 0 },
        Planter: { facets: 8, dia: 90, height: 80, taper: 0.9, twist: 0, drain: 8 },
        Vase: { facets: 5, dia: 70, height: 150, taper: 1.12, twist: 40, drain: 0 },
      },
      advanced: [
        { key: "facets", label: "Facets", min: 3, max: 12, step: 1,
          description: "Number of flat sides around the body. Low counts read as crystalline; high counts approach a smooth cylinder." },
        { key: "dia", label: "Diameter", unit: "mm", min: 30, max: 150, step: 1,
          description: "Across-corners diameter at the base. Size it to the plant, pens, or shelf it has to fit." },
        { key: "height", label: "Height", unit: "mm", min: 20, max: 200, step: 1,
          description: "Overall height along the axis." },
        { key: "taper", label: "Top taper", min: 0.6, max: 1.4, step: 0.02,
          description: "Rim size relative to the base: below 1 tapers inward (planter), 1 is straight (cup), above 1 flares out (vase)." },
        { key: "wall", label: "Wall thickness", unit: "mm", min: 0.8, max: 4, step: 0.1,
          description: "Side-wall thickness. The fdm-pla profile wants **≥ 1.2 mm** — go thinner and partforge flags a min-wall warning." },
        { key: "twist", label: "Twist", unit: "°", min: 0, max: 180, step: 5,
          description: "Rotates the facets from base to rim for a spiral look. 0 keeps the facets vertical." },
        { key: "floor", label: "Floor thickness", unit: "mm", min: 1, max: 6, step: 0.5, hidden: true,
          description: "Internal: solid base thickness, fixed by the design. Hidden from the end user but still drives the geometry." },
      ],
    },
    {
      id: "drainage",
      title: "Drainage",
      description: "Optional drainage hole through the base — turn it on for a planter, off to hold water like a cup or vase.",
      features: [
        { label: "Drainage hole", key: "drain", on: 8,
          description: "Drills a centered hole of this diameter through the floor.",
          sliders: [{ key: "drain", label: "Hole diameter", unit: "mm", min: 3, max: 30, step: 1,
            description: "Diameter of the centered drainage hole." }] },
      ],
    },
  ],
  defaults: { facets: 6, dia: 70, height: 90, taper: 1.2, wall: 1.6, twist: 30, drain: 8, floor: 3 },
  // derive(): turn raw inputs into the n-gon point lists and dependent dimensions the
  // build needs, sized so the wall stays even (see build()).
  derive: (p) => {
    const Rout = p.dia / 2;
    // Offset the inner polygon inward by `wall` along the FACE normals, not the radius:
    // for a regular n-gon an edge offset of `wall` shrinks the circumradius by
    // wall / cos(π/n). This keeps the perpendicular wall = `wall` on every flat.
    // clamp only matters if wall is set past the slider bounds via the API
    const Rin = Math.max(Rout - p.wall / Math.cos(Math.PI / p.facets), 1);
    return {
      outerPts: ngon(Rout, p.facets),
      innerPts: ngon(Rin, p.facets),
      // Inner taper that holds the wall constant top-to-bottom even as the body flares:
      // pick it so inner_radius(top) = outer_radius(top) − wall.
      innerTaper: 1 + (Rout * (p.taper - 1)) / Rin,
      drainR: (p.drain + 0.2) / 2, // nominal hole + 0.2 mm print clearance, as a radius
    };
  },
  parts: {
    planter: {
      label: "Planter",
      views: ["planter"],
      export: { name: "planter" },
      build: (k, p, d) => {
        const body = k.prism(d.outerPts, p.height, { scaleTop: p.taper, twist: p.twist }).label("Faceted wall");
        // Hollow it. The cavity is built from z=0 sharing the body's exact twist RATE and
        // taper slope (f rescales the ~4 mm overshoot so the rates still match), so the
        // inner and outer facets stay radially aligned at every height — the wall can't
        // pinch when twisted. Then clip the cavity to z ≥ floor so the base stays solid.
        const f = (p.height + 4) / p.height;
        const cavity = k
          .prism(d.innerPts, p.height + 4, { scaleTop: 1 + (d.innerTaper - 1) * f, twist: p.twist * f })
          .intersect(k.box([-1e4, -1e4, p.floor], [1e4, 1e4, p.height + 10]))
          .label("Cavity");
        let s = body.cut(cavity);
        // Optional drainage hole straight through the base.
        if (p.drain > 0) s = s.cut(k.cylinder(d.drainR, d.drainR, p.floor + 4).at([0, 0, -2]).label("Drainage hole"));
        return s;
      },
    },
  },
  views: { planter: { label: "Planter" } },
  // Self-verification (see docs/AUTHORING-PARTS.md "Self-verification"): opt into the
  // FDM-PLA process profile (bed-fit gate + min-wall warning) and pin the design intent
  // — fits the bed, no interpenetration, and the RIGHT genus per case: verify runs
  // across every preset, and "Pen cup"/"Vase" turn the drain off, so `expect` is a
  // function of the case's params rather than one static hole count.
  verify: {
    process: "fdm-pla",
    expect: (p) => ({
      planter: { holes: p.drain > 0 ? 1 : 0, bbox: "<=[220,220,250]" },
      _view: { overlaps: 0 } /* _view = whole-model composite (not a named part) */,
    }),
  },
};
