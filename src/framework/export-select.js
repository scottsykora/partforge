// Pure selection helpers for headless export. No kernel, no DOM.

export function partLabel(part, name) {
  return part.parts[name]?.label ?? name;
}

// The union of sub-parts eligible for export, independent of the active view:
// exportable (not exportable:false) AND enabled under the current params.
export function exportablePartNames(part, params) {
  return Object.keys(part.parts).filter((name) => {
    const sp = part.parts[name];
    if (sp.exportable === false) return false;
    return sp.enabled ? !!sp.enabled(params) : true;
  });
}
