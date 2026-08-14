// Shared teardown helpers: run a list of cleanup steps in isolation (one
// step's throw must never skip the others), and capture/restore a DOM
// element's attributes across an attach/detach cycle. Lifted out of
// cutaway-controls.js (the original) so measure-controls.js and
// selection/hover.js — and anything else that wraps host DOM — share one
// implementation instead of drifting copies.

export function runCleanupSteps(steps, message) {
  const errors = [];
  for (const step of steps) {
    try { step(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

export function captureAttributes(element, names) {
  return new Map(names.map((name) => [name, {
    present: element.hasAttribute(name),
    value: element.getAttribute(name),
  }]));
}

export function restoreAttributes(element, attributes) {
  for (const [name, { present, value }] of attributes) {
    if (present) element.setAttribute(name, value);
    else element.removeAttribute(name);
  }
}
