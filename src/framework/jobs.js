// Names of the sub-parts a view shows: declared in the view and enabled for these
// params. Order follows Object.keys(part.parts) (definition order).
export function viewSubParts(part, view, params) {
  return Object.keys(part.parts).filter((name) => {
    const sp = part.parts[name];
    const inView = sp.views.includes(view);
    const on = sp.enabled ? !!sp.enabled(params) : true;
    return inView && on;
  });
}
