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
  calculateItemTotalCents,
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

import type { COARevenueType, DocDestinationType, InvoiceDocDestinationType, InvoiceDocItemPrice, InvoiceDocItemType, InvoiceDocTotals, InvoiceStatusType, OrderDocDestinationItemType, PriceFormulaType, SettlementReasonType, SettlementTypeType } from "../schemas/mod.ts";
import {
  getSettlementMultiplier,
  isDividerItemType,
  isLineItemType,
  SETTLEMENT_CONTRACTS,
} from "../schemas/mod.ts";
import { fromCentsBig, roundDivHalfAwayFromZero } from "./money.ts";
import {
  computeItemPaths,
  isTaxableCoa,
  type ItemPathIssue,
  type ItemUniquenessIssue,
  type LineItem,
  type PriceObject,
  sumDocumentTotals,
  type Tax,
  validateItemUniqueness,
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
 * InvoiceDocItemPrice from schemas to avoid type drift.
 */
export interface InvoiceItem extends LineItem {
  uid_order?: string | null;
  description?: string;
  price?: PriceObject | InvoiceDocItemPrice;
  coa_revenue?: COARevenueType | null;
  tracking_category?: string | null;
  xero_id?: string | null;
  xero_tracking_option_id?: string | null;
  crms_id?: number | string | null;
  // Present on the stored schema (`schemas/invoice.ts`) but absent from this
  // shadow until 2026-08-10, which is why it was missing from every one of the
  // four hand-maintained copies of {@link INVOICE_ONLY_ITEM_FIELDS}.
  crms_opportunity_id?: number | null;
}

// ── Invoice totals ──────────────────────────────────────────────

/** @see {@link InvoiceDocTotals} from `@cfs/core/schemas` */
export type InvoiceTotals = InvoiceDocTotals;

/**
 * Calculate aggregated pricing totals for an invoice.
 *
 * The six-field arithmetic core is {@link sumDocumentTotals}, shared with
 * `calculateOrderTotals` — it was ~35 byte-identical lines in each, and
 * "assembled independently so invoices can diverge later" was a licence for
 * silent drift, not an insurance policy. What genuinely differs is here: the
 * `flattenForXero` prefilter (inert on the arithmetic — see
 * `sumDocumentTotals`) and the settlement projection below, which is what a
 * credit note or a partial billing actually changes.
 *
 * @param items - Full invoice items array (structural items are filtered out)
 * @param taxes - Tax definitions for tax calculation
 * @param settlements - Every settlement against the invoice, reversals included
 */
export function calculateInvoiceTotals(
  items: InvoiceItem[],
  taxes: Tax[],
  // BREAKING, deliberately. An optional param means any un-updated call site
  // silently computes `amount_credited_cents: 0` and re-inflates
  // `amount_due_cents` — the exact class that flipped 14 invoices in #409.
  // Renaming the parameter and changing its element shape turns every one of
  // the 11 call sites into a compile error instead.
  settlements?: readonly {
    type: SettlementTypeType;
    reason: SettlementReasonType;
    amount_cents: number;
  }[],
): InvoiceTotals {
  const core = sumDocumentTotals(flattenForXero(items), taxes);

  // Settlement accounting — the projection of the journal onto this document.
  const { amount_paid_cents, amount_credited_cents, amount_void_cents, amount_due_cents } =
    recomputeSettlementTotals(core.total_cents, settlements ?? []);

  return { ...core, amount_paid_cents, amount_credited_cents, amount_void_cents, amount_due_cents };
}

// ── Payment helpers ─────────────────────────────────────────────

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
 * every one of them while {@link invoiceProjectionMatches} compared key sets
 * before values and reported the ENTIRE CRMS-authored corpus `out_of_sync`,
 * with nothing thrown.
 *
 * ⚠️ Six literals, no spread. core#43 is the standing case where JSR's npm
 * `.d.ts` emit TRUNCATED a spread inside an `as const`, and no core gate could
 * see it.
 */
const INVOICE_ONLY_ITEM_FIELDS = [
  "coa_revenue",
  "tracking_category",
  "xero_id",
  "xero_tracking_option_id",
  "crms_id",
  "crms_opportunity_id",
] as const;

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
function itemPathKey(path: string[]): string {
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

/**
 * Build an invoice destination divider from a source order's destination item.
 * Single source of truth for the divider shape — reused by
 * `projectOrderItemToInvoiceItem` (order→invoice projection), the CRMS invoice
 * webhook (`createUpdateInvoiceFromCrms`), and the destination-divider backfill.
 *
 * `path` defaults to `[]` so callers that run `computeInvoiceItemPaths`
 * afterward (the webhook + backfill) get positional path assignment; the
 * order-projection caller passes the scoped path `[orderDividerUid, ...basePath]`.
 */
export function buildInvoiceDestinationDivider(
  source: { uid: string; name: string; description?: string | null; uid_delivery?: string | null; uid_collection?: string | null },
  path: string[] = [],
): OrderDocDestinationItemType {
  return {
    uid: source.uid,
    type: "destination",
    name: source.name,
    description: source.description ?? "",
    uid_delivery: source.uid_delivery ?? null,
    uid_collection: source.uid_collection ?? null,
    path,
  };
}

/**
 * Project an order item to its invoice-item shape, scoped under an order divider.
 *
 * Order items carry fields (`stock_method`, `order_number`, `uid_order`,
 * `inclusion_type`, `zero_priced`, `uid_delivery`/`uid_collection` on line items,
 * `price.replacement`) that `InvoiceDocLineItemSchema` (strict) rejects. Spreading
 * `...orderItem` into an invoice item leaks them. Call this helper at every
 * order → invoice boundary instead.
 *
 * `destination` and `group` items share their shape with the order doc, so they
 * pass through. Line items (and `transaction_fee`, which is stored as a
 * line-item-shaped invoice item) are narrowed to the invoice-line-item keys.
 *
 * The divider/line split is `ITEM_CONTRACTS[type].kind`, not a list of type
 * literals — so a new line type projects correctly the day it is added to the
 * table, instead of silently falling through to whichever branch happened to be
 * last. The per-branch KEY sets stay hand-written on purpose: they mirror
 * `InvoiceDocLineItemSchema`'s strict shape, and deriving them from the contract
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

  const p = (item.price ?? {}) as Partial<InvoiceDocItemPrice>;
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
      // The intrinsic-tax snapshot inherits, so an invoice's `tax_profile`
      // revert is lossless the way an order's already is. Spread
      // CONDITIONALLY, twice over: an explicit `undefined` trips
      // `validateBeforeWrite`'s no-undefined guard, and `invoicePriceDifferences`
      // compares price KEY SETS — emitting the key unconditionally would make
      // every pre-2026-08 invoice line differ from its order line on a field
      // neither of them ever set.
      ...(p.taxes_base !== undefined ? { taxes_base: p.taxes_base } : {}),
      total_cents: p.total_cents ?? 0,
    },
    // ⚠️ `coa_revenue` is an INVOICE_ONLY field, and projecting it is not a
    // contradiction — it is what makes the override an override. The invoice's
    // own value still wins (`carryForwardOverrides` re-applies it after the
    // replace); this only supplies the order's when the invoice has none,
    // instead of leaving `undefined` for `calculateInvoiceTotals` to read as
    // "taxable" while the stored per-line taxes say otherwise.
    //
    // Comparator-safe by construction: `invoiceItemsMatch` filters
    // INVOICE_ONLY_ITEM_FIELDS out of both key sets, so adding this key changes
    // no sync verdict. That is NOT true of `price.taxes_base` above, which is
    // nested inside `price` and therefore compared — hence the two different
    // treatments of two fields added in the same pass.
    ...(item.coa_revenue !== undefined ? { coa_revenue: item.coa_revenue } : {}),
    path,
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
 * a stored CRMS line omits the key, and `InvoiceDocItemPriceSchema` blesses
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
 * {@link isItemSynced}'s order-shaped one behind the draft mirror — which had
 * drifted into disagreeing about what "the same line" means. Both now call
 * this; {@link isItemSynced} projects its order item first.
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
 * Strip the differences that are **explained** — leaving only the ones an
 * operator should act on (api-cloudrun#481).
 *
 * The sync badge and `scripts/audit-draft-invoice-mirror.ts` were two
 * comparators kept in agreement by hand, and they disagreed by construction: the
 * audit compared money and then *explained* the difference through tested arms,
 * while the badge had none and so reported every one of them. On prod that was
 * 8,792 lines flagged against **0** the audit called real. This is the audit's
 * reasoning, moved to where both callers share it.
 *
 * Three arms, all narrow, and none of them a field exclusion — an excluded field
 * is blind forever, whereas an explained one goes red the moment its explanation
 * stops holding:
 *
 * 1. **`coa_untaxes`** — the invoice knows the line is non-revenue and the order
 *    does not, so the taxability gate fires on one side only.
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
export type InvoiceSyncArm = "coa_untaxes" | "tax_date_version" | "tax_zero_money";

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
 * `scripts/audit-draft-invoice-mirror.ts` reports one bucket per arm. Returning
 * the arm is what lets that audit be a pure CONSUMER of this function rather
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

/**
 * Compare a previous order item to a current invoice item to detect overrides.
 * Returns true if the invoice item is "synced" (matches the order item on all
 * non-invoice-only fields), false if it has been manually overridden.
 *
 * **It projects the order item first, then delegates to
 * {@link invoiceItemsMatch} — and that projection IS core#52's fix.** The
 * function used to compare an order-SHAPED item against an invoice-SHAPED one,
 * key sets before values; `stock_method` is required on a stored order line
 * (`schemas/order.ts`) and REJECTED by the strict `InvoiceDocLineItemSchema`,
 * so the two sets could never be equal and an unchanged item reported
 * "overridden" — for every real line item in the corpus, with nothing thrown.
 * `price.replacement_cents` was a second, independent mismatch. The consequence
 * was that the order→invoice draft mirror propagated additions only: never an
 * edit, never a removal. Filtering both sides did NOT fix it — those are
 * order-only fields, not invoice-only overrides — so the fix had to be to
 * compare two invoice-shaped items, which is a real behavioural change to the
 * mirror rather than a tidy-up.
 *
 * ⚠️ The covering unit test's fixture omits `stock_method`, which is why it was
 * green throughout. Keep it that way only if it is testing something else — a
 * fixture repaired to make this green would delete the evidence.
 *
 * @param prevOrderItem - The order item from the previous version of the order
 * @param invoiceItem - The current invoice item (with order-scoped path)
 * @param orderDividerUid - The uid of the order divider (both sides carry the
 *   scoped path once the order item is projected, so nothing is stripped)
 * @returns true if the item is synced (not overridden), false if overridden
 */
export function isItemSynced(
  prevOrderItem: LineItem,
  invoiceItem: InvoiceItem,
  orderDividerUid: string,
): boolean {
  return invoiceItemsMatch(
    projectOrderItemToInvoiceItem(prevOrderItem, orderDividerUid),
    invoiceItem,
  );
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
 * - **Removed** (in prev order, not in new): removed only if synced, kept if overridden
 *
 * @param prevOrderItems - Items from the previous version of the order
 * @param newOrderItems - Items from the new version of the order
 * @param currentInvoiceItems - Items scoped to this order in the current invoice (without order divider)
 * @param orderDividerUid - The uid of the order divider in the invoice
 * @returns Updated invoice items (scoped under the order divider, ready for insertion)
 */
export function syncOrderToInvoiceSelective(
  prevOrderItems: LineItem[],
  newOrderItems: LineItem[],
  currentInvoiceItems: InvoiceDocItemType[],
  orderDividerUid: string,
): InvoiceDocItemType[] {
  // Index prev order items by path key
  const prevByPath = new Map<string, LineItem>();
  for (const item of prevOrderItems) {
    prevByPath.set(itemPathKey(item.path), item);
  }

  // Index current invoice items by order-relative path key
  const invoiceByPath = new Map<string, InvoiceDocItemType>();
  for (const item of currentInvoiceItems) {
    const relPath = stripOrderPrefix(item.path, orderDividerUid);
    invoiceByPath.set(itemPathKey(relPath), item);
  }

  const result: InvoiceDocItemType[] = [];
  const processedInvoicePaths = new Set<string>();

  // Process new order items in order
  for (const newItem of newOrderItems) {
    const pathKey = itemPathKey(newItem.path);
    const prevItem = prevByPath.get(pathKey);
    const invoiceItem = invoiceByPath.get(pathKey);
    processedInvoicePaths.add(pathKey);

    if (!invoiceItem) {
      // New item — project to invoice shape, scoped under the order divider
      result.push(projectOrderItemToInvoiceItem(newItem, orderDividerUid));
    } else if (prevItem && isItemSynced(prevItem, invoiceItem, orderDividerUid)) {
      // Not overridden — replace with projected order item, carry forward invoice-only fields
      result.push({
        ...projectOrderItemToInvoiceItem(newItem, orderDividerUid),
        ...pickInvoiceOnlyFields(invoiceItem),
      });
    } else {
      // Overridden or no prev item — keep invoice item unchanged
      result.push(invoiceItem);
    }
  }

  // Handle removed items (in invoice but not in new order)
  for (const [pathKey, invoiceItem] of invoiceByPath) {
    if (processedInvoicePaths.has(pathKey)) continue;

    const prevItem = prevByPath.get(pathKey);
    if (prevItem && !isItemSynced(prevItem, invoiceItem, orderDividerUid)) {
      // Overridden — keep it even though it's been removed from the order
      result.push(invoiceItem);
    }
    // Else: synced and removed from order — drop it
  }

  return result;
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
 * Reuses {@link validateItemUniqueness}'s logic — the parent uid is the
 * second-to-last `path` segment, which for invoice items naturally captures
 * each scope:
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
  return validateItemUniqueness(items);
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
 *   deliberate: 112 prod invoices hold destination dividers whose
 *   `uid_delivery`/`uid_collection` point at a different `destinations` doc than
 *   the order's, and that staleness is a real difference the badge should keep
 *   showing, not something a structural repair should quietly overwrite.
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
  const invoiceByUid = new Map<string, InvoiceDocItemType[]>();
  for (const it of invoiceLines) {
    const bucket = invoiceByUid.get(it.uid);
    if (bucket) bucket.push(it);
    else invoiceByUid.set(it.uid, [it]);
  }
  const orderLineCounts = new Map<string, number>();
  for (const it of orderItems) {
    if (!isLineItemType(it.type)) continue;
    orderLineCounts.set(it.uid, (orderLineCounts.get(it.uid) ?? 0) + 1);
  }

  const cursor = new Map<string, number>();
  const pairedFor = new Map<LineItem, InvoiceDocItemType>();
  const paired = new Set<InvoiceDocItemType>();
  for (const orderLine of orderItems) {
    if (!isLineItemType(orderLine.type)) continue;
    const bucket = invoiceByUid.get(orderLine.uid);
    if (!bucket) continue;
    const k = cursor.get(orderLine.uid) ?? 0;
    cursor.set(orderLine.uid, k + 1);
    const match = bucket[k];
    if (!match) continue;
    pairedFor.set(orderLine, match);
    paired.add(match);
  }

  const ambiguous: AmbiguousItemPairing[] = [];
  for (const [uid, bucket] of invoiceByUid) {
    const orderOccurrences = orderLineCounts.get(uid) ?? 0;
    if (orderOccurrences === 0) continue;
    if (bucket.length > 1 || orderOccurrences > 1) {
      ambiguous.push({ uid, invoiceOccurrences: bucket.length, orderOccurrences });
    }
  }

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
    // `path.at(-2)`: that reads a parent only from a SELF-INCLUSIVE path, and
    // the CRMS invoice webhook calls this while its items still carry the
    // pre-normalized ancestry chain (`[principalUid]`, or `[]`) that
    // `computeInvoiceItemPaths` has not yet turned into a full path. This form
    // answers correctly for both, and for a top-level line under a divider it
    // returns the divider — which is exactly the parent it hangs from.
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
  const invoice = new Set<string>();
  for (const it of scopedInvoiceItems) {
    if (it.type === "order" || !isDividerItemType(it.type)) continue;
    invoice.add(itemPathKey(stripOrderPrefix(it.path ?? [], orderDividerUid)));
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
 * **order divider** — a multi-order invoice loops its linked orders. Invoice-only
 * override fields (`coa_revenue`, `tracking_category`, `xero_id`,
 * `xero_tracking_option_id`) are always carried forward.
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
 * recomputes `totals` via {@link calculateInvoiceTotals} before writing.
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
 * Surfaced by `GET /invoices/{uid}/sync-status`, to badge lines and offer
 * per-line/whole resync (see {@link resyncInvoiceLines}).
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
  for (const item of currentInvoiceItems) {
    if (item.type === "order" && item.uid === orderDividerUid) continue;
    if (item.path[0] !== orderDividerUid) continue;
    invoiceByRelPath.set(itemPathKey(stripOrderPrefix(item.path, orderDividerUid)), item);
  }

  const matchedRelKeys = new Set<string>();
  for (const orderItem of orderItems) {
    const relKey = itemPathKey(orderItem.path ?? []);
    matchedRelKeys.add(relKey);
    const fullKey = itemPathKey([orderDividerUid, ...(orderItem.path ?? [])]);
    const current = invoiceByRelPath.get(relKey);
    if (!current) {
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
    status.set(itemPathKey(item.path), "out_of_sync");
  }

  return status;
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
 * Stable key for matching a destination pair by its endpoint uids.
 * Each endpoint's `uid` references a record in the destinations collection;
 * the (delivery.uid, collection.uid) tuple uniquely identifies a pair
 * within a single order.
 */
function destPairKey(uidOrder: string, pair: DocDestinationType): string {
  return [uidOrder, pair.delivery?.uid ?? "", pair.collection?.uid ?? ""].join("/");
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
 * pair, and `pairsMatch` canonicalizes the two together, so this costs no
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
 * The two fields a pair comparison must NOT look at. `uid_order` is the scope
 * key rather than payload; `dates` is snapshotted from the source order, so the
 * invoice never owns it and a change there is not an operator edit.
 */
const PAIR_MATCH_EXCLUDED: ReadonlySet<string> = new Set(["uid_order", "dates"]);

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
function canonicalizePayload(value: unknown): unknown {
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
 * Deep-equality check on a pair's payload, ignoring {@link PAIR_MATCH_EXCLUDED}.
 *
 * 🔴 **An equality check enumerates what it SKIPS, never what it takes**, and
 * the two failure modes are opposite. A forgotten key in a *projection* drops a
 * field, which surfaces. A forgotten key here silently answers *"equal"* — so
 * the caller concludes the invoice pair was never edited, and **overwrites the
 * operator's edit with the order's value.** Silent data loss, not a missing
 * field. Excluding by name makes every future field on the pair compared by
 * construction; the sibling projections in
 * {@link syncOrderDestinationsSelective} enumerate their takings for the same
 * reason, in the other direction.
 */
function pairsMatch(a: DocDestinationType, b: DocDestinationType): boolean {
  const strip = (pair: DocDestinationType): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(pair)) {
      if (!PAIR_MATCH_EXCLUDED.has(key)) out[key] = value;
    }
    return out;
  };
  return JSON.stringify(canonicalizePayload(strip(a))) ===
    JSON.stringify(canonicalizePayload(strip(b)));
}

/**
 * Selectively sync one order's destination pairs into an invoice's destinations,
 * respecting invoice-side overrides. Per-pair matching is by
 * `(uid_order, delivery.uid, collection.uid)`; only pairs scoped to `uidOrder`
 * are touched — pairs from other orders pass through unchanged.
 *
 * Policy per pair:
 * - Not in invoice (new in order) → add, tagged with `uid_order`.
 * - In invoice AND prev order matches current invoice → replace with new order pair.
 * - In invoice BUT prev order ≠ invoice → overridden, keep invoice version.
 * - In invoice but not in new order:
 *   - prev matches invoice → deleted from order, drop.
 *   - prev ≠ invoice → overridden, keep.
 *
 * @param prevOrderDests - Pairs from the previous version of the order
 * @param newOrderDests - Pairs from the new version of the order
 * @param currentInvoiceDests - Current full invoice destinations array (all orders)
 * @param uidOrder - The order uid this sync is scoped to
 * @returns Updated full invoice destinations array
 */
export function syncOrderDestinationsSelective(
  prevOrderDests: DocDestinationType[],
  newOrderDests: DocDestinationType[],
  currentInvoiceDests: InvoiceDestinationPair[],
  uidOrder: string,
): InvoiceDestinationPair[] {
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
    } else if (prev && pairsMatch(prev, inv)) {
      // Not overridden — replace with new order pair.
      synced.push(toInvoiceDestinationPair(uidOrder, newPair));
    } else {
      // Overridden (or prev missing) — keep invoice version.
      synced.push(inv);
    }
  }

  // Handle pairs present in invoice but not in new order.
  for (const [key, inv] of inScope) {
    if (processedKeys.has(key)) continue;
    const prev = prevByKey.get(key);
    if (prev && !pairsMatch(prev, inv)) {
      // Overridden — keep even though removed from order.
      synced.push(inv);
    }
    // Else: synced and removed → drop.
  }

  return [...outOfScope, ...synced];
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

/**
 * Scalar co-write with override detection. Returns the new order value if
 * the invoice value still matches the previous order value (i.e. the invoice
 * has not been manually edited on this field); otherwise returns the current
 * invoice value (treated as an override, preserved).
 *
 * Values are compared by strict equality (`===`). Both `undefined` and `null`
 * participate in the match — a field that was `null` on prev and is `null`
 * on the invoice will accept a new non-null order value.
 */
export function syncScalarWithOverride<T>(
  prevOrderValue: T | undefined,
  newOrderValue: T | undefined,
  currentInvoiceValue: T | undefined,
): T | undefined {
  return prevOrderValue === currentInvoiceValue ? newOrderValue : currentInvoiceValue;
}

