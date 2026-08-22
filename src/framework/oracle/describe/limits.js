// Report array caps. A plain-data module with NO IMPORTS AT ALL, deliberately.
//
// partforge-cloud's sandbox boundary treats everything crossing it as
// attacker-controlled and whitelists fields, types, AND sizes (protocol.js's
// sanitizeResult). Phase B needs these exact numbers on the far side of that boundary,
// and it must be able to read them without dragging the oracle's import graph into a
// browser bundle. Same idiom as cloud's own src/chat/profileLimits.js, and for the same
// reason.
//
// These are CEILINGS, not targets. A report that hits one is not broken; it says so
// through its `truncated` block and carries on.
export const DESCRIBE_LIMITS = {
  MAX_SURFACES: 200,
  MAX_EDGES: 400,
  MAX_FEATURES: 120,
  MAX_PATTERNS: 40,
  MAX_RESIDUAL_REGIONS: 20,
  MAX_SUGGESTION_STEPS: 60,
};
