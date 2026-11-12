/**
 * Purchase helpers — the cumulative share that prices every receipt and every
 * pushed bill line, the per-line headroom, and the status rule.
 *
 * Design: api-cloudrun#1210.
 *
 * @module
 */
import {
  type PurchaseSaleItem,
  type PurchaseSaleItemInputType,
  deriveQueryByItemTypes,
  deriveQueryByOrders,
  deriveQueryByProducts,
  deriveQueryByUnits,
  type ProductTypeType,
  purchaseItemCommittedCents,
  purchaseItemProduct,
  payableInputUidIssue,
  payableLineUid,
  payableLineUidIssue,
  type PayableLineUidFields,
  type PurchaseRowInputType,
  type PurchaseLandedCost,
  type StockMethodType,
  type PurchaseRentalItemInputType,
  purchaseItemBasis,
  type PurchaseItem,
  isPurchaseLine,
} from "../schemas/mod.ts";
import { apportionCents, roundDivHalfUp, toCentsBig } from "./money.ts";
import { type FormulaDiscount, priceFromFormula } from "../schemas/_line-money.ts";
import { componentQuantities, type ComponentRowForWalk } from "./order-lines.ts";
import { productCountsStock } from "./products.ts";
import { derivePurchaseCreditStatus, recomputePurchaseBillTotals } from "./invoices.ts";
import {
  custodyBySourceItem,
  derivePurchaseStatus,
  lineCustodyAt,
  NO_LINE_CUSTODY,
  type PurchaseLineCustody,
} from "./bookings-inbound.ts";

// The payable settlement folds live beside their receivable twins in
// `utils/invoices.ts`, which owns the one fold, and the custody-only status
// beside its order twin in `utils/bookings-inbound.ts`; re-exported here so a
// purchase writer finds them in its own namespace.
export { derivePurchaseCreditStatus, derivePurchaseStatus, recomputePurchaseBillTotals };
// A line's received and returned counts are custody now (C8), folded beside the inbound ladder.
export { custodyBySourceItem, lineCustodyAt, NO_LINE_CUSTODY, type PurchaseLineCustody };
// The mirror authors and the per-arm rules live beside the refine that checks them.
export {
  deriveQueryByItemTypes,
  deriveQueryByOrders,
  deriveQueryByProducts,
  deriveQueryByUnits,
  purchaseItemCommittedCents,
  purchaseItemProduct,
};
// The payable line uid rule (W4K) lives beside the refines that check it.
export { payableInputUidIssue, payableLineUid, payableLineUidIssue, type PayableLineUidFields };

/**
 * The cents a line's units `(before, after]` cost — the k-th receipt or the
 * k-th bill line against a purchase line, priced from where the cumulative
 * count stood before it to where it stands after.
 *
 * `round(amount × after ÷ quantity) − round(amount × before ÷ quantity)`, each
 * rounded once, half-up, over integers.
 *
 * ⭐ **The CUMULATIVE value is rounded, never the partial.** So the partials
 * along any path from 0 to `quantity` telescope to `amount_cents` exactly — no
 * remainder rule, no "last one absorbs the cent" — and the price of reaching a
 * cumulative count is the same whichever deliveries got there. Rounding each
 * partial instead (`round(amount × k ÷ quantity)`) drifts: three receipts of 1
 * against a $10.00 line of 3 cost 333 + 333 + 333 = 999.
 *
 * Receipts and bills run this SEPARATELY, each on its own cumulative count, so
 * a CFS-pushed bill and the receipts it covers carry the same money however the
 * two were split (`cfs-money`: closure under the quantum, × n ÷ d in integer
 * cents, round once).
 *
 * A REVERSAL is the same call with the bounds swapped in sign: the units
 * `(after, before]` leave at exactly what they cost to arrive, because the
 * cumulative value at a count does not depend on the path.
 *
 * @throws when `quantity < 1`, `amountCents < 0`, or the bounds are not
 *   `0 ≤ before ≤ after ≤ quantity` — the writer owns those checks, and a
 *   caller that reaches this past them has a bucket bug to surface, not a price
 *   to invent.
 */
