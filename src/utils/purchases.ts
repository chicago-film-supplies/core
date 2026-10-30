/**
 * Purchase helpers — the cumulative share that prices every receipt and every
 * pushed bill line, the per-line headroom, and the status rule.
 *
 * Design: api-cloudrun#1210.
 *
 * @module
 */
import {
  type BuyItem,
  type BuyItemInputType,
  derivePurchaseStatus,
  deriveQueryByItemTypes,
  deriveQueryByOrders,
  deriveQueryByProducts,
  type ProductTypeType,
  purchaseItemCanceled,
  purchaseItemCommittedCents,
  purchaseItemProduct,
  purchaseItemResolved,
  type PurchaseItemInputType,
  type PurchaseLandedCost,
  type StockMethodType,
  type SubrentItem,
  type SubrentItemInputType,
} from "../schemas/mod.ts";
import { apportionCents, roundDivHalfUp } from "./money.ts";
import { componentQuantities, type ComponentRowForWalk } from "./order-lines.ts";
import { productCountsStock } from "./products.ts";
import { derivePurchaseCreditStatus, purchaseCreditRemainingFromJournal, recomputePurchaseBillTotals } from "./invoices.ts";

// The payable settlement folds live beside their receivable twins in
// `utils/invoices.ts`, which owns the one fold; re-exported here so a purchase
// writer finds them in its own namespace.
export { derivePurchaseCreditStatus, derivePurchaseStatus, purchaseCreditRemainingFromJournal, recomputePurchaseBillTotals };
// The mirror authors and the per-arm rules live beside the refine that checks them.
export {
  deriveQueryByItemTypes,
  deriveQueryByOrders,
  deriveQueryByProducts,
  purchaseItemCanceled,
  purchaseItemCommittedCents,
  purchaseItemProduct,
  purchaseItemResolved,
};

/** The co-written receipt buckets — a buy or subrent item. */
type ReceivableItem = Pick<BuyItem, "quantity" | "quantity_received" | "quantity_canceled">;

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
  line: Pick<BuyItem, "amount_cents" | "quantity" | "landed_costs">,
  quantityReceived: number,
): number {
  return line.landed_costs.reduce(
    (sum, entry) => sum + landedPricedCents(entry, quantityReceived),
    cumulativeShareCents(line.amount_cents, line.quantity, 0, quantityReceived),
  );
}

/** Is a landed cost frozen? A receipt has priced part of it once `received > received_at_entry`. */
export function isLandedCostFrozen(
  entry: Pick<PurchaseLandedCost, "received_at_entry">,
  line: Pick<BuyItem, "quantity_received">,
): boolean {
  return line.quantity_received > entry.received_at_entry;
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
  line: Pick<BuyItem, "quantity" | "quantity_received" | "quantity_canceled" | "landed_costs">,
): number {
  if (remainingToReceive(line) > 0) return 0;
  return line.landed_costs.reduce(
    (sum, entry) => sum + entry.amount_cents - landedPricedCents(entry, line.quantity_received),
    0,
  );
}

/**
 * A line's weight when one landed amount is spread over several lines: the
 * value still to arrive, `cumulativeShareCents(amount, quantity, received,
 * quantity − canceled)`. Units already received carry none of it, because the
 * entry only ever prices units received after it.
 */
export function landedCostWeightCents(
  line: Pick<BuyItem, "amount_cents" | "quantity" | "quantity_received" | "quantity_canceled">,
): number {
  return cumulativeShareCents(line.amount_cents, line.quantity, line.quantity_received, line.quantity - line.quantity_canceled);
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
  lines: readonly Pick<BuyItem, "amount_cents" | "quantity" | "quantity_received" | "quantity_canceled">[],
): number[] {
  return apportionCents(BigInt(amountCents), lines.map((l) => BigInt(landedCostWeightCents(l)))).map(Number);
}

/** Units of a buy or subrent item still to be received: `quantity − canceled − received`. */
export function remainingToReceive(item: ReceivableItem): number {
  return item.quantity - item.quantity_canceled - item.quantity_received;
}

/**
 * Units of a buy or FIXED-basis subrent item still to be billed:
 * `quantity − canceled − billed`.
 *
 * ⚠️ **Not for an activation-billed subrent or a usage item**, whose billable
 * quantity is PERIODS derived from activation spans — `remainingUsageToBill`
 * (serialized-subrent § 7b), a separate util by design, since six callers share
 * this one. A direct item bills once: `1 − quantity_billed`.
 */
export function remainingToBill(item: Pick<BuyItem, "quantity" | "quantity_billed" | "quantity_canceled">): number {
  return item.quantity - item.quantity_canceled - item.quantity_billed;
}

/**
 * Units of a SUBRENT item still to go back to the supplier: `received − returned`.
 * Bounded by what came in, not by what was ordered — an unreceived unit owes no
 * return.
 */
export function remainingToReturn(item: Pick<SubrentItem, "quantity_received" | "quantity_returned">): number {
  return item.quantity_received - item.quantity_returned;
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
  | { ok: true; items: PurchaseItemInputType[] }
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
 * ⚠️ **Expanded items no longer MERGE** (api-cloudrun#1407 D2). They merged —
 * quantities and amounts summed, one hire window per product — only because a
 * purchase held one line per product. Items carry their own row identity now,
 * so a pack item keeps its `uid` and becomes its own item even when the stocked
 * product already has one; the ledger averages the cost either way.
 * Usage and direct items pass through untouched.
 *
 * Returns rather than throws: a refusal is an operator-facing 400, and core
 * throws plain `Error`, which a consumer's middleware reads as a 500.
 *
 * @throws when an item names a product absent from `products` — the caller
 *   reads them first, so a miss is its bug, not the operator's.
 */
export function expandPurchaseItems(
  items: readonly PurchaseItemInputType[],
  products: ReadonlyMap<string, PurchaseExpansionProduct>,
): PurchaseExpansionResult {
  const expanded: PurchaseItemInputType[] = [];
  for (const item of items) {
    if (item.type !== "buy" && item.type !== "subrent") {
      expanded.push(item);
      continue;
    }
    const product = products.get(item.uid_product);
    if (!product) throw new Error(`expandPurchaseItems: product ${item.uid_product} was not read`);
    if (product.stock_method !== "none") {
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

function expandOnto(
  item: BuyItemInputType | SubrentItemInputType,
  uidProduct: string,
  quantity: number,
): BuyItemInputType | SubrentItemInputType {
  if (item.type === "buy") {
    return {
      ...item,
      uid_product: uidProduct,
      quantity,
      ...(item.landed_costs !== undefined ? { landed_costs: item.landed_costs.map((e) => ({ ...e })) } : {}),
    };
  }
  return {
    ...item,
    uid_product: uidProduct,
    quantity,
    billing: { ...item.billing },
    dates: { ...item.dates },
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
