/**
 * Shared order utility functions for CFS applications.
 * Includes pricing calculations, item consolidation, and destination grouping.
 * All arithmetic uses currency.js for safe floating-point calculations.
 *
 * ```ts
 * import { calculateOrderTotals } from "@cfs/utilities/orders";
 *
 * const items = [
 *   {
 *     type: "rental",
 *     quantity: 1,
 *     price: {
 *       base: 100,
 *       formula: "five_day_week",
 *       chargeable_days: 5,
 *       discount: null,
 *       taxes: [],
 *       subtotal: 100,
 *       subtotal_discounted: 100,
 *     },
 *   },
 * ];
 * const totals = calculateOrderTotals(items, []);
 * console.log(totals.total); // 100
 * ```
 *
 * @module
 */

import currency from "currency.js";
import type {
  DiscountType,
  PriceModifierType,
  OrderDocTotalsType,
  OrderDocItemPriceType,
  OrderDatesType,
  OrderDocDatesType,
  DestinationType,
  DocDestinationType,
  FirestoreTimestampType,
  ConsolidatedItemType,
  GroupPathType,
  Tax as SchemaTax,
} from "@cfs/schemas";
import { getDuration, toChicagoYmd } from "./dates.ts";

// ── Types ────────────────────────────────────────────────────────

/** @see {@link DiscountType} from `@cfs/schemas` */
export type Discount = DiscountType;

/** @see {@link PriceModifierType} from `@cfs/schemas` */
export type PriceModifier = PriceModifierType;

/** @see {@link OrderDocItemPriceType} from `@cfs/schemas` */
export type PriceObject = OrderDocItemPriceType;

/** Subset of the full Tax document needed by utility functions. */
export type Tax = Pick<SchemaTax, "uid" | "name" | "rate" | "type">;

/**
 * A single line item in an order (product, destination, group, surcharge, or fee).
 * Loose interface compatible with all OrderDocItemType members — utility functions
 * use type guards (isPriceableItem, isTransactionFeeItem) before accessing
 * member-specific fields.
 */
export interface LineItem {
  uid: string;
  name: string;
  type: string;
  quantity?: number;
  price?: PriceObject | PriceModifierType;
  stock_method?: string;
  path: string[];
  uid_delivery?: string | null;
  uid_collection?: string | null;
  zero_priced?: boolean | null;
  description?: string;
  order_number?: number;
  uid_order?: string | null;
}

/** A pre-tax line item with a full price object (rental, sale, service, surcharge, replacement). */
export interface PreTaxLineItem extends LineItem {
  type: "rental" | "sale" | "service" | "surcharge" | "replacement";
  quantity: number;
  price: PriceObject;
}

/** A transaction fee line item with a PriceModifier price. */
export interface TransactionFeeLineItem extends LineItem {
  type: "transaction_fee";
  quantity: number;
  price: PriceModifierType;
}

/** Any item that has pricing — pre-tax or transaction fee. */
export type PriceableLineItem = PreTaxLineItem | TransactionFeeLineItem;

/** @see {@link OrderDocTotalsType} from `@cfs/schemas` */
export type OrderTotals = OrderDocTotalsType;

/** @see {@link ConsolidatedItemType} from `@cfs/schemas` */
export type ConsolidatedItem = ConsolidatedItemType;

/** @see {@link GroupPathType} from `@cfs/schemas` */
export type GroupPath = GroupPathType;

// ── Date & destination comparison ───────────────────────────────

/**
 * Whether charge dates match the delivery/collection dates
 * (i.e. no custom charge period has been set).
 */
export function isSameAsDeliveryDates(dates: OrderDatesType): boolean {
  return dates.charge_start === dates.delivery_start
    && dates.charge_end === dates.collection_start;
}

/**
 * Whether a destination's collection endpoint matches its delivery endpoint
 * (address, contact, and instructions are all equal).
 */
export function isSameAsDeliveryDestination(destination: DestinationType): boolean {
  if (!destination.delivery && !destination.collection) return true;
  if (!destination.collection) return true;
  if (!destination.delivery) return false;

  return JSON.stringify(destination.delivery.address) === JSON.stringify(destination.collection.address)
    && JSON.stringify(destination.delivery.contact) === JSON.stringify(destination.collection.contact)
    && destination.delivery.instructions === destination.collection.instructions;
}

/**
 * Build a display name for a destination pair from its delivery/collection addresses.
 * Falls back to "Destination N" when no addresses are present.
 */
export function getDestinationPairItemName(
  destination: DestinationType,
  index: number,
): string {
  const deliveryName = destination.delivery?.address?.name || destination.delivery?.address?.street || "";
  const collectionName = destination.collection?.address?.name || destination.collection?.address?.street || "";

  if (!deliveryName && !collectionName) {
    return "Destination " + (index + 1);
  }

  if (!collectionName || deliveryName === collectionName) {
    return deliveryName || "Destination " + (index + 1);
  }

  return deliveryName + " - " + collectionName;
}

/**
 * Pair-derived legend strings for the order's start/end dates.
 *
 * Each pair contributes a label based on its `customer_collecting` /
 * `customer_returning` flags. Labels are deduped and joined with " / ", so
 * a mixed-mode order (one pair we deliver, one pair the customer picks up)
 * renders as "Pickup / Delivery".
 *
 * Mapping:
 *   start: customer_collecting === true → "Pickup", else → "Delivery"
 *   end:   customer_returning  === true → "Return", else → "Pickup"
 *
 * Empty input returns empty strings.
 */
