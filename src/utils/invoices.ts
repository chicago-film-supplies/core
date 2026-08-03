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
  calculateItemDiscount,
  calculateItemPrice,
  calculateItemSubtotal,
  calculateItemTax,
  calculateItemTotal,
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

import currency from "currency.js";
import type { COARevenueType, DocDestinationType, InvoiceDocDestinationType, InvoiceDocItemPrice, InvoiceDocItemType, InvoiceDocTotals, InvoiceStatusType, OrderDocDestinationItemType, PriceFormulaType, SettlementReasonType, SettlementTypeType } from "../schemas/mod.ts";
import {
  getSettlementMultiplier,
  isDividerItemType,
  isLineItemType,
  SETTLEMENT_CONTRACTS,
} from "../schemas/mod.ts";
import { fromCents, fromCentsBig, roundDivHalfAwayFromZero, toCentsBig } from "./money.ts";
import {
  calculateItemSubtotal,
  computeItemPaths,
  costTransactionFees,
  getTotalDiscount,
  getTaxTotals,
  getTransactionFeeTotals,
  isPreTaxItem,
  type ItemPathIssue,
  type ItemUniquenessIssue,
  type LineItem,
  type PriceObject,
  type Tax,
  validateItemUniqueness,
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
}

// ── Invoice totals ──────────────────────────────────────────────

/** @see {@link InvoiceDocTotals} from `@cfs/core/schemas` */
export type InvoiceTotals = InvoiceDocTotals;

/**
 * Calculate aggregated pricing totals for an invoice.
 *
 * Composes from the same atomic building blocks as orders (calculateItemSubtotal,
 * getTaxTotals, etc.) but assembled independently — shared per-item math,
 * independent aggregation. This avoids business logic drift if invoices need
 * different totals logic in the future (credit notes, partial billing, etc.).
 *
 * @param items - Full invoice items array (structural items are filtered out)
 * @param taxes - Tax definitions for tax calculation
 * @param settlements - Every settlement against the invoice, reversals included
 */
export function calculateInvoiceTotals(
  items: InvoiceItem[],
  taxes: Tax[],
  // BREAKING, deliberately. An optional param means any un-updated call site
  // silently computes `amount_credited: 0` and re-inflates `amount_due` — the
  // exact class that flipped 14 invoices in #409. Renaming the parameter and
  // changing its element shape turns every one of the 11 call sites into a
  // compile error instead.
  settlements?: readonly {
    type: SettlementTypeType;
    reason: SettlementReasonType;
    amount_cents: number;
  }[],
): InvoiceTotals {
  const billable = flattenForXero(items);

  // Pass 1: pre-tax items — subtotals, discount, taxes
  let subtotal = currency(0);
  let subtotal_discounted = currency(0);

  for (const item of billable) {
    if (!isPreTaxItem(item)) continue;
    const result = calculateItemSubtotal(item);
    subtotal = subtotal.add(result.subtotal);
    subtotal_discounted = subtotal_discounted.add(result.subtotal_discounted);
  }

  const discount_amount = getTotalDiscount(billable);
  const taxTotals = getTaxTotals(billable, taxes);

  let taxSum = currency(0);
  for (const entry of taxTotals) {
    taxSum = taxSum.add(entry.amount);
  }

  // Pass 2: transaction fees — computed from subtotal_discounted
  const transaction_fees = getTransactionFeeTotals(
    costTransactionFees(billable, subtotal_discounted.value),
  );

  let feeSum = currency(0);
  for (const entry of transaction_fees) {
    feeSum = feeSum.add(entry.amount);
  }

  const total = currency(subtotal_discounted).add(taxSum).add(feeSum).value;

  // Settlement accounting — the projection of the journal onto this document.
  const { amount_paid, amount_credited, amount_due } = recomputeSettlementTotals(
    total,
    settlements ?? [],
  );

  return {
    discount_amount,
    subtotal: subtotal.value,
    subtotal_discounted: subtotal_discounted.value,
    taxes: taxTotals,
    transaction_fees,
    total,
    amount_paid,
    amount_credited,
    amount_due,
  };
}

// ── Payment helpers ─────────────────────────────────────────────

/**
 * Derive invoice status from settlement amounts.
 * Pure function — does not mutate the invoice.
 *
 * **No new status member is needed for a credited invoice.** `paid` already
 * means `amount_due === 0`, not "cash received" — which is exactly what Xero
 * says: #1751 and #1322 are both PAID there with `AmountPaid: 0`.
 *
 * @param currentStatus - Current invoice status
 * @param amountPaid - Total settled in cash
 * @param amountDue - Total still outstanding
 * @param amountCredited - Total settled by credit note
 * @returns The derived status
 */
