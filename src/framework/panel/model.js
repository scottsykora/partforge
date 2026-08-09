// The pure panel model: canonical nodes in, render tree out, plus the condition
// evaluator. No DOM, no dependencies — partforge/lint imports this and
// test/lint-purity.test.js requires its whole closure to be dependency-free.

// The operator table IS the grammar. evalWhen dispatches through it and (from
// phase 5) `when-unknown-operator` builds its did-you-mean list from its keys,
// so adding an operator can never leave lint behind.
export const WHEN_OPS = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  ne: (a, b) => a !== b,
  in: (a, b) => Array.isArray(b) && b.includes(a),
};

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// A condition against raw params. Never throws: a malformed condition reads as
// false, because a panel that crashes is worse than a control that hides.
export function evalWhen(cond, params) {
  if (cond == null) return true;
  if (!isPlainObject(cond)) return false;
  for (const [key, want] of Object.entries(cond)) {
    if (key === "allOf") {
      if (!Array.isArray(want) || !want.every((c) => evalWhen(c, params))) return false;
    } else if (key === "anyOf") {
      if (!Array.isArray(want) || !want.some((c) => evalWhen(c, params))) return false;
    } else if (key === "not") {
      if (evalWhen(want, params)) return false;
    } else if (isPlainObject(want)) {
      const entries = Object.entries(want);
      if (entries.length === 0) return false;
      for (const [op, operand] of entries) {
        const fn = WHEN_OPS[op];
        if (!fn || !fn(params[key], operand)) return false;
      }
    } else if (params[key] !== want) {
      return false;
    }
  }
  return true;
}

// --- tree building ----------------------------------------------------------

// A group earns its place if anything survived inside it. Simpler than the
// predicate it replaces (controls.js:36-41), which needed a "has presets but no
// controls" special case — now a preset-only section just has one child.
const renders = (node) => node.kind !== "group" || node.children.length > 0;

// Drop hidden nodes and groups left empty, and stamp a stable id on everything.
// Ids are positional, so they are stable across rebuilds of the same schema; an
// authored `id` replaces the last segment.
function assign(nodes, prefix) {
  const out = [];
  nodes.forEach((node, i) => {
    if (node.hidden) return;
    const id = node.id ?? (prefix ? `${prefix}/${i}` : String(i));
    if (node.kind !== "group") {
      out.push({ ...node, id });
      return;
    }
    const built = { ...node, id, children: assign(node.children ?? [], id) };
    if (renders(built)) out.push(built);
  });
  return out;
}

export const buildTree = (canonical) => assign(canonical ?? [], "");

// Depth-first flat walk of the control leaves. Used by the renderer, by lint's
// range checks, and by anything that needs "every parameter this panel binds".
export function controlNodes(tree) {
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.kind === "group") walk(n.children);
      else if (n.kind === "control") out.push(n);
    }
  };
  walk(tree);
  return out;
}
