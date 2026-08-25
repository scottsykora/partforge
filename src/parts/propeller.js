// The k.loftSmooth reference part: a boat propeller — bored hub + N airfoil
// blades, each blade a spline-interpolated loft of 5 sparse control sections.
// The "Surface" section keeps the didactic A/B: untick **Smooth** to see the raw
// k.loft of the same control sections. Spec:
// docs/superpowers/specs/2026-08-24-loft-smooth-design.md

// NACA-4-ish airfoil contour, closed and CCW, centered near the quarter chord so
// per-ring `rotate` twists about a sensible pitch axis. `n` points per surface;
// cosine spacing clusters points at the leading edge, which is exactly the uneven
// spacing the centripetal densifier is supposed to handle.
const airfoil = (chord, thickPct, camberPct, n) => {
  const t = thickPct / 100, m = camberPct / 100, p = 0.4;
  const yt = (x) => 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  const yc = (x) => (x < p ? (m / (p * p)) * (2 * p * x - x * x) : (m / ((1 - p) ** 2)) * (1 - 2 * p + 2 * p * x - x * x));
  const upper = [], lower = [];
  for (let i = 0; i <= n; i++) {
    const x = (1 - Math.cos((i / n) * Math.PI)) / 2; // cosine spacing, LE→TE
    upper.push([x, yc(x) + yt(x)]);
    lower.push([x, yc(x) - yt(x)]);
  }
  // TE→LE along the top, LE→TE along the bottom; drop duplicated LE/TE points.
  const pts = [...upper.reverse().slice(0, -1), ...lower.slice(1)];
  return pts.map(([x, y]) => [(x - 0.3) * chord, y * chord]);
};

// Five control stations up the span: a propeller-y chord outline (widest mid-span,
// closing toward a rounded tip) and a root→tip pitch-angle washout.
const SPAN_T = [0, 0.3, 0.6, 0.85, 1];
const CHORD_MUL = [1, 1.12, 1.0, 0.72, 0.28];
const bladeSections = (p) =>
  SPAN_T.map((t, i) => ({
    polygon: airfoil(
      (p.rootChord + (p.tipChord - p.rootChord) * t) * CHORD_MUL[i],
      p.thickness * (1 - 0.45 * t), // blades thin toward the tip
      p.camber,
      p.sectionPts,
    ),
    z: p.span * t,
    rotate: p.twistRoot + (p.twistTip - p.twistRoot) * t,
  }));

export default {
  meta: { title: "Propeller", units: "mm", background: 0x15181d },
  parameters: [
    {
      id: "prop",
      title: "Propeller",
      description: "A boat propeller: bored hub + airfoil blades. The blade is the organic-surface exerciser — every surface is a `loftSmooth` of 5 sparse control sections.",
      controls: [
        { key: "blades", label: "Blades", min: 2, max: 6, step: 1 },
        { key: "span", label: "Blade span", unit: "mm", min: 30, max: 120, step: 1 },
        { key: "rootChord", label: "Root chord", unit: "mm", min: 10, max: 50, step: 1 },
        { key: "tipChord", label: "Tip chord", unit: "mm", min: 6, max: 40, step: 1 },
        { key: "twistRoot", label: "Root pitch", unit: "°", min: 0, max: 80, step: 1,
          description: "Blade angle at the root. 0° puts the chord in the rotation plane." },
        { key: "twistTip", label: "Tip pitch", unit: "°", min: 0, max: 80, step: 1 },
        { key: "thickness", label: "Thickness", unit: "%", min: 4, max: 25, step: 1,
          description: "Airfoil thickness as % of chord, at the root." },
        { key: "camber", label: "Camber", unit: "%", min: 0, max: 12, step: 1 },
        { type: "group", title: "Hub", collapsed: "auto", controls: [
          { key: "hubD", label: "Hub diameter", unit: "mm", min: 14, max: 60, step: 1 },
          { key: "hubH", label: "Hub length", unit: "mm", min: 10, max: 60, step: 1 },
          { key: "boreD", label: "Shaft bore", unit: "mm", min: 2, max: 20, step: 0.5 },
        ] },
      ],
    },
    {
      id: "surface",
      title: "Surface",
      description: "**Smooth** interpolates the 5 sparse control sections with `loftSmooth`; off shows the raw `k.loft` of the same sections. **Stations/Samples** are the densifier resolution; **Section points** is how sparse the control sections are.",
      controls: [
        { key: "smooth", type: "checkbox", label: "Smooth (loftSmooth)",
          description: "A/B toggle: spline-densified vs raw loft of identical control sections." },
        { key: "stations", label: "Stations", min: 5, max: 128, step: 1, when: { smooth: 1 } },
        { key: "samples", label: "Samples / ring", min: 16, max: 512, step: 4, when: { smooth: 1 } },
        { key: "sectionPts", label: "Section points", min: 6, max: 40, step: 1,
          description: "Points per airfoil *surface* in each control section — the sparse input both paths share." },
      ],
    },
  ],
  defaults: {
    blades: 3, span: 70, rootChord: 26, tipChord: 16, twistRoot: 62, twistTip: 30,
    thickness: 12, camber: 6, hubD: 30, hubH: 26, boreD: 8,
    smooth: 1, stations: 48, samples: 128, sectionPts: 12,
  },
  parts: {
    propeller: {
      label: "Propeller", views: ["propeller"], export: { name: "propeller" },
      build: (k, p) => {
        const sections = bladeSections(p);
        const bladeUp = p.smooth
          ? k.loftSmooth({ sections, stations: p.stations, samples: p.samples })
          : k.loft({ rings: sections });
        // Built span-up (+Z); lay it radial along +X — the airfoil chord then sits
        // in the axis/rotation-plane frame, so `rotate` above reads as pitch angle.
        // Root sinks to 62% of hub radius so the union has generous overlap.
        const blade = bladeUp.rotateY(90).translate([p.hubD * 0.31, 0, 0]).label("Blade");
        const blades = [];
        for (let i = 0; i < p.blades; i++) blades.push(blade.clone().rotateZ((360 / p.blades) * i));
        const hub = k.cylinder({ r: p.hubD / 2, h: p.hubH })
          .translate([0, 0, -p.hubH / 2]).label("Hub")
          .cut(k.cylinder({ r: p.boreD / 2, h: p.hubH + 4 }).translate([0, 0, -p.hubH / 2 - 2]).label("Bore"));
        return k.union([hub, ...blades]);
      },
    },
  },
  views: { propeller: { label: "Propeller" } },
  verify: {
    expect: {
      // One through-hole (the shaft bore); everything unioned into one watertight body.
      propeller: { holes: 1, bbox: "<=[300,300,300]" },
      _view: { overlaps: 0 },
    },
  },
};
