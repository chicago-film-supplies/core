/**
 * Shared tax helpers for CFS applications — the single home for doc-level
 * `tax_profile` override logic + as-of Tax-catalog resolution, so the API
 * (orders + invoice webhook) and the manager (optimistic recompute) share one
 * implementation.
 *
 * Depends one-way on `./orders.ts` (base pricing module) — no cycle.
 *
 * @module
 */

import currency from "currency.js";
import type { TaxProfileType } from "../schemas/mod.ts";
import {
  computeItemTaxAmount,
  isPreTaxItem,
  isTaxableCoa,
  type LineItem,
  type PriceModifier,
  type Tax,
  TAXABLE_REVENUE_COAS,
} from "./orders.ts";

// Re-export the pure per-item tax formula so consumers can import everything
// tax-related from `@cfs/core/utils/taxes` (it lives in orders.ts to avoid a
// taxes ↔ orders import cycle).
export { computeItemTaxAmount, type Tax };

// The line-taxability rule lives in `orders.ts` for the same reason
// `computeItemTaxAmount` does — `taxes.ts` depends one-way on `orders.ts`, and
// the pricing engine there needs the gate. Re-exported so consumers can import
// everything tax-related from `@cfs/core/utils/taxes`.
export { isTaxableCoa, TAXABLE_REVENUE_COAS };

/**
 * Pick the Tax whose `[valid_from, valid_to)` bracket contains `asOf`, matched
 * by exact `name`. Returns null when nothing matches (e.g. `asOf` before any
 * historical doc). Throws on catalog drift (two same-name docs bracket the same
 * instant). A missing `valid_from` is treated as an open start; missing/null
 * `valid_to` as an open end.
 *
 * Comparison is by instant (ms since epoch), so Chicago-offset strings with
 * heterogeneous DST (-05:00 vs -06:00) compare correctly.
 */
export function findTaxAt(
  taxes: Tax[],
  name: string,
  asOf: string,
): Tax | null {
  const t = new Date(asOf).getTime();
  const matches = taxes.filter((tax) => {
    if (tax.name !== name) return false;
    if (tax.valid_from != null && t < new Date(tax.valid_from).getTime()) {
      return false;
    }
    if (tax.valid_to != null && t >= new Date(tax.valid_to).getTime()) {
      return false;
    }
    return true;
  });
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const detail = matches
      .map((m) => `${m.uid}@[${m.valid_from ?? "-∞"},${m.valid_to ?? "∞"})`)
      .join(", ");
    throw new Error(
      `Tax catalog drift: multiple "${name}" docs bracket ${asOf}: ${detail}`,
    );
  }
  return matches[0];
}

/**
 * Doc-level location tax profiles → the Tax doc `name` they resolve to (by
 * `findTaxAt`, as-of date). `tax_applied` (no override) and `tax_exempt`
 * (handled separately) are absent.
 */
export const TAX_PROFILE_OVERRIDE_NAME: Partial<Record<TaxProfileType, string>> =
  {
    tax_rantoul: "Rantoul Sales Tax",
    tax_frankfort: "Frankfort Sales Tax",
  };

/**
 * Resolve the effective doc-level override from the org + doc `tax_profile`
 * pair, as-of `asOf`. Precedence: `tax_exempt` wins (a tax-exempt customer pays
 * no tax regardless of location) → else the doc-level location profile
 * (doc over org) resolved to its Tax → else `null` (no override, `tax_applied`).
 *
 * @returns `"exempt"` (→ empty taxes) | a resolved `Tax` | `null` (no override).
 */
export function getEffectiveProfileTax(
  orgProfile: string,
  docProfile: string,
  taxCatalog: Tax[],
  asOf: string,
): Tax | "exempt" | null {
  // Doc-level profile takes precedence over the org's.
  const profiles = [docProfile, orgProfile];
  if (profiles.includes("tax_exempt")) return "exempt";
  for (const p of profiles) {
    const name = TAX_PROFILE_OVERRIDE_NAME[p as TaxProfileType];
    if (name) return findTaxAt(taxCatalog, name, asOf);
  }
  return null;
}

/**
 * Materialize a doc-level `tax_profile` override onto each priceable item's
 * `price.taxes` (single mode — mutates in place):
 * - `tax_exempt` → `taxes = []`, `total = subtotal_discounted`.
 * - `tax_rantoul` / `tax_frankfort` → `taxes = [<resolved tax>]` with amount
 *   computed from the item's **existing** `subtotal_discounted` + `total`
 *   refreshed. (Orders re-run `calculateItemPrice` after, which recomputes both
 *   from the rewritten uid; the CRMS invoice webhook keeps the amounts computed
 *   here on its `charge_total`-authoritative subtotal.)
 * - `tax_applied` / no active override doc → item left untouched.
 *
 * Non-priceable items (destination/group/transaction_fee) are skipped.
 */
export function overrideItemTaxesForProfile(
  items: LineItem[],
  orgProfile: string,
  docProfile: string,
  taxCatalog: Tax[],
  asOf: string,
): void {
  const effective = getEffectiveProfileTax(
    orgProfile,
    docProfile,
    taxCatalog,
    asOf,
  );
  if (effective === null) return;

  for (const item of items) {
    if (!isPreTaxItem(item)) continue;
    const subtotalDiscounted = item.price.subtotal_discounted ?? 0;

    // A non-revenue line is not taxable under ANY profile. Without this clause
    // the location overrides re-taxed exactly the lines the Xero push then
    // strips to `TaxType: "NONE"` — a clean A/B in prod: #1647 (`tax_applied`)
    // held Delivery with `taxes: []`, while #2051 (`tax_rantoul`) had the same
    // product at the same COA carrying a 9% tax. Same rule as
    // `calculateItemTax`, so the profile path cannot reintroduce what the base
    // path now removes.
    if (!isTaxableCoa(item.coa_revenue)) {
      item.price.taxes = [];
      item.price.total = subtotalDiscounted;
      continue;
    }

    if (effective === "exempt") {
      item.price.taxes = [];
      item.price.total = subtotalDiscounted;
      continue;
    }

    const amount = computeItemTaxAmount(
      effective,
      subtotalDiscounted,
      item.quantity,
    );
    const modifier: PriceModifier = {
      uid: effective.uid,
      name: effective.name,
      rate: effective.rate,
      type: effective.type,
      amount,
    };
    item.price.taxes = [modifier];
    item.price.total = currency(subtotalDiscounted).add(amount).value;
  }
}
