/**
 * Shared invoice utility functions for CFS applications.
 * Re-exports generic item helpers from orders and adds invoice-specific utilities.
 *
 * ```ts
 * import { flattenForXero, isPriceableItem, syncOrderItems } from "@cfs/utilities/invoices";
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
  isTransactionFeeItem,
  type ItemPathIssue,
  type ItemUniquenessIssue,
  type LineItem,
  type PriceModifier,
  type PriceObject,
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
import type { COARevenueType, DocDestinationType, DocLineItemTypeType, InvoiceDocItemPrice, InvoiceDocTotals, PriceFormulaType, PriceModifierType } from "@cfs/schemas";
import {
  calculateItemSubtotal,
  computeItemPaths,
  getTotalDiscount,
  getTaxTotals,
  getTransactionFeeTotals,
  isPreTaxItem,
  isTransactionFeeItem,
  type ItemPathIssue,
  type ItemUniquenessIssue,
  type LineItem,
  type PriceObject,
  type Tax,
  validateItemUniqueness,
} from "./orders.ts";

// ── Structural helpers ──────────────────────────────────────────

/** Structural item types that are not billable. */
const STRUCTURAL_TYPES = new Set(["destination", "group", "order"]);

/**
 * Filter out structural items (group/destination/order dividers) and return only
 * billable line items suitable for Xero sync or totals calculation.
 */
export function flattenForXero(items: LineItem[]): LineItem[] {
  return items.filter((item) => !STRUCTURAL_TYPES.has(item.type));
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
  price?: PriceObject | PriceModifierType | InvoiceDocItemPrice;
  coa_revenue?: COARevenueType | null;
  tracking_category?: string | null;
  xero_id?: string | null;
  xero_tracking_option_id?: string | null;
  crms_id?: number | string | null;
}

// ── Invoice totals ──────────────────────────────────────────────

/** @see {@link InvoiceDocTotals} from `@cfs/schemas` */
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
 * @param payments - Optional payments array for amount_paid/amount_due
 */
export function calculateInvoiceTotals(
  items: InvoiceItem[],
  taxes: Tax[],
  payments?: { amount: number; status: string }[],
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
  const feeItems: LineItem[] = [];
  for (const item of billable) {
    if (!isTransactionFeeItem(item)) continue;

    let amount: number;
    if (item.price.type === "percent") {
      amount = currency(subtotal_discounted).multiply(item.price.rate / 100).value;
    } else {
      amount = currency(item.price.rate).multiply(item.quantity).value;
    }

    feeItems.push({ ...item, price: { ...item.price, amount } });
  }

  const transaction_fees = getTransactionFeeTotals(feeItems);

  let feeSum = currency(0);
  for (const entry of transaction_fees) {
    feeSum = feeSum.add(entry.amount);
  }

  const total = currency(subtotal_discounted).add(taxSum).add(feeSum).value;

  // Payment accounting
  const { amount_paid, amount_due } = recomputePaymentTotals(total, payments ?? []);

  return {
    discount_amount,
    subtotal: subtotal.value,
    subtotal_discounted: subtotal_discounted.value,
    taxes: taxTotals,
    transaction_fees,
    total,
    amount_paid,
    amount_due,
  };
}

// ── Payment helpers ─────────────────────────────────────────────

/**
 * Derive invoice status from payment amounts.
 * Pure function — does not mutate the invoice.
 *
 * @param currentStatus - Current invoice status
 * @param amountPaid - Total amount paid
 * @param amountDue - Total amount still due
 * @returns The derived status
 */
export function derivePaymentStatus(
  currentStatus: string,
  amountPaid: number,
  amountDue: number,
): string {
  if (currentStatus === "draft" || currentStatus === "void") return currentStatus;
  if (currency(amountDue).value <= 0) return "paid";
  if (currency(amountPaid).value > 0) return "part_paid";
  return "issued";
}

/**
 * Compute amount_paid and amount_due from a payments array.
 * Pure function — returns values instead of mutating.
 *
 * @param total - Invoice total amount
 * @param payments - Payments array with amount and status fields
 * @returns Computed amount_paid and amount_due
 */
export function recomputePaymentTotals(
  total: number,
  payments: { amount: number; status: string }[],
): { amount_paid: number; amount_due: number } {
  let amountPaid = currency(0);
  for (const p of payments) {
    if (p.status === "active") {
      amountPaid = amountPaid.add(p.amount);
    }
  }
  return {
    amount_paid: amountPaid.value,
    amount_due: currency(total).subtract(amountPaid).value,
  };
}

