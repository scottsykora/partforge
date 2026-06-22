import { DEFAULTS, SECTIONS, derive } from "./drum/params.js";
import { buildSmallDrum, buildBigDrum, buildTensionerBlock, seatBlock } from "./drum/bodies.js";

// motor base offset, mirrors bodies.js
const baseH = (p) => (p.motor_mount ? p.motor_flange_t + p.motor_standoff_h : 0);
// extra gap beyond the gear centre distance so the drums sit close but don't touch.
// At the exact centre distance the blanks overlap 0.2 mm, so 0.3 leaves a 0.1 mm
// gap (blanks barely clear). mm.
const ASSEMBLY_GAP = 0.3;

export default {
  meta: { title: "Capstan Drum", units: "mm", background: 0x15181d },
  parameters: SECTIONS,
  defaults: DEFAULTS,
  derive,
  parts: {
    small: {
      label: "Small drum",
      views: ["both", "small"],
      export: { name: "small_drum" },
      build: (k, p, d, onProgress) => buildSmallDrum(k, p, d, onProgress),
      // display: always seated in the shared assembly frame (view-independent so
      // the mesh caches across views). export: assembled only in the "both" view.
      place: (solid, { view, purpose, p, d }) => {
        const off = [-(d.centerDist + ASSEMBLY_GAP), 0, -baseH(p)];
        if (purpose === "display") return solid.translate(off);
        return view === "both" ? solid.translate(off) : solid;
      },
    },
    big: {
      label: "Big drum",
      views: ["both", "big"],
      export: { name: "big_drum" },
      build: (k, p, d, onProgress) => buildBigDrum(k, p, d, onProgress),
    },
    block: {
      label: "Tensioner block",
      views: ["both"],
      enabled: (p) => p.tensioner_pocket_depth > 0,
      export: { name: "tensioner_block" },
      build: (k, p, d) => buildTensionerBlock(k, p, d), // flat / standalone (canonical)
      place: (solid, { purpose, p, d }) =>
        purpose === "display" ? seatBlock(solid, p, d) : solid,
    },
  },
  views: { both: { label: "Assembly" }, small: { label: "Small" }, big: { label: "Big" } },
};
