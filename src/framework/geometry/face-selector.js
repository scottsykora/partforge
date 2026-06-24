// Map partforge's declarative face selector onto a replicad FaceFinder filter.
//   undefined / null   → undefined (all faces)
//   (f) => f...         → passed through (raw replicad finder escape hatch)
//   { dir, inPlane, at, near } → a filter applying the given criteria (AND)
// dir picks faces whose normal runs along that axis (i.e. parallel to the
// perpendicular plane): X→YZ, Y→XZ, Z→XY.
const PERP_PLANE = { X: "YZ", Y: "XZ", Z: "XY" };

export function toFaceFinder(selector) {
  if (selector == null) return undefined;
  if (typeof selector === "function") return selector;
  return (f) => {
    let r = f;
    if (selector.dir != null) r = r.parallelTo(PERP_PLANE[selector.dir]);
    if (selector.inPlane != null) r = r.inPlane(selector.inPlane, selector.at);
    if (selector.near != null) r = r.containsPoint(selector.near);
    return r;
  };
}
