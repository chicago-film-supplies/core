/**
 * Shared invoice utility functions for CFS applications.
 * Re-exports generic item helpers from orders and adds invoice-specific utilities.
 *
 * ```ts
 * import { flattenForXero, isPriceableItem, syncOrderItems } from "@cfs/core/utils/invoices";
 *
 * const billableItems = flattenForXero(invoice.items);
 * ```
 *
 * @module
 */

export {
  calculateItemDiscountCents,
  calculateItemPrice,
  calculateItemSubtotal,
  calculateItemTax,
  computeItemPaths,
  getItemSubtreeRange,
  getParentProductUid,
  getStructuralUids,
  type Discount,
  isPriceableItem,
  isPreTaxItem,
  isPreTaxPricingItem,
  isTransactionFeeItem,
  type StructuralItem,
  type ItemPathIssue,
  type ItemUniquenessIssue,
  type LineItem,
  type PriceModifier,
  type PriceObject,
  type PricingItem,
  type PricingPrice,
  type PreTaxPricingItem,
  type Tax,
  type ConsolidatedItem,
  type GroupPath,
  type PreTaxLineItem,
  type TransactionFeeLineItem,
  type PriceableLineItem,
  validateItemPaths,
  validateItemUniqueness,
} from "./orders.ts";
import { type PairChargeWindows, priceLine, windowChargeableDays } from "./price-document.ts";

/**
 * The **shared document sub-interface** — helpers a template partial may call
 * for either family.
 *
 * These five are named `order*` and live in `src/utils/orders.ts` because that is where
 * the order document was modelled first, but not one of them reads anything an
 * invoice lacks: the three `orderHas*` predicates take `LineItem`, the
 * structural supertype every member of `OrderDocItemType`, `InvoiceDocItemType`
 * and `FulfillmentItemType` is assignable to; `InvoiceDocDestinationType`
 * **extends** `DocDestinationType`; and an invoice destination's `dates` is the
 * same `OrderDocDates`.
 *
 * ⚠️ **This is what makes a SHARED template partial possible at all.** A partial
 * that writes `it.orders.orderHasTax(…)` can only ever serve an orders-source
 * family — `availableUtilNamespaces(["invoices"], ["invoices"])` resolves
 * `{dates, money, icons, invoices}` and no `it.orders`, so the same markup
 * throws for an invoice. The pattern the templates repo uses instead is to take
 * the family's namespace object as a prop (`u`) and call `u.orderHasTax(…)`,
 * which is only sound while both namespaces really do export the same names.
 * `tests/template-helpers.test.ts` asserts that rather than assuming it —
 * re-exporting here and nowhere else would leave "the two namespaces agree" an
 * unchecked claim that shared partials are built on.
 */
export {
  getDestinationsLegend,
  isSameAsDeliveryDates,
  orderHasDiscount,
  orderHasRentals,
  orderHasTax,
} from "./orders.ts";

import {
  collectSubstitutionAnchors,
  isAtOrBelow,
  isRemovedBySubstitution,
  isStrictlyBelow,
  isSubstitutionRow,
  type SubstitutionAnchor,
  substitutionResync,
} from "./substitutions.ts";
import { mapPathsAcrossRebuild, pairItemsByUidOccurrence } from "./item-pairing.ts";
import type { COARevenueType, DocDestinationType, InvoiceDocDestinationType, InvoiceDocItemPriceType, InvoiceDocItemType, InvoiceDocLineItemType, InvoiceDocTotalsType, InvoiceStatusType, JurisdictionType, OrderDocDestinationItemType, PriceFormulaType, SettlementReasonType, SettlementTypeType, SubstitutedForEntryType } from "../schemas/mod.ts";
import {
  getSettlementMultiplier,
  InvoiceSchema,
  isDividerItemType,
  isLineItemType,
  OrderSchema,
  SETTLEMENT_CONTRACTS,
} from "../schemas/mod.ts";
import { fromCentsBig, roundDivHalfAwayFromZero } from "./money.ts";
import { canonicalChargeWindows, chicagoDaysBetween } from "./dates.ts";
import {
  classifySharedFields,
  fieldsUnder,
  mergeSharedFields,
  resolveMergedPairDates,
  type SharedField,
} from "./shared-fields.ts";
import { agingBucketOf, type InvoiceAging } from "../schemas/mod.ts";
import {
  computeItemPaths,
  isTaxableCoa,
  type ItemPathIssue,
  type ItemUniquenessIssue,
  type LineItem,
  type PriceObject,
  rederiveDocumentTotalsForAudit,
  type Tax,
  validatePathsAgainst,
} from "./orders.ts";

// ── Structural helpers ──────────────────────────────────────────

/**
 * Filter out structural items (group/destination/order dividers) and return only
 * billable line items suitable for Xero sync or totals calculation.
 *
 * The membership test is `ITEM_CONTRACTS[type].kind`. It used to be a local
 * `STRUCTURAL_TYPES` set — a thirteenth hand-written copy of the divider list,
 * and the only one that answered "billable" for a type it had never heard of.
 */
export function flattenForXero(items: LineItem[]): LineItem[] {
  return items.filter((item) => isLineItemType(item.type));
}

// ── Invoice item type ──────────────────────────────────────────

/**
 * An invoice item with optional order-scoping and invoice-specific fields.
 * Extends LineItem with properties that should be carried forward during sync
 * and fields needed for Xero mapping.
 *
 * `price` accepts both the utility's intermediate PriceObject and the full
 * InvoiceDocItemPriceType from schemas to avoid type drift.
 */
export interface InvoiceItem extends LineItem {
  uid_order?: string | null;
  description?: string;
  price?: PriceObject | InvoiceDocItemPriceType;
  coa_revenue?: COARevenueType | null;
  tracking_category?: string | null;
  xero_id?: string | null;
  xero_tracking_option_id?: string | null;
  crms_id?: number | string | null;
  // Present on the stored schema (`schemas/invoice.ts`) but absent from this
  // shadow until 2026-08-10, which is why it was missing from every one of the
  // four hand-maintained copies of {@link INVOICE_ONLY_ITEM_FIELDS}.
  crms_opportunity_id?: number | null;
  /**
   * @see `InvoiceDocLineItemType.substituted_for` (manager#414). Declared here as
   * well as on the stored schema because {@link InvoiceOnlyOverrides} is
   * `Pick<InvoiceItem, …>` — a member of {@link INVOICE_ONLY_ITEM_FIELDS}
   * missing from this shadow does not compile, which is the guard the
   * `crms_opportunity_id` line above records the absence of.
   */
  substituted_for?: SubstitutedForEntryType[];
  /** @see `InvoiceDocDestinationItemType.path_extension_for` — a destination divider's only. */
  path_extension_for?: string[];
}

// ── Invoice totals ──────────────────────────────────────────────

/** @see {@link InvoiceDocTotalsType} from `@cfs/core/schemas` */
export type InvoiceTotals = InvoiceDocTotalsType;

/**
 * **The invoice AUDIT oracle**: totals RE-DERIVED from line inputs, plus the
 * settlement projection. It is what api-cloudrun's #575 totals-drift sweep
 * compares a stored invoice against.
 *
 * It replaced `calculateInvoiceTotals` (api-cloudrun#997 step 2). A writer no
 * longer totals an invoice this way: `priceDocument` prices it and sums stored
 * line money, and the writer projects settlements with
 * {@link recomputeSettlementTotals}. Pointing the sweep at that sum would check
 * the implementation against itself (D2), which is why re-derivation survives
 * only under this name.
 *
 * @param items - Full invoice items array (structural items are filtered out)
 * @param taxes - Tax definitions for tax calculation
 * @param settlements - Every settlement against the invoice, reversals included
 */
export function rederiveInvoiceTotalsForAudit(
  items: InvoiceItem[],
  taxes: Tax[],
  // 🔴 REQUIRED, and it was `settlements?:` until 2026-08-20 while this very
  // comment claimed the opposite — "an optional param means any un-updated call
  // site silently computes `amount_credited_cents: 0`". The comment described a
  // guarantee the signature did not provide, and the guarantee is the whole
  // point: with a default, a 2-arg call returns
  // `paid: 0, credited: 0, void: 0, due: total` and a caller that spreads the
  // result over stored totals ERASES the projection.
  //
  // That is not hypothetical. The one-shot `migrate-card-fee-to-transaction-fee.ts`
  // (#401 — applied, then deleted by `847c05e4`; recover from git history)
  // called it 2-arg on 2026-08-18 and zeroed **120 prod invoices'**
  // `amount_paid_cents`, taking $123,684.19 of recorded payments off the books
  // until they were rebuilt from the journal.
  //
  // ⚠️ **A required param is necessary and NOT sufficient.** That migrator
  // hoisted `calculateOrderTotals | calculateInvoiceTotals` into ONE binding,
  // which collapses the union's call signature to the 2-parameter one — so it
  // would still have type-checked. The companion guard is the ternary-hoist arm
  // of `api-cloudrun`'s `moneyArithmeticCoverage`.
  //
  // ⚠️ And the write guard cannot see it either: the `Invoice` identity refine
  // is `paid + credited + voided + due === total`, which `0 + 0 + 0 + total`
  // satisfies exactly. Pass `[]` explicitly when a document genuinely has no
  // settlements; never let the default decide.
  settlements: readonly {
    type: SettlementTypeType;
    reason: SettlementReasonType;
    amount_cents: number;
  }[],
): InvoiceTotals {
  const core = rederiveDocumentTotalsForAudit(flattenForXero(items), taxes);

  // Settlement accounting — the projection of the journal onto this document.
  const { amount_paid_cents, amount_credited_cents, amount_void_cents, amount_due_cents } =
    recomputeSettlementTotals(core.total_cents, settlements);

  return { ...core, amount_paid_cents, amount_credited_cents, amount_void_cents, amount_due_cents };
}

// ── Payment helpers ─────────────────────────────────────────────

/**
 * Does this invoice record money having moved — paid, credited or voided?
 *
 * ⭐ **Tests the settled VALUE, not a row count**, which is what makes the
 * unfreeze work with no stored state anywhere: reversing a payment to zero
 * leaves the journal rows in place and this predicate answers `false` again.
 * Nothing caches "was settled".
 *
 * ⚠️ **An empty settlement list is not benign** — recomputing totals against one
 * zeroes `amount_paid_cents` and `amount_credited_cents` and restores
 * `amount_due_cents` to the full total. This predicate is what stands between
 * that recompute and a settled invoice's balance.
 *
 * Moved here from `api-cloudrun/src/lib/settlementProjection.ts`, which
 * re-exports it: it is a pure predicate over three numbers, three repos want it,
 * and {@link invoiceIsFrozen} below needs it.
 */
export function invoiceHasSettlement(
  invoice: { totals: { amount_paid_cents: number; amount_credited_cents?: number; amount_void_cents?: number } },
): boolean {
  return invoice.totals.amount_paid_cents !== 0 ||
    (invoice.totals.amount_credited_cents ?? 0) !== 0 ||
    (invoice.totals.amount_void_cents ?? 0) !== 0;
}

/**
 * 🔴 **The authoritative freeze predicate: may an operator still change this
 * invoice's ORGANIZATION or its DATE?**
 *
 * `invoiceHasSettlement(invoice) || status === "paid" || status === "void"`.
 *
 * **The rule follows Xero's**: once a payment is applied, the organization, the
 * invoice date, the items and the money freeze — item descriptions, `reference`,
 * `subject`, `notes` and `due_date` do not. Reversing the payment to zero
 * unfreezes it, because {@link invoiceHasSettlement} reads a VALUE and no field
 * records that the invoice was once settled.
 *
 * ⚠️ **This is NOT {@link SETTLED_STATUSES}, and the difference is the whole
 * reason it exists.** That constant is the STATUS column — `["paid", "void"]` —
 * and it is strictly weaker: it misses a `part_paid` invoice carrying a partial
 * payment, which has real money against it and must not be re-addressed. A gate
 * written on the status alone is wrong in both directions at once — stricter
 * than the server on a `paid` invoice, whose text fields are still editable, and
 * weaker on a `part_paid` one.
 *
 * ⚠️ **It answers the FIELD-CLASS question, not the money question.** The money
 * gate (`lineMoneyAgrees`) asks *did the amount move?*; this asks *is this field
 * the operator's to change at all?* Both exist, and neither subsumes the other.
 */
export function invoiceIsFrozen(
  invoice: {
    status: InvoiceStatusType;
    totals: { amount_paid_cents: number; amount_credited_cents?: number; amount_void_cents?: number };
  },
): boolean {
  return invoiceHasSettlement(invoice) || invoice.status === "paid" || invoice.status === "void";
}

/**
 * Derive invoice status from settlement amounts.
 * Pure function — does not mutate the invoice.
 *
 * **No new status member is needed for a credited invoice.** `paid` already
 * means `amount_due_cents === 0`, not "cash received" — which is exactly what Xero
 * says: #1751 and #1322 are both PAID there with `AmountPaid: 0`.
 *
 * @param currentStatus - Current invoice status
 * @param amountPaidCents - Total settled in cash, in integer cents
 * @param amountDueCents - Total still outstanding, in integer cents
 * @param amountCreditedCents - Total settled by credit note, in integer cents
 * @returns The derived status
 */
export function derivePaymentStatus(
  currentStatus: InvoiceStatusType,
  amountPaidCents: number,
  amountDueCents: number,
  amountCreditedCents = 0,
): InvoiceStatusType {
  if (currentStatus === "draft" || currentStatus === "void") return currentStatus;
  // Bare integer comparisons. The `currency(x).value` wrappers this replaced
  // were quantizing a float before comparing it to zero; an exact cent count
  // needs neither step.
  if (amountDueCents <= 0) return "paid";
  // A partially-credited invoice is as much "part paid" as a partially-paid one
  // — the operator's question is "has anything settled this yet?"
  if (amountPaidCents > 0 || amountCreditedCents > 0) return "part_paid";
  return "issued";
}

/**
 * Turn the settlements journal into the invoice's stored totals.
 *
 * **This is the one function that produces `amount_paid_cents`,
 * `amount_credited_cents` and `amount_due_cents`.** It runs inside the api's
 * co-write transaction and again in manager's optimistic recompute, so the two
 * cannot disagree — the property `computeAvailability` already provides for
 * stock.
 *
 * It used to be "the one place the cents↔dollars boundary is crossed": the
 * journal has always stored minor units while the invoice's `total` was
 * dollars, so this fold converted at the end. With `total_cents` the two sides
 * are the same unit and the boundary is gone — the function is now integer in,
 * integer out, with nothing to convert and nothing to round.
 *
 * **A straight signed fold over EVERY row, with no filtering.** A reversal is
 * simply a settlement whose contract multiplier is −1, so a do/undo pair nets to
 * zero arithmetically rather than by being excluded, and an invoice's
 * settlements can do and undo each other perpetually with the totals correct
 * after every single append. That deletes the liveness derivation entirely —
 * along with the `R2 → R1 → S1` chain that silently vanished money when the
 * trichotomy got it wrong, which under the fold is just `+500 −500 +500 = +500`,
 * correct at every step. `reverses` is provenance for the UI and for audit; it
 * contributes nothing to the sum.
 *
 * Integer sums are exact by construction — nothing to round, no ordering to get
 * wrong — which is the whole reason the journal stores minor units.
 * `Number.MAX_SAFE_INTEGER` is ~$90 trillion in cents, so plain integers are
 * safe here without BigInt.
 *
 * **Negative results are preserved, never clamped.** An over-credited invoice
 * must stay negative, exactly as availability preserves an oversold product's
 * negative. Clamping hides the defect this exists to find.
 *
 * **THREE buckets, dispatched on `sums_into` with no fallthrough arm.** It was
 * two — `if (… === "amount_paid_cents") paid += …; else credited += …` — and
 * that `else` is precisely what made `void` a schema change with a silent
 * runtime hazard: a void row would have landed in `amount_credited_cents`, the
 * identity would still have balanced, and every consumer would have reported a
 * voided invoice as fully credited. A `switch` with a `default` that throws
 * turns the next bucket into a loud failure at the one site that must know
 * about it, instead of a quiet mis-route at every site that reads the result.
 *
 * @param totalCents - Invoice total, in integer cents, from `items[]`
 * @param settlements - Every settlement against the invoice, reversals included
 * @returns The four projected totals plus a per-reason breakdown, in cents
 */
export function recomputeSettlementTotals(
  totalCents: number,
  settlements: readonly {
    type: SettlementTypeType;
    reason: SettlementReasonType;
    amount_cents: number;
  }[],
): {
  amount_paid_cents: number;
  amount_credited_cents: number;
  amount_void_cents: number;
  amount_due_cents: number;
  breakdown: Partial<Record<SettlementReasonType, number>>;
} {
  let paidCents = 0;
  let creditedCents = 0;
  let voidedCents = 0;
  const breakdownCents: Partial<Record<SettlementReasonType, number>> = {};

  for (const s of settlements) {
    const signed = s.amount_cents * getSettlementMultiplier(s.type);
    const bucket = SETTLEMENT_CONTRACTS[s.type].sums_into;
    switch (bucket) {
      case "amount_paid_cents":
        paidCents += signed;
        break;
      case "amount_credited_cents":
        creditedCents += signed;
        break;
      case "amount_void_cents":
        voidedCents += signed;
        break;
      default: {
        // Exhaustiveness, checked by the compiler: a new `sums_into` member
        // makes `bucket` non-`never` here and this line stops type-checking.
        const _exhaustive: never = bucket;
        throw new Error(`unhandled settlement bucket: ${_exhaustive}`);
      }
    }
    breakdownCents[s.reason] = (breakdownCents[s.reason] ?? 0) + signed;
  }

  return {
    amount_paid_cents: paidCents,
    amount_credited_cents: creditedCents,
    amount_void_cents: voidedCents,
    // Integer subtraction over four exact cent counts. This line used to be the
    // one currency.js call in the module, because a dollar-denominated `total`
    // met two converted figures here; with every operand in the same unit there
    // is nothing left for a decimal type to reconcile.
    amount_due_cents: totalCents - paidCents - creditedCents - voidedCents,
    breakdown: breakdownCents,
  };
}

