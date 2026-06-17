/**
 * Shared product utility functions for CFS applications.
 *
 * ```ts
 * import { buildComponentEntries } from "@cfs/utilities/products";
 *
 * // When adding component B to product A, copy B's nested components
 * // into A's components array with adjusted paths:
 * const nested = buildComponentEntries("A", productB.components, 1);
 * ```
 *
 * @module
 */

import type { ProductComponent } from "@cfs/schemas";

/**
 * Remove a component and all its descendants from a flat components array.
 * An entry is removed if its `path` starts with the given path prefix —
 * this covers the component itself and every entry nested beneath it.
 *
 * @param components - The product's current `components` array
 * @param path - Full path of the component to remove (e.g. `["A", "B"]`)
 * @returns New array with the component and its descendants removed
 */
export function removeComponentEntries(
  components: ProductComponent[],
  path: string[],
): ProductComponent[] {
  return components.filter((comp) => {
    if (comp.path.length < path.length) return true;
    return !path.every((uid, i) => comp.path[i] === uid);
  });
}

/**
 * Build component entries for a parent product from a component product's
 * own `components` array. Each entry's `path` is prepended with `parentUid`
 * so it reflects its position in the parent's tree.
 *
 * No recursion needed — the source product's `components` already contains
 * its full descendant tree as a flat array.
 *
 * @param parentUid - UID of the product receiving the component
 * @param sourceComponents - The component product's own `components` array
 * @param baseDepth - Depth of the direct component in the parent (typically 1)
 * @param maxDepth - If set, exclude entries whose depth in the parent exceeds this
 * @returns New `ProductComponent[]` entries with adjusted paths
 */
export function buildComponentEntries(
  parentUid: string,
  sourceComponents: ProductComponent[],
  baseDepth: number,
  maxDepth?: number,
): ProductComponent[] {
  const entries: ProductComponent[] = [];

  for (const comp of sourceComponents) {
    const depth = baseDepth + comp.path.length;
    if (maxDepth != null && depth > maxDepth) continue;

    entries.push({
      ...comp,
      path: [parentUid, ...comp.path],
    });
  }

  return entries;
}