export function getDestinationsLegend(
  destinations: DestinationType[] | undefined | null,
): { start: string; end: string } {
  if (!destinations || destinations.length === 0) {
    return { start: "", end: "" };
  }

  const startSet = new Set<string>();
  const endSet = new Set<string>();
  for (const d of destinations) {
    startSet.add(d.customer_collecting ? "Pickup" : "Delivery");
    endSet.add(d.customer_returning ? "Return" : "Pickup");
  }

  return {
    start: Array.from(startSet).join(" / "),
    end: Array.from(endSet).join(" / "),
  };
}

/**
 * Compute default chargeable days from order dates and holidays.
 * Returns null if required dates are missing.
 */
export function getDefaultChargeDays(
  dates: OrderDatesType,
  holidays: string[],
): number | null {
  if (!dates?.delivery_start || !dates?.collection_start) return null;
  try {
    const duration = getDuration(dates, holidays);
    return duration?.chargeDays ?? null;
  } catch {
    return null;
  }
}

/**
 * Update chargeable_days on line items that still match the previous default.
 * Skips structural items, items without a price, and manual overrides.
 */
export function syncChargeDaysToItems(
  items: LineItem[],
  previousDefault: number | null,
  newDefault: number | null,
): void {
  if (previousDefault === newDefault) return;

  for (const item of items) {
    if (item.type === "destination" || item.type === "group") continue;
    if (!item.price) continue;
    const days = (item.price as PriceObject).chargeable_days;
    if (days === null || days === undefined) continue;
    if (previousDefault === null) continue;
    if (days !== previousDefault) continue;
    (item.price as PriceObject).chargeable_days = newDefault;
  }
}

// ── Per-destination date rollups ─────────────────────────────────

/**
 * Order-level date envelope derived on demand from per-destination dates.
 *
 * Mirrors the field set of the old top-level `order.dates`, except the `_fs`
 * companions are nullable: utilities can't mint a Firestore Timestamp, so each
 * boundary copies the `_fs` from whichever destination owns the extreme value
 * (and is null when no destination sets that boundary).
 */
export interface OrderDateEnvelope {
  delivery_start: string | null;
  delivery_start_fs: FirestoreTimestampType | null;
  delivery_end: string | null;
  delivery_end_fs: FirestoreTimestampType | null;
  collection_start: string | null;
  collection_start_fs: FirestoreTimestampType | null;
  collection_end: string | null;
  collection_end_fs: FirestoreTimestampType | null;
  charge_start: string | null;
  charge_start_fs: FirestoreTimestampType | null;
  charge_end: string | null;
  charge_end_fs: FirestoreTimestampType | null;
  days_active: number | null;
  days_charged: number | null;
}

/**
 * Pick the extreme (earliest for `"min"`, latest for `"max"`) value of one
 * date boundary across destinations, carrying along the `_fs` companion from
 * the owning destination. Instants are compared by epoch ms so mixed
 * CST/CDT offsets compare correctly. Returns nulls when no destination sets
 * the boundary.
 */
function pickEnvelopeBound(
  destinations: ReadonlyArray<Pick<DocDestinationType, "dates">>,
  isoKey: keyof OrderDocDatesType,
  fsKey: keyof OrderDocDatesType,
  dir: "min" | "max",
): { iso: string | null; fs: FirestoreTimestampType | null } {
  let bestT: number | null = null;
  let iso: string | null = null;
  let fs: FirestoreTimestampType | null = null;
  for (const d of destinations) {
    const value = d.dates?.[isoKey] as string | null | undefined;
    if (!value) continue;
    const t = new Date(value).getTime();
    if (Number.isNaN(t)) continue;
    if (bestT === null || (dir === "min" ? t < bestT : t > bestT)) {
      bestT = t;
      iso = value;
      fs = (d.dates[fsKey] as FirestoreTimestampType | undefined) ?? null;
    }
  }
  return { iso, fs };
}

/**
 * Collapse per-destination dates into one order-level envelope.
 *
 * There is no persisted order-level `dates` anymore — every destination owns
 * its own range. This derives a bounding envelope on demand for the consumers
 * that still want one order-level range: the Typesense projection's sort key
 * and the quote / Xero / Calendar / Trello exporters.
 *
 * `*_start` boundaries take the earliest value across destinations, `*_end`
 * boundaries take the latest; `days_active` / `days_charged` take the largest
 * non-null value. For a single-destination order the envelope equals that
 * destination's dates exactly.
 */
export function deriveOrderDateEnvelope(
  destinations: ReadonlyArray<Pick<DocDestinationType, "dates">>,
): OrderDateEnvelope {
  const ds = pickEnvelopeBound(destinations, "delivery_start", "delivery_start_fs", "min");
  const de = pickEnvelopeBound(destinations, "delivery_end", "delivery_end_fs", "max");
  const cs = pickEnvelopeBound(destinations, "collection_start", "collection_start_fs", "min");
  const ce = pickEnvelopeBound(destinations, "collection_end", "collection_end_fs", "max");
  const chs = pickEnvelopeBound(destinations, "charge_start", "charge_start_fs", "min");
  const che = pickEnvelopeBound(destinations, "charge_end", "charge_end_fs", "max");

  let days_active: number | null = null;
  let days_charged: number | null = null;
  for (const d of destinations) {
    if (d.dates?.days_active != null) {
      days_active = Math.max(days_active ?? 0, d.dates.days_active);
    }
    if (d.dates?.days_charged != null) {
      days_charged = Math.max(days_charged ?? 0, d.dates.days_charged);
    }
  }

  return {
    delivery_start: ds.iso, delivery_start_fs: ds.fs,
    delivery_end: de.iso, delivery_end_fs: de.fs,
    collection_start: cs.iso, collection_start_fs: cs.fs,
    collection_end: ce.iso, collection_end_fs: ce.fs,
    charge_start: chs.iso, charge_start_fs: chs.fs,
    charge_end: che.iso, charge_end_fs: che.fs,
    days_active,
    days_charged,
  };
}