// ── Xero helpers ────────────────────────────────────────────────

/**
 * Quantity widening for {@link getXeroUnitAmountFromCents}, matching `QTY_SCALE` in
 * `utils/orders.ts`. Four decimal places of quantity, so the division is exact
 * integers all the way down and a fractional quantity cannot reach `BigInt()`.
 */
const XERO_QTY_SCALE = 10_000n;

/**
 * Compute the Xero unit amount from subtotal and quantity.
 * Bakes duration (chargeable_days × formula) into per-unit price,
 * since Xero has no concept of rental duration.
 *
 * ## The round trip does not close, and that is a property, not a bug
 *
 * Xero recomputes `LineAmount = UnitAmount × Quantity` on its own side, so the
 * remainder this division discards is **real money in someone else's ledger** —
 * unlike the booking `unit_price_cents` denorm, whose residual is discarded on
 * purpose because nothing ever multiplies it back.
 *
 * `getXeroUnitAmountFromCents(10000, 3)` is `33.33`, and Xero will bill
 * `99.99`. **Rounding
 * better does not fix this**: `10000 ÷ 3` is `3333` cents too, and `× 3` is
 * `9999` cents regardless of the arithmetic. The gap is bounded by
 * `quantity − 1` cents on a line and is absorbed through the discount channel
 * (`DiscountRate` at 4dp), which is the only per-line lever Xero gives us.
 *
 * So the exactness this function buys is not a closed round trip — it is that
 * the residual is **at most one cent per unit and never grows**. The float form
 * it replaced could quantize the quotient and then have that error scale with
 * the line.
 *
 * Half away from zero rather than plain half-up: a line's `subtotal_discounted`
 * may be negative when a flat discount exceeds it, and `roundDivHalfUp` rounds
 * a negative numerator toward zero. Symmetry means a credit and its matching
 * charge cannot differ in magnitude.
 *
 * ## Cents in, DOLLARS out — and the asymmetry is the point
 *
 * The input is CFS storage, which is integer cents. The return is Xero's wire
 * format, which is dollars and does not change because CFS's storage did. So
 * this is the one function in the package that deliberately straddles the two
 * units, and the name says which side each is on.
 *
 * ⚠️ **The body moved with the name, and had to.** Its first act used to be
 * `toCentsBig(subtotal)`. Feeding cents to that unedited body is a clean 100×
 * that type-checks perfectly — same signature, same types, silently wrong
 * invoice on a single-env production Xero tenant with no dev twin. The rename
 * exists so every call site fails to compile and the pairing cannot be
 * half-done.
 *
 * @param subtotalCents - Pre-discount subtotal in integer cents
 *   (base_cents × days × formula × quantity)
 * @param quantity - Item quantity. May be fractional; scaled rather than
 *   narrowed, so a non-integer cannot throw on the Xero push path.
 * @returns Per-unit amount for Xero **in dollars**, or 0 if quantity is 0
 */
export function getXeroUnitAmountFromCents(subtotalCents: number, quantity: number): number {
  if (!quantity) return 0;
  return fromCentsBig(roundDivHalfAwayFromZero(
    BigInt(subtotalCents) * XERO_QTY_SCALE,
    BigInt(Math.round(quantity * Number(XERO_QTY_SCALE))),
  ));
}

// ── Selective sync helpers ──────────────────────────────────────

/**
 * The line fields an invoice OWNS rather than inheriting from its order.
 *
 * ONE list. The type ({@link InvoiceOnlyOverrides}), the picker
 * ({@link pickInvoiceOnlyFields}) and the carry-forward
 * ({@link carryForwardOverrides}) are all derived from it — because four
 * hand-maintained copies of one fact is how `crms_id` came to be absent from
 * every one of them while {@link invoiceItemsMatch} compared key sets
 * before values and reported the ENTIRE CRMS-authored corpus `out_of_sync`,
 * with nothing thrown.
 *
 * ⚠️ Seven literals, no spread. core#43 is the standing case where JSR's npm
 * `.d.ts` emit TRUNCATED a spread inside an `as const`, and no core gate could
 * see it.
 *
 * ⭐ **`substituted_for` is a member, and it is the only one that is not
 * merely an override.** The other six are values an invoice may hold instead of
 * its order's; this one is the record that the invoice deliberately bills a
 * DIFFERENT product. Being in the list buys the same two things either way —
 * {@link invoiceItemDifferences} filters it out of both key sets, so a
 * substituted line is not reported as drift on the field that explains it, and
 * {@link carryForwardOverrides} preserves it across a rebuild. What it does NOT
 * buy is survival of the row itself; that is
 * {@link syncOrderToInvoiceSelective}'s anchor handling.
 */
const INVOICE_ONLY_ITEM_FIELDS = [
  "coa_revenue",
  "tracking_category",
  "xero_id",
  "xero_tracking_option_id",
  "crms_id",
  "crms_opportunity_id",
  "substituted_for",
  // 🔴 Type-checked against the STORED shape, not derived from it. Derivation is
  // wrong here and the distinction is the whole point: this is an OVERRIDE
  // POLICY, not a structural difference — `coa_revenue` is on the order line too
  // and `substituted_for` is on the fulfillment line, so "fields the
  // invoice has and the order does not" computes a different list.
  //
  // What CAN be checked is that every member is really a key of the invoice's
  // stored line item. A member that is not silently filters nothing:
  // `invoiceItemDifferences` compares KEY SETS, so a typo here would leave the
  // field in both sets and report every paired line permanently out of sync —
  // which has happened three times (`base_percent`, `crms_id`,
  // `price.discount_percent`: 8,015 of 8,978 paired lines).
  //
  // A `satisfies` rather than a test because it costs nothing and cannot be
  // skipped, and because exporting the list purely to assert it from `tests/`
  // would widen `@cfs/core/utils/invoices` for a guard.
] as const satisfies readonly (keyof InvoiceDocLineItemType)[];

/** Membership form of {@link INVOICE_ONLY_ITEM_FIELDS}, for key filtering. */
const INVOICE_ONLY_ITEM_FIELD_SET: ReadonlySet<string> = new Set(INVOICE_ONLY_ITEM_FIELDS);

/**
 * Return the intersection of two key arrays, minus any keys in the exclude set.
 * Used to derive comparable fields from two schema shapes without hardcoding.
 *
 * @param keysA - Field names from schema A
 * @param keysB - Field names from schema B
 * @param excludes - Field names to exclude from the result
 * @returns Shared field names, excluding the exclude set
 */
export function getSharedFields(keysA: string[], keysB: string[], excludes: string[]): string[] {
  const setB = new Set(keysB);
  const excl = new Set(excludes);
  return keysA.filter((k) => setB.has(k) && !excl.has(k));
}

/**
 * Stable key for path-based item matching.
 * Joins path segments with "/" to produce a unique positional identifier.
 */
function itemPathKey(path: readonly string[]): string {
  return path.join("/");
}

/**
 * Strip the order divider uid prefix from an invoice item's path.
 * Invoice items under an order divider have path = [orderDividerUid, ...originalPath].
 */
function stripOrderPrefix(path: string[], orderDividerUid: string): string[] {
  if (path.length === 0) return [];
  if (path[0] === orderDividerUid) return path.slice(1);
  return path;
}

// ── Date-extension sections (api-cloudrun#680 R1) ───────────────

/**
 * The date-extension sections in one order scope of an invoice: each extension
 * divider's uid → the ORDER-relative path of the order destination divider it
 * extends (`path_extension_for`).
 *
 * An extension section bills MONEY on lines another invoice already billed, so
 * every order-relative reader has to decide what to do with it: alignment and
 * `billedByPath` read it as the divider it extends ({@link toOrderRelativePath}),
 * while the line-drift readers skip it ({@link isInExtensionSection}).
 *
 * @param scopedItems - Items of one order scope, or a whole invoice
 * @param orderDividerUid - The order divider's uid
 */
export function extensionSectionTargets(
  scopedItems: readonly InvoiceItem[],
  orderDividerUid: string,
): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  for (const it of scopedItems) {
    if (it.type !== "destination" || !it.path_extension_for?.length) continue;
    const path = it.path ?? [];
    if (path[0] !== orderDividerUid) continue;
    targets.set(it.uid, [...it.path_extension_for]);
  }
  return targets;
}

/**
 * An invoice item's path in the ORDER's path space, reading an extension
 * section as the order divider it extends: `[O, E, …rest]` → `[…target, …rest]`.
 * Any other item is {@link stripOrderPrefix}.
 */
export function toOrderRelativePath(
  path: readonly string[],
  orderDividerUid: string,
  targets: ReadonlyMap<string, readonly string[]>,
): string[] {
  const rel = stripOrderPrefix([...path], orderDividerUid);
  const target = rel.length > 0 ? targets.get(rel[0]) : undefined;
  return target ? [...target, ...rel.slice(1)] : rel;
}

/** Is this invoice item an extension divider, or anywhere beneath one? */
export function isInExtensionSection(
  path: readonly string[],
  orderDividerUid: string,
  targets: ReadonlyMap<string, readonly string[]>,
): boolean {
  if (targets.size === 0) return false;
  const rel = stripOrderPrefix([...path], orderDividerUid);
  return rel.length > 0 && targets.has(rel[0]);
}

/**
 * Build an invoice destination divider from a source order's destination item.
 * Single source of truth for the divider shape — reused by
 * `projectOrderItemToInvoiceItem` (order→invoice projection), the CRMS invoice
 * webhook (`createUpdateInvoiceFromCrms`), and the destination-divider backfill.
 *
 * `path` defaults to `[]` so callers that run `computeInvoiceItemPaths`
 * afterward (the webhook + backfill) get positional path assignment; the
 * order-projection caller passes the scoped path `[orderDividerUid, ...basePath]`.
 *
 * ⚠️ **It no longer copies `uid_delivery`/`uid_collection`, and `source` no
 * longer accepts them.** They were the divider's second copy of the pair's
 * endpoints, and copying them here across two documents is the mechanism
 * api-cloudrun#664 describes: the pairs come from `order.destinations` and the
 * dividers from `order.items`, ~100 lines apart, with nothing cross-checking
 * them. The section's endpoint is now read from the pair its `uid` names.
 */
export function buildInvoiceDestinationDivider(
  source: { uid: string; name: string; description?: string | null },
  path: string[] = [],
): OrderDocDestinationItemType {
  return {
    uid: source.uid,
    type: "destination",
    name: source.name,
    description: source.description ?? "",
    path,
  };
}

/**
 * Project an order item to its invoice-item shape, scoped under an order divider.
 *
 * Order items carry fields (`stock_method`, `order_number`, `uid_order`,
 * `inclusion_type`, `uid_delivery`/`uid_collection` on line items,
 * `price.replacement`) that `InvoiceDocLineItem` (strict) rejects. Spreading
 * `...orderItem` into an invoice item leaks them. Call this helper at every
 * order → invoice boundary instead.
 *
 * ⭐ **`zero_priced` is projected UNCONDITIONALLY (`?? null`), and the corpus was
 * backfilled first** — stage two of `manager#421`, landed 2026-09-10 by
 * `api-cloudrun/scripts/backfill-zero-priced-projections.ts`.
 *
 * ⚠️ **The order of those two was forced, and the reason is
 * `invoiceItemDifferences` comparing top-level KEY SETS.** `buildOrderLine`
 * writes `zero_priced: null` explicitly on every order line — see its own
 * comment, *"the server writes both as an explicit `null` so the optimistic row
 * matches the echo"* — so the key is present on every order line without
 * exception, and emitting here ahead of the backfill would have made EVERY
 * paired line report a key-set difference at once. This file already records
 * that happening three times (`base_percent`, `crms_id`,
 * `price.discount_percent` — 8,015 of 8,978 paired lines), which is why
 * `coa_revenue`, the tax-class levers and `price.taxes_base` below are all spread
 * CONDITIONALLY.
 *
 * 🔴 **So this key is the one that must NOT be conditional, and the population
 * is why.** A conditional spread on presence is vacuous — the condition is true
 * for every order line. A conditional spread on *statedness* is worse: it makes
 * a line's KEY SET depend on its VALUE, so clearing a component's flag in the
 * catalog would take the key off the projection while the stored line kept it,
 * and that line would report `out_of_sync` forever with nothing wrong. Measured
 * 2026-09-10 in prod, the narrow rule saved 102 invoice documents out of 1,037 —
 * a tenth of the write, for a defect class. `price.base_percent` is spelled
 * `?? null` in `api-cloudrun`'s `buildInvoiceItems` for the same reason.
 *
 * `destination` and `group` items share their shape with the order doc, so they
 * pass through. Line items (and `transaction_fee`, which is stored as a
 * line-item-shaped invoice item) are narrowed to the invoice-line-item keys.
 *
 * The divider/line split is `ITEM_CONTRACTS[type].kind`, not a list of type
 * literals — so a new line type projects correctly the day it is added to the
 * table, instead of silently falling through to whichever branch happened to be
 * last. The per-branch KEY sets stay hand-written on purpose: they mirror
 * `InvoiceDocLineItem`'s strict shape, and deriving them from the contract
 * would make the table a second source of truth for the schema.
 *
 * Mirrors the hand-picked mapping in `api-cloudrun/src/services/invoices.ts`
 * (`createInvoice`) so sync output is shape-consistent with create output.
 *
 * ⚠️ **Exported for probes and audits, and that is the point** (api-cloudrun#481).
 * Anything asking *"does this invoice line equal its order line?"* has to compare
 * against the PROJECTION, not the raw order item — the two differ by exactly the
 * order-only fields this function drops. A prod probe that compared raw order
 * prices invented a phantom `taxes_base: 8,360` difference across the corpus,
 * because `taxes_base` is order-only and never reaches an invoice line. There is
 * no way to reimplement this faithfully outside the module, so the answer is to
 * export it rather than to keep re-deriving it. Paired with
 * {@link invoiceItemDifferences}, which is the other half a probe needs.
 */
export function projectOrderItemToInvoiceItem(item: LineItem, orderDividerUid: string): InvoiceDocItemType {
  const basePath = item.path ?? [];
  const path = [orderDividerUid, ...basePath];

  // `isDividerItemType` is a type PREDICATE, so it narrows `item.type` as well
  // as answering the question. That is what lets both branches below return a
  // real `InvoiceDocItemType` arm: after the `destination` check the divider
  // branch is exactly `"order" | "group"`, and the line branch is exactly
  // `DocLineItemTypeType`. The `as InvoiceItem` casts this function used to end
  // each branch with were the loose shadow's, not the data's.
  if (isDividerItemType(item.type)) {
    if (item.type === "destination") {
      return buildInvoiceDestinationDivider(item, path);
    }
    return {
      uid: item.uid,
      type: item.type,
      name: item.name,
      description: item.description ?? "",
      path,
    };
  }

  const p = (item.price ?? {}) as Partial<InvoiceDocItemPriceType>;
  return {
    uid: item.uid,
    type: item.type,
    name: item.name,
    description: item.description ?? "",
    quantity: item.quantity ?? 0,
    price: {
      base_cents: p.base_cents ?? 0,
      // Carried across so a `percent_of_total` fee line keeps its rate; the
      // exactly-one-of refinement rejects the projection otherwise.
      base_percent: p.base_percent ?? null,
      chargeable_days: p.chargeable_days ?? null,
      formula: (p.formula ?? "five_day_week") as PriceFormulaType,
      subtotal_cents: p.subtotal_cents ?? 0,
      subtotal_discounted_cents: p.subtotal_discounted_cents ?? 0,
      discount: p.discount ?? null,
      taxes: p.taxes ?? [],
      // The would-be-taxed snapshot inherits, so an exempt invoice records
      // what it was exempt FROM the way its order does. Spread
      // CONDITIONALLY, twice over: an explicit `undefined` trips
      // `validateBeforeWrite`'s no-undefined guard, and `invoicePriceDifferences`
      // compares price KEY SETS — emitting the key unconditionally would make
      // every pre-2026-08 invoice line differ from its order line on a field
      // neither of them ever set.
      ...(p.taxes_base !== undefined ? { taxes_base: p.taxes_base } : {}),
      total_cents: p.total_cents ?? 0,
    },
    // Mirrored from the order line so the invoice carries the same answer as the
    // line it was projected from. UNCONDITIONAL — see the docblock: this is the
    // one key here whose presence must not depend on its value.
    zero_priced: item.zero_priced ?? null,
    // ⚠️ `coa_revenue` is an INVOICE_ONLY field, and projecting it is not a
    // contradiction — it is what makes the override an override. The invoice's
    // own value still wins (`carryForwardOverrides` re-applies it after the
    // replace); this only supplies the order's when the invoice has none,
    // instead of leaving `undefined` for the invoice pricer to read as
    // "taxable" while the stored per-line taxes say otherwise.
    //
    // Comparator-safe by construction: `invoiceItemsMatch` filters
    // INVOICE_ONLY_ITEM_FIELDS out of both key sets, so adding this key changes
    // no sync verdict. That is NOT true of `price.taxes_base` above, which is
    // nested inside `price` and therefore compared — hence the two different
    // treatments of two fields added in the same pass.
    ...(item.coa_revenue !== undefined ? { coa_revenue: item.coa_revenue } : {}),
    // The tax levers (`LineTaxCore`: `uid_tax_class`, `uid_tax_class_override`) mirror onto the invoice, because the invoice is
    // what gets billed and it prices its OWN line through the same resolver.
    // The class is required on both grains; the override is copied only when
    // present, for the `taxes_base` reason one field up — the comparator
    // compares KEY SETS.
    ...pickLineTaxFields(item),
    path,
  };
}

/**
 * The `LINE_TAX_FIELDS` a line carries, for a projection onto another
 * grain. `uid_tax_class` is required on every priced line (api-cloudrun#993),
 * so a source line without one is refused loudly rather than projected into a
 * document the schema would 400; `uid_tax_class_override` is copied only when
 * present, so the projection preserves the source line's key set.
 *
 * @throws Error when the line has no `uid_tax_class`.
 */
