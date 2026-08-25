// The backend-shared kernel front. Each backend builds its primitive mapping and
// returns finishKernel(kernel), which layers on everything that is NOT
// backend-specific:
//   - the options-object calling convention (op-options.js): one wrapper per
//     factory op normalizes an options-form call to positional args, then runs
//     the op's semantic check on the normalized args (both calling forms), then
//     calls the raw backend op — so backends stay positional and the solid
//     cache hashes normalized args;
//   - default compound-op compositions — a backend only overrides one when it has
//     a reason to (Manifold's boredCylinder hashes atomically for its solid cache);
//   - a KernelCapabilityError stub for toSTEP / shape2d when a backend lacks that
//     capability (Manifold can't do toSTEP; both backends now define shape2d, so
//     that stub is dead in practice — kept as a safety net for a future backend).
// The per-Solid twin of this layer is addSugar() in solid-sugar.js.
// opentype.js's namespace shape differs between bundler and Node resolution —
// see opentype-interop.js for the trap (it has bitten once in each direction).
import * as opentypeNamespace from "opentype.js";
import { normalizeOpentype, parseFont } from "./opentype-interop.js";
const opentype = normalizeOpentype(opentypeNamespace);
import { KernelCapabilityError } from "./errors.js";
import { isPlainOptions, KERNEL_OP_SPECS } from "./op-options.js";
import { textGlyphs } from "./text2d.js";
import { beveledExtrude } from "./rim-bevel.js";
import { DEFAULT_FONT_BYTES } from "./fonts/default-font.js";
import { convexHull, hullPoints } from "./hull.js";
import { latheRoundedRect, torusContour } from "./rounded-solids.js";
import { screwCrossSection } from "./screw-profile.js";
import { smoothLoftRings } from "./loft-smooth.js";

