/**
 * Shared product utility functions for CFS applications.
 *
 * ```ts
 * import { buildComponentEntries } from "@cfs/core/utils/products";
 *
 * // When adding component B to product A, copy B's nested components
 * // into A's components array with adjusted paths:
 * const nested = buildComponentEntries("A", productB.components, 1);
 * ```
 *
 * @module
 */

import {
  type AuthoredProductComponent,
  type ComponentPriceKeyType,
  type ProductComponent,
  type ProductTypeType,
  roundComponentQuantity,
  type StockMethodType,
} from "../schemas/mod.ts";
import { isDirectComponent } from "./order-lines.ts";

/**
 * Re-exported from `schemas/product.ts`, where it must live so `ProductSchema`'s
 * denormalization refinement can call it without inverting the strict
 * utils → schemas import direction. Import it from here — this is the writers'
 * entry point. (Same arrangement as `deriveName` in `utils/contact-name.ts`.)
 */
export { deriveProductImageUuids } from "../schemas/mod.ts";

/** Product types that have an inventory ledger. */
const LEDGER_TYPES: ReadonlySet<string> = new Set<ProductTypeType>(["rental", "sale"]);

/** A `stock_method` that carries a count. */
export type CountedStockMethod = Exclude<StockMethodType, "none">;

/**
 * True iff a product of this `type` has an inventory ledger (and so a
 * `stock/{P}` projection and a `stock-locks/{P}` token), counted or not.
 *
 * One of the two answers to "what stock does this product have?" — moved here
 * from `api-cloudrun/src/lib/productStock.ts` (which re-exports it) so the
 * manager's component fan-out (api-cloudrun#388) asks the same question the
 * API's ledger lifecycle does. Only `rental` and `sale` are physical: `service`,
 * `surcharge` and `transaction_fee` are billing lines, and `replacement` is the
 * billing stand-in for a lost rental unit, not a second copy of it.
 */
export function productHasLedger(type: ProductTypeType): boolean {
  return LEDGER_TYPES.has(type);
}

/**
 * True iff a product with this `type` + `stock_method` holds a COUNTED stock —
 * a ledger whose `quantity_held` is a number. `stock_method: "none"` has a
 * ledger with a `null` count (supply unbounded), so nothing can be moved
 * against it.
 *
 * A type predicate, so a guarded branch gets `bulk | serialized` for free.
 */
export function productCountsStock(
  type: ProductTypeType,
  stockMethod: StockMethodType,
): stockMethod is CountedStockMethod {
  return productHasLedger(type) && stockMethod !== "none";
}

/**
 * Remove a component and all its descendants from a flat components array.
 * An entry is removed if its `path` starts with the given path prefix —
 * this covers the component itself and every entry nested beneath it.
 *
 * @param components - The product's current `components` array
 * @param path - Full path of the component to remove (e.g. `["A", "B"]`)
 * @returns New array with the component and its descendants removed
 */
export function removeComponentEntries<T extends ProductComponent>(
  components: T[],
  path: string[],
): T[] {
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
export function buildComponentEntries<T extends ProductComponent>(
  parentUid: string,
  sourceComponents: T[],
  baseDepth: number,
  maxDepth?: number,
): T[] {
  const entries: T[] = [];

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

// ── Authoring a parent's components (core#130 row 9) ────────────────

/**
 * A component entry as a writer assembles it, before
 * {@link normalizeAuthoredComponents} fills the authored-side fields.
 * `price_overridden` is on the AUTHORED shape (only a parent authors an
 * override), so a draft may not carry it yet.
 */
export type ComponentDraft = ProductComponent & {
  price_overridden?: ComponentPriceKeyType[];
};

/**
 * **Normalize a parent's component drafts into the stored, authored shape** —
 * the one author, for the api's product writers and the manager's optimistic
 * `addComponent` alike (core#130 row 9). The manager did not sort, so its
 * optimistic order differed from the server's echo.
 *
 * - `price_overridden` defaults to `[]` — every path here either derived it
 *   already or built the entry from the source's own price, so nothing is
 *   overridden by construction.
 * - `inclusion_type` defaults to `"default"`; `zero_priced` to `false` (what an
 *   absent value already resolved to — every reader tests `=== true`).
 * - `quantity` is rounded to the stored 4dp ratio, and an OPTIONAL component's
 *   is `0`.
 * - Then {@link sortComponentsZeroPricedFirst}.
 *
 * Pure: returns fresh entries; the input is not mutated.
 */
export function normalizeAuthoredComponents(
  drafts: readonly ComponentDraft[] | undefined,
): AuthoredProductComponent[] {
  if (!drafts?.length) return [];
  const authored = drafts.map((c) => ({
    ...c,
    price_overridden: c.price_overridden ?? [],
    inclusion_type: c.inclusion_type ?? "default",
    zero_priced: c.zero_priced ?? false,
    quantity: c.inclusion_type === "optional" ? 0 : roundComponentQuantity(c.quantity),
  }));
  return sortComponentsZeroPricedFirst(authored);
}

/**
 * Stable-sort a `product.components` array so that within each parent's
 * direct-children block (keyed by `path.at(-1)`, a path of length ≤ 1 being the
 * root's), entries with `zero_priced === true` precede the rest. Position
 * across parent blocks is preserved — only same-parent siblings swap.
 * Mutates `components` in place and returns it; idempotent.
 */
export function sortComponentsZeroPricedFirst<T extends ProductComponent>(components: T[]): T[] {
  if (!components || components.length < 2) return components;
  const parentGroups = new Map<string, number[]>();
  components.forEach((c, i) => {
    const parentUid = isDirectComponent(c) ? "" : c.path[c.path.length - 1];
    let bucket = parentGroups.get(parentUid);
    if (!bucket) {
      bucket = [];
      parentGroups.set(parentUid, bucket);
    }
    bucket.push(i);
  });
  const sortedAt: T[] = components.slice();
  for (const indices of parentGroups.values()) {
    if (indices.length < 2) continue;
    const sortedIndices = indices.slice().sort((a, b) => {
      const az = components[a].zero_priced === true ? 0 : 1;
      const bz = components[b].zero_priced === true ? 0 : 1;
      if (az !== bz) return az - bz;
      return a - b;
    });
    for (let k = 0; k < indices.length; k++) {
      sortedAt[indices[k]] = components[sortedIndices[k]];
    }
  }
  for (let i = 0; i < components.length; i++) components[i] = sortedAt[i];
  return components;
}