export function cumulativeShareCents(
  amountCents: number,
  quantity: number,
  before: number,
  after: number,
): number {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new RangeError(`cumulativeShareCents: quantity must be a positive integer, got ${quantity}`);
  }
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new RangeError(`cumulativeShareCents: amountCents must be a non-negative integer, got ${amountCents}`);
  }
  if (!Number.isInteger(before) || !Number.isInteger(after) || before < 0 || before > after || after > quantity) {
    throw new RangeError(
      `cumulativeShareCents: need 0 ≤ before ≤ after ≤ quantity, got before=${before} after=${after} quantity=${quantity}`,
    );
  }
  const amount = BigInt(amountCents);
  const qty = BigInt(quantity);
  const at = (k: number) => roundDivHalfUp(amount * BigInt(k), qty);
  return Number(at(after) - at(before));
}

// ── Landed cost (api-cloudrun#1227) ──────────────────────────────

/**
 * How many of a landed cost's units a line's receipts have priced, at a
 * cumulative received count: the units received since the entry was made,
 * `clamp(received − received_at_entry, 0, quantity)`.
 *
 * The clamp at 0 is what makes a REVERSAL that crosses the entry exact: units
 * received before the entry never carried it, so taking them back returns none
 * of it.
 */
export function landedUnitsPriced(
  entry: Pick<PurchaseLandedCost, "quantity" | "received_at_entry">,
  quantityReceived: number,
): number {
  return Math.min(Math.max(quantityReceived - entry.received_at_entry, 0), entry.quantity);
}

/**
 * The cents a landed cost has put onto the ledger at a cumulative received
 * count — `cumulativeShareCents` over the entry's own units, so the receipts
 * telescope to `amount_cents` exactly once every one of them has arrived.
 */
export function landedPricedCents(
  entry: Pick<PurchaseLandedCost, "amount_cents" | "quantity" | "received_at_entry">,
  quantityReceived: number,
): number {
  return cumulativeShareCents(entry.amount_cents, entry.quantity, 0, landedUnitsPriced(entry, quantityReceived));
}

/**
 * The CUMULATIVE cost a buy line's receipts should have journalled once
 * `quantityReceived` units are in: the goods' share plus every landed cost's
 * share, each rounded on its own cumulative count.
 *
 * A receipt's cost is this target minus what the journal already holds for the
 * product. That difference is the whole design, and it is why a partial
 * `(before, after]` landed share is WRONG here: the journal subtraction already
 * removes the landed cents earlier receipts carried, so a partial would leave
 * only the last receipt's share (a $100 entry over two halves journals $50).
 * Only a cumulative target survives the subtraction, and it keeps a reversal
 * exact as well, since the target at a count does not depend on the path.
 *
 * An empty `landed_costs` reduces this to the goods' share, the pre-#1227
 * formula.
 */
export function purchaseLineReceiptTargetCents(
  line: Pick<PurchaseSaleItem, "amount_cents" | "quantity" | "landed_costs">,
  quantityReceived: number,
): number {
  return line.landed_costs.reduce(
    (sum, entry) => sum + landedPricedCents(entry, quantityReceived),
    cumulativeShareCents(line.amount_cents, line.quantity, 0, quantityReceived),
  );
}

/**
 * Is a landed cost frozen? A receipt has priced part of it once the line's
 * `received` count (its row's custody, `custodyBySourceItem`) passes
 * `received_at_entry`.
 */
export function isLandedCostFrozen(
  entry: Pick<PurchaseLandedCost, "received_at_entry">,
  received: number,
): boolean {
  return received > entry.received_at_entry;
}

/**
 * Landed cents a line can no longer price, because no unit is left to arrive:
 * Σ over its entries of `amount_cents − landedPricedCents(entry, received)`,
 * and `0` while any unit is still to come (a receipt may yet price it).
 *
 * Nonzero only after a short close cut units an entry was spread over. It is
 * DERIVED, never stored (ruling 6): the cost basis it belongs to waits on the
 * post-receipt re-base, which is designed with depreciation (api-cloudrun#1388).
 */
export function strandedLandedCents(
  line: Pick<PurchaseSaleItem, "quantity" | "landed_costs">,
  received: number,
): number {
  if (remainingToReceive(line, { received }) > 0) return 0;
  return line.landed_costs.reduce(
    (sum, entry) => sum + entry.amount_cents - landedPricedCents(entry, received),
    0,
  );
}

/**
 * A line's weight when one landed amount is spread over several lines: the
 * value still to arrive, `cumulativeShareCents(amount, quantity, received,
 * quantity)`. Units already received carry none of it, because the
 * entry only ever prices units received after it.
 */
