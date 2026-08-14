// Reference part for the 2-D editing surface (docs/AUTHORING-PARTS.md "Editing
// profiles"): a gasket plate whose outline is a curve-native `pathProfile` (one cubic
// bulge edge), with two bolt bosses unioned onto the bottom edge — their circular tabs
// centered exactly ON that edge, the coincident-edge boolean case paper.js has known
// rough edges around (see the design doc's "two carve-outs"). The corners are then
// rounded with `.fillet(…, { corners: "convex" })`, the bolt holes cut, an optional
// print-clearance offset applied, and the whole profile extruded.
//
// No `meta.backend` override: the geometry-free probe records the *op name* "fillet"
// regardless of whether it ran on a Solid or a Shape2D (see
// ERROR-PATTERNS.md#probe-routed-to-occt), so this build auto-routes to OCCT even
// though `Shape2D.fillet` is the same backend-identical implementation either way
// (KERNEL-CONTRACT.md "One shared implementation"). Forcing `meta.backend: "manifold"`
// would dodge that and preview faster, but the lint rule that catches an OCCT-only
// *Solid* op under a forced Manifold backend (`manifold-backend-uses-occt-op`) has the
// same op-name blind spot and would then misreport this part as broken — so this part
// takes the OCCT route and stays lint-clean. test/gasket-part.test.js still builds it
// directly against a Manifold kernel (bypassing detectBackend/lint entirely), since
// the two backends produce the same profile.
import { pathProfile, circleProfile } from "partforge/geometry";

// Pure dimension math shared with test/gasket-part.test.js, which re-derives the same
// 2-D profile with the free contour-ops/paper-bridge functions (no kernel) to check
// validateProfile/profileCorners/toContours-shaped output independent of the build.
// Exported alongside the default PartDefinition — still DOM-free and side-effect-free.
export function gasketGeometry(p) {
  const w2 = p.w / 2;
  const dep = p.w * 0.6;          // plate depth (top edge sits at y = dep)
  const bulge = p.w * 0.18;       // how far the top edge's cubic bulges outward
  const tabR = p.boltR + 1.5;     // boss radius — enough wall around the hole
  const tabX = p.w * 0.25;        // boss centers, symmetric about x = 0
  const tabSegs = 12;             // low-poly boss facets — a fillet needs a chord it can fit inside
  // Deterministic backoff (AUTHORING-PARTS "Editing profiles" — fillet throws rather
  // than clamping) so cornerR never overruns a boss's own facets or the margins/gap
  // between the outline and a boss, at any width/bolt-radius in the sliders' range.
  // The 0.5 factor covers `fillet`'s "soft cap" halving an edge's share whenever BOTH
  // its neighboring corners are selected too — true here, since `corners: "convex"`
  // selects every convex corner at once, including each boss's own facet corners.
  const marginX = w2 - tabX - tabR;   // material outboard of each boss
  const gapX = tabX - tabR;           // half the gap between the two bosses
  const filletR = Math.max(0, Math.min(p.cornerR, (marginX - 0.3) / 2, (gapX - 0.3) / 2, dep * 0.2, tabR * 0.4));
  return { w2, dep, bulge, tabR, tabX, tabSegs, filletR };
}

export default {
  meta: { title: "Gasket", units: "mm", background: 0x15181d },
  parameters: [
    {
      id: "gasket",
      title: "Gasket",
      description: "A curvy gasket plate with two bolt bosses. Demonstrates `pathProfile`, `Shape2D.union`/`.fillet`/`.cut`/`.offset`, and a coincident-edge boolean (the bosses straddle the outline's bottom edge).",
      controls: [
        { key: "w", label: "Width", unit: "mm", min: 24, max: 80, step: 1,
          description: "Overall plate width. The plate's depth, bulge, and boss spacing all scale from this one dimension." },
        { key: "h", label: "Thickness", unit: "mm", min: 1, max: 8, step: 0.5,
          description: "Plate thickness (the extrusion height)." },
        { key: "boltR", label: "Bolt hole radius", unit: "mm", min: 1, max: 2.5, step: 0.1,
          description: "Radius of each mounting hole, cut through the boss at the end." },
        { key: "cornerR", label: "Corner radius", unit: "mm", min: 0, max: 4, step: 0.25,
          description: "Fillet applied to every convex corner (`Shape2D.fillet`). Automatically backed off if the plate/bosses are too small to fit it — see the build's `filletR` clamp." },
        { key: "clearance", label: "Print-clearance offset", unit: "mm", min: 0, max: 1, step: 0.1,
          description: "Grows the whole outline outward (round corners) for a looser slip fit. 0 = none." },
      ],
    },
  ],
  defaults: { w: 44, h: 3, boltR: 1.6, cornerR: 2, clearance: 0 },
  parts: {
    gasket: {
      label: "Gasket",
      views: ["gasket"],
      export: { name: "gasket" },
      build: (k, p) => {
        const { w2, dep, bulge, tabR, tabX, tabSegs, filletR } = gasketGeometry(p);

        // Curve-native outline: straight sides and bottom, one cubic bulge across the
        // top. `close()` leaves the bottom-left→start edge implicit; contour-ops
        // re-closes it explicitly wherever that matters (corner/fillet math).
        const outline = pathProfile([-w2, 0])
          .lineTo([w2, 0])
          .lineTo([w2, dep])
          .cubicTo([-w2, dep], [w2 * 0.5, dep + bulge], [-w2 * 0.5, dep + bulge])
          .close();

        // Boss centers sit exactly ON the bottom edge (y = 0) — the coincident-edge
        // union case: each tab straddles the existing straight edge rather than
        // merely touching it at a point.
        const tabs = [[-tabX, 0], [tabX, 0]].map(([cx, cy]) => circleProfile(tabR, [cx, cy], tabSegs));

        // Fillet the outer convex corners, THEN cut the bolt holes. Note this ordering
        // trades away the STEP-CIRCLE fidelity the "fillet after booleans" rule buys
        // (AUTHORING-PARTS.md "Editing profiles"): the hole cuts are themselves paper.js
        // booleans, so they degrade the fillet's true `{to,via}` arcs back to cubic
        // approximations before export. That's fine here — the fillet still reads as a
        // rounded corner (curve-exact until the cut, faceted-cubic after) — but a part
        // that needs an exact STEP CIRCLE on a filleted corner should cut first and
        // fillet last instead.
        let plate = k.shape2d(outline).union(tabs[0]).union(tabs[1]);
        if (filletR > 0) plate = plate.fillet(filletR, { corners: "convex" });
        plate = plate.cut(circleProfile(p.boltR, [-tabX, 0])).cut(circleProfile(p.boltR, [tabX, 0]));
        if (p.clearance) plate = plate.offset(p.clearance);

        return plate.extrude({ h: p.h });
      },
    },
  },
  views: { gasket: { label: "Gasket" } },
  // `holes` is Manifold-only topology (ERROR-PATTERNS.md#occt-holes-watertight-na),
  // and this part auto-routes to OCCT (no meta.backend override — see the module
  // comment), so the gate stays on the two facts that hold on both backends;
  // test/gasket-part.test.js's genus() === 2 check covers the hole count directly
  // against a Manifold build instead.
  verify: {
    process: "fdm-pla",
    expect: {
      gasket: { bbox: "<=[60,50,6]" },
      _view: { overlaps: 0 },
    },
  },
};
