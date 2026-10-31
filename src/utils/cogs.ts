/**
 * The cost model, applied: a product's effective cost rules, and its
 * provider-billed activation entries.
 *
 * ```ts
 * import { cogsActivationEntry, effectiveCogs } from "@cfs/core/utils/cogs";
 * ```
 *
 * An activation entry is a DEFAULT: the formula (`uid_price_formula`) and dated
 * `rates` a supplier line takes when it is raised for the product. What a unit's
 * charge windows cost is decided by the line's own snapshot through the formula
 * engine (`@cfs/core/utils/price-formulas`), never here — the period cutter
 * that lived in this module (`billablePeriods`, `remainingUsageToBill`) retired
 * with purchases-as-documents D1/D5, and with it the refusal to bill past a
 * period counter: over-billing is now legal and flagged by the purchase↔bill
 * diff.
 *
 * @module
 */
import type { CogsActivationEntryType, CogsEntryType, Product } from "../schemas/mod.ts";

// ── Effective rules ──────────────────────────────────────────────────

/**
 * The account a `sale` product relieves inventory to when it states no `sale`
 * entry: `5000` "Cost of Goods Sold: Retail Inventory".
 *
 * ⚠️ **A code constant, deliberately not catalog-derived** (as tax classes'
 * `is_default_for` is). It replaces the literal `"5000"` the Xero item body
 * sent, one for one, so every existing product's item body is byte-identical
 * and nothing re-pushes.
 */
export const DEFAULT_SALE_COA_COST = 5000;

/**
 * A product's cost rules as every reader must see them: the stored `cogs`,
 * plus the TYPE default — a `sale` product with no stored `sale` entry gets
 * `{ trigger: "sale", formula: "average_cost", coa_cost: 5000 }`.
 *
 * The default is derived rather than stored because stamping it would be a
 * write to every sale product, and each product write fans out to a Xero item
 * sync and a Typesense reindex (`Product.cogs`'s docblock).
 */
export function effectiveCogs(product: Pick<Product, "type" | "cogs">): CogsEntryType[] {
  const stored = product.cogs ?? [];
  if (product.type !== "sale" || stored.some((e) => e.trigger === "sale")) return [...stored];
  return [
    { trigger: "sale", formula: "average_cost", label: "Inventory relief", coa_cost: DEFAULT_SALE_COA_COST },
    ...stored,
  ];
}

/** The activation entry `uid_cogs` names on a product, or `undefined`. */
export function cogsActivationEntry(
  product: Pick<Product, "cogs">,
  uid_cogs: string,
): CogsActivationEntryType | undefined {
  return product.cogs?.find((e): e is CogsActivationEntryType => e.trigger === "activation" && e.uid === uid_cogs);
}

/**
 * The activation entries on a product whose `provider` is `uid_supplier` — the
 * half of D5's auto-link predicate that reads the product rather than a
 * purchase line: a supplier is auto-linkable for a product when one of its
 * entries names it as provider.
 */
export function cogsActivationEntriesByProvider(
  product: Pick<Product, "cogs">,
  uid_supplier: string,
): CogsActivationEntryType[] {
  return (product.cogs ?? []).filter((e): e is CogsActivationEntryType =>
    e.trigger === "activation" && e.provider.uid === uid_supplier
  );
}