export function derivePaymentStatus(
  currentStatus: string,
  amountPaid: number,
  amountDue: number,
  amountCredited = 0,
): InvoiceStatusType {
  if (currentStatus === "draft" || currentStatus === "void") return currentStatus;
  if (currency(amountDue).value <= 0) return "paid";
  // A partially-credited invoice is as much "part paid" as a partially-paid one
  // — the operator's question is "has anything settled this yet?"
  if (currency(amountPaid).value > 0 || currency(amountCredited).value > 0) return "part_paid";
  return "issued";
}

/**
 * Turn the settlements journal into the invoice's stored totals.
 *
 * **This is the one function that produces `amount_paid`, `amount_credited` and
 * `amount_due`**, and the one place the cents↔dollars boundary is crossed. It
 * runs inside the api's co-write transaction and again in manager's optimistic
 * recompute, so the two cannot disagree — the property `computeAvailability`
 * already provides for stock.
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
 * @param total - Invoice total, in dollars, from `items[]`
 * @param settlements - Every settlement against the invoice, reversals included
 * @returns The three projected totals plus a per-reason breakdown, in dollars
 */
export function recomputeSettlementTotals(
  total: number,
  settlements: readonly {
    type: SettlementTypeType;
    reason: SettlementReasonType;
    amount_cents: number;
  }[],
): {
  amount_paid: number;
  amount_credited: number;
  amount_due: number;
  breakdown: Partial<Record<SettlementReasonType, number>>;
} {
  let paidCents = 0;
  let creditedCents = 0;
  const breakdownCents: Partial<Record<SettlementReasonType, number>> = {};

  for (const s of settlements) {
    const signed = s.amount_cents * getSettlementMultiplier(s.type);
    if (SETTLEMENT_CONTRACTS[s.type].sums_into === "amount_paid") paidCents += signed;
    else creditedCents += signed;
    breakdownCents[s.reason] = (breakdownCents[s.reason] ?? 0) + signed;
  }

  // The ONE conversion boundary, crossed once, at the end.
  const amount_paid = fromCents(paidCents);
  const amount_credited = fromCents(creditedCents);

  const breakdown: Partial<Record<SettlementReasonType, number>> = {};
  for (const [reason, cents] of Object.entries(breakdownCents)) {
    breakdown[reason as SettlementReasonType] = fromCents(cents);
  }

  return {
    amount_paid,
    amount_credited,
    // currency.js appears only here, where the dollar-denominated `total` (from
    // `items[]`) meets the converted figures. Money minus money is exactly what
    // it is for.
    amount_due: currency(total).subtract(amount_paid).subtract(amount_credited).value,
    breakdown,
  };
}

// ── Xero helpers ────────────────────────────────────────────────

/**
 * Quantity widening for {@link getXeroUnitAmount}, matching `QTY_SCALE` in
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
 * unlike the booking `unit_price` denorm, whose residual is discarded on
 * purpose because nothing ever multiplies it back.
 *
 * `getXeroUnitAmount(100, 3)` is `33.33`, and Xero will bill `99.99`. **Rounding
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
 * @param subtotal - Pre-discount subtotal (base × days × formula × quantity)
 * @param quantity - Item quantity. May be fractional; scaled rather than
 *   narrowed, so a non-integer cannot throw on the Xero push path.
 * @returns Per-unit amount for Xero, or 0 if quantity is 0
 */
export function getXeroUnitAmount(subtotal: number, quantity: number): number {
  if (!quantity) return 0;
  return fromCentsBig(roundDivHalfAwayFromZero(
    toCentsBig(subtotal) * XERO_QTY_SCALE,
    BigInt(Math.round(quantity * Number(XERO_QTY_SCALE))),
  ));
}

// ── Selective sync helpers ──────────────────────────────────────

/** Invoice-only item fields excluded from override comparison. */
const INVOICE_ONLY_ITEM_FIELDS = new Set([
  "coa_revenue", "tracking_category", "xero_id", "xero_tracking_option_id",
]);

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
 */
function projectOrderItemToInvoiceItem(item: LineItem, orderDividerUid: string): InvoiceDocItemType {
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
      base: p.base ?? 0,
      chargeable_days: p.chargeable_days ?? null,
      formula: (p.formula ?? "five_day_week") as PriceFormulaType,
      subtotal: p.subtotal ?? 0,
      subtotal_discounted: p.subtotal_discounted ?? 0,
      discount: p.discount ?? null,
      taxes: p.taxes ?? [],
      total: p.total ?? 0,
    },
    path,
  };
}