/** Minimal destination shape consumed by {@link buildQueryByDates}. */
interface QueryByDatesDestination {
  dates: {
    delivery_start: string | null;
    delivery_end: string | null;
    collection_start: string | null;
    collection_end: string | null;
  };
}

/**
 * Deduped, ascending list of Chicago `YYYY-MM-DD` boundary days across every
 * destination's delivery + collection windows. Server-maintained on the order
 * (and fulfillment) doc as `query_by_dates`, reserved for exact-day Firestore
 * `array-contains` lookups. Charge dates are billing-only and excluded.
 */
export function buildQueryByDates(
  destinations: ReadonlyArray<QueryByDatesDestination>,
): string[] {
  const days = new Set<string>();
  for (const d of destinations) {
    for (
      const iso of [
        d.dates?.delivery_start,
        d.dates?.delivery_end,
        d.dates?.collection_start,
        d.dates?.collection_end,
      ]
    ) {
      if (iso) days.add(toChicagoYmd(iso));
    }
  }
  return [...days].sort();
}

// ── Type guards ──────────────────────────────────────────────────

/**
 * Determine whether a line item is priceable (has a price object, not a structural item).
 */
export function isPriceableItem(item: LineItem): item is PriceableLineItem {
  if (!item || typeof item !== "object") return false;
  if (item.type === "destination" || item.type === "group") return false;
  if (!item.price || typeof item.price !== "object") return false;
  return true;
}

/**
 * Determine whether a line item is a transaction fee.
 */
export function isTransactionFeeItem(item: LineItem): item is TransactionFeeLineItem {
  if (!item || typeof item !== "object") return false;
  if (item.type !== "transaction_fee") return false;
  if (!item.price || typeof item.price !== "object") return false;
  return true;
}

/**
 * Determine whether a line item participates in subtotal/discount/tax calculations.
 * Standalone predicate (not composed) because TS doesn't support negated predicates.
 */
export function isPreTaxItem(item: LineItem): item is PreTaxLineItem {
  if (!item || typeof item !== "object") return false;
  if (item.type === "destination" || item.type === "group" || item.type === "transaction_fee") return false;
  if (!item.price || typeof item.price !== "object") return false;
  return true;
}

// ── Days factor ──────────────────────────────────────────────────

/** @param formula - Pricing formula: `"five_day_week"` or `"fixed"`. */
function getDaysFactor(formula: "five_day_week" | "fixed", chargeable_days: number | null): number {
  if (formula === "five_day_week") {
    return (chargeable_days ?? 0) / 5;
  }
  if (formula === "fixed") {
    return 1;
  }
  throw new Error("Unknown formula: " + formula);
}

// ── Item-level calculations ──────────────────────────────────────

/**
 * Calculate the pre-discount and post-discount subtotals for a single line item.
 */
export function calculateItemSubtotal(
  item: LineItem,
): { subtotal: number; subtotal_discounted: number } {
  if (!isPreTaxItem(item)) {
    throw new Error(
      "Item is not priceable: missing price object or is a destination/group/transaction_fee",
    );
  }

  const { base = 0, formula, chargeable_days = null, discount } = item.price;
  const quantity = item.quantity;

  const daysFactor = getDaysFactor(formula, chargeable_days);
  const pricingFactor = Math.max(daysFactor, 1);

  const subtotal = currency(base)
    .multiply(quantity)
    .multiply(pricingFactor);

  if (!discount) {
    return { subtotal: subtotal.value, subtotal_discounted: subtotal.value };
  }

  let subtotal_discounted: currency;
  if (discount.type === "percent") {
    subtotal_discounted = subtotal.multiply((100 - discount.rate) / 100);
  } else {
    const discountAmount = currency(discount.rate)
      .multiply(quantity)
      .multiply(pricingFactor);
    subtotal_discounted = subtotal.subtract(discountAmount);
  }

  return { subtotal: subtotal.value, subtotal_discounted: subtotal_discounted.value };
}

/**
 * Calculate the discount dollar amount for a single line item.
 */
export function calculateItemDiscount(item: LineItem): number {
  const { subtotal, subtotal_discounted } = calculateItemSubtotal(item);
  return currency(subtotal).subtract(subtotal_discounted).value;
}

/**
 * Calculate tax amounts for a single line item from the Tax[] parameter.
 * Returns a PriceModifier[] with computed amounts.
 */
export function calculateItemTax(
  item: LineItem,
  taxes: Tax[],
): PriceModifier[] {
  if (!isPreTaxItem(item)) {
    throw new Error(
      "Item is not priceable: missing price object or is a destination/group/transaction_fee",
    );
  }

  const { subtotal_discounted } = calculateItemSubtotal(item);
  const quantity = item.quantity;

  return item.price.taxes.map((itemTax) => {
    const taxDoc = taxes.find((t) => t.uid === itemTax.uid);
    if (!taxDoc) {
      throw new Error("Unknown tax uid: " + itemTax.uid);
    }

    let amount: number;
    if (taxDoc.type === "percent") {
      amount = currency(subtotal_discounted).multiply(taxDoc.rate / 100).value;
    } else {
      amount = currency(taxDoc.rate).multiply(quantity).value;
    }

    return {
      uid: taxDoc.uid,
      name: taxDoc.name,
      rate: taxDoc.rate,
      type: taxDoc.type,
      amount,
    };
  });
}

/**
 * Calculate the complete price for a single line item.
 * Runs the full pipeline: subtotal → discount → taxes → total.
 */