export function pickLineTaxFields(
  item: { uid: string; uid_tax_class?: string | null; uid_tax_class_override?: string | null },
): { uid_tax_class: string; uid_tax_class_override?: string | null } {
  if (!item.uid_tax_class) {
    throw new Error(`Line ${item.uid} has no uid_tax_class — every priced line must carry its tax class`);
  }
  return {
    uid_tax_class: item.uid_tax_class,
    ...(item.uid_tax_class_override !== undefined ? { uid_tax_class_override: item.uid_tax_class_override } : {}),
  };
}

/**
 * The fields an invoice line may override against its source order line —
 * the type-level twin of {@link INVOICE_ONLY_ITEM_FIELDS}, DERIVED from it
 * rather than restated beside it.
 *
 * Named as its own type because the return of {@link pickInvoiceOnlyFields} is
 * SPREAD over a projected item. `Partial<InvoiceItem>` would let that spread
 * legally overwrite `type`, `uid` or `path` — the row's identity — so the wide
 * type was a licence the function never wanted and does not use.
 */
type InvoiceOnlyOverrides = Partial<
  Pick<InvoiceItem, typeof INVOICE_ONLY_ITEM_FIELDS[number]>
>;

/**
 * Pick only invoice-only override fields from an invoice item.
 * Used to carry forward overrides when replacing an item with updated order data.
 *
 * A loop over {@link INVOICE_ONLY_ITEM_FIELDS}, not one `if` per field: the
 * whole point of the tuple is that adding a field here is a single edit.
 */
function pickInvoiceOnlyFields(item: InvoiceItem): InvoiceOnlyOverrides {
  const result: Record<string, unknown> = {};
  const source = item as unknown as Record<string, unknown>;
  for (const key of INVOICE_ONLY_ITEM_FIELDS) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result as InvoiceOnlyOverrides;
}

// ── The one item comparator ─────────────────────────────────────

/**
 * `JSON.stringify` with object keys sorted, recursively — array order is
 * preserved, because an items array's order is meaning.
 *
 * The plain form is **key-order sensitive**, and both sides of every comparison
 * here come from somewhere that picks its own order: a projection emits keys in
 * source order, while a Firestore map comes back sorted. Two documents that are
 * deeply equal must compare equal, so the stringification has to be canonical.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  return "{" + Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => JSON.stringify(k) + ":" + stableStringify(v))
    .join(",") + "}";
}

/**
 * Which `price` keys two price objects differ on, compared **structurally**, key
 * by key — `[]` when they agree. Members are returned already qualified
 * (`price.taxes`, `price.total_cents`), so the caller never re-prefixes them;
 * the whole-value fallback below returns the bare `price`.
 *
 * ⚠️ **This is the half that made the sync badge lie for the whole corpus.**
 * `price` used to be compared as one `JSON.stringify` blob, so ANY key
 * difference inside it failed the whole line — and every CRMS-authored line
 * carried `price.discount_percent`, which no projection emitted. Measured
 * 2026-08-10 over 8,978 unambiguously paired prod lines: 8,015 failed on that
 * key alone, i.e. the badge was reporting a field's presence as a price change.
 * (That key is gone from the schema and the corpus as of api-cloudrun#480; the
 * structural comparison is what makes the NEXT such key a non-event.)
 * The `base_percent` encoding split — the projection emits an explicit `null`,
 * a stored CRMS line omits the key, and `InvoiceDocItemPrice` blesses
 * both (`.nullable().optional()`) — is the same class.
 *
 * **Absent ≡ null, with no list of which keys it applies to.** A null-valued
 * key is dropped from both sides before comparing, so the rule holds for every
 * nullable price key there is or will be (`base_percent`, `chargeable_days`,
 * `discount`) and cannot go stale. It is safe for the rest by construction: a
 * key that is not nullable cannot hold `null`, so dropping nulls can never
 * erase one of its values. A key present on one side and absent on the other
 * with a NON-null value is still a mismatch, which is the whole point.
 *
 * `discount_percent` was deliberately never normalized away here — it was
 * removed from the schema and from the corpus instead (api-cloudrun#480, landed
 * once both envs measured zero residue), because an exclusion list polices a
 * defect class that can be made unrepresentable. Keep it that way: the fix for
 * a future legacy key is a contraction, not an entry in a skip list.
 */
function invoicePriceDifferences(expected: unknown, current: unknown): string[] {
  const normalize = (p: unknown): Record<string, unknown> | null => {
    if (p === null || typeof p !== "object" || Array.isArray(p)) return null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      out[k] = v;
    }
    return out;
  };

  const e = normalize(expected);
  const c = normalize(current);
  // One side isn't a price object at all (a divider, or a malformed line) —
  // fall back to whole-value equality rather than pretending they agree. There
  // is no sub-key to name in that case, so the difference is the whole field.
  if (e === null || c === null) {
    return stableStringify(expected) === stableStringify(current) ? [] : ["price"];
  }

  const differing = new Set<string>();
  for (const k of Object.keys(e)) {
    if (!(k in c)) differing.add(`price.${k}`);
    else if (stableStringify(e[k]) !== stableStringify(c[k])) differing.add(`price.${k}`);
  }
  // A key the CURRENT line carries and the projection does not is equally a
  // difference — the count check this replaced caught it only in aggregate, and
  // a histogram has to be able to name it.
  for (const k of Object.keys(c)) if (!(k in e)) differing.add(`price.${k}`);
  return [...differing];
}

/**
 * **Which fields two invoice-shaped items differ on** — the substrate of
 * {@link invoiceItemsMatch}, and the reason there is only one comparator.
 *
 * Returns sorted, qualified field names (`name`, `price.taxes`,
 * `price.chargeable_days`); `[]` means the rows agree. Invoice-only fields
 * ({@link INVOICE_ONLY_ITEM_FIELDS}) are filtered out of both sides first, so an
 * override is never a difference.
 *
 * ⚠️ **This exists because the boolean could not be bucketed** (api-cloudrun#481).
 * The badge reported thousands of `out_of_sync` lines with no way to say what
 * they differed ON, so the question *"which of these are real drift?"* could only
 * be answered by a probe reimplementing the comparison — and a reimplementation
 * is what invented a phantom `taxes_base` slice across the whole corpus. A
 * histogram taken through this function agrees with the badge **by construction**,
 * because the badge is defined in terms of it.
 *
 * Both arguments must already be invoice-shaped, with full (divider-scoped)
 * paths — project an order item with {@link projectOrderItemToInvoiceItem} first.
 * Comparison is:
 *
 * - **top-level keys** present on one side and not the other, minus the
 *   invoice-only fields (a key whose value is `undefined` does not count as
 *   present — Firestore stores no such value, so it can only come from a
 *   caller's partially-built object);
 * - **`price` structurally** ({@link invoicePriceDifferences}), with absent ≡
 *   null on the keys the schema blesses both encodings of;
 * - **every other key by canonical value** ({@link stableStringify}).
 */
export function invoiceItemDifferences(expected: InvoiceItem, current: InvoiceItem): string[] {
  const comparableKeys = (it: InvoiceItem) => {
    const rec = it as unknown as Record<string, unknown>;
    return new Set(Object.keys(rec).filter((k) => !INVOICE_ONLY_ITEM_FIELD_SET.has(k) && rec[k] !== undefined));
  };
  const eKeys = comparableKeys(expected);
  const cKeys = comparableKeys(current);

  const e = expected as unknown as Record<string, unknown>;
  const c = current as unknown as Record<string, unknown>;
  const differing = new Set<string>();

  for (const k of eKeys) if (!cKeys.has(k)) differing.add(k);
  for (const k of cKeys) if (!eKeys.has(k)) differing.add(k);

  for (const k of eKeys) {
    if (!cKeys.has(k)) continue; // already reported as a key-set difference
    if (k === "price") {
      for (const pk of invoicePriceDifferences(e[k], c[k])) differing.add(pk);
      continue;
    }
    if (stableStringify(e[k]) !== stableStringify(c[k])) differing.add(k);
  }
  return [...differing].sort();
}

/**
 * **The one comparator.** Are two invoice-shaped items the same row, ignoring
 * the fields an invoice OWNS ({@link INVOICE_ONLY_ITEM_FIELDS})?
 *
 * It replaced two near-duplicate comparisons — the private
 * `invoiceProjectionMatches` behind {@link computeInvoiceSyncStatus}, and
 * `isItemSynced`'s order-shaped one behind the draft mirror — which had drifted
 * into disagreeing about what "the same line" means.
 *
 * ⚠️ `isItemSynced` is GONE (retired with the whole-row sync mode): a whole-row
 * verdict is exactly what the per-field rule replaced, so leaving the predicate
 * exported would have invited a caller back into G1. This comparator survives
 * because {@link computeInvoiceSyncStatus} still asks a row-level question for
 * the sync BADGE, which is a display, not a write decision.
 *
 * The comparison rules live in {@link invoiceItemDifferences}; this is that
 * function's emptiness. Keeping the boolean as the derived half rather than the
 * other way round is deliberate — two implementations of "the same row" is the
 * exact defect this function was created to remove, and a separate boolean pass
 * would be a second one.
 */
export function invoiceItemsMatch(expected: InvoiceItem, current: InvoiceItem): boolean {
  return invoiceItemDifferences(expected, current).length === 0;
}

/**
 * What {@link computeInvoiceSyncStatus} needs in order to EXPLAIN a difference
 * rather than merely report it (api-cloudrun#481).
 *
 * Required, never defaulted. An optional context would mean a caller that
 * forgot it silently gets the naive comparator back — which is the exact
 * regression this exists to remove, and it would be invisible.
 */
export interface InvoiceSyncContext {
  /**
   * Tax uid → its `name`. Two taxes sharing a name are two *versions* of one
   * tax, which is what makes a rate-version difference distinguishable from a
   * genuinely different tax. A uid missing from the map is treated as its own
   * name, so an unknown tax can never be explained away.
   */
  taxNameByUid: ReadonlyMap<string, string>;
  /**
   * Whether the SOURCE ORDER is frozen, i.e. no longer repriceable.
   *
   * ⚠️ **The date-version arm REQUIRES this, and that is a tightening, not
   * bookkeeping.** Both writers now resolve a tax by name at the delivery date,
   * so a same-name/different-version difference is expected history on a frozen
   * order and is **genuine drift on a live one**. The audit that first measured
   * this bucket only *observed* that all 5,119 prod lines sat on frozen orders;
   * requiring it is what stops the explanation from covering a case it was
   * never true of.
   */
  orderFrozen: boolean;
  /**
   * **The INVOICE's own destination pairs' charge windows** — build it with
   * `chargeWindowContext(invoice.destinations)` (`utils/price-document.ts`), the
   * same call the invoice's own pricer makes. It is what the `invoice_windows`
   * arm re-prices the projected order line at.
   *
   * ⚠️ **The invoice's, never the order's.** The projection is ALREADY priced at
   * the order's windows, so passing those makes the arm a tautology that
   * reproduces `expected` and explains nothing — a silent no-op rather than a
   * loud failure.
   *
   * Required and never defaulted, for the reason on this interface: an optional
   * context is a caller that forgot it silently getting the naive comparator
   * back. An invoice whose pairs carry no windows yields an empty array, and the
   * arm then never fires.
   */
  invoiceChargeWindows: readonly PairChargeWindows[];
}

/** Whole-cent tax a line carries. Integer addition — closed under the quantum, exact. */
function taxAmountCents(item: InvoiceItem): number {
  const price = (item as unknown as { price?: { taxes?: Array<{ amount_cents?: number }> } }).price;
  return (price?.taxes ?? []).reduce((n, t) => n + (t.amount_cents ?? 0), 0);
}

/** A line's tax identity — which tax at which rate, order-insensitive. */
function taxIdentity(item: InvoiceItem): string[] {
  const price = (item as unknown as { price?: { taxes?: Array<{ uid?: string; rate?: number }> } }).price;
  return (price?.taxes ?? []).map((t) => `${t.uid}@${t.rate}`).sort();
}