/**
 * Pick only invoice-only override fields from an invoice item.
 * Used to carry forward overrides when replacing an item with updated order data.
 */
function pickInvoiceOnlyFields(item: InvoiceItem): Partial<InvoiceItem> {
  const result: Partial<InvoiceItem> = {};
  if (item.coa_revenue !== undefined) result.coa_revenue = item.coa_revenue;
  if (item.tracking_category !== undefined) result.tracking_category = item.tracking_category;
  if (item.xero_id !== undefined) result.xero_id = item.xero_id;
  if (item.xero_tracking_option_id !== undefined) result.xero_tracking_option_id = item.xero_tracking_option_id;
  return result;
}

/**
 * Compare a previous order item to a current invoice item to detect overrides.
 * Returns true if the invoice item is "synced" (matches the order item on all
 * non-invoice-only fields), false if it has been manually overridden.
 *
 * The comparison strips the order divider prefix from the invoice item's path
 * and ignores invoice-only fields (coa_revenue, tracking_category, xero_id,
 * xero_tracking_option_id).
 *
 * @param prevOrderItem - The order item from the previous version of the order
 * @param invoiceItem - The current invoice item (with order-scoped path)
 * @param orderDividerUid - The uid of the order divider (for path prefix stripping)
 * @returns true if the item is synced (not overridden), false if overridden
 */