// ── Xero helpers ────────────────────────────────────────────────

/**
 * Compute the Xero unit amount from subtotal and quantity.
 * Bakes duration (chargeable_days × formula) into per-unit price,
 * since Xero has no concept of rental duration.
 *
 * @param subtotal - Pre-discount subtotal (base × days × formula × quantity)
 * @param quantity - Item quantity
 * @returns Per-unit amount for Xero, or 0 if quantity is 0
 */
export function getXeroUnitAmount(subtotal: number, quantity: number): number {
  if (!quantity) return 0;
  return currency(subtotal).divide(quantity).value;
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
 * Mirrors the hand-picked mapping in `api-cloudrun/src/services/invoices.ts`
 * (`createInvoice`) so sync output is shape-consistent with create output.
 */
function projectOrderItemToInvoiceItem(item: LineItem, orderDividerUid: string): InvoiceItem {
  const basePath = item.path ?? [];
  const path = [orderDividerUid, ...basePath];

  if (item.type === "destination") {
    return {
      uid: item.uid,
      type: "destination",
      name: item.name,
      description: item.description ?? "",
      uid_delivery: item.uid_delivery ?? null,
      uid_collection: item.uid_collection ?? null,
      path,
    } as InvoiceItem;
  }
  if (item.type === "group") {
    return {
      uid: item.uid,
      type: "group",
      name: item.name,
      description: item.description ?? "",
      path,
    } as InvoiceItem;
  }

  const p = (item.price ?? {}) as Partial<InvoiceDocItemPrice>;
  return {
    uid: item.uid,
    type: item.type as DocLineItemTypeType,
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
  } as InvoiceItem;
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
 * Compute paths for all invoice items, respecting order divider scoping.
 * Wraps computeItemPaths — strips divider prefix per scope, delegates
 * to the shared order path logic, then re-adds the prefix.
 *
 * Pure: returns a fresh array of fresh items. Inputs are not mutated, so it is
 * safe to pass items that originate from a Solid store proxy. Callers should
 * replace their working array with the return value.
 */
export function computeInvoiceItemPaths(items: InvoiceItem[]): InvoiceItem[] {
  const out: InvoiceItem[] = new Array(items.length);
  let currentDividerUid: string | null = null;
  let scopeStart = -1;

  function flushScope(endExclusive: number) {
    if (!currentDividerUid || scopeStart < 0) return;
    const stripped = items.slice(scopeStart, endExclusive).map((si) => ({
      ...si,
      path: stripOrderPrefix(si.path, currentDividerUid as string),
    }));
    const computed = computeItemPaths(stripped as unknown as LineItem[]) as unknown as InvoiceItem[];
    for (let j = 0; j < computed.length; j++) {
      const si = computed[j];
      out[scopeStart + j] = { ...si, path: [currentDividerUid as string, ...si.path] };
    }
  }

  for (let i = 0; i <= items.length; i++) {
    const item = i < items.length ? items[i] : null;
    const isNewScope = !item || item.type === "order";

    if (isNewScope) flushScope(i);

    if (item?.type === "order") {
      currentDividerUid = item.uid;
      out[i] = { ...item, path: [item.uid] };
      scopeStart = i + 1;
    }
  }

  // Items outside any order scope (before the first divider) carry through
  // unchanged — preserves prior semantics for invoices without dividers.
  for (let i = 0; i < items.length; i++) {
    if (out[i] === undefined) out[i] = items[i];
  }

  return out;
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
  const recomputed = computeInvoiceItemPaths(items as unknown as InvoiceItem[]);
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
  return validateItemUniqueness(items as unknown as LineItem[]);
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
export function getOrderScopedItems(items: InvoiceItem[], orderDividerUid: string): InvoiceItem[] {
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
export function removeOrderScopedItems(items: InvoiceItem[], orderDividerUid: string): InvoiceItem[] {
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

// ── Top-level field co-write helpers ────────────────────────────

/**
 * Invoice-side destination pair — matches the schemas-next
 * `InvoiceDocDestinationType` (a `DocDestinationType` plus a `uid_order`
 * scope field). Defined structurally here so this module can be published
 * ahead of / alongside the schemas-next beta that adds the type.
 */
export interface InvoiceDestinationPair extends DocDestinationType {
  uid_order: string;
}

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