export function finishKernel(k) {
  // Compound default: bored-through cylinder (tool overshoots 2 mm each end for
  // a clean cut). Assigned BEFORE the wrap loop so the fallback composition gets
  // the same key validation as a backend-native override.
  k.boredCylinder ??= ({ od, h, bore }) =>
    k.cylinder(od / 2, od / 2, h).cut(k.cylinder(bore / 2, bore / 2, h + 4).translate([0, 0, -2]));

  // Compound defaults: rounded lathe solids — ONE revolve of an arc-exact
  // profile, so OCCT gets real torus/sphere/cylinder faces in STEP and
  // Manifold facets at the mesh LOD. Zero booleans; neither backend overrides.
  k.roundedCylinder ??= ({ r, h, center, round }) => {
    const s = k.revolve({ profile: k.shape2d(latheRoundedRect(r, h, round.top, round.bottom)) });
    return center ? s.translate([0, 0, -h / 2]) : s;
  };
  k.torus ??= ({ rMajor, rMinor }) =>
    k.revolve({ profile: k.shape2d(torusContour(rMajor, rMinor)) });

  // Compound default: a screw-motion sweep of an axial [[r, z]] profile. Exactly
  // k.extrude with a polar-remapped section and one full turn of twist per pitch
  // (see screw-profile.js for why that identity holds, and why the profile must be
  // densified first). No backend override: both backends twist natively, so this
  // is one implementation and STEP gets a real twisted B-rep rather than a loft.
  k.screwSweep ??= ({ profile, pitch, turns, lefthand = false }) =>
    k.extrude({
      profile: screwCrossSection(profile, pitch, { lefthand }),
      h: pitch * turns,
      twist: (lefthand ? -360 : 360) * turns,
    });

  // Compound default: spline-smoothed loft. On a mesh
  // kernel the shared Catmull-Rom densifier expands the sparse control sections in
  // both directions and plain loft stitches them. On a B-rep kernel that strategy
  // is both slow and fragile (native loft through dozens of dense wires aborted at
  // 48×128 in the spike), so it gets only the around-ring reconciliation and its
  // OWN smooth skin across stations (`ruled: false` — exact B-spline surfaces, and
  // ~10× faster). Parity is therefore screwSweep's tolerance class, not sweep's
  // by-construction class: measured ~0.4% volume divergence on the propeller reference part.
  // B-rep detection: `toSTEP` exists here only on a B-rep backend — the stub for
  // mesh kernels is assigned later in this function.
  const brepLoft = typeof k.toSTEP === "function";
  k.loftSmooth ??= ({ sections, stations, samples, shading = "smooth" }) =>
    brepLoft
      ? k.loft({ rings: smoothLoftRings(sections, { stations: "controls", samples }), ruled: false })
      : k.loft({ rings: smoothLoftRings(sections, { stations, samples }), shading });

  for (const [op, { toArgs, check }] of Object.entries(KERNEL_OP_SPECS)) {
    const raw = k[op];
    if (!raw) continue;
    k[op] = (...a) => {
      // toArgs gets the kernel's warning recorder: a couple of specs (roundedBox's
      // rim clamp) DEGRADE during normalization rather than throwing, and that
      // degrade has to reach the build's warning list, not just the console.
      const pos = a.length === 1 && isPlainOptions(a[0]) ? toArgs(a[0], k._recordWarning) : a;
      check?.(...pos);
      return raw(...pos);
    };
  }

  // extrude({ bevel }) desugars here — before the spec-wrapped op ever sees it —
  // into extrude + loft + intersect (rim-bevel.js), so both backends share one
  // implementation and the probe records no CAD-only op. beveledExtrude calls
  // back into the wrapped k.extrude/k.loft, so caching and validation apply.
  const specExtrude = k.extrude;
  k.extrude = (...a) =>
    a.length === 1 && isPlainOptions(a[0]) && a[0].bevel !== undefined
      ? beveledExtrude(k, a[0])
      : specExtrude(...a);

  k.toSTEP ??= () => { throw new KernelCapabilityError("toSTEP requires the OCCT backend"); };
  k.shape2d ??= () => { throw new KernelCapabilityError("shape2d requires the Manifold backend"); };

  // 2-D text as a Shape2D. Backend-agnostic: builds per-glyph Shape2Ds and unions
  // them. Fonts come from k._fonts (framework-preloaded by name) or inline bytes.
  k._fonts ??= new Map();
  // Parse inline bytes once per buffer, keyed by the buffer's own IDENTITY (a stable
  // import yields the same ArrayBuffer each build). WeakMap-by-buffer avoids the
  // wrong-font bug a byteLength key would cause. No separate text2d cache/fontId is
  // needed: text2d builds k.shape2d(glyphContours)+union, and the Shape2D hash keys
  // on the actual glyph coordinates — a different font → different geometry →
  // different cache entry, automatically.
  const byteCache = new WeakMap();                              // original view/buffer → parsed font
  const parseBytes = (arg) => {
    let f = byteCache.get(arg);
    if (!f) {
      // Key on the ORIGINAL arg (stable identity for the cache), but parse the view's
      // EXACT byte range — arg.buffer alone spans the whole (possibly pooled) backing
      // buffer, which would feed opentype garbage for a byteOffset>0 view.
      const buf = ArrayBuffer.isView(arg) ? arg.buffer.slice(arg.byteOffset, arg.byteOffset + arg.byteLength) : arg;
      f = parseFont(opentype, buf); byteCache.set(arg, f);
    }
    return f;
  };
  const resolveFont = (font) => {
    if (font == null) {
      // Lazily parse + memoize the framework's bundled default (vendored Roboto,
      // SIL OFL 1.1 — see fonts/Roboto-LICENSE.txt) so k.text2d works with zero
      // setup when { font } is omitted. Slice to the exact byte range rather than
      // handing opentype the raw .buffer — DEFAULT_FONT_BYTES is a Uint8Array and,
      // while it spans its own freshly-allocated buffer today (byteOffset 0), slicing
      // guards against that ever changing.
      if (!k._defaultFont) {
        const { buffer, byteOffset, byteLength } = DEFAULT_FONT_BYTES;
        k._defaultFont = parseFont(opentype, buffer.slice(byteOffset, byteOffset + byteLength), "the bundled default");
      }
      return k._defaultFont;
    }
    if (typeof font === "string") {
      const f = k._fonts.get(font);
      if (!f) throw new Error(`text2d: unknown font "${font}" — declare it in the part's \`fonts\` field`);
      return f;
    }
    return parseBytes(font);
  };
  k.text2d = (string, opts = {}) => {
    const { font, size = 10, align = "center", valign = "middle", lineHeight, tracking = 0, kerning = true } = opts;
    const parsed = resolveFont(font);
    const regions = textGlyphs(parsed, string, { size, align, valign, lineHeight, tracking, kerning });
    if (regions.length === 0) throw new Error("text2d: string produced no glyph geometry (empty or all-whitespace?)");
    return regions.map((r) => k.shape2d(r)).reduce((a, b) => a.union(b));
  };

  // Convex hull → Shape2D. Backend-agnostic: pure-JS monotone-chain hull of the inputs'
  // sampled points, lifted via k.shape2d. Faceted (curved inputs at a fixed LOD).
  k.hull = (inputs) => {
    if (!Array.isArray(inputs) || inputs.length === 0)
      throw new Error("hull: inputs must be a non-empty array");
    return k.shape2d(convexHull(inputs.flatMap(hullPoints)));
  };
  // Swept hull over an ordered sequence (≥2): union of the hull of each consecutive pair.
  k.hullChain = (inputs) => {
    if (!Array.isArray(inputs) || inputs.length < 2)
      throw new Error("hullChain: needs at least 2 inputs");
    let acc = null;
    for (let i = 0; i < inputs.length - 1; i++) {
      const seg = k.hull([inputs[i], inputs[i + 1]]);
      acc = acc ? acc.union(seg) : seg;
    }
    return acc;
  };

  return k;
}
