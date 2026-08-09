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

  const walk = (nodes, parentVisible) => {
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
        state.set(node.id, { visible, disabled, dimmed });
        walk(node.children, visible);
      } else {
        state.set(node.id, {
          visible, disabled,
          // Relevance is computed over parameter keys, so only a control can be
          // irrelevant. A preset node has no key; the legacy renderer never
          // dims the picker, and neither do we.
          dimmed: node.kind === "control" && !showAll && !relevant.has(node.key),
        });
      }
    }
  };

  walk(tree, true);
  return state;
}
