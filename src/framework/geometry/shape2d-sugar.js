// Backend-shared Shape2D front. Like solid-sugar for Solids, but the 2-D shared
// surface is small: .simple() unwraps a single-region materialization or throws.
// Backends attach the geometry ops (booleans, area, boundingBox, toRegions).
export function addShape2dSugar(s) {
  s.simple = () => {
    const regions = s.toRegions();
    if (regions.length !== 1) throw new Error(`Shape2D.simple: result has ${regions.length} regions, not 1 (use toRegions())`);
    return regions[0];
  };
  return s;
}