export function calculateItemPrice(
  item: LineItem,
  taxes: Tax[],
): { subtotal: number; subtotal_discounted: number; discount: Discount | null; taxes: PriceModifier[]; total: number } {
  if (!isPreTaxItem(item)) {
    throw new Error(
      "Item is not priceable: missing price object or is a destination/group/transaction_fee",
    );
  }

  const { subtotal, subtotal_discounted } = calculateItemSubtotal(item);
  const itemTaxes = calculateItemTax(item, taxes);

  let taxSum = currency(0);
  for (const t of itemTaxes) {
    taxSum = taxSum.add(t.amount);
  }

  let discount: Discount | null = null;
  if (item.price.discount) {
    discount = {
      rate: item.price.discount.rate,
      type: item.price.discount.type,
      amount: currency(subtotal).subtract(subtotal_discounted).value,
    };
  }

  return {
    subtotal,
    subtotal_discounted,
    discount,
    taxes: itemTaxes,
    total: currency(subtotal_discounted).add(taxSum).value,
  };
}

/**
 * Calculate the total (subtotal_discounted + taxes) for a single line item.
 * Handles both PriceObject (regular items) and PriceModifier (transaction fee items).
 */
export function calculateItemTotal(
  item: LineItem,
  taxes: Tax[],
): number {
  if (!isPriceableItem(item)) {
    throw new Error(
      "Item is not priceable: missing price object or is a destination/group",
    );
  }

  if (isTransactionFeeItem(item)) {
    return item.price.amount;
  }

  const { total } = calculateItemPrice(item, taxes);
  return total;
}

// ── Aggregation functions ────────────────────────────────────────

/**
 * Calculate the total discount amount across all pre-tax items.
 */
export function getTotalDiscount(items: LineItem[]): number {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }

  let total = currency(0);
  for (const item of items) {
    if (!isPreTaxItem(item)) continue;
    total = total.add(calculateItemDiscount(item));
  }

  return total.value;
}

/**
 * Aggregate tax PriceModifiers by name across all pre-tax items.
 */
export function getTaxTotals(
  items: LineItem[],
  taxes: Tax[],
): PriceModifier[] {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }

  const totals: Record<string, { uid: string; rate: number; type: "percent" | "flat"; amount: currency }> = {};

  for (const item of items) {
    if (!isPreTaxItem(item)) continue;

    const itemTaxes = calculateItemTax(item, taxes);
    for (const tax of itemTaxes) {
      if (tax.amount === 0) continue;

      if (!totals[tax.name]) {
        totals[tax.name] = { uid: tax.uid, rate: tax.rate, type: tax.type, amount: currency(0) };
      }
      totals[tax.name].amount = totals[tax.name].amount.add(tax.amount);
    }
  }

  return Object.entries(totals).map(([name, { uid, rate, type, amount }]) => ({
    uid, name, rate, type, amount: amount.value,
  }));
}

/**
 * Aggregate transaction fee PriceModifiers across all fee items.
 */
export function getTransactionFeeTotals(items: LineItem[]): PriceModifier[] {
  const totals: Record<string, { uid: string; rate: number; type: "percent" | "flat"; amount: currency }> = {};

  for (const item of items) {
    if (!isTransactionFeeItem(item)) continue;

    if (item.price.amount === 0) continue;

    if (!totals[item.price.name]) {
      totals[item.price.name] = { uid: item.price.uid, rate: item.price.rate, type: item.price.type, amount: currency(0) };
    }
    totals[item.price.name].amount = totals[item.price.name].amount.add(item.price.amount);
  }

  return Object.entries(totals).map(([name, { uid, rate, type, amount }]) => ({
    uid, name, rate, type, amount: amount.value,
  }));
}

/**
 * Calculate aggregated pricing totals for an entire order.
 * Owns the two-pass computation: pre-tax items first, then transaction fees.
 */
export function calculateOrderTotals(
  items: LineItem[],
  taxes: Tax[],
): OrderTotals {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }

  // Pass 1: compute subtotals from pre-tax items
  let subtotal = currency(0);
  let subtotal_discounted = currency(0);

  for (const item of items) {
    if (!isPreTaxItem(item)) continue;
    const result = calculateItemSubtotal(item);
    subtotal = subtotal.add(result.subtotal);
    subtotal_discounted = subtotal_discounted.add(result.subtotal_discounted);
  }

  const discount_amount = getTotalDiscount(items);
  const taxTotals = getTaxTotals(items, taxes);

  let taxSum = currency(0);
  for (const entry of taxTotals) {
    taxSum = taxSum.add(entry.amount);
  }

  // Pass 2: compute transaction fee amounts
  const feeItems: LineItem[] = [];
  for (const item of items) {
    if (!isTransactionFeeItem(item)) continue;

    let amount: number;
    if (item.price.type === "percent") {
      amount = currency(subtotal_discounted).multiply(item.price.rate / 100).value;
    } else {
      amount = currency(item.price.rate).multiply(item.quantity).value;
    }

    feeItems.push({
      ...item,
      price: { ...item.price, amount },
    });
  }

  const transaction_fees = getTransactionFeeTotals(feeItems);

  let feeSum = currency(0);
  for (const entry of transaction_fees) {
    feeSum = feeSum.add(entry.amount);
  }

  const replacement = calculateReplacementTotals(items, taxes);

  return {
    discount_amount,
    subtotal: subtotal.value,
    subtotal_discounted: subtotal_discounted.value,
    taxes: taxTotals,
    transaction_fees,
    total: currency(subtotal_discounted).add(taxSum).add(feeSum).value,
    replacement_total: replacement.total,
  };
}

// ── Order inspection helpers ─────────────────────────────────────

/** Check whether any line item is a rental. */
export function orderHasRentals(items: LineItem[]): boolean {
  if (!Array.isArray(items)) throw new Error("items must be an array");
  return items.some((item) => item.type === "rental");
}

