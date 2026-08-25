// Example PartDefinition — the Shape2D-loft reference part. One rounded-square Shape2D
// is reused up the body with per-ring scales (structurally identical rings: OCCT lofts
// the original arc wires, so STEP keeps true circles); the shoulder morphs that square
// into a circle (structurally different rings: both backends loft the identical
// resampled sections). See docs/AUTHORING-PARTS.md for the conventions.
import { circleProfile } from "partforge/geometry";

export default {
  meta: { title: "Lofted Bottle", units: "mm" },
  parameters: [
    {
      id: "body",
      title: "Bottle",
      description: "A bottle lofted from a rounded-square base to a round neck (`k.loft` " +
        "with `Shape2D` rings). **Corner radius** shapes the base; **Belly** bulges the body.",
      presets: {
        "Flask": { width: 40, bodyH: 70, cornerR: 8, belly: 1.15, neckD: 22, neckH: 25 },
        "Square jar": { width: 60, bodyH: 50, cornerR: 6, belly: 1.0, neckD: 40, neckH: 12 },
        "Slim vial": { width: 24, bodyH: 60, cornerR: 10, belly: 1.05, neckD: 14, neckH: 20 },
      },
      advanced: [
        { key: "width", label: "Base width", unit: "mm", min: 20, max: 80, step: 1, description: "Across-flats width of the rounded-square base." },
        { key: "bodyH", label: "Body height", unit: "mm", min: 30, max: 120, step: 1, description: "Height of the square-section body." },
        { key: "cornerR", label: "Corner radius", unit: "mm", min: 1, max: 12, step: 0.5, description: "Base corner rounding — these arcs stay true circles in STEP." },
        { key: "belly", label: "Belly", min: 0.9, max: 1.4, step: 0.05, description: "Mid-body scale — above 1 bulges, below 1 pinches." },
        { key: "neckD", label: "Neck diameter", unit: "mm", min: 10, max: 50, step: 1, description: "Round neck diameter at the mouth." },
        { key: "neckH", label: "Neck height", unit: "mm", min: 8, max: 40, step: 1, description: "Height of the square-to-circle shoulder." },
      ],
    },
  ],
  defaults: { width: 40, bodyH: 70, cornerR: 8, belly: 1.15, neckD: 22, neckH: 25 },
  parts: {
    bottle: {
      label: "Bottle", views: ["bottle"], export: { name: "lofted-bottle" },
      build: (k, p) => {
        const half = p.width / 2;
        const r = Math.min(p.cornerR, half - 0.5); // fillet must fit the half-width
        const sq = k.shape2d([[-half, -half], [half, -half], [half, half], [-half, half]]).fillet(r);
        // Body: one Shape2D reused with per-ring scale → curve mode (STEP-exact arcs).
        const body = k.loft({ rings: [
          { polygon: sq, z: 0 },
          { polygon: sq, z: p.bodyH * 0.45, scale: p.belly },
          { polygon: sq, z: p.bodyH },
        ] }).label("Body");
        // Shoulder: rounded square → circle → resample mode (shared rings, both backends).
        const shoulder = k.loft({ rings: [
          { polygon: sq, z: p.bodyH },
          { polygon: circleProfile(p.neckD / 2), z: p.bodyH + p.neckH },
        ] }).label("Shoulder");
        return body.union(shoulder);
      },
    },
  },
  views: { bottle: { label: "Bottle" } },
  verify: {
    expect: {
      bottle: { holes: 0, bbox: "<=[120,120,165]" },
      _view: { overlaps: 0 },
    },
  },
};
