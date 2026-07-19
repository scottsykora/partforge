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
import opentype from "opentype.js";
import { KernelCapabilityError } from "./errors.js";
import { isPlainOptions, KERNEL_OP_SPECS } from "./op-options.js";
import { textGlyphs } from "./text2d.js";

export function finishKernel(k) {
  // Compound default: bored-through cylinder (tool overshoots 2 mm each end for
  // a clean cut). Assigned BEFORE the wrap loop so the fallback composition gets
  // the same key validation as a backend-native override.
  k.boredCylinder ??= ({ od, h, bore }) =>
    k.cylinder(od / 2, od / 2, h).cut(k.cylinder(bore / 2, bore / 2, h + 4).translate([0, 0, -2]));

  for (const [op, { toArgs, check }] of Object.entries(KERNEL_OP_SPECS)) {
    const raw = k[op];
    if (!raw) continue;
    k[op] = (...a) => {
      const pos = a.length === 1 && isPlainOptions(a[0]) ? toArgs(a[0]) : a;
      check?.(...pos);
      return raw(...pos);
    };
  }

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
      f = opentype.parse(buf); byteCache.set(arg, f);
    }
    return f;
  };
  const resolveFont = (font) => {
    if (font == null) {
      if (!k._defaultFont) throw new Error("text2d: no font — pass { font } (bytes or a declared name) or configure a default font");
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

  return k;
}
