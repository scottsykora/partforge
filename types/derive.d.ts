// partforge/derive — a lean, DOM-free entry so a part module (or a helper, or a
// test) can merge a grouped `derive` exactly the way the framework does.

import type { Derived, PartDefinition, ResolvedParams } from "./part.js";

/**
 * Resolve a part's `derive` into the derived-values object `d` builds receive.
 *
 * Both authoring forms are handled: one function computed in a single pass, or
 * named groups run in declaration order (each seeing the merged outputs of the
 * groups before it). A group that reads a key no earlier group produced throws.
 * Returns `{}` when the part declares no `derive`.
 */
export function resolveDerived(part: Pick<PartDefinition, "derive">, p: ResolvedParams): Derived;
