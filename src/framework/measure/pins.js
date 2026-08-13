// PURE pin store for measurement mode. Pins are PER-VIEW and keyed on stable
// identity — (subPart, featureLabel|null, occurrence) — not on geometry, so a
// regenerate re-resolves them by label (dormant when the label is gone, revived
// when it returns). `occurrence` disambiguates duplicate labels: it counts
// same-label features earlier in the features table.
const keyString = ({ subPart, featureLabel, occurrence }) =>
  `${subPart}\n${featureLabel}\n${occurrence}`;

export function occurrenceOf(features, featureId) {
  const label = features[featureId - 1];
  let n = 0;
  for (let i = 0; i < featureId - 1; i++) if (features[i] === label) n++;
  return n;
}

export function createPinStore() {
  const byView = new Map(); // view -> Map(keyString -> key)
  const viewMap = (view) => {
    let m = byView.get(view);
    if (!m) { m = new Map(); byView.set(view, m); }
    return m;
  };
  return {
    // -> true when the pin was added, false when it was removed
    toggle(view, key) {
      const m = viewMap(view), ks = keyString(key);
      if (m.has(ks)) { m.delete(ks); return false; }
      m.set(ks, { ...key, occurrence: key.occurrence ?? 0 });
      return true;
    },
    has: (view, key) => viewMap(view).has(keyString(key)),
    list: (view) => [...viewMap(view).values()],
    clear: (view) => { viewMap(view).clear(); },
    count: (view) => viewMap(view).size,
  };
}