/** The same identity with each uid replaced by its NAME — the version-blind form. */
function taxNames(item: InvoiceItem, taxNameByUid: ReadonlyMap<string, string>): string[] {
  const price = (item as unknown as { price?: { taxes?: Array<{ uid?: string }> } }).price;
  return (price?.taxes ?? [])
    .map((t) => taxNameByUid.get(t.uid ?? "") ?? `unknown:${t.uid}`)
    .sort();
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** The price fields a TAX explanation is allowed to cover. */
const TAX_EXPLAINABLE_FIELDS = new Set(["price.taxes", "price.taxes_base", "price.total_cents"]);

/**
 * The price fields a CHARGE-WINDOW explanation is allowed to cover: the day
 * count, and the money that follows from it.
 *
 * Bounded rather than "whatever the reprojection reproduces", for the reason the
 * tax arm is bounded: the reprojection only ever rewrites `price`, so a `name` or
 * `quantity` difference could not agree anyway — but an arm that says which
 * fields it owns cannot silently grow one when something upstream changes what
 * it rewrites.
 */
const WINDOW_EXPLAINABLE_FIELDS = new Set([
  "price.chargeable_days",
  "price.subtotal_cents",
  "price.subtotal_discounted_cents",
  "price.discount",
  "price.taxes",
  "price.total_cents",
]);

/** Do two items agree on one `price.*` key, with absent ≡ null as {@link invoicePriceDifferences} has it? */
function priceKeyAgrees(a: InvoiceItem, b: InvoiceItem, field: string): boolean {
  const key = field.slice("price.".length);
  const read = (it: InvoiceItem) => {
    const v = (it as unknown as { price?: Record<string, unknown> }).price?.[key];
    return v === undefined || v === null ? undefined : v;
  };
  return stableStringify(read(a)) === stableStringify(read(b));
}

/**
 * **The projected order line, re-priced at the INVOICE's own charge windows**
 * (core#112) — or `undefined` when that question does not arise.
 *
 * Since charge-windows beta A a rental line's days and money derive from *its own
 * document's* pair windows ({@link windowChargeableDays}), so an invoice that
 * states its own — a partial bill, charge-windows decision 3 — differs from its
 * order on the day count and every money field below it. This re-derives what the
 * order line WOULD be if billed at the invoice's windows, and the caller explains
 * only the fields that then agree exactly.
 *
 * 🔴 **The tax catalog is the line's OWN resolved rates, not a rate catalog the
 * context carries, and that is a correctness choice rather than a saving.** Two
 * reasons, both measured on the code:
 *
 * 1. {@link calculateItemTax} **throws** `"Unknown tax uid"` for a ref absent from
 *    the catalog it is handed (`utils/orders.ts`). A sync badge that 500s because
 *    a caller passed a filtered catalog is worse than one that over-reports, and
 *    every ref here is a hit by construction.
 * 2. It isolates the variable. Only the day count moves, so a line whose rate
 *    VERSION also differs does not agree here and falls through to
 *    `tax_date_version` — which is the arm that owns that question. Re-pricing at
 *    today's catalog would conflate the two and let a rate change hide inside a
 *    day change.
 *
 * ⚠️ **An extension-section line must not reach this.** It bills the days its
 * section ADDS, priced with the one-week floor SKIPPED, while this prices its
 * pair's total WITH the floor — so the money will not agree and nothing is
 * explained. That is the safe direction, and both callers exclude extension lines
 * before comparing anyway ({@link computeInvoiceSyncStatus} marks them `in_sync`;
 * `computeDocumentDiffs` skips them when it scopes).
 */
function reprojectAtInvoiceWindows(
  expected: InvoiceItem,
  context: InvoiceSyncContext,
): InvoiceItem | undefined {
  const days = windowChargeableDays(expected as unknown as LineItem, context.invoiceChargeWindows);
  if (days === null) return undefined;
  const price = (expected as unknown as { price?: PriceObject }).price;
  // Nothing to explain: the invoice's windows bill what the order's already did.
  if (!price || days === price.chargeable_days) return undefined;
  const item = { ...expected, price: { ...price, chargeable_days: days } } as unknown as LineItem;
  const ownRates: Tax[] = (price.taxes ?? []).map((t) => ({ uid: t.uid, name: t.name, rate: t.rate, type: t.type }));
  return { ...expected, price: { ...price, chargeable_days: days, ...priceLine(item, ownRates) } } as InvoiceItem;
}

/**
 * Strip the differences that are **explained** — leaving only the ones an
 * operator should act on (api-cloudrun#481).
 *
 * The sync badge and api-cloudrun's `audit-draft-invoice-mirror` script (deleted
 * 2026-09-15) were two
 * comparators kept in agreement by hand, and they disagreed by construction: the
 * audit compared money and then *explained* the difference through tested arms,
 * while the badge had none and so reported every one of them. On prod that was
 * 8,792 lines flagged against **0** the audit called real. This is the audit's
 * reasoning, moved to where both callers share it.
 *
 * Four arms, all narrow, and none of them a field exclusion — an excluded field
 * is blind forever, whereas an explained one goes red the moment its explanation
 * stops holding:
 *
 * 0. **`invoice_windows`** — the invoice states its own charge windows, so its
 *    rental lines bill a different number of days than the order's (core#112). A
 *    partial bill is exactly this: charge-windows decision 3 sets the invoice's
 *    own pair windows to the part being billed. The arm re-prices the projected
 *    order line at those windows and covers only the fields that then agree
 *    EXACTLY, so a money change hiding behind a day change is not covered.
 *    ⚠️ It runs first and rebases what the three tax arms compare — see
 *    {@link reprojectAtInvoiceWindows} and the comment at the top of
 *    {@link explainInvoiceItemDifferences}.
 * 1. **`coa_untaxes`** — the invoice knows the line is non-revenue and the order
 *    does not, so the retired account-keyed taxability gate fired on one side
 *    only. ⚠️ **HISTORICAL, and deliberately kept.** Nothing prices this way
 *    since the owner ruling of 2026-08-20 (`isTaxableCoa`), so no NEW line can
 *    reach this arm — but the frozen documents the gate shaped are still
 *    compared against their orders every time the badge renders, and deleting
 *    the arm would turn each of them red for a rule that ran when they were
 *    written.
 * 2. **`tax_date_version`** — the same tax NAMES at different rate versions, on a
 *    **frozen** order. One materializer, two as-of instants; the decision not to
 *    restate completed orders' quoted totals.
 * 3. **`tax_zero_money`** — the tax rows differ but neither side collects a cent.
 *    Checked on the stored amounts, never inferred from `zero_priced`, so a
 *    mislabelled line cannot hide in here.
 *
 * ⚠️ **`price.total_cents` is covered only when it moved by EXACTLY the tax
 * delta.** A tax difference necessarily moves the total, so refusing to cover it
 * would leave every explained line red for a consequence of the thing just
 * explained. Covering it unconditionally would hide a real total divergence
 * behind an unrelated tax one. The equality is exact integer cents, so there is
 * no tolerance to choose.
 *
 * `price.subtotal_cents` and `price.subtotal_discounted_cents` are deliberately
 * NOT explainable: tax is a function of the discounted subtotal, so a line that
 * disagrees there has no independent tax question — the money difference is the
 * finding, and it stays.
 */
export function unexplainedInvoiceItemDifferences(
  expected: InvoiceItem,
  current: InvoiceItem,
  differences: readonly string[],
  context: InvoiceSyncContext,
): string[] {
  return explainInvoiceItemDifferences(expected, current, differences, context).unexplained;
}

/** Which explanation accounted for a difference. */
export type InvoiceSyncArm = "invoice_windows" | "coa_untaxes" | "tax_date_version" | "tax_zero_money";

/** {@link explainInvoiceItemDifferences}'s verdict: what is left, and what accounted for the rest. */
export interface InvoiceSyncExplanation {
  /** Differences no arm accounted for — the ones an operator should act on. */
  unexplained: string[];
  /** The arms that fired. Empty when nothing was explained. */
  arms: InvoiceSyncArm[];
}

/**
 * {@link unexplainedInvoiceItemDifferences}, but it also says WHICH arm fired.
 *
 * The residue alone is what the badge needs; a diagnostic needs the reason, and
 * api-cloudrun's deleted `audit-draft-invoice-mirror` script reported one bucket per arm. Returning
 * the arm is what let that audit be a pure CONSUMER of this function rather
 * than a second implementation of it — which is the defect api-cloudrun#481 is
 * named after, and it had already produced two comparators that disagreed about
 * 8,792 prod lines.
 */
export function explainInvoiceItemDifferences(
  expected: InvoiceItem,
  current: InvoiceItem,
  differences: readonly string[],
  context: InvoiceSyncContext,
): InvoiceSyncExplanation {
  if (differences.length === 0) return { unexplained: [], arms: [] };

  // ── Arm 0: the invoice bills its own charge windows (core#112) ──
  //
  // 🔴 **It runs FIRST and REBASES the comparison, because every arm below is a
  // statement about money, and the day count is upstream of all of it.** Priced
  // at the order's windows, a partial bill's tax rows differ for a reason that
  // has nothing to do with tax, and `tax_zero_money` would happily "explain" the
  // pair on an untaxed line. Re-deriving first means the tax arms see the
  // question they were written for: what is left once the days agree.
  const reprojected = reprojectAtInvoiceWindows(expected, context);
  const windowArms: InvoiceSyncArm[] = [];
  let remaining: readonly string[] = differences;
  if (reprojected) {
    // A field is explained only when pricing the order line at the INVOICE's
    // windows reproduces the invoice's stored value EXACTLY. Two causes at once
    // (a day change and a rate change) reproduce neither, so the line stays
    // badged — the house rule's preferred direction.
    const covered = differences.filter((d) => WINDOW_EXPLAINABLE_FIELDS.has(d) && priceKeyAgrees(reprojected, current, d));
    if (covered.length > 0) {
      windowArms.push("invoice_windows");
      const coveredSet = new Set(covered);
      remaining = differences.filter((d) => !coveredSet.has(d));
    }
  }

  const tax = explainTaxDifferences(reprojected ?? expected, current, remaining, context);
  return { unexplained: tax.unexplained, arms: [...windowArms, ...tax.arms] };
}

/**
 * The three TAX arms, over whatever the charge-window arm left
 * ({@link explainInvoiceItemDifferences}). `expected` is the rebased baseline, so
 * the `totalFollowsTax` arithmetic below is against the same line the residue was
 * measured from.
 */
function explainTaxDifferences(
  expected: InvoiceItem,
  current: InvoiceItem,
  differences: readonly string[],
  context: InvoiceSyncContext,
): InvoiceSyncExplanation {
  if (differences.length === 0) return { unexplained: [], arms: [] };
  const taxFields = differences.filter((d) => TAX_EXPLAINABLE_FIELDS.has(d));
  if (taxFields.length === 0) return { unexplained: [...differences], arms: [] };

  // ⚠️ **Every arm is a statement about a TAX-ROW difference, so none may fire
  // when `price.taxes` agrees.** Without this the zero-money arm is trivially
  // true on any untaxed line — both sides collect nothing — and would go on to
  // "explain" an unrelated `price.taxes_base` difference that has no tax-row
  // question in it at all. Measured on prod the moment the audit cross-check was
  // wired: **171 lines** where this function fired an arm and the audit, which
  // classifies only once the rows disagree, reported the two as agreeing. The
  // conservative direction is the correct one — an unexplained line is merely
  // badged, an over-explained one is invisible.
  if (!differences.includes("price.taxes")) return { unexplained: [...differences], arms: [] };

  const expectedTax = taxAmountCents(expected);
  const currentTax = taxAmountCents(current);

  // ⚠️ `isTaxableCoa` is the RETIRED gate, read here on purpose: this arm
  // explains documents written while it ran. See its docblock.
  const coaUntaxes = !isTaxableCoa((current as { coa_revenue?: COARevenueType | null }).coa_revenue) &&
    (expected as { coa_revenue?: COARevenueType | null }).coa_revenue == null;
  const dateVersion = context.orderFrozen &&
    !sameList(taxIdentity(expected), taxIdentity(current)) &&
    sameList(taxNames(expected, context.taxNameByUid), taxNames(current, context.taxNameByUid));
  const zeroMoney = expectedTax === 0 && currentTax === 0;

  // Order matters only for REPORTING — the arms are independent, and a line can
  // legitimately satisfy more than one. They are collected rather than
  // short-circuited so a diagnostic can say so instead of silently picking the
  // first, which is how a bucket count comes to misdescribe its own population.
  const arms: InvoiceSyncArm[] = [];
  if (coaUntaxes) arms.push("coa_untaxes");
  if (dateVersion) arms.push("tax_date_version");
  if (zeroMoney) arms.push("tax_zero_money");
  if (arms.length === 0) return { unexplained: [...differences], arms };

  // The total moved by EXACTLY what the tax moved, and by nothing else.
  const expectedTotal = (expected as { price?: { total_cents?: number } }).price?.total_cents ?? 0;
  const currentTotal = (current as { price?: { total_cents?: number } }).price?.total_cents ?? 0;
  const totalFollowsTax = currentTotal - expectedTotal === currentTax - expectedTax;

  const unexplained = differences.filter((d) => {
    if (!TAX_EXPLAINABLE_FIELDS.has(d)) return true;
    if (d === "price.total_cents") return !totalFollowsTax;
    return false;
  });
  return { unexplained, arms };
}

// ── Substitutions on an invoice ─────────────────────────────────

/**
 * The substitutions an invoice's order-scoped lines carry, expressed in the
 * ORDER's path space, with SPENT anchors dropped.
 *
 * Two conversions happen here and both are load-bearing:
 *
 * 1. 🔴 **The path spaces differ.** An invoice line's stored `path` is prefixed
 *    with its order divider's uid and an order line's is not, while a
 *    `substituted_for` entry names an ORDER path on every surface that stores it.
 *    Comparing a divider-scoped path against it matches nothing, and the
 *    failure is silent: every substitution reads as unexplained drift.
 * 2. ⭐ **An anchor is SPENT once the order no longer carries X** (owner,
 *    2026-09-16). A merge is always into a Y the order already has, so Y's
 *    presence on the order says nothing about whether the swap still stands.
 *
 * 🔴 **`substitutedFor` IS re-derived.** {@link syncOrderToInvoiceSelective}
 * re-points every entry at wherever X sits on the CURRENT order
 * ({@link substitutionResync}) and writes that value back. The field means *"the
 * replaced line's current order path"*, not *"its path at the moment of the
 * swap"* — a locked value is what let an order-side reparent resurrect X
 * (api-cloudrun#897). The sync is the only place that can do this: it is the one
 * caller holding both revisions of the order. Every downstream reader — the wire
 * guard, `api-cloudrun/scripts/audit-fulfillment-divergence.ts`, {@link computeInvoiceSyncStatus},
 * {@link computeOrderInvoiceCoverage} — sees only the current order.
 *
 * @param scopedInvoiceItems - This order divider's invoice items
 * @param orderItems - The order's CURRENT items
 * @param orderDividerUid - The order divider's uid
 * @returns Live anchors, in order-relative path space
 */
export function liveInvoiceAnchors(
  scopedInvoiceItems: readonly InvoiceItem[],
  orderItems: readonly LineItem[],
  orderDividerUid: string,
): SubstitutionAnchor[] {
  const orderPathKeys = new Set<string>();
  for (const it of orderItems) orderPathKeys.add(itemPathKey(it.path ?? []));
  const anchors = collectSubstitutionAnchors(
    scopedInvoiceItems.map((it) => ({
      path: stripOrderPrefix(it.path ?? [], orderDividerUid),
      substituted_for: it.substituted_for,
    })),
  );
  return anchors.filter((a) => orderPathKeys.has(itemPathKey(a.substitutedFor)));
}

// ── Per-field sync — the ONLY mode (api-cloudrun#890) ───────────

/**
 * The fields an order shares with an invoice, split by the unit the merge runs
 * on. Read from the two schemas by {@link classifySharedFields}, so there is no
 * field list here to drift.
 */
export interface OrderInvoiceSharedFields {
  /** One `items[]` row, paths relative to the row. */
  line: readonly SharedField[];
  /** One `destinations[]` pair, paths relative to the pair. */
  pair: readonly SharedField[];
  /** The document itself, every row excluded. */
  doc: readonly SharedField[];
}

let orderInvoiceSharedFieldsMemo: OrderInvoiceSharedFields | undefined;

/**
 * {@link OrderInvoiceSharedFields}, classified once per process.
 *
 * @throws Error when the classification reports a node it could not interpret —
 *   the merge would otherwise silently skip that field.
 */
export function orderInvoiceSharedFields(): OrderInvoiceSharedFields {
  if (orderInvoiceSharedFieldsMemo) return orderInvoiceSharedFieldsMemo;
  const c = classifySharedFields(OrderSchema, InvoiceSchema);
  if (c.unhandled.length > 0) {
    throw new Error(`order → invoice shared fields unclassified: ${JSON.stringify(c.unhandled)}`);
  }
  if (c.undeclared.length > 0) {
    throw new Error(
      `order → invoice shared fields undeclared — tag each with .meta({ propagate: true }) ` +
        `or .meta({ propagate: false }) if it is a homonym: ${c.undeclared.join(", ")}`,
    );
  }
  orderInvoiceSharedFieldsMemo = {
    line: fieldsUnder(c, "items[]"),
    pair: fieldsUnder(c, "destinations[]"),
    doc: fieldsUnder(c, ""),
  };
  return orderInvoiceSharedFieldsMemo;
}

/**
 * The context the per-field order → invoice sync needs beyond the documents.
 *
 * Each shared field follows the order unless the invoice's value differs from
 * the order's PREVIOUS value — `mergeSharedFields`, one matched row at a time.
 *
 * ⚠️ **This used to be optional, and omitting it selected a WHOLE-ROW mode** in
 * which one differing field (derived money included) froze every field of the
 * row (G1, G2, G6, G7). That mode was additive on purpose while the per-field
 * rule swept out to prod; it shipped in `v0.270.0` (2026-09-15), left no caller
 * behind, and was deleted rather than left as a second way to be wrong.
 */
export interface OrderInvoiceFieldSync {
  /**
   * The holiday dates a pair's day counts are recomputed with, when its merged
   * window is neither the order's nor the invoice's (some leaves from each).
   */
  holidays: readonly string[];
}

/** Is any shared field of this invoice row different from the previous order row? */
function lineOverridden(prevOrderItem: LineItem, invoiceItem: InvoiceDocItemType, orderDividerUid: string): boolean {
  const prev = projectOrderItemToInvoiceItem(prevOrderItem, orderDividerUid);
  return mergeSharedFields(orderInvoiceSharedFields().line, prev, prev, invoiceItem).overridden.length > 0;
}

/** The three-way rule on one matched invoice row. Invoice-only keys are kept by construction. */
function mergeLine(
  prevOrderItem: LineItem,
  newOrderItem: LineItem,
  invoiceItem: InvoiceDocItemType,
  orderDividerUid: string,
): InvoiceDocItemType {
  return mergeSharedFields(
    orderInvoiceSharedFields().line,
    projectOrderItemToInvoiceItem(prevOrderItem, orderDividerUid),
    projectOrderItemToInvoiceItem(newOrderItem, orderDividerUid),
    invoiceItem,
  ).merged;
}

/** Is any shared field of this invoice pair different from the previous order pair? */
function pairOverridden(prev: DocDestinationType, inv: InvoiceDestinationPair, uidOrder: string): boolean {
  const p = toInvoiceDestinationPair(uidOrder, prev);
  return mergeSharedFields(orderInvoiceSharedFields().pair, p, p, inv).overridden.length > 0;
}

/**
 * The three-way rule on one matched pair, then its window's derived fields.
 *
 * The merge runs per `dates` leaf and leaves the derived `_fs` mirrors and day
 * counts as the invoice had them. So afterwards:
 * - window unchanged from the invoice's → nothing to recompute;
 * - window equal to the new order's → take the order's `dates` whole, whose
 *   derived fields were computed from exactly those boundaries;
 * - a mix of the two → each `_fs` from the side its boundary came from, and the
 *   day counts recomputed with `holidays`.
 *
 * 🔴 A mixed window can be invalid (the invoice moved delivery later, the order
 * moved collection earlier). Then the invoice keeps its WHOLE `dates` object and
 * the pair diff shows it. An invalid window is never written.
 */
function mergePair(
  prev: DocDestinationType,
  next: DocDestinationType,
  inv: InvoiceDestinationPair,
  uidOrder: string,
  holidays: readonly string[],
): InvoiceDestinationPair {
  const nextPair = toInvoiceDestinationPair(uidOrder, next);
  const { merged } = mergeSharedFields(
    orderInvoiceSharedFields().pair,
    toInvoiceDestinationPair(uidOrder, prev),
    nextPair,
    inv,
  );

  const dates = resolveMergedPairDates(
    merged.dates,
    nextPair.dates,
    inv.dates,
    holidays,
    canonicalChargeWindows,
  );
  // `null` means the merged window was invalid — keep the invoice's whole
  // `dates` and let the pair diff show it. An invalid window is never written.
  return dates === null ? { ...merged, dates: inv.dates } : { ...merged, dates };
}

/**
 * Selectively sync order items into an invoice, respecting invoice-side overrides.
 *
 * Items are matched by **path** (not uid), since the same product can appear at
 * multiple positions in the items array. For each item:
 *
 * - **Synced** (prev order matches current invoice, minus invoice-only fields):
 *   replaced with the new order item, carrying forward invoice-only overrides
 * - **Overridden** (invoice item differs from prev order): left unchanged
 * - **New** (in new order, not in prev): added under the order divider
 * - **Left out** (a LINE in prev and new, never on the invoice): stays out
 * - **Removed** (in prev order, not in new): removed only if synced, kept if overridden
 * - **Extension sections** ({@link extensionSectionTargets}): passed through
 *   verbatim, at the tail of the scope
 * - **Substituted** ({@link liveInvoiceAnchors}): X's whole subtree is suppressed
 *   and Y's is emitted in its place — see below
 * - **`substituted_for` entries** (manager#414): every row is merged at its
 *   ORDER-EQUIVALENT quantity (D2) and re-offset against the new order, so a
 *   merged Y and a partially swapped X follow order quantity edits. A substitute
 *   row the order does not carry is placed after X's subtree. Entries are
 *   re-pointed when X moves; once the order drops X, the entry and its units go
 *   with it (owner, 2026-09-16)
 *
 * ## 🔴 Why the substitution arm exists: without it a substitution lasts until
 * the next order save
 *
 * Measured against this function before the arm was added, with the order
 * UNCHANGED (`prev === new`) and the invoice holding Y in X's place:
 *
 * ```
 * BEFORE  invoice lines: [ "Light Y" ]
 * AFTER   invoice lines: [ "Light X" ]
 * ```
 *
 * Both halves of the path match fail, and each fails toward undoing the
 * operator's edit: X's order path has no invoice line, so the `!invoiceItem`
 * branch re-projects X; Y's path has no PREV ORDER line, so the removed-items
 * pass drops it as a synced line the order no longer carries. **Neither branch
 * is wrong on its own** — the pair is only wrong because nothing told this
 * function the two rows are the same row, and `substituted_for` is what
 * says so.
 *
 * ⭐ That is Increment 2's lesson on a third surface. A projection undoes any
 * downstream override not stored in a form the projection HONOURS, and being
 * *stored* is not enough — the substitution record was already a stored field on
 * fulfillments and this function had never heard of it.
 *
 * ## 🔴 A line the invoice LEFT OUT stays out (api-cloudrun#680 R1, owner 2026-09-15)
 *
 * The documented rule above was always "new = in new order, not in prev", and the
 * code projected EVERY order line the invoice lacked. So an unsettled partial
 * invoice was refilled with the whole order on its next save, and an "invoice
 * remaining" invoice re-billed lines another invoice had already billed. A line
 * counts as new only when the previous order had no line at its path and no line
 * that moved there. Dividers are still projected when missing: they are the
 * skeleton alignment reads, not something an operator bills.
 *
 * ## Extension sections are billing, not order structure
 *
 * An extension section's divider names no order path of its own, so without its
 * own arm the removed-items pass would drop the divider and every line under it
 * as "synced and removed from the order". They are emitted untouched after
 * everything else.
 *
 * ⚠️ **The whole-scope {@link syncOrderItems} deliberately does NOT get this
 * arm.** It is the operator's hard snap-to-order, documented to discard
 * overrides and drop lines the order no longer has; a substitution is an
 * override, so discarding it is what the operator asked for. Only the automatic
 * per-save sync has to be non-destructive.
 *
 * @param prevOrderItems - Items from the previous version of the order
 * @param newOrderItems - Items from the new version of the order
 * @param currentInvoiceItems - Items scoped to this order in the current invoice (without order divider)
 * ## Every decision is PER FIELD ({@link OrderInvoiceFieldSync})
 *
 * A matched row is {@link mergeSharedFields}'d rather than replaced-or-kept, and
 * a removed row is dropped only when no shared field was overridden. Derived
 * money is never compared, so it can neither freeze a line nor keep a removed
 * one.
 *
 * And a LINE the order moved to a new path, which the invoice carried at the old
 * one, moves with it and keeps every invoice-only field (G3).
 *
 * @param orderDividerUid - The uid of the order divider in the invoice
 * @returns Updated invoice items (scoped under the order divider, ready for insertion)
 *
 * ⚠️ **It takes no {@link OrderInvoiceFieldSync}, and that is not an oversight.**
 * The only thing the context carries is `holidays`, which settles a merged
 * window's day counts — a PAIR concern. Items reach it through
 * {@link syncOrderDestinationScope}, which owns both halves. An unused parameter here would
 * read as "this path considers holidays" when it does not.
 */
export function syncOrderToInvoiceSelective(
  prevOrderItems: LineItem[],
  newOrderItems: LineItem[],
  currentInvoiceItems: InvoiceDocItemType[],
  orderDividerUid: string,
): InvoiceDocItemType[] {
  return syncScopedItems(prevOrderItems, newOrderItems, currentInvoiceItems, orderDividerUid).items;
}

/** {@link syncOrderToInvoiceSelective}'s body. */
function syncScopedItems(
  prevOrderItems: LineItem[],
  newOrderItems: LineItem[],
  storedInvoiceItems: InvoiceDocItemType[],
  orderDividerUid: string,
): { items: InvoiceDocItemType[] } {
  const emit = (row: InvoiceDocItemType) => {
    result.push(row);
  };
  const newPathKeys = new Set(newOrderItems.map((it) => itemPathKey(it.path)));
  // Index prev order items by path key
  const prevByPath = new Map<string, LineItem>();
  for (const item of prevOrderItems) {
    prevByPath.set(itemPathKey(item.path), item);
  }

  // Extension sections bill money on lines another invoice billed; they pass
  // through untouched and take no part in the path match below.
  const extensionTargets = extensionSectionTargets(storedInvoiceItems as InvoiceItem[], orderDividerUid);
  const extensionRows = storedInvoiceItems.filter((it) => isInExtensionSection(it.path, orderDividerUid, extensionTargets));
  const relOf = (row: { path: readonly string[] }) => stripOrderPrefix([...row.path], orderDividerUid);

  // Where each order LINE moved between the two revisions. Dividers are excluded
  // deliberately: an anchor names a line, and a divider's path moving is
  // structure rather than a row changing places.
  const moved = mapPathsAcrossRebuild(
    prevOrderItems.filter((it) => isLineItemType(it.type)),
    newOrderItems.filter((it) => isLineItemType(it.type)),
  );

  // ── `substituted_for` entries (manager#414) ──
  //
  // D2: a row's quantity is the order's at its path, less the units substitutes
  // took from it, plus Σ what it stands in for. Every comparison below reads the
  // ORDER-EQUIVALENT quantity (the offset under the PREVIOUS order removed), and
  // the offset under the NEW order is applied to what is emitted — so an order
  // quantity change reaches a merged or partially swapped row instead of reading
  // as an operator override that freezes it.
  //
  // An entry is live while the order carries its X (owner, 2026-09-16), re-pointed
  // at wherever X sits now. Once the new order lacks X, the entry is dropped and
  // its units go WITH it (owner, 2026-09-16): the stand-in was for a line the
  // order no longer has.
  const resync = substitutionResync(
    storedInvoiceItems
      .filter((it) => isLineItemType(it.type) && !isInExtensionSection(it.path, orderDividerUid, extensionTargets))
      .map((it) => ({ path: relOf(it), substituted_for: (it as InvoiceItem).substituted_for })),
    prevOrderItems.filter((it) => isLineItemType(it.type)),
    newOrderItems.filter((it) => isLineItemType(it.type)),
    (x) => moved.toPath(x),
  );
  const entryAnchorsNew = resync.anchorsNext;

  /** The stored row at its order-equivalent quantity under the previous order. */
  const normalize = (row: InvoiceDocItemType): InvoiceDocItemType => {
    if (!isLineItemType(row.type) || isInExtensionSection(row.path, orderDividerUid, extensionTargets)) return row;
    const quantity = resync.orderEquivalent(relOf(row), row as InvoiceItem);
    if (quantity === ((row as InvoiceItem).quantity ?? 0)) return row;
    return { ...row, quantity } as InvoiceDocItemType;
  };
  const currentInvoiceItems = storedInvoiceItems.map(normalize);

  // Index current invoice items by order-relative path key
  const invoiceByPath = new Map<string, InvoiceDocItemType>();
  for (const item of currentInvoiceItems) {
    if (isInExtensionSection(item.path, orderDividerUid, extensionTargets)) continue;
    const relPath = stripOrderPrefix(item.path, orderDividerUid);
    invoiceByPath.set(itemPathKey(relPath), item);
  }

  const result: InvoiceDocItemType[] = [];
  const processedInvoicePaths = new Set<string>();
  /** Order-relative keys already emitted by the substitution arm. */
  const emittedSubstituted = new Set<string>();

  // An entry's substitute rows that the NEW order does not carry at their own
  // path, grouped by X's new key. They are placed right AFTER X's subtree —
  // never inside it, where a positional path recompute would reparent them
  // under X — whether or not X itself is still on the invoice.
  const entryRowsByX = new Map<string, InvoiceDocItemType[]>();
  for (const a of entryAnchorsNew) {
    const rows = currentInvoiceItems.filter((it) => {
      const rel = relOf(it);
      return isAtOrBelow(rel, a.path) && !newPathKeys.has(itemPathKey(rel)) &&
        !isInExtensionSection(it.path, orderDividerUid, extensionTargets);
    });
    const x = itemPathKey(a.substitutedFor);
    entryRowsByX.set(x, [...(entryRowsByX.get(x) ?? []), ...rows]);
  }
  const enteredX = new Map<string, readonly string[]>();
  const flushEntryRows = (x: string) => {
    for (const row of entryRowsByX.get(x) ?? []) {
      const relKey = itemPathKey(relOf(row));
      if (emittedSubstituted.has(relKey)) continue;
      emittedSubstituted.add(relKey);
      // A merged Y the order dropped keeps only its stand-in units, unless its
      // own part was overridden on the invoice.
      const prevItem = prevByPath.get(relKey);
      const own = prevItem && !lineOverridden(prevItem, row, orderDividerUid) ? 0 : (row as InvoiceItem).quantity ?? 0;
      emit({ ...row, quantity: own } as InvoiceDocItemType);
    }
    enteredX.delete(x);
  };

  // Process new order items in order
  for (const newItem of newOrderItems) {
    const pathKey = itemPathKey(newItem.path);
    for (const [x, xPath] of enteredX) {
      if (!isAtOrBelow(newItem.path, xPath)) flushEntryRows(x);
    }
    if (entryRowsByX.has(pathKey)) enteredX.set(pathKey, newItem.path);

    const prevItem = prevByPath.get(pathKey);
    const invoiceItem = invoiceByPath.get(pathKey);
    processedInvoicePaths.add(pathKey);

    if (!invoiceItem) {
      // A LINE the previous order already had that the invoice does not carry
      // was left out on purpose: keep it out. A line that MOVED here counts as
      // left out only if the invoice did not carry it at its old path either —
      // otherwise this is the invoice's own line following a reparent.
      if (isLineItemType(newItem.type)) {
        const movedFrom = prevItem ? undefined : moved.fromPath(newItem.path);
        const movedFromKey = movedFrom !== undefined ? itemPathKey(movedFrom) : undefined;
        const carriedBefore = movedFromKey !== undefined && invoiceByPath.has(movedFromKey);
        if (prevItem || (movedFrom !== undefined && !carriedBefore)) continue;

        // The invoice's own row moves with the line and keeps every field (G3).
        // Only when no order line took over the old path — otherwise that row
        // belongs to the line sitting there now, and a fresh projection stands.
        const movedPrev = movedFromKey !== undefined ? prevByPath.get(movedFromKey) : undefined;
        if (carriedBefore && movedPrev && !newPathKeys.has(movedFromKey!)) {
          const stored = invoiceByPath.get(movedFromKey!)!;
          processedInvoicePaths.add(movedFromKey!);
          const row = {
            ...mergeLine(movedPrev, newItem, stored, orderDividerUid),
            path: [orderDividerUid, ...newItem.path],
          } as InvoiceDocItemType;
          emit(row);
          continue;
        }
      }
      // New item — project to invoice shape, scoped under the order divider
      emit(projectOrderItemToInvoiceItem(newItem, orderDividerUid));
    } else if (prevItem) {
      // Each shared field follows the order unless the invoice overrode it.
      emit(mergeLine(prevItem, newItem, invoiceItem, orderDividerUid));
    } else {
      // Overridden or no prev item — keep invoice item unchanged
      emit(invoiceItem);
    }
  }

  for (const x of [...enteredX.keys()]) flushEntryRows(x);

  // Handle removed items (in invoice but not in new order)
  for (const [pathKey, invoiceItem] of invoiceByPath) {
    if (processedInvoicePaths.has(pathKey) || emittedSubstituted.has(pathKey)) continue;

    const prevItem = prevByPath.get(pathKey);
    const overridden = prevItem !== undefined && lineOverridden(prevItem, invoiceItem, orderDividerUid);
    if (overridden) {
      // Overridden — keep it even though it's been removed from the order
      emit(invoiceItem);
    }
    // Else: synced and removed from order — drop it
  }

  for (const row of extensionRows) emit(row);

  // Apply the NEW order's D2 offset, re-point live entries and strip spent ones.
  // A substituted row left with no units is dropped, with everything below it.
  const items: InvoiceDocItemType[] = [];
  const droppedPaths: string[][] = [];
  for (const row of result) {
    if (!isLineItemType(row.type) || isInExtensionSection(row.path, orderDividerUid, extensionTargets)) {
      items.push(row);
      continue;
    }
    const rel = relOf(row);
    if (droppedPaths.some((d) => isStrictlyBelow(rel, d))) continue;
    const { quantity, substituted_for, substituted } = resync.reoffset(
      rel,
      (row as InvoiceItem).substituted_for,
      (row as InvoiceItem).quantity ?? 0,
    );
    if (!substituted) {
      items.push(row);
      continue;
    }
    if (quantity <= 0) {
      droppedPaths.push(rel);
      continue;
    }
    const out = { ...row, quantity } as InvoiceDocItemType & { substituted_for?: SubstitutedForEntryType[] };
    if (substituted_for) out.substituted_for = substituted_for as SubstitutedForEntryType[];
    else delete out.substituted_for;
    items.push(out);
  }
  return { items };
}

// ── Invoice path computation ─────────────────────────────────────

/**
 * The structural divider hierarchy of an INVOICE's items array, outermost
 * first — one level deeper than an order's, because an invoice can bill
 * several orders and separates them with an `order` divider.
 *
 * @see {@link ORDER_ITEM_LEVELS}
 */
export const INVOICE_ITEM_LEVELS = ["order", "destination", "group"] as const;

/**
 * Compute paths for all invoice items, respecting order divider scoping.
 *
 * This is `computeItemPaths` at invoice depth, and nothing else — the invoice
 * hierarchy IS the order hierarchy with `order` prepended, and "a divider
 * closes every level at or below its own" already expresses order-divider
 * scoping. It is kept as a named function rather than asking callers to pass
 * `INVOICE_ITEM_LEVELS` themselves because the level list is the one thing a
 * caller must not get wrong: handing invoice items the order hierarchy would
 * silently treat every `order` divider as an ordinary line item and drop it out
 * of every path.
 *
 * It used to be a real wrapper — slice into per-divider scopes, strip the
 * prefix, delegate, re-add the prefix — and that scope loop is where D1 lived:
 * it returned early when no `order` divider had been seen, so any invoice
 * without one fell through to a tail loop that copied the INPUT objects by
 * reference. No prefix, no self-append, no linearization, and the documented
 * purity guarantee false on that branch. 28 prod invoices / 79 items sat at
 * `path: []`, and the write guard — "path equals what this function
 * produces" — called them clean, because a fixed-point check inherits every
 * hole in its normalizer. With the levels generalized there is no scope loop to
 * return early from, so that shape is now unwriteable rather than merely fixed.
 *
 * Pure: returns a fresh array of fresh items. Inputs are not mutated, so it is
 * safe to pass items that originate from a Solid store proxy. Callers should
 * replace their working array with the return value.
 *
 * Generic in `T`, like every sibling here (`computeItemPaths`,
 * `validateItemPaths`, `validateInvoiceItemPaths`, `getItemSubtreeRange`), so a
 * caller holding the real `Invoice["items"]` gets it back rather than the loose
 * `InvoiceItem[]`.
 */
export function computeInvoiceItemPaths<T extends InvoiceItem>(items: T[]): T[] {
  return computeItemPaths(items, INVOICE_ITEM_LEVELS);
}

/**
 * Assert every invoice item's `path` matches what {@link computeInvoiceItemPaths}
 * would produce — the order-divider-scoped variant of {@link computeItemPaths}.
 *
 * Use as a defensive write-time invariant: any client that writes invoices
 * should pipe `items` through `computeInvoiceItemPaths` first, so a non-empty
 * result here means the client skipped the recompute step. Also flags index
 * positions whose `uid` doesn't match the recomputed array's uid at the same
 * index — under depth-first contiguity, a uid mismatch means the array needs
 * re-linearization.
 *
 * Returns `[]` when every path is clean and order is canonical.
 */
export function validateInvoiceItemPaths<T extends InvoiceItem>(items: T[]): ItemPathIssue[] {
  return validatePathsAgainst(items, computeInvoiceItemPaths);
}

/**
 * Within-parent uniqueness check for invoice items.
 *
 * 🔴 **Keyed on the parent's full PATH, not its uid — unlike
 * {@link validateItemUniqueness}.** A date-extension section (api-cloudrun#680
 * R1) repeats the divider subtree of the order destination it extends under a
 * new section divider: `[O, D, G, L]` and `[O, E, G, L]` are two rows, and the
 * group `G` keeps its uid because alignment reads `[O, E, G]` as the order's
 * `[D, G]`. Keyed on the parent uid they collide. A doubled tree — the collapse
 * this guards — repeats the full path, so it is still refused.
 *
 * The scopes, by what the parent path ends in:
 *  - top-level destination/group/product under an order divider →
 *    parentUid is the order divider uid (first segment),
 *  - product under a destination → parentUid is the destination uid,
 *  - product under a group → parentUid is the group uid,
 *  - component → parentUid is the parent product line uid.
 *
 * So the `(parentUid, uid)` key naturally scopes per order divider for
 * top-level entries, and per parent product for nested ones.
 *
 * Returns `[]` when uniqueness holds.
 */
export function validateInvoiceItemUniqueness<T extends InvoiceItem>(items: T[]): ItemUniquenessIssue[] {
  const seen = new Map<string, number>();
  const issues: ItemUniquenessIssue[] = [];
  for (let i = 0; i < items.length; i++) {
    const path = items[i].path ?? [];
    const parent = path.slice(0, -1);
    const key = parent.join("/") + "\0" + items[i].uid;
    const firstIndex = seen.get(key);
    if (firstIndex !== undefined) {
      issues.push({ index: i, uid: items[i].uid, parentUid: parent.at(-1) ?? null, firstIndex });
    } else {
      seen.set(key, i);
    }
  }
  return issues;
}

// ── Order-scoped item sync ──────────────────────────────────────

/**
 * Get all invoice items scoped to a specific order divider.
 * Returns the order divider itself plus all items whose path starts
 * with the order divider's uid.
 *
 * @param items - Full invoice items array
 * @param orderDividerUid - The uid of the order divider item
 * @returns Items scoped to that order (divider + children)
 */
export function getOrderScopedItems<T extends InvoiceItem>(items: T[], orderDividerUid: string): T[] {
  return items.filter((item) =>
    (item.type === "order" && item.uid === orderDividerUid) ||
    item.path[0] === orderDividerUid
  );
}

/**
 * Remove all invoice items scoped to a specific order divider.
 * Returns a new array with the order divider and all items whose path
 * starts with the order divider's uid removed.
 *
 * @param items - Full invoice items array
 * @param orderDividerUid - The uid of the order divider item to remove
 * @returns Items with the order scope removed
 */
export function removeOrderScopedItems<T extends InvoiceItem>(items: T[], orderDividerUid: string): T[] {
  return items.filter((item) =>
    !(item.type === "order" && item.uid === orderDividerUid) &&
    item.path[0] !== orderDividerUid
  );
}

/**
 * Build invoice items from an order's items, scoped under an order divider.
 * Projects each order item to its invoice-item shape and prepends the order
 * divider uid to its path.
 *
 * @param orderItems - The order's items array (may contain destination/group/line items)
 * @param orderDividerUid - The uid of the order divider these items belong under
 * @returns Items projected to invoice shape with path prepended by orderDividerUid
 */
export function buildOrderScopedItems(orderItems: LineItem[], orderDividerUid: string): InvoiceDocItemType[] {
  return orderItems.map((item) => projectOrderItemToInvoiceItem(item, orderDividerUid));
}

// ── Divider-structure adoption ──────────────────────────────────

/**
 * A uid that identifies more than one line on at least one side, so the k-th
 * occurrence pairing in {@link adoptOrderDividerStructure} is a guess rather
 * than a fact. Reported, never silently resolved.
 */
export interface AmbiguousItemPairing {
  uid: string;
  /** Occurrences of this uid among the scope's invoice LINE items. */
  invoiceOccurrences: number;
  /** Occurrences of this uid among the order's LINE items. */
  orderOccurrences: number;
}

/** @see {@link adoptOrderDividerStructure} */
export interface AdoptedDividerStructure {
  items: InvoiceDocItemType[];
  ambiguous: AmbiguousItemPairing[];
}

/**
 * Re-hang one order-scope of an invoice's items on the ORDER's divider
 * skeleton. Pure, and **structure-only**.
 *
 * The CRMS invoice tree carries none of the `group` dividers its order does
 * (measured 2026-08-10: zero of 999 prod invoices carry one; 941 of 978 orders
 * do), so every invoice line's path is shorter than its counterpart's and the
 * path-keyed comparators match nothing at all — `computeInvoiceSyncStatus`
 * reports every line both "missing" and "removed", and
 * `syncOrderToInvoiceSelective` re-projects nothing. This is what makes the two
 * trees comparable again; the direction is settled — **the order tree is
 * right**, and `flattenForXero` strips dividers at the Xero boundary so
 * carrying them costs Xero nothing.
 *
 * What it does:
 * - **Adopts the order's divider skeleton wholesale.** A `destination`/`group`
 *   divider the order carries is placed at the order's position; an invoice-side
 *   divider the order lacks is dropped. A divider the invoice ALREADY carries
 *   under the same uid keeps its own row — only its `path` moves. That is
 *   deliberate, because this pass is **structure-only**: it re-hangs rows and
 *   never restates their content, so an invoice-side row's own fields survive
 *   whatever else moves around them.
 *   ⚠️ The ORIGINAL justification is dead and must not be re-derived. It argued
 *   from 112 prod invoices whose destination dividers named a different
 *   `destinations` doc than the order's — but a divider carries no
 *   `uid_delivery`/`uid_collection` at all any more (deleted from
 *   `DestinationDividerArm` at the api-cloudrun#662/#663/#664 contract step and
 *   purged from both corpora). An endpoint divergence now lives on the PAIR
 *   (`destinations[i].delivery.uid`), which is api-cloudrun#676's subject and
 *   nothing this function reads.
 * - **Re-paths each paired line** to `[orderDividerUid, ...orderLine.path]`.
 * - **Adds, removes, re-prices, re-names and re-quantifies nothing.** An order
 *   line the invoice does not carry is NOT added; an invoice line the order does
 *   not carry is kept, at its current parent (root of the order scope when that
 *   parent no longer exists), because an invoice-only line is line-level drift
 *   for the badge to report — not a structural defect to erase.
 * - **Passes any `order` divider row through at the head**, and never mints one:
 *   its identity is the source order's uid and only the caller knows it.
 *
 * Pairing is by `uid`; where a uid repeats, the k-th invoice occurrence pairs
 * with the k-th order occurrence in document order. `uid` is NOT a row identity
 * (it repeats within one document on 18% of prod orders), so those pairings are
 * returned in `ambiguous` for the caller to surface rather than being trusted
 * silently.
 *
 * The result is a fixed point of {@link computeInvoiceItemPaths}: callers still
 * run it (and {@link validateInvoiceItemUniqueness}) before writing.
 *
 * @param scopedInvoiceItems - This order's slice of the invoice's items, as
 *   {@link getOrderScopedItems} returns it (the `order` divider may be present
 *   or absent)
 * @param orderItems - The source order's full `items` array
 * @param orderDividerUid - The order divider's uid, i.e. the source order's uid
 */
export function adoptOrderDividerStructure(
  scopedInvoiceItems: InvoiceDocItemType[],
  orderItems: LineItem[],
  orderDividerUid: string,
): AdoptedDividerStructure {
  const orderDividerRows = scopedInvoiceItems.filter((it) => it.type === "order");
  const rest = scopedInvoiceItems.filter((it) => it.type !== "order");
  const invoiceLines = rest.filter((it) => isLineItemType(it.type));
  const invoiceDividerByUid = new Map<string, InvoiceDocItemType>();
  for (const it of rest) if (!isLineItemType(it.type)) invoiceDividerByUid.set(it.uid, it);

  // ── pair lines by (uid, k-th occurrence) ──
  // The pairing itself is `pairItemsByUidOccurrence` (`utils/item-pairing.ts`),
  // which is where the argument for the key lives. It moved there when
  // `syncItems` (`api-cloudrun/src/lib/orderFulfillmentSync.ts`) needed the same
  // question answered across two ORDERS: two copies of one pairing rule in one
  // domain is what api-cloudrun#593 was.
  // {@link AmbiguousItemPairing} stays declared here rather than being replaced
  // by the generic `AmbiguousPairing`, because its field names name the two
  // SIDES — which a function paired over anything cannot.
  const orderLines = orderItems.filter((it) => isLineItemType(it.type));
  const { forward: pairedFor, matched: paired, ambiguous: guessed } = pairItemsByUidOccurrence(
    orderLines,
    invoiceLines,
  );
  const ambiguous: AmbiguousItemPairing[] = guessed.map((a) => ({
    uid: a.uid,
    invoiceOccurrences: a.toOccurrences,
    orderOccurrences: a.fromOccurrences,
  }));

  // ── where does each unpaired invoice line hang? ──
  const unpaired = invoiceLines.filter((it) => !paired.has(it));
  const surviving = new Set<string>();
  for (const it of orderItems) if (isDividerItemType(it.type)) surviving.add(it.uid);
  for (const orderLine of pairedFor.keys()) surviving.add(orderLine.uid);
  for (const it of unpaired) surviving.add(it.uid);

  /** Key `""` is the root of the order scope. */
  const unpairedByParent = new Map<string, InvoiceDocItemType[]>();
  for (const it of unpaired) {
    // The last segment that is not the item's own uid. Deliberately NOT
    // `path.at(-2)`: that reads a parent only from a SELF-INCLUSIVE path, and a
    // caller may hand this items still carrying the pre-normalized ancestry chain
    // (`[principalUid]`, or `[]`) that `computeInvoiceItemPaths` has not yet
    // turned into a full path. This form answers correctly for both, and for a
    // top-level line under a divider it returns the divider — which is exactly
    // the parent it hangs from.
    // ⚠️ That caller was the CRMS invoice webhook, which **no longer exists** —
    // it went with the 2026-09 cutover, and the only live caller of this function
    // today is `api-cloudrun/scripts/repair-invoice-structure.ts`. So the
    // pre-normalized case is exercised by `tests/invoices.test.ts` alone. Kept
    // because a repair script is exactly where an unnormalized tree turns up.
    const rel = stripOrderPrefix(it.path ?? [], orderDividerUid);
    let claimed = "";
    for (let k = rel.length - 1; k >= 0; k--) {
      if (rel[k] !== it.uid) {
        claimed = rel[k];
        break;
      }
    }
    const parent = claimed !== "" && surviving.has(claimed) ? claimed : "";
    const bucket = unpairedByParent.get(parent);
    if (bucket) bucket.push(it);
    else unpairedByParent.set(parent, [it]);
  }

  // ── emit ──
  const out: InvoiceDocItemType[] = orderDividerRows.map((d) => ({ ...d, path: [d.uid] }));
  const emitted = new Set<InvoiceDocItemType>();
  const emitUnpairedChildren = (parentUid: string, parentPath: string[]) => {
    for (const child of unpairedByParent.get(parentUid) ?? []) {
      if (emitted.has(child)) continue;
      emitted.add(child);
      const childPath = [...parentPath, child.uid];
      out.push({ ...child, path: childPath } as InvoiceDocItemType);
      emitUnpairedChildren(child.uid, childPath);
    }
  };

  // Root-level invoice-only lines head the scope. Appending them instead would
  // drop them inside whichever divider happened to be last, silently changing
  // the parent of the one population this function promises not to move.
  emitUnpairedChildren("", [orderDividerUid]);

  for (const orderItem of orderItems) {
    const path = [orderDividerUid, ...(orderItem.path ?? [])];
    if (isDividerItemType(orderItem.type)) {
      const existing = invoiceDividerByUid.get(orderItem.uid);
      out.push(
        existing
          ? ({ ...existing, path } as InvoiceDocItemType)
          : projectOrderItemToInvoiceItem(orderItem, orderDividerUid),
      );
      emitUnpairedChildren(orderItem.uid, path);
      continue;
    }
    const match = pairedFor.get(orderItem);
    if (!match) continue; // an order line the invoice does not bill — not added
    out.push({ ...match, path } as InvoiceDocItemType);
    emitUnpairedChildren(orderItem.uid, path);
  }

  return { items: out, ambiguous };
}

/**
 * Is one order-scope of an invoice hung on the same divider skeleton as its
 * order? The alignment predicate {@link adoptOrderDividerStructure} drives
 * toward, and the one definition of "aligned" the audit and the endpoint share.
 *
 * ⚠️ **It compares DIVIDER paths, not all paths.** Full path-set equality is
 * the wrong criterion and would never go green: measured 2026-08-10, 15 of the
 * 102 prod pairs carrying a custom line carry a legitimate invoice-only line,
 * which makes the path sets differ forever while the tree shapes agree
 * perfectly. A line the order lacks is **line-level drift**, correctly reported
 * `out_of_sync` by {@link computeInvoiceSyncStatus}; conflating it with a
 * structural misalignment would make the two indistinguishable and the
 * structural repair unfinishable.
 *
 * The invoice's own `order` divider is excluded — it has no order-side
 * counterpart by construction (`isDividerItemType("order")` is `true`).
 */
export function invoiceScopeDividersMatch(
  scopedInvoiceItems: InvoiceItem[],
  orderItems: LineItem[],
  orderDividerUid: string,
): boolean {
  // An extension section reads as the order divider it extends, so a scope
  // holding both that divider and its extension collapses to one key, and a
  // scope holding only the extension still names the order's divider. A
  // `path_extension_for` naming no order divider leaves a key the order lacks,
  // which is exactly an unaligned scope.
  const targets = extensionSectionTargets(scopedInvoiceItems, orderDividerUid);
  const invoice = new Set<string>();
  for (const it of scopedInvoiceItems) {
    if (it.type === "order" || !isDividerItemType(it.type)) continue;
    invoice.add(itemPathKey(toOrderRelativePath(it.path ?? [], orderDividerUid, targets)));
  }
  const order = new Set<string>();
  for (const it of orderItems) {
    if (!isDividerItemType(it.type)) continue;
    order.add(itemPathKey(it.path ?? []));
  }
  if (invoice.size !== order.size) return false;
  for (const k of order) if (!invoice.has(k)) return false;
  return true;
}

/**
 * Carry forward invoice-specific overrides from existing items to rebuilt items.
 * Matches by uid — if a rebuilt item has the same uid as an existing invoice
 * item, the {@link INVOICE_ONLY_ITEM_FIELDS} are preserved from the existing
 * item. The field list is not restated here on purpose; this delegates to
 * {@link pickInvoiceOnlyFields} so there is one place to change.
 *
 * @param rebuiltItems - Items rebuilt from the order
 * @param existingItems - Current invoice items (to carry forward overrides from)
 * @returns Rebuilt items with invoice-specific overrides applied
 */
export function carryForwardOverrides(rebuiltItems: InvoiceDocItemType[], existingItems: InvoiceItem[]): InvoiceDocItemType[] {
  const existingByUid = new Map<string, InvoiceItem>();
  for (const item of existingItems) {
    if (item.uid) existingByUid.set(item.uid, item);
  }

  return rebuiltItems.map((item) => {
    if (!item.uid) return item;
    const existing = existingByUid.get(item.uid);
    if (!existing) return item;

    // What the four hand-inlined conditional spreads were doing, expressed once.
    return { ...item, ...pickInvoiceOnlyFields(existing) };
  });
}

/**
 * Sync a single order's items into an invoice's items array.
 * Replaces all items scoped to the order divider with rebuilt items from the order,
 * carrying forward invoice-specific overrides on matched uids.
 *
 * @param invoiceItems - Current full invoice items array
 * @param orderItems - The order's current items array
 * @param orderDividerUid - The uid of the order divider in the invoice
 * @returns Updated invoice items array
 */
export function syncOrderItems(
  invoiceItems: InvoiceDocItemType[],
  orderItems: LineItem[],
  orderDividerUid: string,
): InvoiceDocItemType[] {
  // Capture existing items under this order scope for override carryforward
  const existingScoped = getOrderScopedItems(invoiceItems, orderDividerUid);

  // Remove old scoped items
  const withoutOld = removeOrderScopedItems(invoiceItems, orderDividerUid);

  // Find where the order divider was (to insert at same position)
  // If not found, append at end
  const orderDividerIndex = invoiceItems.findIndex(
    (item) => item.type === "order" && item.uid === orderDividerUid,
  );

  // Build new scoped items from order
  const rebuilt = buildOrderScopedItems(orderItems, orderDividerUid);
  const withOverrides = carryForwardOverrides(rebuilt, existingScoped);

  // Reconstruct: find the order divider in the original to get its metadata
  const orderDivider = invoiceItems.find(
    (item) => item.type === "order" && item.uid === orderDividerUid,
  );

  if (!orderDivider) {
    // Order divider doesn't exist yet — append at end
    return [...withoutOld, ...withOverrides];
  }

  // Re-insert order divider + rebuilt items at the original position
  // Calculate the insertion point in the filtered array
  let insertAt = 0;
  let origIndex = 0;
  for (const item of invoiceItems) {
    if (origIndex === orderDividerIndex) break;
    if (
      !(item.type === "order" && item.uid === orderDividerUid) &&
      item.path[0] !== orderDividerUid
    ) {
      insertAt++;
    }
    origIndex++;
  }

  const result = [...withoutOld];
  result.splice(insertAt, 0, orderDivider, ...withOverrides);
  return result;
}

// ── On-demand order → invoice resync (operator-triggered) ───────────

/**
 * Re-project an order's lines into an invoice, on demand.
 *
 * The automatic `syncOrderToInvoiceSelective` (inside `updateOrder`) keeps
 * non-overridden lines current as the order changes. This is the operator's
 * manual trigger to either snap a whole order's scope back to the order after
 * edits, or re-pull individual lines by `path` — the escape hatch for a line
 * that was overridden on the invoice and should now track the order again.
 *
 * Pure: returns a fresh items array; the input is not mutated. Scoped to one
 * **order divider** — a multi-order invoice loops its linked orders. The
 * {@link INVOICE_ONLY_ITEM_FIELDS} are always carried forward — named by the
 * list rather than re-spelled, because the copy that stood here listed four of
 * them and the list has six.
 *
 * - `targetPaths` omitted → **whole**: every order-scoped line is rebuilt from
 *   the order — a hard snap-to-order, so price overrides are discarded and lines
 *   the order dropped are removed. Delegates to {@link syncOrderItems}.
 * - `targetPaths` given → **per-line**: only lines at those full, divider-scoped
 *   paths are replaced with a fresh projection of the matching order line; every
 *   other line — siblings and untargeted overrides — is left untouched. A target
 *   path the order no longer has is left as-is (use a whole resync to drop
 *   removed lines); a target path not on the invoice is a no-op.
 *
 * The caller re-linearizes paths via {@link computeInvoiceItemPaths} and
 * re-prices it with `priceDocument` before writing.
 */
export function resyncInvoiceLines(
  currentInvoiceItems: InvoiceDocItemType[],
  orderItems: LineItem[],
  orderDividerUid: string,
  targetPaths?: string[][],
): InvoiceDocItemType[] {
  // Whole snap-to-order: rebuild the divider's entire scope from the order.
  if (!targetPaths) {
    return syncOrderItems(currentInvoiceItems, orderItems, orderDividerUid);
  }

  // Per-line: replace only the targeted lines in place, others untouched.
  const orderByPath = new Map<string, LineItem>();
  for (const oi of orderItems) orderByPath.set(itemPathKey(oi.path ?? []), oi);

  const targetRelKeys = new Set(
    targetPaths.map((p) => itemPathKey(stripOrderPrefix(p, orderDividerUid))),
  );

  return currentInvoiceItems.map((item) => {
    // The divider itself and items outside this order's scope pass through.
    if (item.type === "order" && item.uid === orderDividerUid) return item;
    if (item.path[0] !== orderDividerUid) return item;

    const relKey = itemPathKey(stripOrderPrefix(item.path, orderDividerUid));
    if (!targetRelKeys.has(relKey)) return item;

    const orderItem = orderByPath.get(relKey);
    if (!orderItem) return item; // order dropped this line — leave it (whole resync removes)

    return {
      ...projectOrderItemToInvoiceItem(orderItem, orderDividerUid),
      ...pickInvoiceOnlyFields(item),
    };
  });
}

/**
 * Derive each order-scoped invoice line's sync status against the CURRENT order
 * projection — no stored flag (minimal-state, derived). A line is `out_of_sync`
 * when it differs from `projectOrderItemToInvoiceItem(orderItem)` at the same
 * `path`, ignoring the invoice-only override fields
 * ({@link INVOICE_ONLY_ITEM_FIELDS}) **and ignoring any difference that is
 * EXPLAINED** ({@link unexplainedInvoiceItemDifferences}); otherwise `in_sync`.
 * Surfaced by `GET /invoices/{uid}/sync-status` and its MCP twin
 * (`get_invoices_uid_sync_status`), to offer per-line/whole resync (see
 * {@link resyncInvoiceLines}).
 *
 * ⚠️ **It does NOT drive a manager badge, and this line used to say it did.**
 * Measured 2026-09-17: nothing under `manager/src` calls that endpoint. What an
 * operator sees is {@link computeDocumentDiffs}, which reuses the explanation
 * arms but then suppresses every `derived` field — so the two answer different
 * questions and only this one reports derived money. The stale claim mattered:
 * it is what made core#112 read as an operator-facing regression rather than a
 * wrong answer on an API surface.
 *
 * ⚠️ **A line goes green because its difference is EXPLAINED, never because a
 * field was skipped** (api-cloudrun#481). The distinction is the whole design: an
 * excluded field is blind forever, while an explained one goes red the moment
 * its explanation stops holding — so a frozen invoice whose tax differs only by
 * rate version reads clean, and prod order #765 ↔ invoice #2162, whose line money
 * genuinely diverges, stays red. The naive form reported 8,792 prod lines of
 * which the audit called **0** real, which is a badge no operator can use.
 *
 * ⚠️ **Meaningful only where the invoice is hung on the SAME divider skeleton as
 * its order** — it is keyed on `path`, so if the two trees disagree structurally
 * no pair is ever compared and every line reports both "missing" and "removed"
 * with `differs` at exactly 0. Check {@link invoiceScopeDividersMatch} first; a
 * `differs` of 0 beside two large counts is the tell.
 *
 * Keyed by the full, divider-scoped `path` (`join("/")`), matching what the
 * invoice stores. Scoped to one order divider; a multi-order invoice merges the
 * per-divider maps. Reports as `out_of_sync`:
 * - an order line the invoice is missing (keyed by its projected path), and
 * - an order-scoped invoice line with no matching order line (removed upstream).
 *
 * 🔴 **A SUBSTITUTED pair is neither of those, and reporting it as both is how
 * a tracked divergence becomes permanent noise.** X is missing from the invoice
 * and Y matches no order line, so the naive form badges two rows `out_of_sync`
 * for one deliberate operator edit, forever, with no resync that could ever
 * clear them. {@link liveInvoiceAnchors} is what distinguishes the two cases:
 *
 * - X (and its components) get **no entry at all** — there is no invoice row to
 *   badge, and inventing one at a projected path invites a per-line resync that
 *   would undo the substitution.
 * - Y (and its components) read **`in_sync`** — the invoice is exactly what the
 *   operator asked it to be. It is not "a difference we chose to ignore": the
 *   moment the anchor is spent or removed, both rows go back to being compared
 *   normally, which is the same standard the explained-difference arms are held
 *   to.
 */
export function computeInvoiceSyncStatus(
  currentInvoiceItems: InvoiceItem[],
  orderItems: LineItem[],
  orderDividerUid: string,
  context: InvoiceSyncContext,
): Map<string, "in_sync" | "out_of_sync"> {
  const status = new Map<string, "in_sync" | "out_of_sync">();

  // Index this divider's invoice lines by order-relative path key.
  const invoiceByRelPath = new Map<string, InvoiceItem>();
  // An extension section extends lines the order has, at dates the order has:
  // it is what the invoice was asked to bill, not drift from the order.
  const extensionTargets = extensionSectionTargets(currentInvoiceItems, orderDividerUid);
  for (const item of currentInvoiceItems) {
    if (item.type === "order" && item.uid === orderDividerUid) continue;
    if (item.path[0] !== orderDividerUid) continue;
    if (isInExtensionSection(item.path, orderDividerUid, extensionTargets)) {
      status.set(itemPathKey(item.path), "in_sync");
      continue;
    }
    invoiceByRelPath.set(itemPathKey(stripOrderPrefix(item.path, orderDividerUid)), item);
  }

  // The substitutions this scope carries, in the order's own path space.
  const anchors = liveInvoiceAnchors(currentInvoiceItems, orderItems, orderDividerUid);
  // D2 (manager#414): a merged or partially swapped row is compared at its
  // ORDER-EQUIVALENT quantity, so exactly the substituted units are explained.
  const scopedLines = [...invoiceByRelPath].map(([k, it]) => ({ path: k.split("/"), substituted_for: it.substituted_for }));
  const resync = substitutionResync(scopedLines, orderItems, orderItems);

  const matchedRelKeys = new Set<string>();
  for (const orderItem of orderItems) {
    const relKey = itemPathKey(orderItem.path ?? []);
    matchedRelKeys.add(relKey);
    const fullKey = itemPathKey([orderDividerUid, ...(orderItem.path ?? [])]);
    const stored = invoiceByRelPath.get(relKey);
    const equivalent = stored === undefined ? undefined : resync.orderEquivalent(orderItem.path ?? [], stored);
    const current = stored === undefined || equivalent === (stored.quantity ?? 0) ? stored : { ...stored, quantity: equivalent };
    if (!current) {
      // Explained: this line was substituted away. No invoice row exists to
      // carry a badge, so emit no entry rather than a phantom `out_of_sync`.
      if (isRemovedBySubstitution(orderItem.path ?? [], anchors)) continue;
      status.set(fullKey, "out_of_sync"); // order has a line the invoice lacks
      continue;
    }
    const expected = projectOrderItemToInvoiceItem(orderItem, orderDividerUid);
    const unexplained = unexplainedInvoiceItemDifferences(
      expected,
      current,
      invoiceItemDifferences(expected, current),
      context,
    );
    status.set(fullKey, unexplained.length === 0 ? "in_sync" : "out_of_sync");
  }

  // Invoice-scoped lines the order no longer has.
  for (const [relKey, item] of invoiceByRelPath) {
    if (matchedRelKeys.has(relKey)) continue;
    // Y itself, or one of Y's components — the divergence is tracked, not drift.
    const substituted = isSubstitutionRow(stripOrderPrefix(item.path, orderDividerUid), anchors);
    status.set(itemPathKey(item.path), substituted ? "in_sync" : "out_of_sync");
  }

  return status;
}

// ── Order-first coverage ────────────────────────────────────────

/** An invoice line with no counterpart on the order it is scoped to. */
export interface UnmatchedInvoiceLine {
  /** The invoice the line was read from — an order can be billed by several. */
  invoiceUid: string;
  item: InvoiceItem;
}

/** @see {@link computeOrderInvoiceCoverage} */
export interface OrderInvoiceCoverage {
  /**
   * Order LINE items that no compared invoice carries at the same path, in the
   * order's own document order.
   */
  uninvoiced: LineItem[];
  /**
   * Lines the invoices carry under this order's divider that the order does not
   * have, deduplicated by path across invoices. `transaction_fee` is excluded.
   */
  unmatched: UnmatchedInvoiceLine[];
  /** Invoice uids that contributed to the answer. */
  compared: string[];
  /**
   * Invoice uids whose scope is hung on a DIFFERENT divider skeleton. They
   * contribute to neither list — see the warning on the function.
   */
  unaligned: string[];
}

/**
 * **Is this order fully invoiced?** — the ORDER-first, union-across-invoices
 * question, and the complement of {@link computeInvoiceSyncStatus}.
 *
 * The two are easy to confuse and answer different things. `computeInvoiceSyncStatus`
 * stands on ONE invoice and asks whether each of its lines still agrees with the
 * order, collapsing *missing* / *removed* / *differs* into a single
 * `out_of_sync` flag. This stands on the ORDER and asks which of its lines no
 * live invoice bills — so it unions every linked invoice, and a line billed on
 * invoice A is covered even though invoice B lacks it. **Neither can be derived
 * from the other**: prod order #1000 is billed by #2385 and #2388, and every one
 * of its lines is `out_of_sync` on at least one of them while exactly one line
 * is genuinely unbilled.
 *
 * It deliberately says nothing about lines that DIFFER. A matched-but-drifted
 * line is covered here and is `computeInvoiceSyncStatus`'s subject; measured
 * 2026-08-25 the corpus carries 1,653 drifted lines against 177 uninvoiced ones,
 * so folding the two would bury this answer in the other's.
 *
 * ⚠️ **`void` invoices are skipped, drafts are NOT.** A draft states the intent
 * to bill and is one click from doing so; measured on the whole prod corpus,
 * excluding drafts changes the answer on **0** orders, so the simpler rule costs
 * nothing. Voiding, by contrast, un-bills — counting a void invoice's lines as
 * covered is how an order reads fully invoiced while nobody is being charged.
 *
 * 🔴 **Every scope is gated on {@link invoiceScopeDividersMatch} FIRST, and that
 * gate is the difference between a signal and an artifact.** This comparison is
 * keyed on `path`, so where the two trees disagree structurally no pair is ever
 * compared and EVERY order line reports uninvoiced while EVERY invoice line
 * reports unmatched. That is not hypothetical: **966 of 969 prod pairs were
 * unaligned on 2026-08-10** (CRMS-authored invoices carried none of their
 * order's `group` dividers), `repair-invoice-structure.ts` took it to 0, one
 * reappeared on 2026-08-12, and the corpus reads 989 aligned / 0 unaligned on
 * 2026-08-25. **Alignment is a measurement, not a property.**
 *
 * So the gate is fail-closed rather than advisory: if ANY linked scope is
 * unaligned, `uninvoiced` and `unmatched` come back **empty** and the uid is in
 * `unaligned` — the caller renders "not computed" and cannot render a number.
 * Returning a partial union beside an `unaligned` list the caller might not read
 * would be the same policing this repo keeps replacing with unrepresentability,
 * and it fails in the dangerous direction: an unaligned scope's lines are
 * uncounted, so every line it bills reads UNBILLED.
 *
 * ⚠️ **`unmatched` is not a defect count.** Nothing in the stored state separates
 * "the order dropped this line after it was billed" from "an operator added it
 * on the invoice on purpose", and the second is ordinary: of 190 such lines on
 * prod, 143 are `replacement` charges raised at billing time. Only
 * `transaction_fee` is excluded, because it is a document-level charge
 * (`pricing: "from_total"`) that has no order counterpart by construction.
 * `custom-` uids are NOT filtered — that is a presentation judgment, and this
 * returns the item so the caller can make it.
 *
 * An invoice whose scope holds no items at all is `compared` and contributes
 * nothing; that is an order this invoice does not bill, not a structural
 * disagreement, so it must not suppress the answer the way `unaligned` does.
 *
 * @param orderUid The source order's uid — which IS its divider's uid on every
 *   invoice that bills it (Option B; the transitional `uid_order` field is gone).
 * @param orderItems The order's full `items` array, dividers included — the
 *   alignment predicate reads them.
 * @param invoices Every invoice linked to the order, live or void.
 */
export function computeOrderInvoiceCoverage(
  orderUid: string,
  orderItems: LineItem[],
  invoices: ReadonlyArray<{ uid: string; status: InvoiceStatusType; items: InvoiceItem[] }>,
): OrderInvoiceCoverage {
  const orderLineKeys = new Set<string>();
  for (const item of orderItems) {
    if (!isLineItemType(item.type)) continue;
    orderLineKeys.add(itemPathKey(item.path ?? []));
  }

  const compared: string[] = [];
  const unaligned: string[] = [];
  const covered = new Set<string>();
  const unmatched: UnmatchedInvoiceLine[] = [];
  const unmatchedSeen = new Set<string>();
  // Every compared invoice's live substitutions, pooled — an order can be
  // billed by several, and a line substituted on ANY of them is not uninvoiced.
  const allAnchors: SubstitutionAnchor[] = [];

  for (const invoice of invoices) {
    if (invoice.status === "void") continue;
    const scoped = getOrderScopedItems(invoice.items ?? [], orderUid);
    // An empty scope has no dividers to disagree about. Running the predicate on
    // it would report a structural conflict where there is simply no content.
    if (scoped.length > 0 && !invoiceScopeDividersMatch(scoped, orderItems, orderUid)) {
      unaligned.push(invoice.uid);
      continue;
    }
    compared.push(invoice.uid);
    const anchors = liveInvoiceAnchors(scoped, orderItems, orderUid);
    allAnchors.push(...anchors);
    const extensionTargets = extensionSectionTargets(scoped, orderUid);
    for (const item of scoped) {
      if (!isLineItemType(item.type)) continue;
      // An extension line bills days on a line billed elsewhere; it neither
      // covers that line nor stands unmatched.
      if (isInExtensionSection(item.path ?? [], orderUid, extensionTargets)) continue;
      const relPath = stripOrderPrefix(item.path ?? [], orderUid);
      const relKey = itemPathKey(relPath);
      covered.add(relKey);
      if (item.type === "transaction_fee") continue;
      if (orderLineKeys.has(relKey) || unmatchedSeen.has(relKey)) continue;
      // 🔴 A substituted line legitimately matches no order line — that is what
      // the substitution IS. Without this the operator's own edit is reported
      // back as an anomaly on every read, and `substituted_for` names the
      // order line it stands in for, so the join is not actually missing.
      if (isSubstitutionRow(relPath, anchors)) continue;
      unmatchedSeen.add(relKey);
      unmatched.push({ invoiceUid: invoice.uid, item });
    }
  }

  // Fail closed: a partial union cannot be told apart from a complete one by
  // looking at `uninvoiced`, and the partial answer over-reports.
  if (unaligned.length > 0) return { uninvoiced: [], unmatched: [], compared, unaligned };

  const uninvoiced = orderItems.filter(
    (item) =>
      isLineItemType(item.type) &&
      !covered.has(itemPathKey(item.path ?? [])) &&
      // Substituted away, and therefore never to be billed AS ITSELF. Y carries
      // the money instead; reporting X uninvoiced is a nag no action can clear.
      !isRemovedBySubstitution(item.path ?? [], allAnchors),
  );

  return { uninvoiced, unmatched, compared, unaligned };
}

// ── Top-level field co-write helpers ────────────────────────────

/**
 * Invoice-side destination pair: a {@link DocDestinationType} plus a `uid_order`
 * scope field, so a multi-order invoice can carry pairs from several orders and
 * have them selectively synced per source order. Alias of the canonical
 * `InvoiceDocDestinationType` from `@cfs/core/schemas`.
 */
export type InvoiceDestinationPair = InvoiceDocDestinationType;

/**
 * Stable key for matching a destination pair: **the order it is scoped to, and
 * the pair's own identity** — its destination divider's uid.
 *
 * `uid_order` is still part of it because an invoice can bill several orders
 * and each brings its own dividers; the pair uid alone is unique only within
 * one order's scope.
 *
 * 🔴 **It was `(uid_order, delivery.uid, collection.uid)` and that key MOVED —
 * which is the whole of api-cloudrun#663.** Those are `destinations/{uid}`
 * document ids, so correcting an address on one side re-pointed them, the key
 * stopped naming the same row, and the override check never ran: the invoice's
 * payload was never consulted, and an operator's jurisdiction override was
 * dropped with no error and a changed tax rate on an issued invoice.
 *
 * Measured 2026-08-25 across all 988 prod invoice pairs (dev identical): all
 * **988 join on this key, 750 on the old one, and 0 join on the old key
 * alone** — so the re-key reaches 238 pairs the endpoint key could not, and
 * regresses none.
 *
 * ⚠️ The invoice's divider REUSES the order's ({@link adoptOrderDividerStructure}
 * keeps a divider the invoice already carries under the same uid), which is what
 * makes one key address both documents' idea of the same row.
 */
function destPairKey(uidOrder: string, pair: DocDestinationType): string {
  return [uidOrder, pair.uid ?? ""].join("/");
}

/** Stable key for an invoice-side pair (uses its own uid_order). */
function invoicePairKey(pair: InvoiceDestinationPair): string {
  return destPairKey(pair.uid_order, pair);
}

/**
 * **The ONE author of an invoice destination pair.** Project an order's pair
 * into the invoice's, tagged with the order it is scoped to.
 *
 * ⚠️ **A projection enumerates what it TAKES, so every hand-written one is a
 * place a new field gets dropped.** There were FIVE of them — the two below,
 * `createInvoice` and the CRMS invoice webhook in api-cloudrun, and the schema
 * literal itself — and adding `jurisdiction` (api-cloudrun#591) had to touch
 * every one. Two were missed on the first pass: one surfaced as six failing
 * tests, the other as a type error. Hence one author.
 *
 * **Nullish is normalized to `null`, never left `undefined`.** Firestore
 * REFUSES an undefined value — the write fails, it does not drop the key — so a
 * pair whose optional field is simply absent would make the invoice
 * unwritable. `null` and absent mean the same thing on every field of this
 * pair, and {@link canonicalizePayload} folds the two together, so this costs no
 * information and no override detection.
 *
 * ⚠️ The spread is deliberate and is what makes a NEW pair field carried by
 * construction. Do not "tidy" it into an explicit field list — that is the
 * defect this function exists to remove.
 */
export function toInvoiceDestinationPair(
  uidOrder: string,
  pair: DocDestinationType,
): InvoiceDestinationPair {
  const out: Record<string, unknown> = { uid_order: uidOrder };
  for (const [key, value] of Object.entries(pair)) out[key] = value ?? null;
  return out as unknown as InvoiceDestinationPair;
}

/**
 * Key-sorted deep copy with `null`/`undefined`/absent collapsed to absent —
 * so two payloads compare equal iff they say the same thing.
 *
 * ⚠️ **Both normalizations are load-bearing, and neither is cosmetic.**
 * *Key order*: one side of a comparison is a stored document (Firestore returns
 * map keys sorted) and the other may be freshly built (insertion order), so a
 * raw `JSON.stringify` can report two identical pairs as different. *Nullish*:
 * every field on this pair means the same thing absent as it does `null` — no
 * destination record, no address, no instructions, no jurisdiction claim — and
 * a corpus mid-migration holds both spellings of that. Reading one as an edit
 * would freeze the pair as "overridden" and stop it syncing **entirely**,
 * because the check is all-or-nothing for the whole pair.
 */
export function canonicalizePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizePayload);
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === null || v === undefined) continue;
    out[key] = canonicalizePayload(v);
  }
  return out;
}

