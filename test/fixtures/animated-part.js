// Two-view animated fixture for the CLI's cross-view `--animation` resolution
// and for opacity fades in headless stills.
//
// It lives here rather than reusing src/parts/hinged-box.js because the CLI
// tests need something the reference parts deliberately are not: a part whose
// animations sit in a NON-default view (`assembly`, not the first-declared
// `box`), so "which view does this animation belong to" is actually observable
// in the written filenames.
export default {
  meta: { title: "Anim Box", units: "mm" },
  parameters: [
    {
      id: "box",
      title: "Box",
      advanced: [
        { key: "width", label: "Width", unit: "mm", min: 20, max: 120, step: 1 },
        { key: "depth", label: "Depth", unit: "mm", min: 20, max: 120, step: 1 },
        { key: "height", label: "Height", unit: "mm", min: 10, max: 80, step: 1 },
        { key: "wall", label: "Wall", unit: "mm", min: 1.2, max: 5, step: 0.2 },
      ],
    },
    {
      id: "pose",
      title: "Pose",
      advanced: [
        { key: "lidAngle", label: "Lid angle", unit: "°", min: 0, max: 110, step: 1 },
        { key: "lidLift", label: "Lid lift", unit: "mm", min: 0, max: 60, step: 1 },
      ],
    },
  ],
  defaults: { width: 60, depth: 40, height: 24, wall: 2, lidAngle: 0, lidLift: 0 },
  parts: {
    base: {
      label: "Base",
      views: ["box", "assembly"],
      export: { name: "base" },
      build: (k, p) =>
        k.box({ min: [0, 0, 0], max: [p.width, p.depth, p.height] })
          .cut(k.box({ min: [p.wall, p.wall, p.wall], max: [p.width - p.wall, p.depth - p.wall, p.height + 1] })),
    },
    lid: {
      label: "Lid",
      views: ["box", "assembly"],
      export: { name: "lid" },
      build: (k, p) => k.box({ min: [0, 0, p.height], max: [p.width, p.depth, p.height + p.wall] }),
      place: (s, { purpose, p }) =>
        purpose === "export"
          ? s.translate([p.width + 10, 0, -p.height])
          : s.rotate(-p.lidAngle, [0, p.depth, p.height], [1, 0, 0]).translate([0, 0, p.lidLift]),
    },
  },
  views: {
    // The default view (first declared) carries an animation of its own, so a
    // `--animation` lookup that silently fell back to the default view would
    // find something rather than erroring — the failure mode worth pinning.
    box: {
      label: "Box",
      animations: {
        cycle: {
          label: "Open / close",
          duration: 2.4,
          loop: true,
          easing: "linear",
          tracks: { lidAngle: [[0, 0], [0.5, 110], [1, 0]] },
        },
      },
    },
    assembly: {
      label: "Assembly",
      animations: {
        open: {
          label: "Open lid",
          camera: "front",
          duration: 1.2,
          tracks: { lidAngle: [[0, 0], [1, 110]] },
        },
        assemble: {
          label: "Assemble",
          steps: [
            {
              label: "Lower the lid",
              camera: "left",
              duration: 1.0,
              tracks: { lidLift: [[0, 40], [1, 0]] },
              // Fades the lid in as it lands — the opacity track the headless
              // renderer has to honour.
              opacity: { lid: [[0, 0], [1, 1]] },
            },
            { label: "Open to check clearance", camera: "iso", duration: 1.0, tracks: { lidAngle: [[0, 0], [1, 110]] } },
          ],
        },
      },
    },
  },
};
