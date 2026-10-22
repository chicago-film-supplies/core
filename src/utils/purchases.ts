/**
 * Purchase helpers — the cumulative share that prices every receipt and every
 * pushed bill line, the per-line headroom, and the status rule.
 *
 * Design: api-cloudrun#1210.
 *
 * @module
 */
import {
  derivePurchaseStatus,
  type ProductTypeType,
  type PurchaseLine,
  type PurchaseLineInputType,
  type StockMethodType,
} from "../schemas/mod.ts";
import { roundDivHalfUp } from "./money.ts";
import { componentQuantities, type ComponentRowForWalk } from "./order-lines.ts";
import { productCountsStock } from "./products.ts";
import { derivePurchaseCreditStatus, purchaseCreditRemainingFromJournal, recomputePurchaseBillTotals } from "./invoices.ts";

// The payable settlement folds live beside their receivable twins in
// `utils/invoices.ts`, which owns the one fold; re-exported here so a purchase
// writer finds them in its own namespace.
export { derivePurchaseCreditStatus, derivePurchaseStatus, purchaseCreditRemainingFromJournal, recomputePurchaseBillTotals };

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

/** Units of a line still to be received: `quantity − canceled − received`. */
export function remainingToReceive(line: Pick<PurchaseLine, "quantity" | "quantity_received" | "quantity_canceled">): number {
  return line.quantity - line.quantity_canceled - line.quantity_received;
}

/** Units of a line still to be billed: `quantity − canceled − billed`. */
export function remainingToBill(line: Pick<PurchaseLine, "quantity" | "quantity_billed" | "quantity_canceled">): number {
  return line.quantity - line.quantity_canceled - line.quantity_billed;
}

// ── Pack expansion (api-cloudrun#1081) ───────────────────────────

/** A catalog `components[]` row as {@link expandPurchaseLines} reads it. */
export interface PurchaseExpansionComponent extends ComponentRowForWalk {
  uid: string;
  name?: string;
  type: ProductTypeType;
  stock_method: StockMethodType;
}

/** The product facts {@link expandPurchaseLines} reads, keyed by uid in its map. */
export interface PurchaseExpansionProduct {
  uid: string;
  name: string;
  type: ProductTypeType;
  stock_method: StockMethodType;
  components?: readonly PurchaseExpansionComponent[];
}

/** Why a line could not be expanded into one stockable line. */
export interface PurchaseExpansionRefusal {
  uid_product: string;
  reason: "no_stocked_component" | "several_stocked_components";
  message: string;
}

/** The result of {@link expandPurchaseLines}. */
export type PurchaseExpansionResult =
  | { ok: true; lines: PurchaseLineInputType[] }
  | { ok: false; refusal: PurchaseExpansionRefusal };

/**
 * Replace every pack line with the stocked product it is a pack of, so a stored
 * purchase only ever names a product that can be RECEIVED.
 *
 * A pack is a `stock_method: "none"` product with `components` — the same
 * relation a sale already draws through (`118 Hot Hands (40 Pairs)` →
 * `410 (1 Pair) × 40`). Sales keep the pack as a priced parent over $0
 * component lines; a purchase deliberately does NOT (owner, 2026-10-22): the
 * line's money is the stocked product's cost, so it must sit on the line the
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
 * Lines that land on one product MERGE — quantities and amounts summed, the
 * earliest `expected_date` kept — because a purchase holds one line per product
 * and the ledger averages the cost anyway (owner, 2026-10-22).
 *
 * Returns rather than throws: a refusal is an operator-facing 400, and core
 * throws plain `Error`, which a consumer's middleware reads as a 500.
 *
 * @throws when a line names a product absent from `products` — the caller reads
 *   them first, so a miss is its bug, not the operator's.
 */
export function expandPurchaseLines(
  lines: readonly PurchaseLineInputType[],
  products: ReadonlyMap<string, PurchaseExpansionProduct>,
): PurchaseExpansionResult {
  const expanded: PurchaseLineInputType[] = [];
  for (const line of lines) {
    const product = products.get(line.uid_product);
    if (!product) throw new Error(`expandPurchaseLines: product ${line.uid_product} was not read`);
    if (product.stock_method !== "none") {
      expanded.push(line);
      continue;
    }
    const frontier = stockedFrontier(product, line.quantity);
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
              frontier.map((f) => f.name).join(", ") + "). Buy each as its own line.",
          },
      };
    }
    const [leaf] = frontier;
    expanded.push({
      uid_product: leaf.uid,
      quantity: leaf.quantity,
      amount_cents: line.amount_cents,
      ...(line.expected_date !== undefined ? { expected_date: line.expected_date } : {}),
    });
  }
  return { ok: true, lines: mergeByProduct(expanded) };
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

function mergeByProduct(lines: readonly PurchaseLineInputType[]): PurchaseLineInputType[] {
  const byProduct = new Map<string, PurchaseLineInputType>();
  for (const line of lines) {
    const prev = byProduct.get(line.uid_product);
    if (!prev) {
      byProduct.set(line.uid_product, { ...line });
      continue;
    }
    prev.quantity += line.quantity;
    prev.amount_cents += line.amount_cents;
    const dates = [prev.expected_date, line.expected_date].filter((d): d is string => typeof d === "string");
    if (dates.length > 0) prev.expected_date = dates.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
  }
  return [...byProduct.values()];
}
