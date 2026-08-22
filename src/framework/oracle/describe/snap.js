// Measurement -> intent. A tessellated CAD export puts a 12mm wall at 11.9976 and a
// clearance hole at 5.2996, and handing those numbers to an agent produces a part
// parameterised on scanning artefacts. Snapping converts them back into the numbers a
// human actually typed.
//
// The invariant that makes this safe: snapping NEVER destroys the measurement. Every
// snap returns {raw, to, note} and report.js writes both, so a reader can always see
// what was measured and what it was interpreted as, and disagree with the second
// without losing the first (spec §3.1 principle 3).
//
// Candidates are ordered coarsest-first and the FIRST match within tolerance wins, not
// the nearest. 11.4998 must become 11.5 rather than 11.5 losing to 12 on some
// tie-break, and a coarse-first walk with a tight band gives that for free.
//
// Pure leaf. See spec §2.7.

// Snap band, relative to the value. Tight enough that a real 11.73 never becomes 11.75,
// loose enough to absorb any chord tolerance a sane exporter produces.
export const SNAP_TOL_FRAC = 5e-4;
const ABS_FLOOR = 1e-4;          // below this a relative band is meaninglessly small

// ISO 273 metric clearance holes, close fit, in millimetres. Keyed by the drilled
// diameter a CAD model actually carries, which is what a mesh can show us — the thread
// size is the annotation, not the measurement.
//
// Checked against a live reference (ISO 273 close-fit column, cross-checked across
// multiple fastener-hardware references) rather than shipped as given: the brief's
// draft table used the *close*-fit diameters for M5-M10 (5.3, 6.4, 8.4, 10.5) but the
// *medium/normal*-fit diameters for M2-M4 (2.4, 2.9, 3.4, 4.5) while labelling every
// row "close fit" — an internally inconsistent table that would misidentify an M2/
// M2.5/M3/M4 close-fit hole as one size larger. Corrected M2-M4 to their true
// close-fit diameters (2.2, 2.7, 3.2, 4.3); M5-M10 were already correct and are
// unchanged.
const CLEARANCE = [
  { d: 2.2, note: "M2 clearance (close fit)" },
  { d: 2.7, note: "M2.5 clearance (close fit)" },
  { d: 3.2, note: "M3 clearance (close fit)" },
  { d: 4.3, note: "M4 clearance (close fit)" },
  { d: 5.3, note: "M5 clearance (close fit)" },
  { d: 6.4, note: "M6 clearance (close fit)" },
  { d: 8.4, note: "M8 clearance (close fit)" },
  { d: 10.5, note: "M10 clearance (close fit)" },
];

const near = (a, b) => Math.abs(a - b) <= Math.max(Math.abs(b) * SNAP_TOL_FRAC, ABS_FLOOR);

export function snapValue(raw, opts = {}) {
  if (!Number.isFinite(raw)) return null;
  const steps = opts.steps ?? [10, 5, 1, 0.5, 0.25, 0.1, 0.05];
  for (const step of steps) {
    const to = Math.round(raw / step) * step;
    // Re-round to kill float dust from the divide: 0.4999/0.5 -> 0.5, not 0.5000000001.
    const clean = Math.round(to * 1e6) / 1e6;
    if (clean !== 0 && near(raw, clean)) return { raw, to: clean, note: null };
  }
  return null;
}

export function snapHoleDiameter(raw) {
  for (const c of CLEARANCE) if (near(raw, c.d)) return { raw, to: c.d, note: c.note };
  return snapValue(raw);
}

// The coarsest step every value is a multiple of. Reported so the hints layer can
// propose parameters on that grid, and so a report reader can see at a glance whether
// the part was designed in whole millimetres or in something finer.
//
// Candidate list stops at 0.25, not 0.1: at SNAP_TOL_FRAC's band, any value written to
// one decimal place is *always* within tolerance of the nearest 0.1 multiple — that is
// what "one decimal place" means, independent of whether the part has any real grid.
// A 0.1 candidate therefore matches every input and never returns anything but a false
// positive; unlike 0.25, it carries no information. Confirmed by running the brief's
// original [10, 5, 2.5, 2, 1, 0.5, 0.25, 0.1] list against [3.1, 7.7, 11.3]: it reports
// {grid: 0.1, coverage: 1} instead of the `null` its own test requires.
export function inferGrid(values) {
  const finite = values.filter((v) => Number.isFinite(v) && Math.abs(v) > ABS_FLOOR);
  if (finite.length < 2) return null;
  for (const grid of [10, 5, 2.5, 2, 1, 0.5, 0.25]) {
    const hits = finite.filter((v) => near(v, Math.round(v / grid) * grid));
    if (hits.length === finite.length) return { grid, coverage: 1 };
  }
  return null;
}
