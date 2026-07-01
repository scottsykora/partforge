// The auto-regenerate state machine (no DOM, no workers — pure orchestration).
// mount.js wires it to the geometry service: `missingParts` reports what the
// active view still needs, `send` dispatches one build job for those parts.
//
// Invariants (pinned by test/framework/regen-loop.test.js):
// - nothing is sent until ready() (the worker announced its kernel);
// - at most one build is in flight; kicks while generating are absorbed and the
//   caller re-kicks after buildDone();
// - markDirty() bumps the params version and debounces a kick, so dragging a
//   slider queues one build per pause, not one per pixel;
// - a build that a mid-flight edit outdated is reported stale by buildDone()
//   (return false → the caller discards the meshes and kicks a rebuild).
export function createRegenLoop({ missingParts, send, debounceMs = 180 }) {
  let kernelReady = false;
  let generating = false;
  let paramsVersion = 0; // bumped on every settings edit
  let genVersion = -1;   // the params version the in-flight build is building
  let timer = null;

  function kick() {
    if (!kernelReady || generating) return; // re-kicked when the current build finishes
    const missing = missingParts();
    if (missing.length === 0) return;
    generating = true;
    genVersion = paramsVersion;
    send(missing);
  }

  return {
    kick,
    ready() { kernelReady = true; kick(); },
    markDirty() {
      paramsVersion++;
      clearTimeout(timer);
      timer = setTimeout(kick, debounceMs);
    },
    // The build finished (meshes / needs-occt / error). Returns whether its result
    // is still current; the caller applies the meshes only on true, then kicks.
    buildDone() {
      generating = false;
      return genVersion === paramsVersion;
    },
    version: () => paramsVersion,
  };
}
