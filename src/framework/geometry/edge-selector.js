// Map partforge's declarative edge selector onto a replicad EdgeFinder filter.
//   undefined          → undefined (all edges)
//   (e) => e...         → passed through (raw replicad finder escape hatch)
//   { dir, inPlane, at, near } → a filter applying the given criteria (AND)
const AXIS = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

export function toEdgeFinder(selector) {
  if (selector == null) return undefined;
  if (typeof selector === "function") return selector;
  return (e) => {
    let f = e;
    if (selector.dir != null) f = f.inDirection(Array.isArray(selector.dir) ? selector.dir : AXIS[selector.dir]);
    if (selector.inPlane != null) f = f.inPlane(selector.inPlane, selector.at);
    if (selector.near != null) f = f.containsPoint(selector.near);
    return f;
  };
}