export function landedCostWeightCents(
  line: Pick<PurchaseSaleItem, "amount_cents" | "quantity">,
  received: number,
): number {
  if (received >= line.quantity) return 0; // Nothing still to arrive; an over-receipt prices nothing either.
  return cumulativeShareCents(line.amount_cents, line.quantity, received, line.quantity);
}

/** One buy line as {@link allocateLandedCostCents} weighs it: the line and its row's received count. */
export interface LandedCostTarget {
  line: Pick<PurchaseSaleItem, "amount_cents" | "quantity">;
  received: number;
}

/**
 * Spread one landed amount over several buy lines, in proportion to each
 * line's value still to arrive ({@link landedCostWeightCents}), with
 * {@link apportionCents}. Σ is exactly `amountCents`.
 *
 * The client runs it so the preview it shows is the split it sends; a line with
 * weight 0 gets 0, and the caller drops it rather than send a 0-cent entry.
 *
 * @throws when every line's weight is 0. There is nothing to be proportional
 *   to, and splitting evenly would put cost on lines with nothing left to
 *   arrive.
 */
export function allocateLandedCostCents(
  amountCents: number,
  lines: readonly LandedCostTarget[],
): number[] {
  return apportionCents(BigInt(amountCents), lines.map((t) => BigInt(landedCostWeightCents(t.line, t.received))))
    .map(Number);
}

/**
 * What a close does to one line ({@link purchaseLineCloseOutcome}):
 *
 * - `lower` — its `quantity` drops to `quantity` (≥ 1), money restated;
 * - `remove` — nothing is left, so the line goes, as an order line does
 *   (ruling 47). Its inbound booking is KEPT while it holds custody, at
 *   `quantity_ordered: 0`, and deleted while it is only a plan;
 * - `end_window` — a TIME charge keeps its quantity and its pair's charge
 *   window ends at the close (ruling 63): its bills metered the time, and a
 *   carrier line simply stops, as an order ends a hire early by shortening
 *   its pair.
 */
export type PurchaseLineCloseOutcome =
  | { kind: "lower"; quantity: number }
  | { kind: "remove" }
  | { kind: "end_window" };

/**
 * **What a close leaves a line holding** (one-document-model Phase 5, ruling 47).
 * A close is a quantity edit: a buy or subrent line drops to what its row has
 * received (`custody`, from `custodyBySourceItem`), a flat charge to what was
 * billed (never above what was ordered), and a line left with nothing is
 * removed. A TIME charge ends its pair's window instead (ruling 63).
 *
 * Only the facts both sides need live here; restating the money, keeping the
 * booking and moving the window are the writer's.
 */