/**
 * One invoice destination pair that {@link syncOrderDestinationsSelective}
 * removed, and WHY.
 *
 * 🔴 **The two reasons are not degrees of the same thing, and the difference is
 * api-cloudrun#663.**
 *
 * - `removed_from_order` — the order genuinely deleted this pair, the invoice
 *   had not edited it, so dropping it is the intended behaviour. Reported for
 *   completeness, not because anything is wrong.
 * - `key_names_no_order_pair` — the order carries no pair at this key AT ALL,
 *   so `prev` is `undefined` and **the override check never ran**. The pair is
 *   dropped without its payload ever being compared to anything. Measured on
 *   prod 2026-08-24: 239 of 989 invoice pairs are in this state, 14 of them
 *   carrying a `jurisdiction` that prices their lines.
 *
 * ⚠️ **The same condition means the OPPOSITE thing in the two loops.** In the
 * first loop `prev === undefined` falls to *"Overridden (or prev missing) —
 * keep invoice version"*; in the second it falls through to the drop. That
 * asymmetry is the defect, and it is why this type exists rather than a boolean.
 */
export interface DroppedInvoiceDestination {
  uid_order: string;
  /**
   * The pair's identity — its destination divider's uid, and the key the sync
   * addressed it by. Reported alongside the endpoints rather than instead of
   * them: the uid is what an operator (or a repair) uses to FIND the row, the
   * endpoints are what tells a human WHERE it was going.
   */
  uid: string | null;
  delivery_uid: string | null;
  collection_uid: string | null;
  /** The field that prices the pair's lines — the reason a silent drop matters. */
  jurisdiction: JurisdictionType | null;
  reason: "removed_from_order" | "key_names_no_order_pair";
}

