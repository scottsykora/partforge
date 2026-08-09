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

export function computeState(tree, { params, relevant }) {
  const state = new Map();
  const showAll = !(relevant instanceof Set);

  const walk = (nodes, parentVisible, isTop) => {
    for (const node of nodes) {
      const passes = evalWhen(node.when, params);
      const hideOnFail = node.whenFalse !== "disable";
      const visible = parentVisible && (passes || !hideOnFail);
      const disabled = !passes && !hideOnFail;

      if (node.kind === "group") {
        // A group is dimmed when nothing inside it is relevant — the
        // .section-hidden behavior, generalized from sections to any group.
        const keys = controlNodes([node]).map((c) => c.key);
        const dimmed = !showAll && !keys.some((k) => relevant.has(k));
        // Only a TOP-LEVEL group gets `.section-hidden` (display:none). An inner
        // group merely dims, because collapsing an inner group out of the layout
        // on a relevance change makes the panel jump under the user's cursor.
        state.set(node.id, { visible, disabled, dimmed, dimmedSection: dimmed && isTop });
        walk(node.children, visible, false);
      } else {
        state.set(node.id, {
          visible, disabled, dimmedSection: false,
          // Relevance is computed over parameter keys, so only a control can be
          // irrelevant. A preset node has no key; the legacy renderer never
          // dims the picker, and neither do we.
          dimmed: node.kind === "control" && !showAll && !relevant.has(node.key),
        });
      }
    }
  };

  walk(tree, true, true);
  return state;
}
