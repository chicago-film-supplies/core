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

import type { TaxProfileType } from "../schemas/mod.ts";
import {
  calculateItemPrice,
  computeItemTaxAmountCents,
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
export { computeItemTaxAmountCents, type Tax };

// The line-taxability rule lives in `orders.ts` for the same reason
// `computeItemTaxAmountCents` does — `taxes.ts` depends one-way on `orders.ts`, and
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
 *
 * **A profile added here needs a `taxes/` document with that exact name, or
 * `findTaxAt` returns `null` and the override silently does nothing.** That is
 * the failure mode `tax_paxton` was added to fix rather than to repeat: prod
 * #1978 was delivered to Paxton, Illinois, Xero taxed it `TAX005` at the 6.25%
 * IL-state rate, and CFS had no Paxton profile at all — so it fell back to
 * Rantoul's 9% and disagreed with Xero by $4.89 on top of the service-line tax
 * it should not have charged.
 */
export const TAX_PROFILE_OVERRIDE_NAME: Partial<Record<TaxProfileType, string>> =
  {
    tax_rantoul: "Rantoul Sales Tax",
    tax_frankfort: "Frankfort Sales Tax",
    tax_paxton: "Paxton Sales Tax",
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
 * - `tax_exempt` → `taxes = []`, `total_cents = subtotal_discounted_cents`.
 * - `tax_rantoul` / `tax_frankfort` → `taxes = [<resolved tax>]` with amount
 *   computed from the item's **existing** `subtotal_discounted_cents` + `total_cents`
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
    const subtotalDiscountedCents = item.price.subtotal_discounted_cents ?? 0;

    // A non-revenue line is not taxable under ANY profile. Without this clause
    // the location overrides re-taxed exactly the lines the Xero push then
    // strips to `TaxType: "NONE"` — a clean A/B in prod: #1647 (`tax_applied`)
    // held Delivery with `taxes: []`, while #2051 (`tax_rantoul`) had the same
    // product at the same COA carrying a 9% tax. Same rule as
    // `calculateItemTax`, so the profile path cannot reintroduce what the base
    // path now removes.
    if (!isTaxableCoa(item.coa_revenue)) {
      item.price.taxes = [];
      item.price.total_cents = subtotalDiscountedCents;
      continue;
    }

    if (effective === "exempt") {
      item.price.taxes = [];
      item.price.total_cents = subtotalDiscountedCents;
      continue;
    }

    const amountCents = computeItemTaxAmountCents(
      effective,
      subtotalDiscountedCents,
      item.quantity,
    );
    const modifier: PriceModifier = {
      uid: effective.uid,
      name: effective.name,
      rate: effective.rate,
      type: effective.type,
      amount_cents: amountCents,
    };
    item.price.taxes = [modifier];
    item.price.total_cents = subtotalDiscountedCents + amountCents;
  }
}

/**
 * **The one tax materializer.** Apply a document's `tax_profile` as a doc-level
 * override, then reprice every priceable line from its (rewritten) tax uid.
 * Mutates `items` in place; callers run `calculateOrderTotals` /
 * `calculateInvoiceTotals` afterwards.
 *
 * This is {@link overrideItemTaxesForProfile} **plus the reprice** — the pair
 * every write path that owns its own line prices needs, and the pair only the
 * order path had. `api-cloudrun`'s `repriceOrderItemsForProfile` was this
 * function for orders only; native `POST/PUT /invoices` called neither half, so
 * a `tax_exempt` invoice stored the profile, sent Xero `TaxType: NONE`, and kept
 * CFS items and totals fully taxed.
 *
 * Three consumers, one implementation: api-cloudrun's order write paths,
 * api-cloudrun's `createInvoice`/`updateInvoice`, and the manager's optimistic
 * recompute. The manager consumer is the reason this lives in `core` rather than
 * in `api-cloudrun/src/lib/` — a client-side reimplementation would recreate, on
 * the client, exactly the order/invoice divergence this function exists to
 * close.
 *
 * ⚠️ **The CRMS invoice webhook must keep calling the bare
 * {@link overrideItemTaxesForProfile}, not this.** Its subtotals are
 * `charge_total`-authoritative (api-cloudrun#236) — a reprice would recompute
 * them from `base_cents × quantity × days_factor` and under-bill, which
 * `crms.test.ts` pins at 28.6% on a real line.
 *
 * **`orgProfile` is a real parameter, not a constant.** The order path hardcoded
 * `"tax_applied"` here, so an org-level `tax_exempt` was honored on that
 * customer's invoices and silently ignored on their orders. Precedence is
 * {@link getEffectiveProfileTax}'s: `tax_exempt` from either side wins, then the
 * doc's location profile, then the org's.
 *
 * **Pure** — `asOf` is injected rather than defaulted to now, so this stays free
 * of an ambient clock (the workspace date rules ban `new Date()` for business
 * datetimes, and a defaulted `now` is how that ban gets bypassed). Callers
 * derive it: the order paths from the earliest destination delivery start, the
 * invoice paths from `invoice.date`.
 *
 * @param items Document items, mutated in place. Non-priceable members
 *   (destination/group/transaction_fee) are skipped by both halves.
 * @param orgProfile The customer organization's `tax_profile`.
 * @param docProfile The document's own `tax_profile`, which takes precedence.
 * @param taxCatalog The `taxes` collection, for name+date resolution.
 * @param asOf Instant to resolve the tax catalog at.
 */
export function materializeDocumentTax(
  items: LineItem[],
  orgProfile: TaxProfileType,
  docProfile: TaxProfileType,
  taxCatalog: Tax[],
  asOf: string,
): void {
  overrideItemTaxesForProfile(items, orgProfile, docProfile, taxCatalog, asOf);

  for (const item of items) {
    if (!isPreTaxItem(item)) continue;
    const computed = calculateItemPrice(item, taxCatalog);
    // A SPREAD, not a field-by-field rebuild. The order-side original listed
    // every key it meant to keep, which made preservation opt-in: `taxes_base`
    // had to be re-added later as a conditional spread once the rebuild was
    // found to be dropping it, and `base_percent` is still missing from that
    // list. It is inert there only because `isPreTaxItem` rejects the
    // `percent_of_total` lines that carry it — an accident, not a design.
    //
    // Spreading also makes this function shape-agnostic, which is what lets one
    // implementation serve both documents: an order price carries
    // `replacement_cents` and an invoice price carries `discount_percent`, both
    // strict-schema keys the other rejects, and neither is named here.
    item.price = {
      ...item.price,
      subtotal_cents: computed.subtotal_cents,
      subtotal_discounted_cents: computed.subtotal_discounted_cents,
      discount: computed.discount,
      taxes: computed.taxes,
      total_cents: computed.total_cents,
    };
  }
}