/**
 * What {@link syncOrderDestinationsSelective} returns.
 *
 * 🔴 **`dropped` is a REPORT, and an ignored return is the failure mode.** It
 * carries no policy: the drop already happened, and nothing here decides
 * differently. It exists so a caller can say out loud that an invoice-side
 * jurisdiction was discarded — which until now happened with no error, no log
 * and a changed tax rate on an issued invoice.
 *
 * Same shape and the same hazard as `UnreviewedTaxWarning[]`: dropping the
 * value compiles, reads fine, and puts the loss back to being invisible. It is
 * pinned on the api-cloudrun side for exactly that reason.
 */
export interface OrderDestinationSyncResult {
  destinations: InvoiceDestinationPair[];
  dropped: DroppedInvoiceDestination[];
}

/**
 * Selectively sync one order's destination pairs into an invoice's destinations,
 * respecting invoice-side overrides. Per-pair matching is by
 * `(uid_order, pair.uid)` — see {@link destPairKey}, and note that it was the
 * ENDPOINT uids until api-cloudrun#663, where the key itself moved whenever an
 * address was corrected. Only pairs scoped to `uidOrder` are touched — pairs
 * from other orders pass through unchanged.
 *
 * Policy per pair:
 * - Not in invoice (new in order) → add, tagged with `uid_order`.
 * - In invoice AND the order has a `prev` for it → merged PER FIELD
 *   ({@link mergePair}): every `dates` leaf, each endpoint atom, `jurisdiction`
 *   and the customer flags each follow the order unless the invoice's value
 *   differs from the order's previous one.
 * - In invoice but the order has no `prev` → keep the invoice version.
 * - In invoice but not in new order: dropped, unless some shared field was
 *   overridden, in which case it is kept.
 *
 * ⚠️ **An override is per FIELD, so it is not a whole-pair freeze.** The rest of
 * the pair (address, contact, instructions, `customer_collecting`/`returning`)
 * keeps tracking the order.
 *
 * 🔴 **This REVERSED one ruling, in `v0.270.0`, and the reversal is easy to miss
 * because it is a consequence rather than a decision.** Under the whole-pair
 * comparator `jurisdiction` was *invoice-owned*: skipped by the match and
 * reconciled separately, so a jurisdiction-only edit was not an override and a
 * pair the ORDER deleted was DROPPED — on the stated ground that *"an
 * owned-field edit is not a claim that the destination still exists"*. Per
 * field there is no owned set: `jurisdiction` is a shared field like any other,
 * so editing it IS an override and the pair now SURVIVES its own deletion,
 * reported in `kept`. Both readings are defensible; this one follows from the
 * campaign's single rule, and it is the behaviour prod has had since
 * 2026-09-15.
 *
 * @param prevOrderDests - Pairs from the previous version of the order
 * @param newOrderDests - Pairs from the new version of the order
 * @param currentInvoiceDests - Current full invoice destinations array (all orders)
 * @param uidOrder - The order uid this sync is scoped to
 * @param extensionPairUids - Pairs of this order's date-extension sections
 *   ({@link extensionSectionTargets}'s keys). They name no order pair by
 *   construction, so they are kept verbatim rather than dropped as
 *   `key_names_no_order_pair`. Empty when the invoice has no order divider,
 *   because no section can hang under one.
 * @param mode - The merge context ({@link OrderInvoiceFieldSync}); its
 *   `holidays` settle a merged window's derived day counts in {@link mergePair}.
 * @returns `{ destinations, dropped }` — the updated full invoice destinations
 *   array, and every pair this call removed, each with the reason it went. See
 *   {@link OrderDestinationSyncResult}; **do not discard `dropped`.**
 */
