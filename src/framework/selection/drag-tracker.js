// Shared drag-threshold state machine: distinguishes a click from a
// click-terminated orbit/pan gesture. Multiple pointers are tracked (a second
// finger joining mid-gesture must not un-arm the drag flag — see
// selection-pick.test.js's "another pointer joins" case); the drag flag only
// resets once every pointer has lifted. Lifted out of selection/pick.js so
// measure-mode.js shares one implementation and one threshold instead of a
// second, divergent copy.
export function createDragTracker({ thresholdSquared = 16 } = {}) {
  const pointerStarts = new Map();
  let dragged = false;

  return {
    onDown(ev) {
      if (pointerStarts.size === 0) dragged = false;
      pointerStarts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    },
    onMove(ev) {
      const start = pointerStarts.get(ev.pointerId);
      if (!start || dragged) return;
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      dragged = dx * dx + dy * dy > thresholdSquared;
    },
    onUp(ev) {
      pointerStarts.delete(ev.pointerId);
    },
    onCancel(ev) {
      pointerStarts.delete(ev.pointerId);
      if (pointerStarts.size === 0) dragged = false;
    },
    // Reads and resets drag state for a click: call at the top of the click
    // handler, before deciding whether to act on it.
    consumeClick() {
      const wasDragged = dragged;
      pointerStarts.clear();
      dragged = false;
      return wasDragged;
    },
  };
}
