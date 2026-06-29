// Enumerate the parameter configurations verify() checks: the default config plus
// every declared preset (or an explicit part.verify.cases list).

function presetMap(part) {
  const map = {};
  for (const section of part.parameters ?? []) {
    if (!section.presets) continue;
    for (const [name, overrides] of Object.entries(section.presets)) {
      if (name in map) throw new Error(`duplicate preset name across sections: "${name}"`);
      map[name] = overrides;
    }
  }
  return map;
}

export function expandCases(part) {
  const presets = presetMap(part);
  const make = (name) => {
    if (name === "defaults") return { name, params: { ...part.defaults } };
    if (!(name in presets)) throw new Error(`unknown verify case "${name}" (not "defaults" or a preset)`);
    return { name, params: { ...part.defaults, ...presets[name] } };
  };
  const names = part.verify?.cases ?? ["defaults", ...Object.keys(presets)];
  return names.map(make);
}
