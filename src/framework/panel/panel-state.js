// Every cross-cutting decision the panel makes about a node, in one pure pass.
// The renderer does nothing but apply the result.
//
// This is the rail-state.js / rail.js split applied to the panel: the tangled
// part isn't drawing controls, it's deciding which are visible, which are
// disabled and which are dimmed — three mechanisms acting on the same nodes.
// Computing them together, without a DOM, is what makes their interaction
// testable and keeps render.js small.
//
// The two mechanisms are deliberately independent and MUST stay visually
// distinct (see the spec): `when` hides or disables, relevance only dims.
import { evalWhen, controlNodes } from "./model.js";

// A panel with a handful of sections should present itself fully, not make the
// user click three times to see it. Beyond this many, collapsing wins: the rail
// is a fixed-height column and an eight-section part scrolls forever.
//
// Counting SECTIONS rather than controls is deliberate — an author can predict
// it at a glance, which matters because the rule shapes what their panel looks
// like on first load.
export const AUTO_OPEN_MAX_SECTIONS = 3;

const resolveOpen = (node, autoOpen) => {
  if (node.bare) return true;                    // no disclosure to open
  if (node.collapsed === true) return false;
  if (node.collapsed === false) return true;
  return autoOpen;                               // "auto" or unset
};

export function computeState(tree, { params, relevant }) {
  const state = new Map();
  const showAll = !(relevant instanceof Set);
  const autoOpen = tree.length <= AUTO_OPEN_MAX_SECTIONS;

  const walk = (nodes, parentVisible, isTop, parentDisabled) => {
    for (const node of nodes) {
      const passes = evalWhen(node.when, params);
      const hideOnFail = node.whenFalse !== "disable";
      const visible = parentVisible && (passes || !hideOnFail);
      // Disabled propagates like visible does: a disabled group disables its
      // whole subtree in the state itself, so render.js never has to walk
      // descendants (and get bitten by their sibling ordering) to apply it.
      const disabled = parentDisabled || (!passes && !hideOnFail);

      if (node.kind === "group") {
        // A group is dimmed when nothing inside it is relevant — the
        // .section-hidden behavior, generalized from sections to any group.
        const keys = controlNodes([node]).map((c) => c.key);
        const dimmed = !showAll && !keys.some((k) => relevant.has(k));
        // Only a TOP-LEVEL group gets `.section-hidden` (display:none). An inner
        // group merely dims, because collapsing an inner group out of the layout
        // on a relevance change makes the panel jump under the user's cursor.
        // Groups: only dimmedSection is consumed by the renderer today; inner-group dimmed is informational (controls dim individually).
        state.set(node.id, { visible, disabled, dimmed, dimmedSection: dimmed && isTop, open: resolveOpen(node, autoOpen) });
        walk(node.children, visible, false, disabled);
      } else {
        state.set(node.id, {
          visible, disabled, dimmedSection: false, open: true,
          // Relevance is computed over parameter keys, so only a control can be
          // irrelevant. A preset node has no key; the legacy renderer never
          // dims the picker, and neither do we.
          dimmed: node.kind === "control" && !showAll && !relevant.has(node.key),
        });
      }
    }
  };

  walk(tree, true, true, false);
  return state;
}
