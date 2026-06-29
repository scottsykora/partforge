// Reusable design-for-manufacturing process profiles. `bed` is the build volume
// [x,y,z] in mm (a hard bbox-fit gate); `minWall` mm (a warn); `clearance` mm is
// carried for a future gap check (not enforced yet).
export const PROFILES = {
  "fdm-pla": { bed: [220, 220, 250], minWall: 1.2, clearance: 0.2 },
  "fdm-petg": { bed: [220, 220, 250], minWall: 1.5, clearance: 0.3 },
  "resin": { bed: [120, 68, 160], minWall: 0.6, clearance: 0.1 },
};

export function resolveProfile(spec) {
  if (typeof spec === "string") {
    if (!(spec in PROFILES)) {
      throw new Error(`unknown process profile: "${spec}" (known: ${Object.keys(PROFILES).join(", ")})`);
    }
    return { ...PROFILES[spec] };
  }
  if (spec && typeof spec === "object") {
    const base = spec.base ? resolveProfile(spec.base) : {};
    const { base: _drop, ...overrides } = spec;
    return { ...base, ...overrides };
  }
  throw new Error(`invalid process profile: ${JSON.stringify(spec)}`);
}
