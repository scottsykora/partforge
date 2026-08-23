// CLI-facing fixture for the `volumeShareReason: "rejected"` path (fix round 2,
// IMPORTANT 2): a 300x300x50mm block with a 3mm-diameter through-hole whose volume
// (~353mm3) sits well under accept.js's MIN_GAIN_FRACTION threshold (1e-4 of the
// ~4.5M mm3 block) — a candidate the acceptance loop reaches, builds, and evaluates
// (default --budget of 48 is never remotely threatened by 2 candidates), but whose
// gain never wins a round. Genuinely different from "budget" (test/fixtures/
// describe-washer-part.js's f1 at a starved --budget) and from "not-proposed"
// (that same fixture's f2, a `revolve` — a type `toCandidate` never proposes at all).
export default {
  meta: { title: "describe-rejected fixture", units: "mm" },
  imports: { scan: new URL("./describe-rejected.stl", import.meta.url) },
  parameters: [],
  defaults: {},
  parts: { body: { build: (k) => k.import("scan") } },
  views: { default: { label: "Default" } },
};