/** Check whether any pre-tax line item has a discount. */
export function orderHasDiscount(items: LineItem[]): boolean {
  if (!Array.isArray(items)) throw new Error("items must be an array");
  return items.some((item) =>
    isPreTaxItem(item) && item.price.discount !== null
  );
}

/** Check whether any pre-tax line item has taxes applied. */
export function orderHasTax(items: LineItem[]): boolean {
  if (!Array.isArray(items)) throw new Error("items must be an array");
  return items.some((item) =>
    isPreTaxItem(item) && item.price.taxes.length > 0
  );
}

// ── Replacement totals ──────────────────────────────────────────

/** Replacement cost totals for an order, with and without tax. */
export interface ReplacementTotals {
  subtotal: number;
  tax: number;
  total: number;
}

/**
 * Calculate the total replacement cost across all pre-tax items that have
 * a replacement value on their price object.
 *
 * Returns `subtotal` (sum of replacement × quantity), `tax` (taxes applied
 * to that subtotal), and `total` (subtotal + tax).
 */
export function calculateReplacementTotals(
  items: LineItem[],
  taxes: Tax[],
): ReplacementTotals {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }

  let subtotal = currency(0);
  let taxTotal = currency(0);

  for (const item of items) {
    if (!isPreTaxItem(item)) continue;

    if (item.price.replacement == null) continue;

    const quantity = item.quantity;
    const itemReplacementSubtotal = currency(item.price.replacement).multiply(quantity);
    subtotal = subtotal.add(itemReplacementSubtotal);

    for (const itemTax of item.price.taxes) {
      const taxDoc = taxes.find((t) => t.uid === itemTax.uid);
      if (!taxDoc) continue;

      if (taxDoc.type === "percent") {
        taxTotal = taxTotal.add(
          itemReplacementSubtotal.multiply(taxDoc.rate / 100),
        );
      } else {
        taxTotal = taxTotal.add(currency(taxDoc.rate).multiply(quantity));
      }
    }
  }

  return {
    subtotal: subtotal.value,
    tax: taxTotal.value,
    total: subtotal.add(taxTotal).value,
  };
}

// ── Path computation ──────────────────────────────────────────────

/**
 * Build a set of structural item uids (dest/group) from items array.
 * Used to distinguish structural path elements from product parent refs.
 */
export function getStructuralUids(items: LineItem[]): Set<string> {
  return new Set(
    items.filter((i) => i.type === "destination" || i.type === "group").map((i) => i.uid),
  );
}

/**
 * Get the parent product uid from an item's path.
 * Returns null for non-components (where path.at(-2) is a structural uid or absent).
 */
export function getParentProductUid(item: LineItem, structuralUids: Set<string>): string | null {
  const secondToLast = item.path?.at(-2);
  if (!secondToLast) return null;
  if (structuralUids.has(secondToLast)) return null;
  return secondToLast;
}

/**
 * Return the contiguous index range covering an item and every descendant of it,
 * derived purely from `path` (not from item types or adjacency rules).
 *
 * `computeItemPaths` lays items out depth-first, so descendants of `items[index]`
 * are always contiguous starting at `index + 1` and run until the first item
 * whose path does not start with `items[index].path`.
 *
 * Generic over any `{ path: string[] }` so it works on order line items, invoice
 * line items (whose paths are scoped by an order divider uid), and any other
 * path-keyed flat array.
 */
export function getItemSubtreeRange<T extends { path: string[] }>(
  items: T[],
  index: number,
): { startIndex: number; endIndex: number } {
  const prefix = items[index].path;
  let endIndex = index;
  for (let i = index + 1; i < items.length; i++) {
    const p = items[i].path;
    if (p.length < prefix.length) break;
    let matches = true;
    for (let j = 0; j < prefix.length; j++) {
      if (p[j] !== prefix[j]) { matches = false; break; }
    }
    if (!matches) break;
    endIndex = i;
  }
  return { startIndex: index, endIndex };
}

/**
 * A single path mismatch reported by {@link validateItemPaths} or
 * {@link validateInvoiceItemPaths} (re-exported from `@cfs/utilities/invoices`).
 */
export interface ItemPathIssue {
  /** Index of the offending item in the input array. */
  index: number;
  /** The item's `uid` (or `undefined` if missing). */
  uid: string | undefined;
  /** The path that was actually persisted on the item. */
  path: string[];
  /** The path that {@link computeItemPaths} would produce for this item. */
  expected: string[];
}

/**
 * Assert every line item's `path` matches what {@link computeItemPaths} would
 * produce — i.e. structural prefix + component ancestry + self uid, with no
 * stale dest/group uids from prior drag positions.
 *
 * Use as a defensive write-time invariant: any client (manager, webhook
 * handlers, manual firestore_admin pokes) that writes orders should pipe
 * `items` through `computeItemPaths` first, so a non-empty result here means
 * the client skipped the recompute step.
 *
 * Reports per-index mismatches; under the depth-first contiguity invariant,
 * an index whose `uid` doesn't match the recomputed array's uid at the same
 * index is also a violation (the array needs re-linearization). The original
 * path is reported so the caller can diff against `expected`.
 *
 * Returns `[]` when every path is clean and order is canonical.
 */