export function syncOrderDestinationsSelective(
  prevOrderDests: DocDestinationType[],
  newOrderDests: DocDestinationType[],
  currentInvoiceDests: InvoiceDestinationPair[],
  uidOrder: string,
  extensionPairUids: ReadonlySet<string>,
  mode: OrderInvoiceFieldSync,
): OrderDestinationSyncResult {
  // Index prev order pairs by key (scoped to uidOrder).
  const prevByKey = new Map<string, DocDestinationType>();
  for (const pair of prevOrderDests) {
    prevByKey.set(destPairKey(uidOrder, pair), pair);
  }

  // Partition invoice pairs: in-scope (this order) vs out-of-scope (other orders).
  const inScope = new Map<string, InvoiceDestinationPair>();
  const outOfScope: InvoiceDestinationPair[] = [];
  for (const pair of currentInvoiceDests) {
    if (pair.uid_order === uidOrder) {
      inScope.set(invoicePairKey(pair), pair);
    } else {
      outOfScope.push(pair);
    }
  }

  const synced: InvoiceDestinationPair[] = [];
  const dropped: DroppedInvoiceDestination[] = [];
  const processedKeys = new Set<string>();

  // Walk new order pairs in order.
  for (const newPair of newOrderDests) {
    const key = destPairKey(uidOrder, newPair);
    processedKeys.add(key);
    const prev = prevByKey.get(key);
    const inv = inScope.get(key);

    if (!inv) {
      // New pair — add tagged with uid_order.
      synced.push(toInvoiceDestinationPair(uidOrder, newPair));
    } else if (prev) {
      synced.push(mergePair(prev, newPair, inv, uidOrder, mode.holidays));
    } else {
      // Overridden (or prev missing) — keep invoice version.
      synced.push(inv);
    }
  }

  // Handle pairs present in invoice but not in new order.
  for (const [key, inv] of inScope) {
    if (processedKeys.has(key)) continue;
    if (inv.uid !== undefined && extensionPairUids.has(inv.uid)) {
      synced.push(inv);
      continue;
    }
    const prev = prevByKey.get(key);
    if (prev && pairOverridden(prev, inv, uidOrder)) {
      // Overridden — keep even though removed from order.
      synced.push(inv);
      continue;
    }
    // Dropped. ⚠️ Two ways to reach this line and they are NOT the same event:
    // with a `prev` the order deleted a pair the invoice had not edited, which
    // is intended; without one the key names no order pair, so the override
    // check never ran and the invoice's payload was never consulted. The second is
    // api-cloudrun#663, and it is the reason this reports rather than counts.
    dropped.push({
      uid_order: uidOrder,
      uid: inv.uid ?? null,
      delivery_uid: inv.delivery?.uid ?? null,
      collection_uid: inv.collection?.uid ?? null,
      jurisdiction: inv.jurisdiction ?? null,
      reason: prev ? "removed_from_order" : "key_names_no_order_pair",
    });
  }

  return { destinations: [...outOfScope, ...synced], dropped };
}