export function isItemSynced(
  prevOrderItem: LineItem,
  invoiceItem: InvoiceItem,
  orderDividerUid: string,
): boolean {
  // Build a normalized version of the invoice item for comparison:
  // strip invoice-only fields and order divider path prefix
  const normalizedInvoice: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(invoiceItem)) {
    if (INVOICE_ONLY_ITEM_FIELDS.has(key)) continue;
    if (key === "path") {
      normalizedInvoice[key] = stripOrderPrefix(value as string[], orderDividerUid);
    } else {
      normalizedInvoice[key] = value;
    }
  }

  // Compare all fields from the order item against the normalized invoice item
  const orderKeys = Object.keys(prevOrderItem);
  const invoiceKeys = Object.keys(normalizedInvoice);

  // Must have the same set of non-invoice-only keys
  const orderKeySet = new Set(orderKeys);
  const invoiceKeySet = new Set(invoiceKeys);
  for (const k of orderKeySet) {
    if (!invoiceKeySet.has(k)) return false;
  }
  for (const k of invoiceKeySet) {
    if (!orderKeySet.has(k)) return false;
  }

  for (const key of orderKeys) {
    const a = (prevOrderItem as unknown as Record<string, unknown>)[key];
    const b = normalizedInvoice[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) return false;
  }

  return true;
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
  currentInvoiceItems: InvoiceItem[],
  orderDividerUid: string,
): InvoiceItem[] {
  // Index prev order items by path key
  const prevByPath = new Map<string, LineItem>();
  for (const item of prevOrderItems) {
    prevByPath.set(itemPathKey(item.path), item);
  }

  // Index current invoice items by order-relative path key
  const invoiceByPath = new Map<string, InvoiceItem>();
  for (const item of currentInvoiceItems) {
    const relPath = stripOrderPrefix(item.path, orderDividerUid);
    invoiceByPath.set(itemPathKey(relPath), item);
  }

  const result: InvoiceItem[] = [];
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
  const recomputed = computeInvoiceItemPaths(items);
  const issues: ItemPathIssue[] = [];
  for (let i = 0; i < items.length; i++) {
    const original = items[i].path ?? [];
    const expected = recomputed[i].path;
    const orderMismatch = items[i].uid !== recomputed[i].uid;
    if (
      orderMismatch ||
      original.length !== expected.length ||
      original.some((seg, j) => seg !== expected[j])
    ) {
      issues.push({ index: i, uid: items[i].uid, path: original, expected });
    }
  }
  return issues;
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
export function buildOrderScopedItems(orderItems: LineItem[], orderDividerUid: string): InvoiceItem[] {
  return orderItems.map((item) => projectOrderItemToInvoiceItem(item, orderDividerUid));
}

/**
 * Carry forward invoice-specific overrides from existing items to rebuilt items.
 * Matches by uid — if a rebuilt item has the same uid as an existing invoice item,
 * the invoice-specific fields (coa_revenue, tracking_category, xero_id,
 * xero_tracking_option_id) are preserved from the existing item.
 *
 * @param rebuiltItems - Items rebuilt from the order
 * @param existingItems - Current invoice items (to carry forward overrides from)
 * @returns Rebuilt items with invoice-specific overrides applied
 */
export function carryForwardOverrides(rebuiltItems: InvoiceItem[], existingItems: InvoiceItem[]): InvoiceItem[] {
  const existingByUid = new Map<string, InvoiceItem>();
  for (const item of existingItems) {
    if (item.uid) existingByUid.set(item.uid, item);
  }

  return rebuiltItems.map((item) => {
    if (!item.uid) return item;
    const existing = existingByUid.get(item.uid);
    if (!existing) return item;

    return {
      ...item,
      ...(existing.coa_revenue !== undefined && { coa_revenue: existing.coa_revenue }),
      ...(existing.tracking_category !== undefined && { tracking_category: existing.tracking_category }),
      ...(existing.xero_id !== undefined && { xero_id: existing.xero_id }),
      ...(existing.xero_tracking_option_id !== undefined && { xero_tracking_option_id: existing.xero_tracking_option_id }),
    };
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
  invoiceItems: InvoiceItem[],
  orderItems: LineItem[],
  orderDividerUid: string,
): InvoiceItem[] {
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
 * Compare two invoice-shaped items for sync equality, ignoring the invoice-only
 * override fields ({@link INVOICE_ONLY_ITEM_FIELDS}). Key-set + per-key JSON
 * comparison — order-insensitive, the same normalization {@link isItemSynced}
 * applies at the order↔invoice boundary. Both items must already be
 * invoice-shaped with full (divider-scoped) paths.
 */
function invoiceProjectionMatches(expected: InvoiceItem, current: InvoiceItem): boolean {
  const comparableKeys = (it: InvoiceItem) =>
    Object.keys(it).filter((k) => !INVOICE_ONLY_ITEM_FIELDS.has(k));
  const eKeys = comparableKeys(expected);
  const cKeys = comparableKeys(current);
  if (eKeys.length !== cKeys.length) return false;
  const cSet = new Set(cKeys);
  for (const k of eKeys) if (!cSet.has(k)) return false;
  const e = expected as unknown as Record<string, unknown>;
  const c = current as unknown as Record<string, unknown>;
  for (const k of eKeys) {
    if (JSON.stringify(e[k]) !== JSON.stringify(c[k])) return false;
  }
  return true;
}

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
  currentInvoiceItems: InvoiceItem[],
  orderItems: LineItem[],
  orderDividerUid: string,
  targetPaths?: string[][],
): InvoiceItem[] {
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
 * ({@link INVOICE_ONLY_ITEM_FIELDS}); otherwise `in_sync`. Consumed by the
 * manager to badge lines and offer per-line/whole resync (see
 * {@link resyncInvoiceLines}).
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
    status.set(fullKey, invoiceProjectionMatches(expected, current) ? "in_sync" : "out_of_sync");
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

/** Deep-equality check on a pair's endpoint payload, ignoring uid_order. */
function pairsMatch(a: DocDestinationType, b: DocDestinationType): boolean {
  return JSON.stringify({
    delivery: a.delivery,
    collection: a.collection,
    customer_collecting: a.customer_collecting,
    customer_returning: a.customer_returning,
  }) === JSON.stringify({
    delivery: b.delivery,
    collection: b.collection,
    customer_collecting: b.customer_collecting,
    customer_returning: b.customer_returning,
  });
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
      synced.push({
        uid_order: uidOrder,
        dates: newPair.dates,
        delivery: newPair.delivery,
        collection: newPair.collection,
        customer_collecting: newPair.customer_collecting,
        customer_returning: newPair.customer_returning,
      });
    } else if (prev && pairsMatch(prev, inv)) {
      // Not overridden — replace with new order pair.
      synced.push({
        uid_order: uidOrder,
        dates: newPair.dates,
        delivery: newPair.delivery,
        collection: newPair.collection,
        customer_collecting: newPair.customer_collecting,
        customer_returning: newPair.customer_returning,
      });
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

/**
 * Object co-write with override detection. Like `syncScalarWithOverride` but
 * compares two objects for deep equality via JSON.stringify. If `keys` is
 * provided, only those keys are compared (useful when one side carries
 * fields the other doesn't — e.g. invoice.organization.tax_profile has no
 * equivalent on the order snapshot).
 */
export function syncObjectWithOverride<T extends Record<string, unknown>>(
  prevOrderValue: T,
  newOrderValue: T,
  currentInvoiceValue: T,
  keys?: (keyof T)[],
): T {
  const pick = (v: T) => {
    if (!keys) return v;
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k as string] = v[k];
    return out;
  };
  const matches = JSON.stringify(pick(prevOrderValue)) === JSON.stringify(pick(currentInvoiceValue));
  return matches ? newOrderValue : currentInvoiceValue;
}