export function purchaseLineCloseOutcome(item: PurchaseItem, custody: PurchaseLineCustody): PurchaseLineCloseOutcome {
  const to = (quantity: number): PurchaseLineCloseOutcome =>
    quantity === 0 ? { kind: "remove" } : { kind: "lower", quantity };
  switch (item.type) {
    case "sale":
    case "rental":
      return to(Math.min(item.quantity, custody.received));
    case "service":
    case "replacement":
      if (purchaseItemBasis(item) === "time") return { kind: "end_window" };
      return to(Math.min(item.quantity, item.quantity_billed ?? 0));
    default: {
      const unreachable: never = item;
      throw new Error(`purchaseLineCloseOutcome: unknown item ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Units of a buy or subrent line still to be received: `quantity − received`, from its row's custody. */
export function remainingToReceive(
  item: Pick<PurchaseSaleItem, "quantity">,
  custody: Pick<PurchaseLineCustody, "received">,
): number {
  return item.quantity - custody.received;
}

/**
 * **A flat purchase line's NET cost and its discount record** (Phase 2 ruling 7):
 * the operator states the GROSS and a supplier discount, and the line stores the
 * net as `amount_cents` — what receipts, basis, bills and credits slice.
 *
 * Composed from the money steps every priced line already uses, so no new
 * rounding exists here:
 *
 * - **percent** — `priceFromFormula` on one period at the gross: the discounted
 *   amount rounds ONCE, half away from zero, exactly as a customer line's does.
 * - **flat** — `rate` is 4dp dollars PER UNIT (`cfs-money`: a rate is not an
 *   amount), taken to cents as `priceFromFormula` takes it, then multiplied by
 *   the integer quantity: closed, nothing to round.
 *
 * A discount larger than the gross yields a negative net, which the stored
 * schema refuses — the caller's 400 to make, not this function's to clamp.
 *
 * @returns `discount` is `null` when none was stated; otherwise its
 *   `amount_cents` is `gross − net`.
 */
export function flatPurchaseLineMoney(
  grossCents: number,
  quantity: number,
  discount: FormulaDiscount | null,
): { amount_cents: number; discount: { rate: number; type: FormulaDiscount["type"]; amount_cents: number } | null } {
  if (!Number.isInteger(grossCents) || !Number.isInteger(quantity)) {
    throw new Error(`A flat purchase line's gross and quantity are integers, got ${grossCents} × ${quantity}`);
  }
  if (discount === null) return { amount_cents: grossCents, discount: null };
  const net = discount.type === "percent"
    ? priceFromFormula([{ rate_key: "flat", amount_cents: grossCents }], [{ rate_key: "flat", num: 1, den: 1 }], 1, discount)
      .subtotal_discounted_cents
    : grossCents - Number(toCentsBig(discount.rate)) * quantity;
  return { amount_cents: net, discount: { rate: discount.rate, type: discount.type, amount_cents: grossCents - net } };
}

/**
 * Units of a FLAT item still to be billed: `quantity − canceled − billed`,
 * never below 0 — an over-billed line (legal since D5, flagged by the diff) has
 * nothing left.
 *
 * ⚠️ **Not for a TIME line**, which has no billed count (`quantity_billed:
 * null`): what it still owes is its units' unbilled charge windows, read by
 * the bill projector, not a number here.
 */
export function remainingToBill(
  item: { quantity: number; quantity_billed: number },
): number {
  return Math.max(0, item.quantity - item.quantity_billed);
}

/**
 * Units of a SUBRENT line still to go back to the supplier: `received −
 * returned`, from its row's custody. Bounded by what came in, not by what was
 * ordered — an unreceived unit owes no return.
 */
export function remainingToReturn(custody: PurchaseLineCustody): number {
  return custody.received - custody.returned;
}

// ── Pack expansion (api-cloudrun#1081) ───────────────────────────

/** A catalog `components[]` row as {@link expandPurchaseItems} reads it. */
export interface PurchaseExpansionComponent extends ComponentRowForWalk {
  uid: string;
  name?: string;
  type: ProductTypeType;
  stock_method: StockMethodType;
}

/** The product facts {@link expandPurchaseItems} reads, keyed by uid in its map. */
export interface PurchaseExpansionProduct {
  uid: string;
  name: string;
  type: ProductTypeType;
  stock_method: StockMethodType;
  components?: readonly PurchaseExpansionComponent[];
}

/** Why an item could not be expanded into one stockable item. */
export interface PurchaseExpansionRefusal {
  uid_product: string;
  reason: "no_stocked_component" | "several_stocked_components";
  message: string;
}

/** The result of {@link expandPurchaseItems}. */
export type PurchaseExpansionResult =
  | { ok: true; items: PurchaseRowInputType[] }
  | { ok: false; refusal: PurchaseExpansionRefusal };

/**
 * Replace every pack on a buy or subrent item with the stocked product it is a
 * pack of, so a stored purchase only ever names a product that can be RECEIVED.
 *
 * A pack is a `stock_method: "none"` product with `components` — the same
 * relation a sale already draws through (`118 Hot Hands (40 Pairs)` →
 * `410 (1 Pair) × 40`). Sales keep the pack as a priced parent over $0
 * component lines; a purchase deliberately does NOT (owner, 2026-10-22): the
 * item's money is the stocked product's cost, so it must sit on the item the
 * receipt lands on. `118 × 12 @ $360` becomes `410 × 480 @ $360`, the ratio
 * applied once, here, through {@link componentQuantities} — the one quantity
 * rule the order expander uses.
 *
 * The receivable FRONTIER of a pack is every component that counts stock and
 * has no counted ancestor in the walk: `353 (240 Pairs)` reaches `410` through
 * the uncounted `118`, and a pallet stops at its counted case rather than the
 * uncounted bottle under it. Exactly one frontier node expands; none is a
 * refusal (buying it would receive nothing), and several is a refusal too —
 * one amount has no rule for splitting across two products' cost.
 *
 * ⚠️ **Expanded items do not MERGE here** (api-cloudrun#1407 D2). An expanded
 * item is keyed by the product it now names (W4K, `payableLineUid`): its `uid`
 * and its path's last segment become the stocked product's. A stocked product
 * the same group already holds is then a second row at one path, which the
 * writer's `itemArrayIssues` uniqueness refuses, as an order's would; the
 * operator merges or splits it into a sibling group.
 * Charge items and dividers pass through untouched, and so does a line that
 * states its kit in the rows: this rewrite serves only a client still sending a
 * bare pack (one-document-model Phase 6a-K), and is deleted once none does.
 *
 * Returns rather than throws: a refusal is an operator-facing 400, and core
 * throws plain `Error`, which a consumer's middleware reads as a 500.
 *
 * @throws when an item names a product absent from `products` — the caller
 *   reads them first, so a miss is its bug, not the operator's.
 */
export function expandPurchaseItems(
  items: readonly PurchaseRowInputType[],
  products: ReadonlyMap<string, PurchaseExpansionProduct>,
): PurchaseExpansionResult {
  const expanded: PurchaseRowInputType[] = [];
  for (const item of items) {
    if (item.type !== "sale" && item.type !== "rental") {
      expanded.push(item);
      continue;
    }
    const product = products.get(item.uid);
    if (!product) throw new Error(`expandPurchaseItems: product ${item.uid} was not read`);
    if (product.stock_method !== "none" || isInKitRows(item, items)) {
      expanded.push(item);
      continue;
    }
    const frontier = stockedFrontier(product, item.quantity);
    if (frontier.length !== 1) {
      return {
        ok: false,
        refusal: frontier.length === 0
          ? {
            uid_product: product.uid,
            reason: "no_stocked_component",
            message: `${product.name} has no stocked component, so buying it would receive nothing. ` +
              "Buy the stocked product instead, or give this product its component.",
          }
          : {
            uid_product: product.uid,
            reason: "several_stocked_components",
            message: `${product.name} contains several stocked products (` +
              frontier.map((f) => f.name).join(", ") + "). Buy each as its own item.",
          },
      };
    }
    const [leaf] = frontier;
    expanded.push(expandOnto(item, leaf.uid, leaf.quantity));
  }
  return { ok: true, items: expanded };
}

/** Does this line sit in a kit the rows already state: a line above it, or any row beneath it? */
function isInKitRows(item: PurchaseRowInputType, rows: readonly PurchaseRowInputType[]): boolean {
  const prefix = (short: readonly string[], long: readonly string[]) => short.length < long.length && short.every((seg, k) => long[k] === seg);
  return rows.some((row) => prefix(item.path, row.path) || (isPurchaseLine(row) && prefix(row.path, item.path)));
}

function expandOnto(
  item: PurchaseSaleItemInputType | PurchaseRentalItemInputType,
  uidProduct: string,
  quantity: number,
): PurchaseSaleItemInputType | PurchaseRentalItemInputType {
  // Keyed by the product it now orders (W4K): the uid and the path's last segment.
  const keyed = { uid: uidProduct, path: [...item.path.slice(0, -1), uidProduct] };
  if (item.type === "sale") {
    return {
      ...item,
      ...keyed,
      quantity,
      ...(item.landed_costs !== undefined ? { landed_costs: item.landed_costs.map((e) => ({ ...e })) } : {}),
    };
  }
  return {
    ...item,
    ...keyed,
    quantity,
    ...(item.uid_orders !== undefined ? { uid_orders: [...item.uid_orders] } : {}),
  };
}

function stockedFrontier(
  product: PurchaseExpansionProduct,
  quantity: number,
): { uid: string; name: string; quantity: number }[] {
  const frontier: { uid: string; name: string; quantity: number }[] = [];
  const stockedPaths: string[][] = [];
  for (const { component, quantity: qty, path } of componentQuantities(product.uid, product.components ?? [], quantity)) {
    const underStocked = stockedPaths.some((p) => p.length < path.length && p.every((seg, i) => path[i] === seg));
    if (underStocked || !productCountsStock(component.type, component.stock_method)) continue;
    stockedPaths.push(path);
    frontier.push({ uid: component.uid, name: component.name ?? component.uid, quantity: qty });
  }
  return frontier;
}