/**
 * Remove all destination pairs scoped to a specific order.
 * Mirrors `removeOrderScopedItems` for the items array.
 */
export function removeOrderScopedDestinations(
  dests: InvoiceDestinationPair[],
  uidOrder: string,
): InvoiceDestinationPair[] {
  return dests.filter((d) => d.uid_order !== uidOrder);
}

/** A destination the order deleted that the invoice kept, and which half kept it. */
export interface KeptInvoiceDestination {
  uid_order: string;
  /** The destination divider's uid — the last segment of its path, and its pair's `uid`. */
  uid: string;
  divider_overridden: boolean;
  pair_overridden: boolean;
}

/** What {@link syncOrderDestinationScope} returns. */
export interface OrderDestinationScopeSyncResult {
  /** The invoice's items scoped under the order divider, WITHOUT the divider itself. */
  scopedItems: InvoiceDocItemType[];
  /** The invoice's full destinations array, every order's scope included. */
  destinations: InvoiceDestinationPair[];
  /** Pairs removed — see {@link OrderDestinationSyncResult}; **do not discard.** */
  dropped: DroppedInvoiceDestination[];
  /** Destinations the order deleted that survive on the invoice because one half was overridden. */
  kept: KeptInvoiceDestination[];
}

/**
 * Is one destination ROW overridden on the invoice? A destination row is its
 * divider AND its pair — the pair has no path of its own and hangs off its
 * divider's (`pair.uid === last(divider.path)`).
 *
 * Each half runs the same per-field test its own sync runs —
 * {@link lineOverridden} for the divider, {@link pairOverridden} for the pair —
 * and the row is overridden if EITHER half is.
 *
 * A half with no previous order counterpart is not an override, matching both
 * underlying helpers: each drops an invoice row the order never had.
 */
function destinationRowOverridden(
  prevDivider: LineItem | undefined,
  prevPair: DocDestinationType | undefined,
  invDivider: InvoiceDocItemType | undefined,
  invPair: InvoiceDestinationPair | undefined,
  orderDividerUid: string,
): { divider: boolean; pair: boolean } {
  return {
    divider: invDivider !== undefined && prevDivider !== undefined &&
      lineOverridden(prevDivider, invDivider, orderDividerUid),
    pair: invPair !== undefined && prevPair !== undefined &&
      pairOverridden(prevPair, invPair, orderDividerUid),
  };
}

/**
 * Sync one order's scope of an invoice — its items and its destination pairs —
 * and decide each deleted destination ONCE (api-cloudrun#664).
 *
 * {@link syncOrderToInvoiceSelective} decides a destination divider by path and
 * {@link syncOrderDestinationsSelective} decides its pair by `pair.uid`, each
 * with its own override test. Run alone, they can split a destination the order
 * deleted: a renamed divider is kept while its unedited pair is dropped, or an
 * edited pair is kept while its unedited divider is dropped. Either result
 * fails the divider ⟺ pair write guard, and because the invoice write is staged
 * inside the ORDER's transaction, the order edit fails with it.
 *
 * So after both run, every destination the order deleted in this edit is
 * re-decided as one row via {@link destinationRowOverridden}: overridden ⇒ both
 * halves kept (the missing one restored from the stored invoice), otherwise both
 * dropped. Destinations still on the order are untouched — a consistent order
 * already adds and keeps both halves together.
 *
 * ⚠️ A restored divider is appended at the tail of the scope, which is where
 * {@link syncOrderToInvoiceSelective} already places a kept removed row.
 *
 * @param prevOrder - The order before the edit
 * @param nextOrder - The order after the edit
 * @param currentScopedItems - The invoice's items under the order divider, without the divider
 * @param currentInvoiceDests - The invoice's full destinations array (all orders)
 * @param orderUid - The order's uid, which is also its invoice divider's uid
 * @param mode - The merge context ({@link OrderInvoiceFieldSync}).
 *
 * ⚠️ **There is no per-half `flags` argument any more.** It named which halves
 * the edit touched, so an untouched half could be carried as stored — a saving
 * the per-field rule does not need and cannot safely take: a field the order did
 * not change merges to what the invoice already has, so running both halves
 * unconditionally is already a no-op where the old flag would have skipped.
 * Both halves merge per field. A line's `chargeable_days` is derived, so the
 * merge leaves it alone and the caller's `priceDocument` stamps it from the
 * line's own invoice pair.
 */
export function syncOrderDestinationScope(
  prevOrder: { items: LineItem[]; destinations: DocDestinationType[] },
  nextOrder: { items: LineItem[]; destinations: DocDestinationType[] },
  currentScopedItems: InvoiceDocItemType[],
  currentInvoiceDests: InvoiceDestinationPair[],
  orderUid: string,
  mode: OrderInvoiceFieldSync,
): OrderDestinationScopeSyncResult {
  const itemSync = syncScopedItems(prevOrder.items, nextOrder.items, currentScopedItems, orderUid);
  let scopedItems = itemSync.items;
  const destSync: OrderDestinationSyncResult = syncOrderDestinationsSelective(
    prevOrder.destinations,
    nextOrder.destinations,
    currentInvoiceDests,
    orderUid,
    new Set(extensionSectionTargets(currentScopedItems as InvoiceItem[], orderUid).keys()),
    mode,
  );
  let destinations = destSync.destinations;
  const dropped = [...destSync.dropped];
  const kept: KeptInvoiceDestination[] = [];

  const lastOf = (path: readonly string[] | undefined): string | undefined =>
    path && path.length > 0 ? path[path.length - 1] : undefined;
  const isDestinationDivider = (it: { type: string }) => it.type === "destination";

  const prevDividers = new Map<string, LineItem>();
  for (const it of prevOrder.items) {
    const uid = lastOf(it.path);
    if (isDestinationDivider(it) && uid !== undefined) prevDividers.set(uid, it);
  }
  const prevPairs = new Map(prevOrder.destinations.map((p) => [p.uid, p]));
  const nextUids = new Set<string>(nextOrder.destinations.map((p) => p.uid));
  for (const it of nextOrder.items) {
    const uid = lastOf(it.path);
    if (isDestinationDivider(it) && uid !== undefined) nextUids.add(uid);
  }

  // The destinations THIS edit deleted: on the previous order, on neither half of the next.
  const deleted = new Set<string>();
  for (const uid of [...prevDividers.keys(), ...prevPairs.keys()]) {
    if (!nextUids.has(uid)) deleted.add(uid);
  }

  const dividerIn = (items: readonly InvoiceDocItemType[], uid: string) =>
    items.find((it) => isDestinationDivider(it) && lastOf(stripOrderPrefix(it.path, orderUid)) === uid);
  const pairIn = (dests: readonly InvoiceDestinationPair[], uid: string) =>
    dests.find((p) => p.uid_order === orderUid && p.uid === uid);

  for (const uid of deleted) {
    const invDivider = dividerIn(currentScopedItems, uid);
    const invPair = pairIn(currentInvoiceDests, uid);
    const overridden = destinationRowOverridden(prevDividers.get(uid), prevPairs.get(uid), invDivider, invPair, orderUid);

    if (overridden.divider || overridden.pair) {
      if (invDivider && !dividerIn(scopedItems, uid)) scopedItems = [...scopedItems, invDivider];
      if (invPair && !pairIn(destinations, uid)) {
        destinations = [...destinations, invPair];
        const at = dropped.findIndex((d) => d.uid_order === orderUid && d.uid === uid);
        if (at >= 0) dropped.splice(at, 1);
      }
      kept.push({ uid_order: orderUid, uid, divider_overridden: overridden.divider, pair_overridden: overridden.pair });
      continue;
    }

    const survivingDivider = dividerIn(scopedItems, uid);
    if (survivingDivider) scopedItems = scopedItems.filter((it) => it !== survivingDivider);
    const survivingPair = pairIn(destinations, uid);
    if (survivingPair) {
      destinations = destinations.filter((p) => p !== survivingPair);
      dropped.push({
        uid_order: orderUid,
        uid: survivingPair.uid ?? null,
        delivery_uid: survivingPair.delivery?.uid ?? null,
        collection_uid: survivingPair.collection?.uid ?? null,
        jurisdiction: survivingPair.jurisdiction ?? null,
        reason: prevPairs.has(uid) ? "removed_from_order" : "key_names_no_order_pair",
      });
    }
  }

  return { scopedItems, destinations, dropped, kept };
}

/**
 * Age one invoice against a report date — how many whole Chicago calendar days
 * past its anchor the report is drawn, and which bucket that puts it in.
 *
 * 🔴 **The pair is computed together so the two halves cannot disagree.** A
 * caller that counted days itself and then asked `agingBucketOf` for a bucket
 * would be a second copy of the rule, and the copies drift the first time an
 * edge moves.
 *
 * 🔴 **Calendar days, never elapsed milliseconds.** Both `date` and `due_date`
 * are `chicagoStartOfDay()` fields, and Chicago days are 23 or 25 hours long
 * twice a year — so `(asOf - anchor) / 86400000` moves invoices across every
 * bucket edge, twice a year, silently. Measured counterexample in
 * `core/src/utils/dates.ts`.
 *
 * ⚠️ **The caller owns the population.** This ages whatever it is handed; it
 * does not decide what belongs on the report. That rule is
 * `totals.amount_due_cents > 0` and it is stated on `schemas/reporting.ts`,
 * because a status set is not a balance.
 *
 * ```ts
 * agingOf("2026-08-01T00:00:00.000-05:00", "2026-09-07T00:00:00.000-05:00");
 * // { days_overdue: 37, bucket: "31-60" }
 * ```
 *
 * @param anchorDate The invoice's stored `date` or `due_date`, per the run's
 *   anchor — the two members of `AGING_ANCHORS` in `schemas/reporting.ts`.
 * @param asOf The report's as-of invoice date.
 */
export function agingOf(anchorDate: string, asOf: string): InvoiceAging {
  const days_overdue = chicagoDaysBetween(asOf, anchorDate);
  return { days_overdue, bucket: agingBucketOf(days_overdue) };
}