export function validateItemPaths<T extends LineItem>(items: T[]): ItemPathIssue[] {
  const recomputed = computeItemPaths(items);
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
 * A single uniqueness violation reported by {@link validateItemUniqueness}
 * (and the invoice-scoped variant in `@cfs/utilities/invoices`).
 */
export interface ItemUniquenessIssue {
  /** Index of the second (offending) occurrence in the array. */
  index: number;
  /** The duplicated item's `uid`. */
  uid: string;
  /**
   * Uid of the immediate structural parent (group, destination, or order
   * divider) or — for components — the parent product line. `null` when the
   * item is at the top level with no enclosing structural item.
   */
  parentUid: string | null;
  /** Index of the first occurrence sharing the same `(parentUid, uid)`. */
  firstIndex: number;
}

/**
 * Assert that within each items array, no two entries share the same `uid`
 * AND the same immediate structural parent. The immediate structural parent
 * is the second-to-last `path` segment (or `null` for items whose path is
 * just `[self.uid]`).
 *
 * This is the uniqueness invariant orders/invoices rely on so that path-based
 * line identity is unambiguous. Violations indicate a duplicate that should
 * be merged — `mergeStagedIntoOrder` and the migration script consolidate.
 *
 * Returns `[]` when uniqueness holds.
 */
export function validateItemUniqueness<T extends LineItem>(items: T[]): ItemUniquenessIssue[] {
  const seen = new Map<string, number>();
  const issues: ItemUniquenessIssue[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const path = item.path ?? [];
    const parentUid = path.length >= 2 ? path[path.length - 2] : null;
    const key = (parentUid ?? "\0root") + "\0" + item.uid;
    const firstIndex = seen.get(key);
    if (firstIndex !== undefined) {
      issues.push({ index: i, uid: item.uid, parentUid, firstIndex });
    } else {
      seen.set(key, i);
    }
  }
  return issues;
}

/**
 * Compute full structural paths for a flat items array AND linearize it
 * depth-first with `zero_priced` items sorted before priced ones inside each
 * parent's direct-children block.
 *
 * Each item's path = [structural context...] + [component ancestry...] + [self uid].
 *
 * Client-sent paths carry component ancestry (from ProductComponent.path).
 * This function prepends structural context (dest/group) and appends self uid.
 *
 * Three transforms in order:
 *  1. Recompute every item's `path`. Strip ALL structural uids (every dest +
 *     group currently in the array) and the item's own uid from the
 *     client-supplied path; also strip orphan ancestor uids — segments that
 *     don't resolve to any item in the array (e.g. catalog-only intermediate
 *     kit uids that were never materialized). Then prepend the structural
 *     prefix and append the item's own uid.
 *  2. Linearize line items inside each (destination, group) block as a tree:
 *     each parent product is followed by its full subtree before the next
 *     sibling. Destination and group dividers stay where they are; only the
 *     line items between them are reordered.
 *  3. Within each parent's direct-children, stable-sort `zero_priced === true`
 *     before others. Drag-drop reorders preserve intra-band order.
 *
 * Pure: returns a fresh array of fresh items. Inputs are not mutated, so it is
 * safe to pass items that originate from a Solid store proxy (the manager app
 * routes reordered arrays through this function inside `setEntity` updaters).
 * Callers should replace their working array with the return value.
 *
 * Post-condition (under the within-parent uniqueness invariant): a parent and
 * its full subtree occupy a contiguous index range, so `getItemSubtreeRange`
 * and `getGroupItems` can rely on path-prefix matching alone.
 */
export function computeItemPaths<T extends LineItem>(items: T[]): T[] {
  const structuralUids = getStructuralUids(items);
  const allItemUids = new Set(items.map((i) => i.uid));

  // Pass 1: recompute paths.
  let currentDestUid: string | null = null;
  let currentGroupUid: string | null = null;
  const withPaths: T[] = items.map((item) => {
    if (item.type === "destination") {
      currentDestUid = item.uid;
      currentGroupUid = null;
      return { ...item, path: [item.uid] };
    }
    if (item.type === "group") {
      currentGroupUid = item.uid;
      return { ...item, path: currentDestUid ? [currentDestUid, item.uid] : [item.uid] };
    }
    const prefix: string[] = [];
    if (currentDestUid) prefix.push(currentDestUid);
    if (currentGroupUid) prefix.push(currentGroupUid);
    const clientPath = (item.path ?? []).filter(
      (seg) => !structuralUids.has(seg) && seg !== item.uid && allItemUids.has(seg),
    );
    return { ...item, path: [...prefix, ...clientPath, item.uid] };
  });

  // Pass 2 + 3: linearize each contiguous line-item block as a tree, with
  // zero-priced-first sorting per parent.
  const result: T[] = [];
  let i = 0;
  while (i < withPaths.length) {
    const item = withPaths[i];
    if (item.type === "destination" || item.type === "group") {
      result.push(item);
      i++;
      continue;
    }
    let j = i;
    while (j < withPaths.length && withPaths[j].type !== "destination" && withPaths[j].type !== "group") {
      j++;
    }
    const block = withPaths.slice(i, j);
    result.push(...linearizeBlockDepthFirst(block, structuralUids));
    i = j;
  }
  return result;
}

/**
 * Tree-linearize a contiguous run of line items inside a single
 * (destination, group) block. Items whose direct parent (the second-to-last
 * path segment after structural stripping) is another line item in the same
 * block are emitted immediately after that parent's emission; otherwise they
 * are emitted at the top level of the block. Each parent's direct-children
 * block is stable-sorted with `zero_priced === true` first.
 *
 * Robust to duplicates: each input item appears in the output exactly once.
 * If two parents share a uid (a same-product duplicate that should have been
 * consolidated), all children attach to the first parent in the input order;
 * the second parent emits as a leaf. This is a graceful-degradation path —
 * the within-parent uniqueness invariant rules out the case in steady state.
 */
function linearizeBlockDepthFirst<T extends LineItem>(block: T[], structuralUids: Set<string>): T[] {
  if (block.length <= 1) return block.slice();

  const blockUids = new Set(block.map((i) => i.uid));
  const ROOT = "\0root";

  const childrenByParent = new Map<string, T[]>();
  for (const item of block) {
    const parentUid = item.path.at(-2);
    const key = parentUid && blockUids.has(parentUid) && !structuralUids.has(parentUid)
      ? parentUid
      : ROOT;
    let bucket = childrenByParent.get(key);
    if (!bucket) {
      bucket = [];
      childrenByParent.set(key, bucket);
    }
    bucket.push(item);
  }

  // Stable sort each parent's children: zero-priced first.
  for (const bucket of childrenByParent.values()) {
    bucket.sort((a, b) => {
      const az = a.zero_priced === true ? 0 : 1;
      const bz = b.zero_priced === true ? 0 : 1;
      return az - bz;
    });
  }

  const result: T[] = [];
  const emitted = new Set<T>();
  function emitChildren(parentKey: string) {
    const bucket = childrenByParent.get(parentKey);
    if (!bucket) return;
    for (const child of bucket) {
      if (emitted.has(child)) continue;
      emitted.add(child);
      result.push(child);
      emitChildren(child.uid);
    }
  }
  emitChildren(ROOT);

  // Catch any items whose parent uid resolved to a non-emitted bucket —
  // append them at the end so no item is dropped.
  if (emitted.size < block.length) {
    for (const item of block) {
      if (!emitted.has(item)) {
        emitted.add(item);
        result.push(item);
      }
    }
  }

  return result;
}

// ── Item consolidation and destination grouping ──────────────────

const NON_PRODUCT_TYPES = new Set(["destination", "group", "surcharge", "transaction_fee"]);
const PACKING_LIST_ITEM_TYPES = new Set(["rental", "sale"]);
const DELIVERY_TYPES = new Set(["rental", "sale"]);
const COLLECTION_TYPES = new Set(["rental"]);

/**
 * Walk backwards from `index` to determine which destination and group
 * an item belongs to. `destination` is the destination's `uid_delivery`;
 * `group` is the group item's `uid` (not its display name) — keying on
 * uid lets group display names be edited without losing collapse state
 * or risking collisions between two groups that happen to share a name.
 */
export function getGroupPath(items: LineItem[], index: number): GroupPath {
  const item = items[index];
  const structuralUids = getStructuralUids(items);
  const result: GroupPath = {
    destination: null,
    group: null,
    product: getParentProductUid(item, structuralUids),
  };

  for (let i = index - 1; i >= 0; i--) {
    const entry = items[i];
    if (entry.type === "group" && result.group === null) {
      result.group = entry.uid ?? null;
    }
    if (entry.type === "destination") {
      result.destination = entry.uid_delivery ?? null;
      break;
    }
  }

  return result;
}

/**
 * Deduplicate line items by product UID and sum quantities.
 */
export function consolidateItems(lineItems: LineItem[]): ConsolidatedItem[] {
  if (!Array.isArray(lineItems)) {
    throw new Error("lineItems must be an array");
  }

  const map: Record<
    string,
    {
      uid: string;
      name: string;
      type: string;
      quantity: number;
      total_price: currency;
      stock_method: string;
    }
  > = {};

  for (const item of lineItems) {
    if (NON_PRODUCT_TYPES.has(item.type)) continue;
    if (!item.uid) continue;

    const total = item.price && "total" in item.price ? (item.price.total || 0) : 0;

    if (map[item.uid]) {
      map[item.uid].quantity += item.quantity || 0;
      map[item.uid].total_price = map[item.uid].total_price.add(total);
    } else {
      map[item.uid] = {
        uid: item.uid,
        name: item.name || "",
        type: item.type || "",
        quantity: item.quantity || 0,
        total_price: currency(total),
        stock_method: item.stock_method || "none",
      };
    }
  }

  return Object.values(map).map((entry) => ({
    uid: entry.uid,
    name: entry.name,
    type: entry.type,
    quantity: entry.quantity,
    total_price: entry.total_price.value,
    unit_price: entry.quantity > 0
      ? currency(entry.total_price).divide(entry.quantity).value
      : 0,
    stock_method: entry.stock_method,
  }));
}

/** A destination section with its delivery/collection UIDs and child items. */
export interface DestinationGroup {
  uid_delivery: string;
  uid_collection: string;
  items: LineItem[];
  packing_list_delivery: LineItem[];
  packing_list_collection: LineItem[];
}

/**
 * Slice the flat items array into destination sections.
 */
export function groupByDestination(
  items: LineItem[],
  fallbackDeliveryUid: string,
  fallbackCollectionUid?: string,
): DestinationGroup[] {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }

  const collectionFallback = fallbackCollectionUid || fallbackDeliveryUid;

  const groups: DestinationGroup[] = [];
  let current: DestinationGroup | null = null;

  for (const item of items) {
    if (item.type === "destination") {
      if (current) groups.push(current);
      current = {
        uid_delivery: item.uid_delivery || fallbackDeliveryUid,
        uid_collection: item.uid_collection || collectionFallback,
        items: [],
        packing_list_delivery: [],
        packing_list_collection: [],
      };
      continue;
    }

    if (!current) {
      current = {
        uid_delivery: fallbackDeliveryUid,
        uid_collection: collectionFallback,
        items: [],
        packing_list_delivery: [],
        packing_list_collection: [],
      };
    }

    current.items.push(item);

    if (DELIVERY_TYPES.has(item.type) && item.uid) {
      current.packing_list_delivery.push(item);
    }
    if (COLLECTION_TYPES.has(item.type) && item.uid) {
      current.packing_list_collection.push(item);
    }
  }

  if (current) groups.push(current);

  if (groups.length === 0) {
    return [{
      uid_delivery: fallbackDeliveryUid,
      uid_collection: collectionFallback,
      items: [],
      packing_list_delivery: [],
      packing_list_collection: [],
    }];
  }

  return groups;
}

/**
 * Collect the child product items belonging to a collapsible section.
 *
 * Destination / group: walk forward to the next divider of the same or
 * outer level, collecting every line item.
 *
 * Product: walk only its own contiguous subtree (via `getItemSubtreeRange`)
 * and return the immediate children (`path.at(-2) === item.uid`). Under the
 * within-parent uniqueness invariant, `path.at(-2) === uid` is unambiguous
 * inside the subtree; constraining to the subtree range protects against
 * accidental cross-parent collisions if an upstream invariant violation
 * slips through.
 */
export function getGroupItems(items: LineItem[], index: number): LineItem[] {
  if (!Array.isArray(items) || index < 0 || index >= items.length) return [];

  const item = items[index];

  if (item.type === "destination") {
    const result: LineItem[] = [];
    for (let i = index + 1; i < items.length; i++) {
      if (items[i].type === "destination") break;
      if (items[i].type === "group") continue;
      result.push(items[i]);
    }
    return result;
  }

  if (item.type === "group") {
    const result: LineItem[] = [];
    for (let i = index + 1; i < items.length; i++) {
      if (items[i].type === "group" || items[i].type === "destination") break;
      result.push(items[i]);
    }
    return result;
  }

  const range = getItemSubtreeRange(items, index);
  const result: LineItem[] = [];
  for (let i = range.startIndex + 1; i <= range.endIndex; i++) {
    if (items[i].path.at(-2) === item.uid) result.push(items[i]);
  }
  return result;
}

/**
 * Collect the indices of all items that should be removed when the item
 * at `index` is deleted — the item itself plus all its descendants.
 * Returns indices sorted ascending.
 */
export function getRemovalIndices(items: LineItem[], index: number): number[] {
  if (!Array.isArray(items) || index < 0 || index >= items.length) return [];

  const item = items[index];

  // Destination: self + everything until the next destination
  if (item.type === "destination") {
    const indices = [index];
    for (let i = index + 1; i < items.length; i++) {
      if (items[i].type === "destination") break;
      indices.push(i);
    }
    return indices;
  }

  // Group: self + everything until the next group or destination
  if (item.type === "group") {
    const indices = [index];
    for (let i = index + 1; i < items.length; i++) {
      if (items[i].type === "group" || items[i].type === "destination") break;
      indices.push(i);
    }
    return indices;
  }

  // Product: self + descendants. Under the depth-first contiguity invariant,
  // a product's full subtree is the contiguous range from `index` to the last
  // item whose path extends this item's path.
  const range = getItemSubtreeRange(items, index);
  const result: number[] = [];
  for (let i = range.startIndex; i <= range.endIndex; i++) result.push(i);
  return result;
}

/** Count and pricing totals for a collapsed destination or group section. */
export interface GroupTotalsResult {
  count: number;
  subtotal: number;
  subtotal_discounted: number;
  total: number;
}

/**
 * Get count and pricing totals for a collapsed section.
 */
export function getGroupTotals(
  items: LineItem[],
  index: number,
  taxes: Tax[],
): GroupTotalsResult {
  const children = getGroupItems(items, index);
  if (children.length === 0) return { count: 0, subtotal: 0, subtotal_discounted: 0, total: 0 };

  const { subtotal, subtotal_discounted, total } = calculateOrderTotals(children, taxes);
  return { count: children.length, subtotal, subtotal_discounted, total };
}

/** An expanded packing list entry preserving group context. */
export interface PackingListItem {
  uid: string;
  name: string;
  type: string;
  quantity: number;
  stock_method: string;
  group_name: string | null;
}

/**
 * Build a packing list from order line items.
 *
 * When `consolidated` is true, deduplicates by product UID and sums quantities
 * (delegates to {@link consolidateItems}). When false (default), returns
 * expanded entries with `group_name` preserved.
 *
 * Pass `destinationUid` to scope to a single destination; omit for the full order.
 *
 * Excludes structural rows, surcharges, transaction fees, and services.
 */
export function buildPackingList(
  items: LineItem[],
  consolidated?: boolean,
  destinationUid?: string,
): PackingListItem[] | ConsolidatedItem[] {
  if (!Array.isArray(items)) {
    throw new Error("items must be an array");
  }

  // Scope to destination if requested
  let scoped: LineItem[];
  if (destinationUid) {
    scoped = [];
    let inDestination = false;
    for (const item of items) {
      if (item.type === "destination") {
        inDestination = item.uid_delivery === destinationUid ||
          item.uid_collection === destinationUid;
        continue;
      }
      if (inDestination) scoped.push(item);
    }
  } else {
    scoped = items;
  }

  // Filter to packing-list-eligible items
  const filtered = scoped.filter(
    (item) => item.uid && PACKING_LIST_ITEM_TYPES.has(item.type),
  );

  if (consolidated) {
    return consolidateItems(filtered);
  }

  // Expanded: walk the scoped array to track current group name
  const result: PackingListItem[] = [];
  let currentGroup: string | null = null;

  for (const item of scoped) {
    if (item.type === "group") {
      currentGroup = item.name ?? null;
      continue;
    }
    if (item.type === "destination") {
      currentGroup = null;
      continue;
    }
    if (!item.uid || !PACKING_LIST_ITEM_TYPES.has(item.type)) continue;

    result.push({
      uid: item.uid,
      name: item.name || "",
      type: item.type || "",
      quantity: item.quantity || 0,
      stock_method: item.stock_method || "none",
      group_name: currentGroup,
    });
  }

  return result;
}
